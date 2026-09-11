import type { HudElement, JsonValue } from '@schema/index.js';
import type { GameState } from '../game-state.js';

/**
 * Shared HTML/CSS HUD (plan §10).
 *
 * "A basic HUD is shared HTML/CSS code mounted by the runtime, with data bindings to a small
 * game-state object. Expose useful labels, colours, and values; do not build a general UI
 * layout editor."
 *
 * The same code runs in the editor preview, the player, and exported games.
 */

export type HudAction = 'restart' | 'nextScene' | 'resume' | 'none';

export interface HudCallbacks {
  onAction(action: HudAction): void;
}

export interface HudOptions {
  elements: HudElement[];
  state: GameState;
  /** Where the HUD is mounted; defaults to `document.body`. */
  root?: HTMLElement | null;
  callbacks: HudCallbacks;
}

const isJsonNumber = (value: JsonValue | undefined): value is number => typeof value === 'number';
const isJsonString = (value: JsonValue | undefined): value is string => typeof value === 'string';
const isJsonBoolean = (value: JsonValue | undefined): value is boolean => typeof value === 'boolean';

export class Hud {
  private readonly root: HTMLElement;
  private readonly state: GameState;
  private readonly callbacks: HudCallbacks;
  private readonly elements: HudElement[];
  private readonly nodes = new Map<string, { text: HTMLElement; container: HTMLElement }>();
  private readonly unsubscribe: () => void;
  private readonly ownsRoot: boolean;
  private readonly bound = new Map<string, Set<string>>();
  private disposed = false;

  constructor(options: HudOptions) {
    this.elements = options.elements;
    this.state = options.state;
    this.callbacks = options.callbacks;
    const documentRef = options.root?.ownerDocument ?? globalThis.document;
    // The HUD always owns its own container inside the host, so its scoped styles apply
    // whether it was mounted on the page body or inside the editor's viewport.
    const host = options.root ?? documentRef.body;
    const created = documentRef.createElement('div');
    created.className = 'coilbox-hud';
    created.setAttribute('data-coilbox-hud', 'true');
    host.appendChild(created);
    this.root = created;
    this.ownsRoot = true;

    injectStyles(this.root.ownerDocument);
    for (const element of this.elements) this.mount(element);

    this.unsubscribe = this.state.subscribe((key, value) => this.updateBindings(key, value));
    // Seed every binding once so the HUD is correct before the first change.
    for (const [key, value] of Object.entries(this.state.snapshot())) this.updateBindings(key, value);
    for (const element of this.elements) if (element.type === 'overlay') this.refreshOverlay(element);
  }

  /** Show or hide overlays by kind ('start', 'win', 'pause'). */
  setOverlayVisible(kind: 'start' | 'win' | 'lose' | 'pause', visible: boolean): void {
    for (const element of this.elements) {
      if (element.type !== 'overlay' || element.kind !== kind) continue;
      const node = this.nodes.get(element.id);
      if (node) node.container.style.display = visible ? 'flex' : 'none';
    }
  }

  /** Show a single overlay and hide the others; `null` hides them all. */
  showOnlyOverlay(kind: 'start' | 'win' | 'lose' | 'pause' | null): void {
    for (const element of this.elements) {
      if (element.type !== 'overlay') continue;
      const node = this.nodes.get(element.id);
      if (!node) continue;
      node.container.style.display = element.kind === kind ? 'flex' : 'none';
    }
  }

  updateText(elementId: string, text: string): void {
    const node = this.nodes.get(elementId);
    if (node) node.text.textContent = text;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    for (const node of this.nodes.values()) node.container.remove();
    this.nodes.clear();
    if (this.ownsRoot) this.root.remove();
  }

  private mount(element: HudElement): void {
    const documentRef = this.root.ownerDocument;
    const container = documentRef.createElement('div');
    container.className = `hud-element hud-${element.type} hud-${positionClass(element)}`;
    container.dataset.hudId = element.id;

    const text = documentRef.createElement(element.type === 'button' ? 'button' : 'div');
    if (element.type === 'button') {
      // SAFETY: the ternary above created a <button> exactly when this element is a button, so the
      // node is an HTMLButtonElement in this branch.
      (text as HTMLButtonElement).type = 'button';
      text.textContent = element.label;
      text.addEventListener('click', () => this.callbacks.onAction(element.action));
    } else if (element.type === 'counter') {
      text.textContent = `${element.label}: 0`;
    } else if (element.type === 'label') {
      text.textContent = element.text;
    } else {
      // overlay
      const title = documentRef.createElement('h2');
      title.textContent = element.title;
      const message = documentRef.createElement('p');
      message.textContent = element.message;
      text.appendChild(title);
      text.appendChild(message);
      if (element.actionLabel.length > 0) {
        const button = documentRef.createElement('button');
        button.type = 'button';
        button.textContent = element.actionLabel;
        button.addEventListener('click', () => this.callbacks.onAction(element.action));
        text.appendChild(button);
      }
      text.style.background = element.background;
      text.style.color = element.color;
      container.style.display = 'none';
    }

    if ('color' in element) text.style.color = element.color;
    if ('size' in element) text.style.fontSize = `${element.size}px`;
    if (element.type === 'counter' || element.type === 'label') {
      const bind = element.type === 'counter' ? element.bind : element.bind;
      if (bind.length > 0) {
        const set = this.bound.get(bind) ?? new Set<string>();
        set.add(element.id);
        this.bound.set(bind, set);
      }
    }

    container.appendChild(text);
    this.root.appendChild(container);
    this.nodes.set(element.id, { text, container });
  }

