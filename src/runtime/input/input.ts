import type { InputBindings } from '@schema/index.js';

/**
 * Action-based input (plan §10).
 *
 * Gameplay asks about *actions* ("move forward", "jump", "interact"), never about keys.
 * Bindings live in `game.json` so the same actions can later be driven by touch controls or
 * a gamepad without touching behavior code.
 */

export const DEFAULT_BINDINGS: InputBindings = {
  moveForward: ['KeyW', 'ArrowUp'],
  moveBackward: ['KeyS', 'ArrowDown'],
  moveLeft: ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  interact: ['KeyE'],
  restart: ['KeyR'],
  primary: ['Mouse0'],
};

export interface PointerState {
  /** Normalised device coordinates, -1..1, origin at the centre. */
  x: number;
  y: number;
  /** Pointer position in canvas pixels. */
  clientX: number;
  clientY: number;
  down: boolean;
  justPressed: boolean;
  justReleased: boolean;
}

export interface InputOptions {
  /** Keyboard/pointer target; defaults to `window` / the canvas owner document. */
  target: EventTarget;
  /** Element used to convert pointer coordinates; defaults to the target if it is an element. */
  canvas?: HTMLElement;
  bindings?: InputBindings;
}

/**
 * The event each registered listener type delivers.
 *
 * `EventTarget.addEventListener` is string-keyed, so the payload type is not part of its
 * signature. Naming the pairing here type-checks every handler at its registration site and
 * leaves exactly one place — `addListener` — where the DOM's guarantee is written down.
 */
interface InputEventMap {
  keydown: KeyboardEvent;
  keyup: KeyboardEvent;
  blur: Event;
  pointerdown: PointerEvent;
  pointerup: PointerEvent;
  pointermove: PointerEvent;
  pointerleave: PointerEvent;
  contextmenu: MouseEvent;
}

export class InputSystem {
  private readonly bindings: Map<string, Set<string>>;
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly released = new Set<string>();
  private readonly target: EventTarget;
  private readonly canvas: HTMLElement | null;
  private readonly listeners: Array<{ target: EventTarget; type: string; handler: EventListener }> = [];
  private pointerState: PointerState = {
    x: 0,
    y: 0,
    clientX: 0,
    clientY: 0,
    down: false,
    justPressed: false,
    justReleased: false,
  };
  private disposed = false;

  constructor(options: InputOptions) {
    this.bindings = buildBindingMap(options.bindings ?? DEFAULT_BINDINGS);
    this.target = options.target;
    this.canvas = options.canvas ?? (options.target instanceof HTMLElement ? options.target : null);

    this.addListener(this.target, 'keydown', (event) => this.handleKey(event, true));
    this.addListener(this.target, 'keyup', (event) => this.handleKey(event, false));
    // A window that loses focus must not leave keys stuck down.
    this.addListener(this.target, 'blur', () => this.clear());
    if (this.canvas) {
      this.addListener(this.canvas, 'pointerdown', (event) => this.handlePointer(event, 'down'));
      this.addListener(this.canvas, 'pointerup', (event) => this.handlePointer(event, 'up'));
      this.addListener(this.canvas, 'pointermove', (event) => this.handlePointer(event, 'move'));
      this.addListener(this.canvas, 'pointerleave', () => this.clearPointer());
      this.addListener(this.canvas, 'contextmenu', (event) => event.preventDefault());
    }
  }

  isActionDown(action: string): boolean {
    return this.anyDown(action);
  }

  /** True on the frame the action was pressed. */
  wasActionPressed(action: string): boolean {
    return this.anyIn(this.pressed, action);
  }

  wasActionReleased(action: string): boolean {
    return this.anyIn(this.released, action);
  }

  /** Movement axis in the XZ plane, already normalised for diagonal input. */
  moveAxis(): { x: number; y: number } {
    const x = (this.isActionDown('moveRight') ? 1 : 0) - (this.isActionDown('moveLeft') ? 1 : 0);
    const y = (this.isActionDown('moveForward') ? 1 : 0) - (this.isActionDown('moveBackward') ? 1 : 0);
    const length = Math.hypot(x, y);
    return length > 1 ? { x: x / length, y: y / length } : { x, y };
  }

