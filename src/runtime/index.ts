/**
 * Runtime entry point. Editor code must never be imported from here (plan §6): the
 * player build imports this module and nothing under `src/editor`.
 */

export { RuntimeWorld, type RuntimeWorldOptions, type RuntimeStats, type WorldState } from './world.js';
export { RuntimeWorldError, buildSceneGraph, type BuiltEntity, type BuiltScene } from './scene-graph.js';
export { FixedStepLoop, type FixedStepLoopOptions, type LoopStats } from './loop.js';
export { RuntimeViewport, checkWebGL2Capability, disposeSceneResources, type WebGL2Capability } from './render/viewport.js';
export { createBox3DBackend, loadBox3D, BOX3D_BINDING } from './physics/box3d-adapter.js';
export type {
  ColliderSpec,
  ColliderShapeSpec,
  ContactEvent,
  PhysicsBackend,
  PhysicsBodySpec,
  PhysicsBodyType,
  PhysicsCounters,
  PhysicsWorldHandle,
  PhysicsWorldOptions,
  RaycastHit,
} from './physics/types.js';
export { BehaviorRegistry, BehaviorRegistrationError, validateBehaviorDefinition } from './behaviors/registry.js';
export type {
  BehaviorContext,
  BehaviorDefinition,
  BehaviorEntry,
  BehaviorInstance,
  BehaviorPropertyDescriptor,
  BehaviorPropertyType,
} from './behaviors/types.js';
export { EmptyAssetResolver, UrlAssetResolver, type AssetResolver } from './assets/resolver.js';
export { loadProjectFromUrl, ProjectLoadError, describeIssues, type LoadedProject } from './project/loader.js';