  private updateBindings(key: string, value: JsonValue): void {
    const elementIds = this.bound.get(key);
    if (!elementIds) return;
    for (const elementId of elementIds) {
      const element = this.elements.find((candidate) => candidate.id === elementId);
      const node = this.nodes.get(elementId);
      if (!element || !node) continue;
      if (element.type === 'counter') {
        const target = element.target > 0 ? ` / ${element.target}` : '';
        node.text.textContent = `${element.label}: ${formatValue(value)}${target}`;
      } else if (element.type === 'label') {
        const template = element.text;
        node.text.textContent = template.includes('{value}') ? template.replace('{value}', formatValue(value)) : `${template}${formatValue(value)}`;
      }
    }
  }

  private refreshOverlay(element: Extract<HudElement, { type: 'overlay' }>): void {
    const node = this.nodes.get(element.id);
    if (!node) return;
    // The 'start' overlay is visible until the game begins; the others start hidden.
    node.container.style.display = element.kind === 'start' ? 'flex' : 'none';
  }
}

function positionClass(element: HudElement): string {
  if (element.type === 'overlay') return 'center';
  return element.position;
}

function formatValue(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return '0';
  if (isJsonNumber(value)) return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (isJsonBoolean(value)) return value ? 'yes' : 'no';
  if (isJsonString(value)) return value;
  return JSON.stringify(value);
}

/** One stylesheet for every HUD, injected once per document. */
function injectStyles(documentRef: Document): void {
  if (documentRef.getElementById('coilbox-hud-styles')) return;
  const style = documentRef.createElement('style');
  style.id = 'coilbox-hud-styles';
  style.textContent = `
/*
 * The HUD is styled here rather than in the editor's stylesheet because an export ships the runtime
 * and the player with no styling compiler of their own: this <style> element is the whole dependency.
 * See coilbox/no-stylex-outside-editor.
 *
 * The values below are the editor palette's, spelled literally because this file cannot import the
 * editor's tokens. They are duplicated deliberately and not by accident — the overlay floats over the
 * same render the editor's viewport shows, so a coloured button here would be the one chromatic
 * pixel in a strictly neutral product. The editor's chrome is #171717 with #fafafa text,
 * white/10% borders, and a near-white primary button; keep these in step with
 * src/editor/styles/tokens.stylex.ts. (No backticks in this comment: it lives inside a template
 * literal, and a stray pair would close it and turn the rest of the stylesheet into JavaScript.)
 */
.coilbox-hud { position: fixed; inset: 0; pointer-events: none; font: 14px/1.4 Inter, ui-sans-serif, -apple-system, "Segoe UI", sans-serif; }
.hud-host > .coilbox-hud { position: absolute; }
.coilbox-hud .hud-element { position: absolute; padding: 4px 8px; }
.coilbox-hud .hud-top-left { top: 10px; left: 12px; }
.coilbox-hud .hud-top-center { top: 10px; left: 50%; transform: translateX(-50%); }
.coilbox-hud .hud-top-right { top: 10px; right: 12px; }
.coilbox-hud .hud-bottom-left { bottom: 12px; left: 12px; }
.coilbox-hud .hud-bottom-center { bottom: 12px; left: 50%; transform: translateX(-50%); }
.coilbox-hud .hud-bottom-right { bottom: 12px; right: 12px; }
.coilbox-hud .hud-center { inset: 0; display: flex; align-items: center; justify-content: center; }
.coilbox-hud .hud-overlay > * { background: rgba(23, 23, 23, 0.94); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 6px; padding: 22px 26px; text-align: center; min-width: 240px; pointer-events: auto; box-shadow: 0 20px 50px rgba(0, 0, 0, 0.55); }
.coilbox-hud .hud-overlay h2 { margin: 0 0 6px; font-size: 20px; letter-spacing: -0.01em; }
.coilbox-hud .hud-overlay p { margin: 0 0 14px; color: #b4b4b4; }
.coilbox-hud button { pointer-events: auto; background: #e8e8e8; color: #171717; border: 0; border-radius: 6px; padding: 7px 16px; font: inherit; font-weight: 500; cursor: pointer; }
.coilbox-hud button:hover { background: #dcdcdc; }
.coilbox-hud .hud-counter, .coilbox-hud .hud-label { font-variant-numeric: tabular-nums; text-shadow: 0 1px 3px rgba(0,0,0,0.6); }
`;
  documentRef.head.appendChild(style);
}