  get pointer(): PointerState {
    return this.pointerState;
  }

  /** Method form used by the behavior context's `BehaviorInput` interface. */
  pointerSnapshot(): PointerState {
    return this.pointerState;
  }

  /** Clear per-frame edge state. The runtime calls this once per rendered frame. */
  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
    this.pointerState = { ...this.pointerState, justPressed: false, justReleased: false };
  }

  /** Keys currently held, for the debug overlay. */
  heldKeys(): string[] {
    return [...this.down];
  }

  clear(): void {
    this.down.clear();
    this.pressed.clear();
    this.released.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { target, type, handler } of this.listeners) target.removeEventListener(type, handler);
    this.listeners.length = 0;
    this.clear();
  }

  get listenerCount(): number {
    return this.listeners.length;
  }

  private handleKey(event: KeyboardEvent, isDown: boolean): void {
    const code = event.code || event.key;
    // Only swallow keys the game actually binds, so browser shortcuts keep working.
    const bound = this.isBound(code);
    if (bound && event.cancelable) event.preventDefault();
    if (isDown) {
      if (this.down.has(code)) return; // ignore auto-repeat for the edge sets
      this.down.add(code);
      this.pressed.add(code);
    } else {
      this.down.delete(code);
      this.released.add(code);
    }
  }

  private handlePointer(event: PointerEvent, phase: 'down' | 'up' | 'move'): void {
    const rect = this.canvas?.getBoundingClientRect();
    const clientX = event.clientX;
    const clientY = event.clientY;
    const width = rect?.width ?? 1;
    const height = rect?.height ?? 1;
    const x = ((clientX - (rect?.left ?? 0)) / Math.max(1, width)) * 2 - 1;
    const y = -(((clientY - (rect?.top ?? 0)) / Math.max(1, height)) * 2 - 1);

    if (phase === 'down') {
      this.down.add('Mouse0');
      this.pressed.add('Mouse0');
      this.pointerState = { ...this.pointerState, x, y, clientX, clientY, down: true, justPressed: true };
      return;
    }
    if (phase === 'up') {
      this.down.delete('Mouse0');
      this.released.add('Mouse0');
      this.pointerState = { ...this.pointerState, x, y, clientX, clientY, down: false, justReleased: true };
      return;
    }
    this.pointerState = { ...this.pointerState, x, y, clientX, clientY };
  }

  private clearPointer(): void {
    this.down.delete('Mouse0');
    this.pointerState = { ...this.pointerState, down: false };
  }

  private isBound(code: string): boolean {
    for (const keys of this.bindings.values()) {
      if (keys.has(code)) return true;
    }
    return false;
  }

  private anyDown(action: string): boolean {
    return this.anyIn(this.down, action);
  }

  private anyIn(set: Set<string>, action: string): boolean {
    const keys = this.bindings.get(action);
    if (!keys) return false;
    for (const key of keys) {
      if (set.has(key)) return true;
    }
    return false;
  }

  private addListener<K extends keyof InputEventMap>(
    target: EventTarget,
    type: K,
    handler: (event: InputEventMap[K]) => void,
  ): void {
    // SAFETY: the DOM delivers the event interface that belongs to the registered type, which is
    // exactly the pairing `InputEventMap` records; a browser never dispatches any other shape.
    const listener: EventListener = (event) => handler(event as InputEventMap[K]);
    target.addEventListener(type, listener);
    this.listeners.push({ target, type, handler: listener });
  }
}

function buildBindingMap(bindings: InputBindings): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const [action, keys] of Object.entries(bindings)) {
    map.set(action, new Set(keys));
  }
  // Movement and restart are the contract behaviors rely on; make sure they always exist.
  for (const [action, keys] of Object.entries(DEFAULT_BINDINGS)) {
    if (!map.has(action)) map.set(action, new Set(keys));
  }
  return map;
}
