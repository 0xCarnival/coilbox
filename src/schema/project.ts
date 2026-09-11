import { z } from 'zod';
import { assetId, finiteNumber, hexColor, jsonObject } from './fields.js';

/**
 * Project manifest (`game.json`) and asset manifest (`assets/manifest.json`).
 *
 * `schemaVersion` describes the document format; `engineVersion` records the engine
 * the project was authored against so incompatible projects fail with a clear message
 * instead of loading half-way.
 */

export const PROJECT_SCHEMA_VERSION = 1;
export const ENGINE_VERSION = '0.1.0';

export const sceneEntrySchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  /** Project-relative POSIX path, e.g. `scenes/main.scene.json`. */
  path: z.string().min(1),
});

export const physicsSettingsSchema = z.object({
  fixedTimeStep: finiteNumber.positive().max(0.5).default(1 / 60),
  /** Solver sub-steps per fixed step. */
  subStepCount: finiteNumber.int().min(1).max(16).default(4),
  /** Maximum fixed steps consumed in one frame before time is dropped. */
  maxSubSteps: finiteNumber.int().min(1).max(20).default(5),
  enableSleep: z.boolean().default(true),
  /** Speed above which a contact reports a hit event. */
  hitEventThreshold: finiteNumber.min(0).default(1),
});

export const renderSettingsSchema = z.object({
  antialias: z.boolean().default(true),
  shadows: z.boolean().default(true),
  /** Device pixel ratio cap; keeps 1080p authoring predictable on Retina displays. */
  pixelRatioCap: finiteNumber.min(0.5).max(4).default(2),
  toneMapping: z.enum(['none', 'aces', 'neutral']).default('aces'),
  exposure: finiteNumber.min(0).max(8).default(1),
});

export const hudElementSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('label'),
    id: z.string().min(1),
    text: z.string().default(''),
    /** Game-state key bound to the label text; empty = static text. */
    bind: z.string().default(''),
    position: z.enum(['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']).default('top-left'),
    color: hexColor.default('#ffffff'),
    size: finiteNumber.min(6).max(200).default(18),
  }),
  z.object({
    type: z.literal('counter'),
    id: z.string().min(1),
    label: z.string().default('Score'),
    bind: z.string().default('score'),
    target: finiteNumber.default(0),
    position: z.enum(['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']).default('top-right'),
    color: hexColor.default('#ffffff'),
    size: finiteNumber.min(6).max(200).default(20),
  }),
  z.object({
    type: z.literal('button'),
    id: z.string().min(1),
    label: z.string().default('Restart'),
    /** Game-state action dispatched on click. */
    action: z.enum(['restart', 'nextScene', 'none']).default('restart'),
    position: z.enum(['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']).default('bottom-center'),
    color: hexColor.default('#ffffff'),
    size: finiteNumber.min(6).max(200).default(18),
  }),
  z.object({
    type: z.literal('overlay'),
    id: z.string().min(1),
    kind: z.enum(['start', 'win', 'lose', 'pause']).default('start'),
    title: z.string().default(''),
    message: z.string().default(''),
    /** Label of the primary action button; empty hides it. */
    actionLabel: z.string().default(''),
    action: z.enum(['restart', 'nextScene', 'resume', 'none']).default('restart'),
    background: hexColor.default('#101319'),
    color: hexColor.default('#ffffff'),
  }),
]);

export const gameSettingsSchema = z.object({
  physics: physicsSettingsSchema.prefault({}),
  render: renderSettingsSchema.prefault({}),
  /** Initial game-state values available to HUD bindings and behaviors. */
  initialGameState: jsonObject.prefault({}),
  hud: z.array(hudElementSchema).default([]),
  /** Input action -> key bindings. Actions are defined independently of keys. */
  inputBindings: z.record(z.string(), z.array(z.string())).prefault({}),
});

export const gameSchema = z.object({
  schemaVersion: z.number().int().positive(),
  engineVersion: z.string().min(1).default(ENGINE_VERSION),
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  scenes: z.array(sceneEntrySchema).min(1),
  startScene: z.string().min(1),
  settings: gameSettingsSchema.prefault({}),
  /** Project-relative paths; omit to use the defaults. */
  assetManifest: z.string().default('assets/manifest.json'),
  behaviorRegistry: z.string().default('scripts/registry.json'),
  /** Compatibility hint: last engine version this project was opened with. */
  engineCompat: z.string().default(ENGINE_VERSION),
});

export const assetKind = z.enum(['model', 'image', 'audio']);

export const assetEntrySchema = z.object({
  id: assetId,
  kind: assetKind,
  /** Project-relative POSIX path. */
  path: z.string().min(1),
  /** Content hash used to detect replacement and to keep identity stable across moves. */
  hash: z.string().min(1).default(''),
  bytes: finiteNumber.min(0).default(0),
  /** Optional author-facing note. */
  note: z.string().default(''),
  /** Extensions/decoders required to load the asset (for example meshopt, ktx2). */
  requires: z.array(z.string()).default([]),
  meta: jsonObject.prefault({}),
});

export const assetManifestSchema = z.object({
  schemaVersion: z.number().int().positive(),
  assets: z.array(assetEntrySchema).default([]),
});

export type SceneEntry = z.infer<typeof sceneEntrySchema>;
export type GameSettings = z.infer<typeof gameSettingsSchema>;
export type GameDocument = z.infer<typeof gameSchema>;
export type GameDocumentInput = z.input<typeof gameSchema>;
export type AssetEntry = z.infer<typeof assetEntrySchema>;
export type AssetKind = z.infer<typeof assetKind>;
export type AssetManifest = z.infer<typeof assetManifestSchema>;
export type HudElement = z.infer<typeof hudElementSchema>;
export type PhysicsSettings = z.infer<typeof physicsSettingsSchema>;
export type RenderSettings = z.infer<typeof renderSettingsSchema>;
export type InputBindings = GameSettings['inputBindings'];

export const DEFAULT_GRAVITY: [number, number, number] = [0, -9.81, 0];
