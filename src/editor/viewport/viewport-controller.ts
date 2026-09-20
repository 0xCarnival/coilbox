import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Entity, SceneDocument, Transform, MaterialComponent } from '@schema/index.js';
import { applyMaterial, createLight, createPrimitiveMesh, RuntimeWorldError } from '@runtime/scene-graph.js';
import { disposeSceneResources } from '@runtime/render/viewport.js';
import { BATCHED_LAYER, primitiveBatchKey, PrimitiveBatches, type BatchMember } from '@runtime/instancing.js';
import { EnvironmentProjection } from '@runtime/render/environment.js';
import { AnimationController } from '@runtime/animation.js';
import { loadMaterialTextures, type MaterialTextures, type ModelInstance } from '@runtime/assets/loader.js';
import type { AssetDropTarget } from '../assets/asset-drop.js';
import { selectionRoots } from '../document/selection-roots.js';
import { applyPivotDelta, pointsInRect } from './group-transform.js';
import { ShadingPass, type ShadingMode } from './shading.js';
import { FlyNavigator } from './fly-navigator.js';

/**
 * The editor view's render scale: device pixels per CSS pixel.
 *
 * `'device'` follows the display, capped at 2, which is what the view always did — and on a Retina
 * display it is four times the pixels the game draws, since the runtime caps at 1. `1` matches the
 * game; the fractions are for a scene that is still slow at that.
 */
export type RenderScale = 0.5 | 0.75 | 1 | 'device';

export const RENDER_SCALES: readonly RenderScale[] = [0.5, 0.75, 1, 'device'];

export function isRenderScale(value: unknown): value is RenderScale {
  return value === 'device' || value === 1 || value === 0.75 || value === 0.5;
}

/**
 * The entities that stay visible when the view is isolated to `roots`: the roots themselves, their
 * descendants (which follow from the parent's visibility, but are listed so a lookup is one `has`),
 * and their ancestors, without which the roots would be hidden inside hidden groups.
 */
function isolationSet(scene: SceneDocument, roots: readonly string[]): Set<string> {
  const byId = new Map(scene.entities.map((entity) => [entity.id, entity] as const));
  const children = new Map<string | null, string[]>();
  for (const entity of scene.entities) {
    const list = children.get(entity.parentId) ?? [];
    list.push(entity.id);
    children.set(entity.parentId, list);
  }
  const visible = new Set<string>();
  for (const root of roots) {
    for (let current = byId.get(root); current; current = current.parentId === null ? undefined : byId.get(current.parentId)) {
      visible.add(current.id);
    }
    const stack = [root];
    while (stack.length > 0) {
      const id = stack.pop()!;
      visible.add(id);
      for (const child of children.get(id) ?? []) stack.push(child);
    }
  }
  return visible;
}

/**
 * Editor viewport: an imperative Three.js authoring view owned by one React component.
 *
 * Rules this file follows (plan §5, §8):
 * - React never receives per-frame object transforms; it renders panels only.
 * - Dragging a handle moves the *projection* and produces viewport feedback. Exactly one
 *   command is committed on release; Escape restores the document transform.
 * - The projection is built from the same component mapping the runtime uses, so what the
 *   editor shows is what Play will build.
 */

export type TransformTool = 'translate' | 'rotate' | 'scale';

/**
 * The frame a transform gizmo's axes are drawn in: the world's, or the selected object's own.
 *
 * Blender's Global/Local. For a group the pivot takes the primary selection's orientation in local
 * space, so dragging along the gizmo's X moves the group along *that object's* X.
 */
export type TransformSpace = 'world' | 'local';

export interface SnapSettings {
  enabled: boolean;
  translate: number;
  rotateDegrees: number;
  scale: number;
}

export interface ViewportCallbacks {
  onSelect(entityId: string | null, additive: boolean): void;
  onSelectMany(ids: string[], additive: boolean): void;
  onCommitTransforms(entries: Array<{ entityId: string; transform: Transform }>): void;
  onMarquee?(rect: { x: number; y: number; width: number; height: number } | null): void;
  onDragStateChange?(dragging: boolean): void;
  onWarning?(message: string): void;
  /** Reported after a model finishes loading so the inspector can list its clips. */
  onModelLoaded?(entityId: string, clips: string[]): void;
  /** Reported when a model could not be loaded, with the reason. */
  onModelFailed?(entityId: string, message: string): void;
}

/**
 * Supplies model instances to the viewport. The editor implements this over the workspace
 * API; the runtime implements the same idea over its own asset cache, so an entity looks the
 * same in both.
 */
export interface ViewportAssetProvider {
  instantiate(assetId: string): Promise<ModelInstance>;
  clipsFor(assetId: string): string[] | null;
  loadTexture(assetId: string, options: { colorSpace: 'srgb' | 'linear' }): Promise<THREE.Texture>;
}

export interface ViewportOptions extends ViewportCallbacks {
  canvas: HTMLCanvasElement;
  container: HTMLElement;
}

/** What the editor viewport drew, for the status bar and for automated checks. */
export interface ViewportStats {
  entities: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  geometries: number;
  /** Primitives drawn through a shared `InstancedMesh` rather than their own call. */
  instancedPrimitives: number;
}

interface EntityProjection {
  object: THREE.Group;
  /** Component signature last projected, so property edits rebuild only what changed. */
  signature: string;
  entity: Entity;
  /** Loaded model instance for this entity, when it has a model component. */
  model: ModelInstance | null;
  /** Preview playback for the entity's animation component. */
  animation: AnimationController | null;
  /** Asset id the pending load belongs to, so a changed asset reloads. */
  pendingAssetId: string | null;
  /** True once a load failed, to avoid retrying every sync. */
  failed: boolean;
  textures: MaterialTextures;
  textureKey: string;
}

const EDITOR_ONLY = 'editorOnly';
const MATERIAL_TEXTURE_PROPERTIES = ['map', 'normalMap', 'emissiveMap'] as const;
function materialTextureKey(component: MaterialComponent): string {
  return MATERIAL_TEXTURE_PROPERTIES.map((slot) => component[slot] ?? '').join('|');
}

/**
 * The editor's own colours in the 3D layer.
 *
 * The DOM port left these behind: the CSS tokens became strictly neutral while the scene
 * background, the grid, the editor fill light, the selection box, and the collider outlines were
 * still the old blue-cast palette, which made the viewport the one place the editor still showed a
 * hue it had retired.
 *
 * They are literals rather than tokens because these are `THREE.Color` and `THREE.GridHelper`
 * arguments, not CSS the token layer can reach.
 *
 * ## What is deliberately *not* neutral here
 *
 * The transform gizmo. `TransformControls` draws its own red/green/blue axes and offers no way to
 * restyle them, and those colours are a convention every 3D tool shares — an X axis that is not red
 * is a worse problem than a chromatic pixel. Given that, the useful move is the opposite of forcing
 * it: neutralise everything else so the gizmo is the only thing in the viewport permitted a hue,
 * and it reads as the tool rather than as one more coloured element.
 */
const SCENE = {
  /** Above the panel, so the viewport reads as a lifted surface rather than a hole in the shell. */
  background: '#1c1c1c',
  /** Two steps: major grid lines are visible, minor ones are a texture rather than a ruling. */
  gridMajor: '#3d3d3d',
  gridMinor: '#2a2a2a',
  /**
   * The fill that keeps an unlit document authorable.
   *
   * Pure grey. A tinted fill would be a lie about the document: these lights are editor-only and
   * Play mode uses the document's own, so anything they add is colour the author did not choose and
   * will not see in the game.
   */
  fillSky: '#b4b4b4',
  fillGround: '#3a3a3a',
  /** The key light is white for the same reason: it is light, not paint. */
  fillKey: '#ffffff',
  /** The selection box, at the brightest neutral available so it reads against any document. */
  selection: '#f0f0f0',
  /** Collider wireframes: visible as an overlay, quiet enough not to compete with the geometry. */
  collider: '#9a9a9a',
  /** A sensor collider. Distinguished by opacity rather than hue — see the call site. */
  colliderSensor: '#6e6e6e',
} as const;

/**
 * The editor's default field of view, and the world height an orthographic view shows.
 *
 * The orthographic frustum is derived from a *height* rather than a width so that switching
 * projection keeps the visible vertical extent: the view zooms by the same amount in both, and the
 * framing does not jump when the projection changes.
 */
const FIELD_OF_VIEW = 55;
const ORTHO_HEIGHT = 12;

/**
 * How far the camera turns per pixel dragged on the view gizmo.
 *
 * Close to `OrbitControls`' own `2π / elementHeight` for a typical stage, so a drag on the ball and a
 * drag on the stage turn the view at a similar rate rather than the gizmo feeling like a different
 * instrument.
 */
const ORBIT_RADIANS_PER_PIXEL = 0.01;

/**
 * How close to a pole the turntable may tilt.
 *
 * At the pole the view direction is parallel to the up vector and `lookAt` has no way to choose a
 * roll — the view snaps to whatever orientation the arithmetic lands on. A third of a degree off is
 * visually straight down and numerically safe.
 */
const MIN_POLAR = 0.006;

/** How far ahead of a game camera its orbit target is placed, which is what reproduces its aim. */
const CAMERA_VIEW_TARGET = 10;

/** Within this many radians of a pole, "the opposite view" means the other pole, not a half turn. */
const OPPOSITE_POLE_THRESHOLD = 0.05;

/**
 * The world bounds of an object's *content*, ignoring everything that exists only for editing.
 *
 * `Box3.setFromObject` walks the whole subtree, and under an entity's group live things the game never
 * sees: a camera's `CameraHelper` draws its frustum out to the far plane, a collider draws its shape,
 * a light draws its cone. Framing a scene on those is catastrophic rather than untidy — with a camera
 * in the scene, Home put the editor camera 1268 metres away and the level became a speck, because the
 * bundled game cameras have far planes in the hundreds.
 *
 * So the walk is manual and skips any subtree marked `EDITOR_ONLY`, which is the marker the editor
 * already puts on every helper it adds.
 */
function expandContentBounds(object: THREE.Object3D, box: THREE.Box3): void {
  if (object.userData[EDITOR_ONLY] === true) return;
  if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
    object.geometry.computeBoundingBox();
    const local = object.geometry.boundingBox;
    if (local) box.union(local.clone().applyMatrix4(object.matrixWorld));
  }
  for (const child of object.children) expandContentBounds(child, box);
}

/** The world box of every content mesh under an object, one entry per mesh. */
function collectContentBoxes(object: THREE.Object3D, boxes: THREE.Box3[]): void {
  if (object.userData[EDITOR_ONLY] === true) return;
  if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
    object.geometry.computeBoundingBox();
    const local = object.geometry.boundingBox;
    if (local) boxes.push(local.clone().applyMatrix4(object.matrixWorld));
  }
  for (const child of object.children) collectContentBoxes(child, boxes);
}

/**
 * Below this many meshes a scene is framed on everything; above it, backdrops are left out.
 *
 * A level's sea, sky box or ground slab is one mesh many times the size of anything the player
 * drives on, and framing the union of both puts the camera where the level is a thin line across a
 * dark plane. With enough meshes the median size is a fair reading of "the level", and anything
 * dwarfing it is scenery to look past, not at.
 */
const BACKDROP_MIN_MESHES = 8;
const BACKDROP_RATIO = 8;

function contentBoundsWithoutBackdrops(object: THREE.Object3D): THREE.Box3 {
  const boxes: THREE.Box3[] = [];
  collectContentBoxes(object, boxes);
  const size = new THREE.Vector3();
  const diagonals = boxes.map((box) => box.getSize(size).length()).sort((a, b) => a - b);
  const box = new THREE.Box3();
  if (boxes.length >= BACKDROP_MIN_MESHES) {
    const median = diagonals[Math.floor(diagonals.length / 2)] ?? 0;
    const limit = median * BACKDROP_RATIO;
    for (const candidate of boxes) if (candidate.getSize(size).length() <= limit) box.union(candidate);
  }
  if (box.isEmpty()) for (const candidate of boxes) box.union(candidate);
  return box;
}

/** Build a camera in the requested projection, at the editor's default framing. */
function createCamera(projection: ProjectionKind): EditorCamera {
  if (projection === 'orthographic') {
    const halfHeight = ORTHO_HEIGHT / 2;
    const camera = new THREE.OrthographicCamera(-halfHeight, halfHeight, halfHeight, -halfHeight, 0.05, 2000);
    camera.position.set(7, 5.5, 9);
    return camera;
  }
  return new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 0.05, 2000);
}

/**
 * Fit a camera to the canvas.
 *
 * The two projections need different work: perspective takes an aspect ratio, orthographic takes a
 * rebuilt frustum. Both end in `updateProjectionMatrix`, and both are needed on every resize.
 */
function fitCamera(
  camera: EditorCamera,
  width: number,
  height: number,
  frustumHeight = ORTHO_HEIGHT,
): void {
  if (camera instanceof THREE.OrthographicCamera) {
    const halfHeight = frustumHeight / 2;
    const aspect = width / height;
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
  } else {
    camera.aspect = width / height;
  }
  camera.updateProjectionMatrix();
}

/**
 * The editor camera, in either projection.
 *
 * Both are `THREE.Camera`s, which is all the raycaster, the renderer, and `OrbitControls` need. What
 * they do *not* share is `fov` — an orthographic camera has none — so anything that reasons about
 * the field of view has to branch rather than reach for the property. This union is what makes that
 * branch a compile error to forget instead of a silent `undefined`.
 */
export type EditorCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

/** A point in CSS pixels. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** A size in CSS pixels. Shared by the controller, the viewport handle, and overlays. */
export interface CanvasSize {
  width: number;
  height: number;
}

/** Which projection a camera provides. */
export type ProjectionKind = 'perspective' | 'orthographic';

/**
 * Everything that places the editor camera, as plain numbers so it can be stored and restored.
 *
 * `zoom` is the orthographic dolly: `OrbitControls` zooms an orthographic camera by scaling its
 * frustum rather than moving it, so position and target alone would restore a top view at the wrong
 * magnification. `fov` is the perspective lens, `null` for an orthographic camera, which has none.
 */
export interface CameraBookmark {
  projection: ProjectionKind;
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  zoom: number;
  fov: number | null;
}

/**
 * The six directions the view gizmo can look from.
 *
 * Named after the axis and the side rather than after Blender's Front/Back/Top/Bottom vocabulary:
 * which world axis is "front" depends on the engine's convention, and this editor's is the
 * document's — +Z is toward the viewer in the default framing, but nothing enforces that a game
 * faces that way, so the gizmo labels the axis it will actually look along.
 */
export type ViewFace = { axis: 'x' | 'y' | 'z'; sign: 1 | -1 };

/**
 * The camera's world-space orientation, as the view gizmo reads it.
 *
 * A named contract rather than three loose tuples at each end: the gizmo and the controller are two
 * files that have to agree on the order and meaning of these vectors, and the one that is easy to get
 * wrong — `forward` points the way the camera looks, so a direction aimed *at* the viewer has a
 * negative dot product with it — is worth spelling out once.
 */
/**
 * A camera's field of view and its clipping planes.
 *
 * Named rather than repeated inline because it crosses three layers: the authored camera component's
 * values, `enterCameraView`, and the `cameraPlanes` read-back. The parameter here used to be a bare
 * `fov: number`, and that is exactly how the clipping planes came to be dropped — a shape with a name
 * is harder to half-pass.
 */
export interface CameraPlanes {
  fov: number;
  near: number;
  far: number;
}

export interface CameraBasis {
  right: [number, number, number];
  up: [number, number, number];
  forward: [number, number, number];
}

export class EditorViewport {
  readonly scene = new THREE.Scene();
  /**
   * The active camera.
   *
   * Mutable because switching projection replaces it: `OrbitControls` and `TransformControls` each
   * capture the camera they were constructed with, so a swap has to rebuild them rather than assign
   * a new one and hope. See `setProjection`.
   */
  camera: EditorCamera;

  private readonly canvas: HTMLCanvasElement;
  private readonly container: HTMLElement;
  private readonly callbacks: ViewportCallbacks;
  readonly renderer: THREE.WebGLRenderer;
  private orbit: OrbitControls;
  private transform: TransformControls;
  /** Kept here because a projection switch rebuilds `TransformControls`, which starts in world space. */
  private space: TransformSpace = 'world';
  /** The projection currently in use, so a resize knows which camera to refit. */
  private project: ProjectionKind = 'perspective';
  /**
   * The framing to restore when the game camera's view is left, or null when not in it.
   *
   * Held here rather than in the shell because it is all camera state — position, up, target,
   * projection, fov — and every one of those is the viewport's to own.
   */
  private cameraView: {
    position: THREE.Vector3;
    up: THREE.Vector3;
    target: THREE.Vector3;
    project: ProjectionKind;
    fov: number | null;
    /** Which entity's transform the preview is following, so `sync` can keep it live. */
    entityId: string;
    /** The authored clipping and field of view, re-applied with the transform on every sync. */
    planes: CameraPlanes;
  } | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly root = new THREE.Group();
  private readonly helpers = new THREE.Group();
  private readonly grid: THREE.GridHelper;
  private readonly projections = new Map<string, EntityProjection>();
  private readonly pivot = new THREE.Group();
  private readonly selectionBox = new THREE.Box3();
  private readonly boxHelper: THREE.Box3Helper;

  private frameHandle: number | null = null;
  private running = false;
  private dragging = false;
  /** Set while a cancelled drag waits for its release, so the release records nothing. */
  private cancelPending = false;
  private pointerId = 1;
  private selection: string[] = [];
  private snap: SnapSettings = { enabled: false, translate: 0.5, rotateDegrees: 15, scale: 0.25 };
  private pointerDownAt: { x: number; y: number } | null = null;
  private marqueeStart: { x: number; y: number } | null = null;
  private marqueeActive = false;
  private pivotStart: THREE.Matrix4 | null = null;
  private readonly rootStartWorlds = new Map<string, THREE.Matrix4>();
  private disposed = false;
  private lastSyncedScene: SceneDocument | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** The last canvas size, so a render can set its own viewport without measuring the DOM. */
  private width = 1;
  private height = 1;
  private assetProvider: ViewportAssetProvider | null = null;
  private readonly environment: EnvironmentProjection;
  /** Editor-only fill, switched off once the document lights itself with an environment. */
  private readonly fillLights: THREE.Light[] = [];
  private readonly clock = new THREE.Clock();
  private readonly pendingLoads = new Map<string, number>();
  private nextLoadToken = 0;
  private readonly shading = new ShadingPass();
  /** Identical, unselected primitives folded into instanced draws; rebuilt on sync and selection. */
  private readonly batches = new PrimitiveBatches();
  private renderScale: RenderScale = 1;
  /** The user's shadow switch; the shadow map runs only when this is on *and* the view is lit. */
  private shadowsEnabled = true;
  /**
   * Whether the next frame has to be drawn.
   *
   * The loop still runs every frame — animations advance and the orbit damps there — but it draws
   * only when something asked it to or something is visibly moving. An idle editor on a large scene
   * costs nothing, and a bookmark, a sync or a resize costs one frame rather than sixty a second.
   */
  private needsRender = true;
  private readonly fly: FlyNavigator;
  /** The entities the view is isolated to, with their ancestors; null shows everything. */
  private isolatedIds: Set<string> | null = null;
  private isolatedRoots: string[] = [];
  /** The scene the camera has been framed for, so a fresh scene opens on its contents and a re-sync does not move the camera. */
  private framedSceneId: string | null = null;

  constructor(options: ViewportOptions) {
    this.canvas = options.canvas;
    this.container = options.container;
    this.callbacks = options;

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(this.pixelRatioFor(this.renderScale));
    this.renderer.shadowMap.enabled = this.shadowsEnabled && this.shading.usesShadows();
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.scene.background = new THREE.Color(SCENE.background);
    this.environment = new EnvironmentProjection(this.renderer, this.scene);

    this.camera = createCamera('perspective');
    this.camera.position.set(7, 5.5, 9);
    // Batched primitives keep their own mesh on a layer no camera draws; picking still has to see it.
    this.raycaster.layers.enable(BATCHED_LAYER);

    this.orbit = new OrbitControls(this.camera, this.canvas);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.target.set(0, 0.5, 0);
    this.orbit.screenSpacePanning = true;
    // Trackpad-friendly: left drag orbits, right drag pans, wheel/magnify zooms.
    this.orbit.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.orbit.addEventListener('change', this.invalidate);
    this.fly = new FlyNavigator(this.canvas, () => ({ camera: this.camera, orbit: this.orbit }), this.invalidate);

    this.grid = new THREE.GridHelper(60, 60, new THREE.Color(SCENE.gridMajor), new THREE.Color(SCENE.gridMinor));
    this.grid.userData[EDITOR_ONLY] = true;
    this.helpers.add(this.grid);

    // Editor-only fill light so an unlit document is still authorable. Play mode uses the
    // document's own lights through the runtime, so this never affects gameplay.
    const editorAmbient = new THREE.HemisphereLight(SCENE.fillSky, SCENE.fillGround, 0.55);
    editorAmbient.userData[EDITOR_ONLY] = true;
    const editorKey = new THREE.DirectionalLight(SCENE.fillKey, 0.85);
    editorKey.position.set(6, 10, 6);
    editorKey.userData[EDITOR_ONLY] = true;
    this.helpers.add(editorAmbient, editorKey);
    this.fillLights.push(editorAmbient, editorKey);

    this.scene.add(this.root, this.helpers);
    this.pivot.userData[EDITOR_ONLY] = true;
    this.scene.add(this.pivot);

    this.transform = new TransformControls(this.camera, this.canvas);
    this.transform.setSize(0.9);
    this.transform.addEventListener('dragging-changed', this.handleDraggingChanged);
    this.transform.addEventListener('objectChange', this.handleTransformObjectChange);
    this.transform.addEventListener('mouseUp', this.handleTransformCommit);
    this.transform.addEventListener('change', this.invalidate);
    const helper = this.transform.getHelper();
    helper.userData[EDITOR_ONLY] = true;
    this.scene.add(helper);

    this.boxHelper = new THREE.Box3Helper(this.selectionBox, new THREE.Color(SCENE.selection));
    this.boxHelper.visible = false;
    this.boxHelper.userData[EDITOR_ONLY] = true;
    this.scene.add(this.boxHelper);

    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('pointercancel', this.handlePointerCancel);

    this.observeResize();
  }

  // ------------------------------------------------------------------ lifecycle

  start(): void {
    if (this.disposed || this.running) return;
    this.running = true;
    this.renderLoop();
  }

  stop(): void {
    this.running = false;
    if (this.frameHandle !== null) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
  }

  /** Hide the editor view while a runtime world is playing on another canvas. */
  suspend(): void {
    this.stop();
    this.transform.detach();
    this.canvas.style.visibility = 'hidden';
  }

  resume(): void {
    this.canvas.style.visibility = 'visible';
    this.start();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.batches.dispose();
    for (const projection of this.projections.values()) this.disposeProjectionChildren(projection);
    this.stop();
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerCancel);
    this.transform.removeEventListener('dragging-changed', this.handleDraggingChanged);
    this.transform.removeEventListener('objectChange', this.handleTransformObjectChange);
    this.transform.removeEventListener('mouseUp', this.handleTransformCommit);
    this.transform.removeEventListener('change', this.invalidate);
    this.transform.detach();
    this.transform.dispose();
    this.orbit.removeEventListener('change', this.invalidate);
    this.orbit.dispose();
    this.fly.dispose();
    this.shading.dispose();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    disposeSceneResources(this.root);
    this.boxHelper.geometry.dispose();
    if (this.boxHelper.material instanceof THREE.Material) this.boxHelper.material.dispose();
    this.environment.dispose();
    this.scene.clear();
    this.renderer.dispose();
  }

  // ------------------------------------------------------------------ projection

  /** Project the authored scene into the viewport, creating/updating/removing as needed. */
  sync(scene: SceneDocument): void {
    this.lastSyncedScene = scene;
    this.needsRender = true;
    if (this.isolatedIds) this.isolatedIds = isolationSet(scene, this.isolatedRoots);
    this.batches.clear();
    const seen = new Set<string>();
    for (const entity of scene.entities) {
      seen.add(entity.id);
      this.syncEntity(entity);
    }
    // Deleting the entry being visited is well defined for a Map iterator, so no copy is needed.
    for (const [id, projection] of this.projections) {
      if (seen.has(id)) continue;
      this.disposeProjectionChildren(projection);
      projection.object.removeFromParent();
      disposeSceneResources(projection.object);
      this.projections.delete(id);
    }
    // Attach in a second pass: parents may appear after their children.
    for (const entity of scene.entities) {
      const projection = this.projections.get(entity.id);
      if (!projection) continue;
      const parentProjection = entity.parentId === null ? null : this.projections.get(entity.parentId);
      const desiredParent: THREE.Object3D = parentProjection ? parentProjection.object : this.root;
      if (projection.object.parent !== desiredParent) desiredParent.add(projection.object);
      // Sibling order in the document drives render order and the hierarchy listing.
      projection.object.renderOrder = entity.order;
    }
    this.environment.apply(scene.environment);
    if (scene.environment.background.type === 'none') this.scene.background = new THREE.Color(SCENE.background);
    this.updateFillLights();
    this.rebuildBatches();
    this.updateSelectionHelper();
    this.attachTransform();
    /**
     * A scene opens framed on its contents. The default camera stands seven metres from the origin,
     * which is a fine place to start an empty scene and a bad place to start inside a racetrack.
     */
    if (this.framedSceneId !== scene.id) {
      this.framedSceneId = scene.id;
      if (scene.entities.length > 0) this.frameAll();
    }
    /**
     * Last, because it reads the transforms just written.
     *
     * While the game camera's view is held, this is what keeps it a view of the camera the game would
     * use *now*: moving the camera in the inspector, reparenting it, or editing an ancestor updates
     * the projection here, and without this the preview would keep showing where the camera used to
     * be until the user left and re-entered.
     */
    if (this.cameraView) this.applyCameraView(this.cameraView.planes);
  }

  private syncEntity(entity: Entity): void {
    const signature = JSON.stringify(entity.components);
    let projection = this.projections.get(entity.id);
    if (!projection) {
      projection = {
        object: new THREE.Group(),
        signature: '',
        entity,
        model: null,
        animation: null,
        pendingAssetId: null,
        failed: false,
        textures: {},
        textureKey: '',
      };
      projection.object.name = entity.name;
      projection.object.userData.entityId = entity.id;
      this.projections.set(entity.id, projection);
    }
    projection.entity = entity;
    projection.object.name = entity.name;

    if (projection.signature !== signature) {
      // Rebuild the entity's visual children; the group itself stays put so selection and
      // transform controls are not disturbed by a property edit.
      this.disposeProjectionChildren(projection);
      this.projectComponents(projection, entity);
      projection.signature = signature;
    }

    const modelComponent = entity.components.find((component) => component.type === 'model');
    const wantedAssetId = modelComponent?.type === 'model' ? modelComponent.assetId : null;
    if (wantedAssetId !== projection.pendingAssetId) {
      projection.failed = false;
    }
    if (wantedAssetId && !projection.model && !projection.failed && projection.pendingAssetId !== wantedAssetId) {
      this.loadModelFor(projection, wantedAssetId);
    } else if (!wantedAssetId && projection.model) {
      // The model component went away: drop the instance, keep everything else.
      this.disposeProjectionModel(projection);
    }

    this.syncProjectionAnimation(projection, entity);

    const { position, rotation, scale } = entity.transform;
    projection.object.position.set(position[0], position[1], position[2]);
    projection.object.quaternion.set(rotation[0], rotation[1], rotation[2], rotation[3]).normalize();
    projection.object.scale.set(scale[0], scale[1], scale[2]);
    projection.object.visible =
      entity.enabled && entity.editor.visible && (this.isolatedIds === null || this.isolatedIds.has(entity.id));
  }

  /**
   * The editor's own fill shines when the document has no lighting of its own, and always in the
   * solid view, which draws every scene under the same studio light by design.
   */
  /**
   * Fold every identical, showing, unselected primitive into an instanced draw.
   *
   * Selected entities (and their descendants) stay on their own meshes so the transform gizmo moves
   * what the user sees; everything else in a racetrack is a few shapes repeated a thousand times.
   */
  private rebuildBatches(): void {
    const selected = new Set(this.selection);
    const members: BatchMember[] = [];
    this.root.updateMatrixWorld(true);
    for (const projection of this.projections.values()) {
      if (!this.isEffectivelyVisible(projection.object) || this.hasSelectedAncestor(projection.entity, selected)) continue;
      const key = primitiveBatchKey(projection.entity);
      if (key === null) continue;
      const mesh = projection.object.children.find(isPrimitiveMesh);
      if (!mesh) continue;
      members.push({ key, mesh });
    }
    this.batches.rebuild(members, this.root);
    for (const child of this.root.children) {
      if (child instanceof THREE.InstancedMesh) child.userData[EDITOR_ONLY] = true;
    }
  }

  private hasSelectedAncestor(entity: Entity, selected: ReadonlySet<string>): boolean {
    for (let current: Entity | undefined = entity; current; ) {
      if (selected.has(current.id)) return true;
      current = current.parentId === null ? undefined : this.projections.get(current.parentId)?.entity;
    }
    return false;
  }

  private updateFillLights(): void {
    const lighting = this.lastSyncedScene?.environment.lighting.type ?? 'none';
    const visible = lighting === 'none' || !this.shading.usesSceneLights();
    for (const light of this.fillLights) light.visible = visible;
  }

  // ------------------------------------------------------------------ isolation

  /**
   * Show only these entities (and what they contain), or everything again with null.
   *
   * A display state, not a document edit: the authored `editor.visible` flags are untouched, so
   * leaving isolation restores exactly what was showing before.
   */
  setIsolation(entityIds: readonly string[] | null): void {
    if (entityIds === null || entityIds.length === 0) {
      if (this.isolatedIds === null) return;
      this.isolatedIds = null;
      this.isolatedRoots = [];
    } else {
      this.isolatedRoots = [...entityIds];
      this.isolatedIds = this.lastSyncedScene ? isolationSet(this.lastSyncedScene, this.isolatedRoots) : new Set(entityIds);
    }
    if (this.lastSyncedScene) this.sync(this.lastSyncedScene);
    this.needsRender = true;
  }

  /** The isolated entities, or null when the whole scene shows. */
  isolation(): string[] | null {
    return this.isolatedIds ? [...this.isolatedRoots] : null;
  }

  private projectComponents(projection: EntityProjection, entity: Entity): void {
    const object = projection.object;
    // A disabled-in-game entity is still editable, but it is drawn dimmed rather than
    // hidden, so authoring an entity that is off in the game is not confusing.
    for (const component of entity.components) {
      switch (component.type) {
        case 'primitive': {
          const mesh = createPrimitiveMesh(component);
          if (component.shape === 'plane') mesh.receiveShadow = true;
          object.add(mesh);
          break;
        }
        case 'material': {
          const mesh = object.children.find(isMesh);
          // `applyMaterial` configures standard-material fields, so a mesh that does not carry one
          // is left alone rather than written with properties it does not have.
          if (mesh && mesh.material instanceof THREE.MeshStandardMaterial) applyMaterial(mesh.material, component, projection.textures);
          break;
        }
        case 'light': {
          const light = createLight(component);
          object.add(light);
          if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) {
            light.target.position.set(0, 0, -10);
            object.add(light.target);
          }
          break;
        }
        case 'camera': {
          const camera = new THREE.PerspectiveCamera(component.fov, 16 / 9, component.near, component.far);
          const helper = new THREE.CameraHelper(camera);
          helper.userData[EDITOR_ONLY] = true;
          object.add(camera, helper);
          break;
        }
        case 'collider': {
          const outline = new THREE.Mesh(
            new THREE.BoxGeometry(component.size[0], component.size[1], component.size[2]),
            /**
             * A sensor is told apart from a solid collider by *opacity*, not by hue.
             *
             * Colour would have said "different kind of thing" in a palette whose whole premise is
             * that hue means nothing; a paler wire is the same statement in the language the rest of
             * the viewport speaks, and it maps onto what a sensor is — a boundary that does not stop
             * anything.
             */
            new THREE.MeshBasicMaterial({
              color: new THREE.Color(component.isSensor ? SCENE.colliderSensor : SCENE.collider),
              wireframe: true,
              transparent: true,
              opacity: component.isSensor ? 0.22 : 0.38,
            }),
          );
          outline.position.set(component.offset[0], component.offset[1], component.offset[2]);
          outline.userData[EDITOR_ONLY] = true;
          outline.name = 'collider-outline';
          outline.visible = false;
          object.add(outline);
          break;
        }
        case 'model': {
          // The instance is attached asynchronously; until then show a loading marker so the
          // object is still selectable and its absence is visible.
          const marker = new THREE.Mesh(
            new THREE.BoxGeometry(0.6, 0.6, 0.6),
            new THREE.MeshBasicMaterial({ color: new THREE.Color(SCENE.collider), wireframe: true, transparent: true, opacity: 0.6 }),
          );
          marker.userData[EDITOR_ONLY] = true;
          marker.name = 'model-loading';
          object.add(marker);
          break;
        }
        case 'animation':
          // Playback is attached once the model instance exists (see syncProjectionAnimation).
          break;
        case 'audio':
        case 'behavior':
          // Neither draws anything: behaviors are instantiated by the behavior runtime in Play,
          // and audio plays when a behavior or the audio system asks for it.
          break;
        default:
          break;
      }
    }
    const material = entity.components.find((component) => component.type === 'material');
    if (material?.type === 'material') {
      const key = materialTextureKey(material);
      const missing = MATERIAL_TEXTURE_PROPERTIES.some((slot) => material[slot] !== null && !projection.textures[slot]);
      if (key !== projection.textureKey || missing) void this.loadTexturesFor(projection, material, key);
    }
  }

  setAssetProvider(provider: ViewportAssetProvider | null): void {
    this.assetProvider = provider;
  }

  invalidateAsset(assetId: string): void {
    if (this.disposed) return;
    for (const projection of this.projections.values()) {
      const hasModel = projection.entity.components.some(
        (component) => component.type === 'model' && component.assetId === assetId,
      );
      const hasTexture = projection.entity.components.some(
        (component) =>
          component.type === 'material' &&
          (component.map === assetId || component.normalMap === assetId || component.emissiveMap === assetId),
      );
      if (!hasModel && !hasTexture) continue;
      if (hasModel) this.pendingLoads.delete(`${projection.entity.id}:${assetId}`);
      if (hasTexture && projection.textureKey) this.pendingLoads.delete(`${projection.entity.id}:${projection.textureKey}`);
      if (hasModel) this.disposeProjectionModel(projection);
      projection.pendingAssetId = null;
      projection.failed = false;
      projection.textures = {};
      projection.textureKey = '';
      projection.signature = '';
    }
    if (this.lastSyncedScene) this.sync(this.lastSyncedScene);
  }

  private async loadModelFor(projection: EntityProjection, assetId: string): Promise<void> {
    const provider = this.assetProvider;
    projection.pendingAssetId = assetId;
    if (!provider) return;
    const key = `${projection.entity.id}:${assetId}`;
    if (this.pendingLoads.has(key)) return;
    const loadToken = ++this.nextLoadToken;
    this.pendingLoads.set(key, loadToken);
    try {
      const instance = await provider.instantiate(assetId);
      // The projection may have been rebuilt or removed while the load was in flight.
      const current = this.projections.get(projection.entity.id);
      if (
        this.pendingLoads.get(key) !== loadToken ||
        !current ||
        current !== projection ||
        current.pendingAssetId !== assetId ||
        this.disposed
      )
        return;
      this.disposeProjectionModel(current);
      current.model = instance;
      current.object.add(instance.object);
      this.needsRender = true;
      const clipNames = instance.clips.map((clip, index) => clip.name || `clip-${index}`);
      this.callbacks.onModelLoaded?.(projection.entity.id, clipNames);
      this.syncProjectionAnimation(current, current.entity);
    } catch (error) {
      const current = this.projections.get(projection.entity.id);
      if (this.pendingLoads.get(key) !== loadToken) return;
      if (current && current === projection) current.failed = true;
      const message = error instanceof Error ? error.message : String(error);
      this.callbacks.onModelFailed?.(projection.entity.id, message);
      this.callbacks.onWarning?.(message);
    } finally {
      if (this.pendingLoads.get(key) === loadToken) this.pendingLoads.delete(key);
    }
  }

  private async loadTexturesFor(projection: EntityProjection, component: MaterialComponent, key: string): Promise<void> {
    const provider = this.assetProvider;
    projection.textureKey = key;
    if (!provider) return;
    const pendingKey = `${projection.entity.id}:${key}`;
    if (this.pendingLoads.has(pendingKey)) return;
    const loadToken = ++this.nextLoadToken;
    this.pendingLoads.set(pendingKey, loadToken);
    try {
      const textures = await loadMaterialTextures(provider, component);
      const current = this.projections.get(projection.entity.id);
      if (
        this.pendingLoads.get(pendingKey) !== loadToken ||
        !current ||
        current !== projection ||
        this.disposed ||
        current.textureKey !== key
      )
        return;
      current.textures = textures;
      const mesh = current.object.children.find(isMesh);
      const material = current.entity.components.find((candidate) => candidate.type === 'material');
      if (mesh && mesh.material instanceof THREE.MeshStandardMaterial && material?.type === 'material') {
        applyMaterial(mesh.material, material, textures);
        this.needsRender = true;
      }
    } catch (error) {
      this.callbacks.onWarning?.(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.pendingLoads.get(pendingKey) === loadToken) this.pendingLoads.delete(pendingKey);
    }
  }

  private syncProjectionAnimation(projection: EntityProjection, entity: Entity): void {
    const component = entity.components.find((candidate) => candidate.type === 'animation');
    if (!component || component.type !== 'animation' || !projection.model) {
      if (projection.animation && (!component || component.type !== 'animation')) {
        projection.animation.dispose();
        projection.animation = null;
      }
      return;
    }
    if (!projection.animation) {
      projection.animation = new AnimationController(projection.model.object, projection.model.clips, component);
    } else {
      projection.animation.setPlaying(component.playing);
      projection.animation.setLoop(component.loop);
      projection.animation.setSpeed(component.speed);
      if (projection.animation.currentClip !== (component.clip ?? projection.animation.clipNames[0] ?? null)) {
        projection.animation.play(component.clip);
      }
    }
  }

  private disposeProjectionModel(projection: EntityProjection): void {
    projection.animation?.dispose();
    projection.animation = null;
    if (!projection.model) return;
    // The instance shares geometry and textures with the cached source; only the
    // per-instance materials and cloned skeleton belong to this projection.
    for (const material of projection.model.materials) material.dispose();
    disposeSkeletons(projection.model.object);
    projection.object.remove(projection.model.object);
    projection.model = null;
    projection.pendingAssetId = null;
  }

  private disposeProjectionChildren(projection: EntityProjection): void {
    projection.animation?.dispose();
    projection.animation = null;
    // Removing a child splices `children`, so the pass runs over a copy of the current list.
    for (const child of projection.object.children.slice()) {
      if (projection.model && child === projection.model.object) continue;
      projection.object.remove(child);
      disposeSceneResources(child);
    }
    if (projection.model) {
      for (const material of projection.model.materials) material.dispose();
      disposeSkeletons(projection.model.object);
      projection.object.remove(projection.model.object);
      projection.model = null;
    }
    projection.pendingAssetId = null;
  }

  /** Entity ids whose projection could not be built (used by tests and the console). */
  unsupportedComponents(): string[] {
    const result: string[] = [];
    for (const [id, projection] of this.projections) {
      if (projection.object.children.some((child) => child.name.startsWith('unsupported:'))) result.push(id);
    }
    return result;
  }

  /** Re-apply component mapping after a component was added or changed outside `sync`. */
  refreshEntity(scene: SceneDocument, entityId: string): void {
    const entity = scene.entities.find((candidate) => candidate.id === entityId);
    if (!entity) return;
    const projection = this.projections.get(entityId);
    if (projection) projection.signature = '';
    this.sync(scene);
  }

  // ------------------------------------------------------------------ selection

  setSelection(entityIds: readonly string[]): void {
    this.selection = [...entityIds];
    this.rebuildBatches();
    this.attachTransform();
    this.updateSelectionHelper();
    this.needsRender = true;
  }

  /**
   * Bind the transform controls to the current selection.
   *
   * Split out because a projection switch rebuilds `TransformControls`, and the rebuilt one starts
   * detached — without re-running this, changing projection would silently drop the gizmo from the
   * selected object.
   */
  private attachTransform(): void {
    if (this.selection.length === 1) {
      const object = this.projections.get(this.selection[0]!)?.object;
      if (object) {
        this.transform.attach(object);
        return;
      }
    }
    if (this.selection.length > 1) {
      const parentOf = (id: string): string | null =>
        this.lastSyncedScene?.entities.find((entity) => entity.id === id)?.parentId ?? null;
      const roots = selectionRoots(this.selection, parentOf);
      const objects = roots.map((id) => this.projections.get(id)?.object).filter((object): object is THREE.Group => Boolean(object));
      if (objects.length > 0) {
        const center = new THREE.Vector3();
        for (const object of objects) {
          object.updateWorldMatrix(true, false);
          center.add(new THREE.Vector3().setFromMatrixPosition(object.matrixWorld));
        }
        center.multiplyScalar(1 / objects.length);
        this.pivot.position.copy(center);
        this.pivot.quaternion.identity();
        if (this.space === 'local') {
          const primary = this.projections.get(this.selection[0]!)?.object ?? objects[0]!;
          primary.getWorldQuaternion(this.pivot.quaternion);
        }
        this.pivot.scale.setScalar(1);
        this.pivot.updateMatrixWorld(true);
        this.transform.attach(this.pivot);
        return;
      }
    }
    this.transform.detach();
  }

  private updateSelectionHelper(): void {
    if (this.selection.length === 0) {
      this.boxHelper.visible = false;
      return;
    }
    this.selectionBox.makeEmpty();
    for (const id of this.selection) {
      const object = this.projections.get(id)?.object;
      if (!object) continue;
      this.selectionBox.union(this.entityBounds(object));
    }
    if (this.selectionBox.isEmpty()) {
      this.boxHelper.visible = false;
      return;
    }
    this.boxHelper.box.copy(this.selectionBox);
    this.boxHelper.visible = true;
  }

  // ------------------------------------------------------------------ tools

  setTool(tool: TransformTool): void {
    this.transform.setMode(tool);
  }

  setSpace(space: TransformSpace): void {
    if (space === this.space) return;
    this.space = space;
    this.transform.setSpace(space);
    /** The group pivot's orientation depends on the space, so it is re-derived rather than kept. */
    this.attachTransform();
  }

  transformSpace(): TransformSpace {
    return this.space;
  }

  /**
   * The current framing, in a form that survives a reload. The field of view travels with it: the
   * game camera's view swaps in the authored fov, and a bookmark taken there must reproduce that
   * framing, not the editor's default lens at the same position.
   */
  cameraBookmark(): CameraBookmark {
    const { position, up } = this.camera;
    const { target } = this.orbit;
    return {
      projection: this.project,
      position: [position.x, position.y, position.z],
      target: [target.x, target.y, target.z],
      up: [up.x, up.y, up.z],
      zoom: this.camera.zoom,
      fov: this.camera instanceof THREE.PerspectiveCamera ? this.camera.fov : null,
    };
  }

  /**
   * Restore a saved framing. Leaves the game camera's view first, like every other view command,
   * and rebuilds the camera when the bookmark's projection differs from the current one.
   */
  applyCameraBookmark(bookmark: CameraBookmark): void {
    this.exitCameraView();
    this.replaceCamera(bookmark.projection);
    this.camera.position.set(...bookmark.position);
    this.camera.up.set(...bookmark.up);
    this.orbit.target.set(...bookmark.target);
    this.camera.zoom = bookmark.zoom;
    if (bookmark.fov !== null && this.camera instanceof THREE.PerspectiveCamera) this.camera.fov = bookmark.fov;
    this.camera.lookAt(this.orbit.target);
    this.camera.updateProjectionMatrix();
    this.orbit.update();
    this.resize();
    this.renderNow();
  }

  setSnap(snap: SnapSettings): void {
    this.snap = { ...snap };
    this.transform.setTranslationSnap(snap.enabled ? snap.translate : null);
    this.transform.setRotationSnap(snap.enabled ? THREE.MathUtils.degToRad(snap.rotateDegrees) : null);
    this.transform.setScaleSnap(snap.enabled ? snap.scale : null);
  }

  setColliderOutlinesVisible(visible: boolean): void {
    for (const projection of this.projections.values()) {
      for (const child of projection.object.children) {
        if (child.name === 'collider-outline') child.visible = visible;
      }
    }
    this.needsRender = true;
  }

  focusSelection(): void {
    if (this.selection.length === 1) {
      const object = this.projections.get(this.selection[0]!)?.object;
      if (object) this.frame(object);
      return;
    }
    if (this.selection.length > 1) {
      const box = new THREE.Box3();
      for (const id of this.selection) {
        const object = this.projections.get(id)?.object;
        if (object) box.union(this.entityBounds(object));
      }
      this.frameBox(box);
      return;
    }
    this.frame(this.root);
  }

  /**
   * Frame an object: put the orbit target on it and stand back far enough to see all of it.
   *
   * Shared by `focusSelection` and `frameAll`, which differ only in what they pass — the selection,
   * or the whole scene root. The distance formula is the part worth not duplicating, because it is
   * the part with the trigonometry in it.
   */
  private frame(object: THREE.Object3D): void {
    this.frameBox(this.entityBounds(object));
  }

  private entityBounds(object: THREE.Object3D): THREE.Box3 {
    object.updateWorldMatrix(true, true);
    const box = new THREE.Box3();
    expandContentBounds(object, box);
    if (box.isEmpty()) box.expandByPoint(new THREE.Vector3().setFromMatrixPosition(object.matrixWorld));
    return box;
  }

  private isEffectivelyVisible(object: THREE.Object3D): boolean {
    for (let current: THREE.Object3D | null = object; current !== null; current = current.parent) {
      if (!current.visible) return false;
      if (current === this.scene) break;
    }
    return true;
  }

  private frameBox(box: THREE.Box3): void {
    this.exitCameraView();
    this.needsRender = true;
    if (box.isEmpty()) {
      this.orbit.target.set(0, 0.5, 0);
      return;
    }
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    /**
     * How far back to stand so the sphere fits.
     *
     * A perspective camera needs trigonometry — the distance at which its field of view spans the
     * sphere — and an orthographic one does not, because its visible height is fixed regardless of
     * distance. Both branches exist because `fov` is the one property the two do not share.
     */
    const distance =
      this.camera instanceof THREE.OrthographicCamera
        ? Math.max(2.5, sphere.radius * 2.4)
        : Math.max(2.5, sphere.radius / Math.tan((this.camera.fov * Math.PI) / 360) + 1.5);
    const direction = new THREE.Vector3().subVectors(this.camera.position, this.orbit.target).normalize();
    this.orbit.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(direction, distance * 1.4);
    /**
     * A kilometre-scale level frames from further away than the default far plane reaches, and a
     * camera that clips everything it was just pointed at shows only sky. Push the plane out to cover
     * the far side of the sphere with room to orbit; it is never pulled back in, so nothing already
     * visible disappears.
     */
    const reach = (distance * 1.4 + sphere.radius) * 2;
    if (this.camera.far < reach) {
      this.camera.far = reach;
      this.camera.updateProjectionMatrix();
    }
    this.orbit.update();
    this.renderNow();
  }

  getTool(): TransformTool {
    return this.transform.mode;
  }

  isDragging(): boolean {
    return this.dragging;
  }

  // ------------------------------------------------------------------ input

  private handleDraggingChanged = (event: { value: unknown }): void => {
    this.dragging = Boolean(event.value);
    if (this.dragging && this.selection.length > 1) {
      const parentOf = (id: string): string | null =>
        this.lastSyncedScene?.entities.find((entity) => entity.id === id)?.parentId ?? null;
      this.rootStartWorlds.clear();
      this.pivot.updateMatrixWorld(true);
      this.pivotStart = this.pivot.matrixWorld.clone();
      for (const id of selectionRoots(this.selection, parentOf)) {
        const object = this.projections.get(id)?.object;
        if (!object) continue;
        object.updateWorldMatrix(true, false);
        this.rootStartWorlds.set(id, object.matrixWorld.clone());
      }
    } else if (!this.dragging) {
      this.pivotStart = null;
      this.rootStartWorlds.clear();
    }
    /**
     * Orbit stays off while the game camera's view is held.
     *
     * A transform drag releases with `enabled = true`, which handed the canvas back to OrbitControls
     * while `inCameraView()` still said true — the next drag orbited away from the camera the user
     * was supposedly looking through, and the preview silently stopped being one.
     */
    this.orbit.enabled = !this.dragging && this.cameraView === null;
    this.callbacks.onDragStateChange?.(this.dragging);
  };

  private handleTransformObjectChange = (): void => {
    if (!this.dragging || !this.pivotStart || this.rootStartWorlds.size === 0) return;
    this.pivot.updateMatrixWorld(true);
    const worlds = applyPivotDelta(this.pivotStart, this.pivot.matrixWorld, this.rootStartWorlds);
    for (const [id, world] of worlds) {
      const object = this.projections.get(id)?.object;
      if (!object || !object.parent) continue;
      object.parent.updateWorldMatrix(true, false);
      const local = object.parent.matrixWorld.clone().invert().multiply(world);
      local.decompose(object.position, object.quaternion, object.scale);
    }
    this.updateSelectionHelper();
  };

  private handleTransformCommit = (): void => {
    // A cancelled drag still ends with a release; it must not become an undoable command.
    if (this.cancelPending) {
      this.cancelPending = false;
      return;
    }
    const parentOf = (id: string): string | null =>
      this.lastSyncedScene?.entities.find((entity) => entity.id === id)?.parentId ?? null;
    const ids = this.selection.length > 1 ? selectionRoots(this.selection, parentOf) : this.selection;
    const entries: Array<{ entityId: string; transform: Transform }> = [];
    for (const entityId of ids) {
      const object = this.projections.get(entityId)?.object;
      if (!object) continue;
      entries.push({
        entityId,
        transform: {
          position: [object.position.x, object.position.y, object.position.z],
          rotation: [object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w],
          scale: [object.scale.x, object.scale.y, object.scale.z],
        },
      });
    }
    if (entries.length > 0) this.callbacks.onCommitTransforms(entries);
  };

  /**
   * Cancel the drag in progress (Escape, plan §16 "drag cancellation").
   *
   * The projected transform returns to the authored document and the release that follows records
   * nothing, so an abandoned drag cannot leave a command behind. The transform controls are sent a
   * synthetic release as well, otherwise a pointer that keeps travelling before its real release
   * would move the object again.
   *
   * Returns false when no drag is in progress, so the caller can fall back to its own Escape action.
   */
  cancelDrag(scene: SceneDocument | null): boolean {
    if (!this.dragging) return false;
    this.cancelPending = true;
    this.transform.reset();
    const parentOf = (id: string): string | null =>
      scene?.entities.find((entity) => entity.id === id)?.parentId ?? null;
    const ids = this.selection.length > 1 ? selectionRoots(this.selection, parentOf) : this.selection;
    if (scene) for (const entityId of ids) this.restoreProjection(scene, entityId);
    try {
      this.canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: this.pointerId, button: 0, bubbles: true }));
    } catch {
      // The pointer may already be gone; the drag is cancelled either way.
    }
    this.dragging = false;
    /** Guarded for the same reason as `handleDraggingChanged`: camera view keeps orbit switched off. */
    this.orbit.enabled = this.cameraView === null;
    this.callbacks.onDragStateChange?.(false);
    this.attachTransform();
    return true;
  }

  /** Put the projected object back where the document says it is. */
  private restoreProjection(scene: SceneDocument, entityId: string): void {
    const entity = scene.entities.find((candidate) => candidate.id === entityId);
    const object = this.projections.get(entityId)?.object;
    if (!entity || !object) return;
    const { position, rotation, scale } = entity.transform;
    object.position.set(position[0], position[1], position[2]);
    object.quaternion.set(rotation[0], rotation[1], rotation[2], rotation[3]);
    object.scale.set(scale[0], scale[1], scale[2]);
    this.updateSelectionHelper();
  }

  private handlePointerDown = (event: PointerEvent): void => {
    this.pointerDownAt = { x: event.clientX, y: event.clientY };
    this.pointerId = event.pointerId;
    if (event.button === 0 && event.shiftKey && this.transform.axis === null) {
      this.marqueeStart = { x: event.clientX, y: event.clientY };
      this.marqueeActive = false;
      this.orbit.enabled = false;
    }
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.marqueeStart || this.dragging || this.transform.axis !== null) return;
    if (!this.marqueeActive && Math.hypot(event.clientX - this.marqueeStart.x, event.clientY - this.marqueeStart.y) <= 4) return;
    if (!this.marqueeActive) {
      this.marqueeActive = true;
      try {
        this.canvas.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture can fail when the browser has already cancelled the pointer.
      }
    }
    this.orbit.enabled = false;
    const bounds = this.container.getBoundingClientRect();
    const x = this.marqueeStart.x - bounds.left;
    const y = this.marqueeStart.y - bounds.top;
    const currentX = event.clientX - bounds.left;
    const currentY = event.clientY - bounds.top;
    this.callbacks.onMarquee?.({ x, y, width: currentX - x, height: currentY - y });
  };

  private handlePointerCancel = (event: PointerEvent): void => {
    try {
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }
    this.pointerDownAt = null;
    this.marqueeStart = null;
    if (this.marqueeActive) this.callbacks.onMarquee?.(null);
    this.marqueeActive = false;
    this.orbit.enabled = this.cameraView === null;
  };

  private handlePointerUp = (event: PointerEvent): void => {
    const down = this.pointerDownAt;
    this.pointerDownAt = null;
    const marquee = this.marqueeActive;
    this.marqueeActive = false;
    const marqueeStart = this.marqueeStart;
    this.marqueeStart = null;
    const hadMarqueeStart = marqueeStart !== null;
    try {
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }
    if (hadMarqueeStart) this.orbit.enabled = this.cameraView === null;
    if (marquee && marqueeStart) {
      const bounds = this.container.getBoundingClientRect();
      const current = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      const start = { x: marqueeStart.x - bounds.left, y: marqueeStart.y - bounds.top };
      const projected = new Map<string, { x: number; y: number }>();
      for (const [id, projection] of this.projections) {
        if (
          projection.object.userData[EDITOR_ONLY] === true ||
          !projection.entity.editor.visible ||
          projection.entity.editor.locked ||
          !projection.entity.enabled ||
          !this.isEffectivelyVisible(projection.object)
        ) continue;
        const box = this.entityBounds(projection.object);
        if (box.isEmpty()) continue;
        const center = box.getCenter(new THREE.Vector3()).project(this.camera);
        if (center.z > 1) continue;
        projected.set(id, {
          x: ((center.x + 1) / 2) * bounds.width,
          y: ((-center.y + 1) / 2) * bounds.height,
        });
      }
      this.callbacks.onSelectMany(pointsInRect(projected, { x: start.x, y: start.y, width: current.x - start.x, height: current.y - start.y }), true);
      this.callbacks.onMarquee?.(null);
      this.orbit.enabled = this.cameraView === null;
      return;
    }
    if (!down || this.dragging) return;
    // Treat anything beyond a few pixels as an orbit/pan gesture, not a click.
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
    if (this.transform.axis !== null) return;

    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.root.children, true);
    for (const hit of hits) {
      if (hit.object.userData[EDITOR_ONLY] === true || !this.isEffectivelyVisible(hit.object)) continue;
      const entityId = findEntityId(hit.object);
      if (entityId && this.projections.get(entityId)?.entity.enabled) {
        this.callbacks.onSelect(entityId, event.shiftKey || event.metaKey || event.ctrlKey);
        return;
      }
    }
    this.callbacks.onSelect(null, false);
  };

  pickDrop(clientX: number, clientY: number): AssetDropTarget {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.root.children, true);
    for (const hit of hits) {
      if (hit.object.userData[EDITOR_ONLY] === true || !this.isEffectivelyVisible(hit.object)) continue;
      const entityId = findEntityId(hit.object);
      if (entityId && this.projections.get(entityId)?.entity.enabled) {
        return { entityId, point: [hit.point.x, hit.point.y, hit.point.z] };
      }
    }
    const ray = this.raycaster.ray;
    const distance = Math.abs(ray.direction.y) > 1e-6 ? -ray.origin.y / ray.direction.y : 5;
    const point = ray.origin.clone().addScaledVector(ray.direction, distance > 0 ? distance : 5);
    return { entityId: null, point: [point.x, point.y, point.z] };
  }

  renderThumbnail(object: THREE.Object3D, size = 96): string {
    const scene = new THREE.Scene();
    scene.add(object);
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x555555, 2);
    const directional = new THREE.DirectionalLight(0xffffff, 2);
    directional.position.set(3, 5, 4);
    scene.add(hemisphere, directional);
    object.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(object);
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 10000);
    const direction = new THREE.Vector3(1, 0.8, 1).normalize();
    const distance = Math.max(0.1, sphere.radius / Math.tan((camera.fov * Math.PI) / 360)) * 1.35;
    camera.position.copy(sphere.center).addScaledVector(direction, distance);
    camera.lookAt(sphere.center);
    const target = new THREE.WebGLRenderTarget(size, size, { depthBuffer: true, stencilBuffer: false });
    const previousTarget = this.renderer.getRenderTarget();
    const previousColor = this.renderer.getClearColor(new THREE.Color());
    const previousAlpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(target);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, true, true);
    this.renderer.render(scene, camera);
    const pixels = new Uint8Array(size * size * 4);
    this.renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
    this.renderer.setRenderTarget(previousTarget);
    this.renderer.setClearColor(previousColor, previousAlpha);
    target.dispose();
    scene.remove(hemisphere, directional);
    scene.remove(object);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) return '';
    const image = context.createImageData(size, size);
    for (let row = 0; row < size; row += 1) {
      const source = row * size * 4;
      const destination = (size - row - 1) * size * 4;
      image.data.set(pixels.subarray(source, source + size * 4), destination);
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  }

  // ------------------------------------------------------------------ rendering

  private observeResize(): void {
    const resize = () => this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(resize);
      this.resizeObserver.observe(this.container);
    }
    resize();
  }

  resize(): void {
    const width = this.container.clientWidth || this.canvas.clientWidth;
    const height = this.container.clientHeight || this.canvas.clientHeight;
    if (width <= 0 || height <= 0) return;
    this.renderer.setSize(width, height, false);
    this.width = width;
    this.height = height;
    this.needsRender = true;
    fitCamera(this.camera, width, height);
  }

  private pixelRatioFor(scale: RenderScale): number {
    return scale === 'device' ? Math.min(globalThis.devicePixelRatio || 1, 2) : scale;
  }

  /** Device pixels per CSS pixel the editor view draws at. */
  setRenderScale(scale: RenderScale): void {
    this.renderScale = scale;
    this.renderer.setPixelRatio(this.pixelRatioFor(scale));
    this.resize();
    this.needsRender = true;
  }

  renderScaleSetting(): RenderScale {
    return this.renderScale;
  }

  /** How the view draws the authored materials; see `ShadingMode`. */
  setShadingMode(mode: ShadingMode): void {
    if (mode === this.shading.current()) return;
    const shadowsBefore = this.renderer.shadowMap.enabled;
    this.shading.set(mode);
    this.updateFillLights();
    const shadowsAfter = this.shadowsEnabled && this.shading.usesShadows();
    if (shadowsAfter !== shadowsBefore) this.applyShadowMap(shadowsAfter);
    this.needsRender = true;
  }

  shadingMode(): ShadingMode {
    return this.shading.current();
  }

  // ------------------------------------------------------------------ fly navigation

  /**
   * Fly navigation: WASD/QE (or the arrows) move the camera, right-drag looks, the wheel sets the
   * speed, Shift is a sprint. The orbit target travels with the camera, so leaving fly mode leaves
   * the orbit where the flight ended.
   */
  setFlyEnabled(enabled: boolean): void {
    if (enabled === this.fly.enabled()) return;
    if (enabled) this.exitCameraView();
    this.fly.setEnabled(enabled);
    this.orbit.enableZoom = !enabled;
    this.orbit.mouseButtons.RIGHT = enabled ? null : THREE.MOUSE.PAN;
    this.needsRender = true;
  }

  flyEnabled(): boolean {
    return this.fly.enabled();
  }

  /** Fly speed in metres per second. */
  setFlySpeed(speed: number): void {
    this.fly.setSpeed(speed);
  }

  flySpeed(): number {
    return this.fly.speed();
  }

  /**
   * Rebuild the camera for a new projection, carrying the framing across.
   *
   * `OrbitControls` and `TransformControls` each capture the camera at construction, so replacing the
   * camera means rebuilding both. The orbit target and the camera's position are carried across, so
   * the view does not jump — only the projection changes, which is the whole point of the switch.
   *
   * Split out from `setProjection` because the view gizmo also needs a rebuilt camera without a
   * projection change: clicking an axis switches to orthographic *and* moves the camera, and doing
   * those as two rebuilds would flicker through an intermediate framing.
   */
  private replaceCamera(next: ProjectionKind): void {
    if (next === this.project) return;
    const target = this.orbit.target.clone();
    const position = this.camera.position.clone();
    const up = this.camera.up.clone();

    const helper = this.transform.getHelper();
    this.transform.detach();
    this.transform.removeEventListener('dragging-changed', this.handleDraggingChanged);
    this.transform.removeEventListener('objectChange', this.handleTransformObjectChange);
    this.transform.removeEventListener('mouseUp', this.handleTransformCommit);
    this.transform.removeEventListener('change', this.invalidate);
    this.scene.remove(helper);
    this.transform.dispose();
    this.orbit.removeEventListener('change', this.invalidate);
    this.orbit.dispose();

    this.project = next;
    this.camera = createCamera(next);
    this.camera.position.copy(position);
    /**
     * The up vector travels with the position. A face view sets it (top and bottom look along ±Y, so
     * their up cannot be +Y), and losing it here would silently roll the view back to a default
     * horizon the moment the projection changed underneath it.
     */
    this.camera.up.copy(up);

    this.orbit = new OrbitControls(this.camera, this.canvas);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.target.copy(target);
    this.orbit.screenSpacePanning = true;
    this.orbit.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: this.fly.enabled() ? null : THREE.MOUSE.PAN,
    };
    this.orbit.enableZoom = !this.fly.enabled();
    this.orbit.addEventListener('change', this.invalidate);

    this.transform = new TransformControls(this.camera, this.canvas);
    this.transform.setSize(0.9);
    this.transform.addEventListener('dragging-changed', this.handleDraggingChanged);
    this.transform.addEventListener('objectChange', this.handleTransformObjectChange);
    this.transform.addEventListener('mouseUp', this.handleTransformCommit);
    this.transform.addEventListener('change', this.invalidate);
    const nextHelper = this.transform.getHelper();
    nextHelper.userData[EDITOR_ONLY] = true;
    this.scene.add(nextHelper);
    this.transform.setSpace(this.space);
    this.attachTransform();

    this.resize();
    this.renderNow();
  }

  /** Switch the editor view between perspective and orthographic. */
  setProjection(next: ProjectionKind): void {
    this.replaceCamera(next);
  }

  /**
   * The world-space bounding box of an entity, or null when it has none.
   *
   * The measurement overlay needs the box in world units and the camera needs it in screen space, so
   * this returns the box and lets the caller decide — projecting inside the controller would put
   * layout arithmetic in a class that has no business knowing the canvas is measured in CSS pixels.
   */
  worldBounds(entityId: string): { min: [number, number, number]; max: [number, number, number] } | null {
    const object = this.projections.get(entityId)?.object;
    if (!object) return null;
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return null;
    return {
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
    };
  }

  /**
   * A world point as canvas coordinates, or null when it is behind the camera.
   *
   * The `z` check matters: `project` happily maps a point behind the viewer to a plausible-looking
   * screen position, which would draw a label for something not on screen.
   */
  toScreen(point: [number, number, number]): ScreenPoint | null {
    const vector = new THREE.Vector3(point[0], point[1], point[2]).project(this.camera);
    if (vector.z > 1) return null;
    return {
      x: ((vector.x + 1) / 2) * this.width,
      y: ((1 - vector.y) / 2) * this.height,
    };
  }

  /** The stage's size in CSS pixels, for an overlay that has to stay inside it. */
  canvasSize(): CanvasSize {
    return { width: this.width, height: this.height };
  }

  /** The camera's distance from its orbit target, for the scene-scale readout. */
  cameraDistance(): number {
    return this.camera.position.distanceTo(this.orbit.target);
  }

  /** The projection in use, for `setDisplay` and the face views. */
  projection(): ProjectionKind {
    return this.project;
  }

  /**
   * The camera's world-space basis, for the view gizmo.
   *
   * The gizmo has to place six axis handles at the screen positions their world directions project
   * to, and it has to do that every frame while the camera moves. Returning the basis rather than a
   * projection of six points keeps that arithmetic in the overlay, where the pixel radius lives, and
   * keeps the controller free of layout — the same split `worldBounds`/`toScreen` already use.
   *
   * `forward` is the direction the camera looks, so a direction pointing *at* the viewer has a
   * negative dot product with it; the gizmo draws those in front.
   */
  cameraBasis(): CameraBasis {
    const matrix = this.camera.matrixWorld;
    const right = new THREE.Vector3().setFromMatrixColumn(matrix, 0).normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(matrix, 1).normalize();
    const forward = new THREE.Vector3().setFromMatrixColumn(matrix, 2).normalize().negate();
    return { right: [right.x, right.y, right.z], up: [up.x, up.y, up.z], forward: [forward.x, forward.y, forward.z] };
  }

  /**
   * Look along a world axis, flat.
   *
   * This is what the gizmo's axis handles do, and it is deliberately two changes at once: the camera
   * moves onto the axis, and the projection becomes orthographic. A face view drawn in perspective is
   * not a face view — parallel edges converge and the elevation you are trying to read is wrong — so
   * "show me this face" and "stop showing me perspective" are the same request. Blender's numpad
   * views behave the same way.
   *
   * The up vector is chosen per axis rather than inherited: looking along ±Y means the old up vector
   * is parallel to the view direction, which makes `lookAt` degenerate and renders nothing
   * predictable. The four side views keep a world-up horizon; top and bottom take ∓Z so the scene
   * still reads with +X to the right.
   */
  faceView(face: ViewFace): void {
    /**
     * A view command repositions the camera, so it leaves the game camera's view first — the same
     * rule `orbitAround` and `frame` follow. Without it, clicking an axis while looking through the
     * game camera moved the view but left the camera-view state set, so the next keypress restored a
     * framing the user had already navigated away from.
     */
    this.exitCameraView();
    this.replaceCamera('orthographic');

    const distance = this.camera.position.distanceTo(this.orbit.target);
    const direction = new THREE.Vector3(
      face.axis === 'x' ? face.sign : 0,
      face.axis === 'y' ? face.sign : 0,
      face.axis === 'z' ? face.sign : 0,
    );
    this.camera.up.set(0, 1, 0);
    if (face.axis === 'y') this.camera.up.set(0, 0, -face.sign);
    this.camera.position.copy(this.orbit.target).addScaledVector(direction, distance);
    this.camera.lookAt(this.orbit.target);

    this.resize();
    this.renderNow();
  }

  /**
   * Rotate the camera around its target: azimuth about world up, elevation clamped.
   *
   * Both arguments are radians, and both follow a pointer drag's sign convention — positive
   * `azimuth` is what dragging *right* does, positive `polar` what dragging *down* does — so the
   * numpad steps and the gizmo share one implementation instead of two that drift apart.
   *
   * ## Why this is a turntable and not a trackball
   *
   * The first version rotated the camera about its own axes and carried `camera.up` through the same
   * quaternion. That is a trackball, and a trackball rolls: after tilting the view and then dragging
   * sideways, the camera's right vector measured `[-0.201, -0.582, 0.788]` where it had been
   * `[0.549, 0, 0.836]` — level. That 35° of roll is the whole scene appearing to spin about the
   * screen rather than swing around the model, which is not what any 3D editor does.
   *
   * A turntable keeps `up` at world up and clamps the polar angle, so the horizon is level *by
   * construction* and cannot drift however the drags are sequenced. `OrbitControls` does exactly this
   * for a drag on the stage itself, so the gizmo and the stage now feel the same.
   *
   * `camera.up` is set rather than preserved, which is what makes a face view a starting point rather
   * than a trap: after looking straight down, `up` is `-Z`, and the first orbit would otherwise have
   * to rotate about an axis parallel to the view direction.
   */
  orbitAround(azimuth: number, polar: number): void {
    this.exitCameraView();
    this.replaceCamera('perspective');
    this.camera.up.set(0, 1, 0);

    const offset = this.camera.position.clone().sub(this.orbit.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= azimuth;
    spherical.phi = Math.min(Math.max(spherical.phi - polar, MIN_POLAR), Math.PI - MIN_POLAR);
    offset.setFromSpherical(spherical);

    this.camera.position.copy(this.orbit.target).add(offset);
    this.camera.lookAt(this.orbit.target);
    this.renderNow();
  }

  /**
   * Orbit by a pointer drag, in pixels.
   *
   * Orbiting also returns the view to perspective. That is Blender's auto-perspective, and it is what
   * stops a face view being a trap: a user who clicks Front and then drags away is asking for a 3D
   * view of the thing they just squared up to, and answering with an orthographic tumble would leave
   * them in a projection they never chose and have no visible way out of.
   */
  orbitBy(deltaX: number, deltaY: number): void {
    this.orbitAround(deltaX * ORBIT_RADIANS_PER_PIXEL, deltaY * ORBIT_RADIANS_PER_PIXEL);
  }

  /**
   * Swap perspective and orthographic, returning whichever is now in force.
   *
   * Blender's numpad 5. The face views pick orthographic on their own, so without an explicit toggle
   * the only way back to perspective would be to orbit — and lose the framing you squared up to.
   */
  toggleProjection(): ProjectionKind {
    this.exitCameraView();
    const next: ProjectionKind = this.project === 'perspective' ? 'orthographic' : 'perspective';
    this.replaceCamera(next);
    return next;
  }

  /**
   * Look from the opposite side: half a turn about the vertical axis.
   *
   * Blender's numpad 9. Elevation is untouched, so it is the same view from behind rather than a
   * mirror of it — and the projection is untouched too, because this is a *view* command and not an
   * orbit. Routing it through `orbitAround` would have quietly dropped a face view back to
   * perspective, which is exactly the surprise that made the gizmo's first version feel wrong.
   *
   * Straight down or straight up is the one case a half turn cannot express — the azimuth is
   * meaningless on the pole, so the turn is spent going to the other pole instead.
   */
  oppositeView(): void {
    this.exitCameraView();
    const offset = this.camera.position.clone().sub(this.orbit.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    if (spherical.phi < OPPOSITE_POLE_THRESHOLD || spherical.phi > Math.PI - OPPOSITE_POLE_THRESHOLD) {
      spherical.phi = Math.PI - spherical.phi;
      /**
       * The up vector has to travel with the pole.
       *
       * Looking down uses `-Z` and looking up uses `+Z`, so reflecting the elevation while keeping
       * the old up leaves world `+X` running the other way across the screen — Numpad 9 and Ctrl+7
       * would show the same view mirrored.
       */
      this.camera.up.set(0, 0, spherical.phi < Math.PI / 2 ? -1 : 1);
    } else {
      spherical.theta += Math.PI;
    }
    offset.setFromSpherical(spherical);
    this.camera.position.copy(this.orbit.target).add(offset);
    this.camera.lookAt(this.orbit.target);
    this.renderNow();
  }

  /**
   * Look through the scene's active game camera.
   *
   * The editor camera is moved onto the entity's world transform and the orbit target is placed
   * along its forward direction, which is what lets the ordinary `lookAt`-based controls reproduce
   * the game camera's aim instead of fighting it. Input is switched off while the view is held: a
   * camera you can orbit away from is not showing you what the game will show.
   *
   * The entity id is kept, so `sync` can re-read the authored transform while the view is held —
   * otherwise editing the camera in the inspector would leave a preview of where it used to be.
   *
   * Returns false when the entity has no projected object, so the caller can say so rather than
   * leaving the user pressing a key that appears dead.
   */
  enterCameraView(entityId: string, planes: CameraPlanes): boolean {
    const object = this.projections.get(entityId)?.object;
    if (!object) return false;
    this.exitCameraView();

    /**
     * The framing is captured *before* anything about the camera changes.
     *
     * It used to be captured after `replaceCamera('perspective')` and the up reset, so the snapshot
     * always said "perspective, up = +Y" and entering from an orthographic face view and leaving
     * again quietly lost the face view instead of restoring it.
     */
    this.cameraView = {
      position: this.camera.position.clone(),
      up: this.camera.up.clone(),
      target: this.orbit.target.clone(),
      project: this.project,
      fov: this.camera instanceof THREE.PerspectiveCamera ? this.camera.fov : null,
      entityId,
      planes,
    };

    this.replaceCamera('perspective');
    this.camera.up.set(0, 1, 0);
    this.applyCameraView(planes);
    this.orbit.enabled = false;
    this.renderNow();
    return true;
  }

  /**
   * Put the editor camera on the viewed entity's authored transform.
   *
   * Separate from `enterCameraView` because the authored transform can change while the view is
   * held: `sync` calls this again after each projection update, so the preview follows the inspector
   * instead of freezing at the moment the key was pressed.
   */
  private applyCameraView(planes: CameraPlanes): void {
    const viewing = this.cameraView;
    if (!viewing) return;
    const object = this.projections.get(viewing.entityId)?.object;
    if (!object) return;

    object.updateWorldMatrix(true, false);
    const position = new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);
    /**
     * `getWorldQuaternion` rather than `setFromRotationMatrix`.
     *
     * The latter assumes an orthonormal matrix, and a scene is free to scale a camera or any of its
     * ancestors — a scaled world matrix fed to it yields a rotation that is not the entity's, so the
     * preview would look through a camera aimed somewhere the game's is not.
     */
    const rotation = object.getWorldQuaternion(new THREE.Quaternion());
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rotation).normalize();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(rotation).normalize();

    this.camera.position.copy(position);
    this.camera.up.copy(up);
    this.orbit.target.copy(position).addScaledVector(forward, CAMERA_VIEW_TARGET);
    if (this.camera instanceof THREE.PerspectiveCamera) {
      this.camera.fov = planes.fov;
      /**
       * The authored clipping planes come with the field of view. Keeping the editor's own near and
       * far shows geometry the game camera would clip, which makes the preview a different picture
       * from the one the game starts with — the whole point of looking through it.
       */
      this.camera.near = planes.near;
      this.camera.far = planes.far;
    }
    this.camera.lookAt(this.orbit.target);
    this.camera.updateProjectionMatrix();
  }

  /** Leave the game camera's view, restoring the framing it was entered from. */
  exitCameraView(): void {
    const previous = this.cameraView;
    if (!previous) return;
    this.cameraView = null;
    this.orbit.enabled = true;
    /** Restores the projection it was entered from, so a face view survives a look through. */
    this.replaceCamera(previous.project);
    this.camera.position.copy(previous.position);
    this.camera.up.copy(previous.up);
    this.orbit.target.copy(previous.target);
    if (previous.fov !== null && this.camera instanceof THREE.PerspectiveCamera) this.camera.fov = previous.fov;
    this.camera.lookAt(this.orbit.target);
    this.camera.updateProjectionMatrix();
    this.renderNow();
  }

  inCameraView(): boolean {
    return this.cameraView !== null;
  }

  /**
   * The editor camera's field of view and clipping planes.
   *
   * Read back rather than assumed because camera view sets all three from the authored component, and
   * "the preview clips what the game camera clips" is only true if they actually arrived — which a
   * gate can check against the document.
   */
  cameraPlanes(): CameraPlanes {
    const perspective = this.camera instanceof THREE.PerspectiveCamera ? this.camera : null;
    return { fov: perspective?.fov ?? 0, near: this.camera.near, far: this.camera.far };
  }

  /** Frame the whole scene. Blender's Home, and the counterpart to `focusSelection`. */
  frameAll(): void {
    this.root.updateWorldMatrix(true, true);
    const box = contentBoundsWithoutBackdrops(this.root);
    if (box.isEmpty()) box.expandByPoint(new THREE.Vector3().setFromMatrixPosition(this.root.matrixWorld));
    this.frameBox(box);
  }

  /** Show or hide the ground grid. */
  setGridVisible(visible: boolean): void {
    this.grid.visible = visible;
    this.needsRender = true;
  }

  gridVisible(): boolean {
    return this.grid.visible;
  }

  /** Show or hide the helpers that draw cast shadows in the editor. */
  setShadowsVisible(visible: boolean): void {
    this.shadowsEnabled = visible;
    const enabled = visible && this.shading.usesShadows();
    if (enabled !== this.renderer.shadowMap.enabled) this.applyShadowMap(enabled);
    this.needsRender = true;
  }

  private applyShadowMap(enabled: boolean): void {
    this.renderer.shadowMap.enabled = enabled;
    // Shadow maps are baked into materials, so every one of them has to be recompiled for the
    // change to take effect; without this the renderer keeps the maps it already built.
    for (const projection of this.projections.values()) {
      projection.object.traverse((child) => {
        /**
         * `isMesh` is Three's own discriminant — the library sets it on every mesh subclass and
         * branches on it internally — so this narrows without an assertion about what the traversal
         * happened to visit.
         */
        if (!(child instanceof THREE.Mesh)) return;
        const material = child.material;
        // A mesh may carry one material or an array of them, and both need the same flag.
        if (Array.isArray(material)) for (const entry of material) entry.needsUpdate = true;
        else if (material) material.needsUpdate = true;
      });
    }
  }

  shadowsVisible(): boolean {
    return this.shadowsEnabled;
  }

  /**
   * Draw the stage.
   *
   * One camera and one viewport: the split view this used to support drew a second camera into the
   * same canvas with a scissor rectangle, and it went with the 2D mode. A face view now answers the
   * question split existed for — seeing an elevation without losing your place — and it answers it
   * without a second render target, a second camera to keep framed, or a second place for the gizmo
   * and the raycaster to disagree.
   */
  renderNow(): void {
    this.orbit.update();
    this.draw();
  }

  /** Ask for a frame. Bound, because it is handed to the controls as a listener. */
  private readonly invalidate = (): void => {
    this.needsRender = true;
  };

  private draw(): void {
    this.needsRender = false;
    if (this.selection.length > 0) this.updateSelectionHelper();
    this.shading.apply(this.root);
    try {
      this.renderer.setViewport(0, 0, this.width, this.height);
      this.renderer.render(this.scene, this.camera);
    } finally {
      this.shading.restore();
    }
  }

  private renderLoop = (): void => {
    if (!this.running) return;
    this.frameHandle = requestAnimationFrame(this.renderLoop);
    const delta = Math.min(this.clock.getDelta(), 0.1);
    let animating = false;
    for (const projection of this.projections.values()) {
      const animation = projection.animation;
      if (!animation) continue;
      animation.update(delta);
      if (animation.getState().playing) animating = true;
    }
    const flew = this.fly.update(delta);
    // Damping keeps the orbit moving after the pointer stops; `update` says whether it still is.
    const orbited = this.orbit.update();
    if (!(this.needsRender || animating || flew || orbited || this.dragging)) return;
    this.draw();
  };

  /** Statistics used by the editor status bar and by tests. */
  stats(): ViewportStats {
    return {
      entities: this.projections.size,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      programs: this.renderer.info.programs?.length ?? 0,
      geometries: this.renderer.info.memory.geometries,
      instancedPrimitives: this.batches.instanced(),
    };
  }

  /** World-space position of an entity, for tests and inspectors. */
  entityWorldPosition(entityId: string): THREE.Vector3 | null {
    const object = this.projections.get(entityId)?.object;
    if (!object) return null;
    object.updateWorldMatrix(true, false);
    return new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);
  }

  projectObject(entityId: string): THREE.Object3D | null {
    return this.projections.get(entityId)?.object ?? null;
  }

  /** Clip names of a loaded model instance, or null when nothing is loaded yet. */
  clipNames(entityId: string): string[] | null {
    const model = this.projections.get(entityId)?.model;
    return model ? model.clips.map((clip, index) => clip.name || `clip-${index}`) : null;
  }

  /** Animation preview state, for checks and for the inspector read-out. */
  animationState(entityId: string): ReturnType<AnimationController['getState']> | null {
    return this.projections.get(entityId)?.animation?.getState() ?? null;
  }

  /** Whether the projection is showing a loaded model, a loading marker, or a failure. */
  modelStatus(entityId: string): 'none' | 'loading' | 'loaded' | 'failed' {
    const projection = this.projections.get(entityId);
    if (!projection) return 'none';
    if (projection.model) return 'loaded';
    return projection.failed ? 'failed' : projection.pendingAssetId ? 'loading' : 'none';
  }
}

/** Whether a projected object is a mesh, by three's own runtime marker rather than a class check. */
function isMesh(object: THREE.Object3D): object is THREE.Mesh {
  return 'isMesh' in object && object.isMesh === true;
}

function isPrimitiveMesh(object: THREE.Object3D): object is BatchMember['mesh'] {
  return isMesh(object) && object.material instanceof THREE.MeshStandardMaterial;
}

/** Release the skeletons a skinned model owns: instances share geometry, never skeletons. */
function disposeSkeletons(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh && object.skeleton instanceof THREE.Skeleton) object.skeleton.dispose();
  });
}

function findEntityId(object: THREE.Object3D): string | null {
  let cursor: THREE.Object3D | null = object;
  while (cursor) {
    const entityId: unknown = cursor.userData?.entityId;
    if (isEntityId(entityId)) return entityId;
    cursor = cursor.parent;
  }
  return null;
}

/** `userData.entityId` is set by `syncEntity`; three types `userData` as an open bag. */
function isEntityId(value: unknown): value is string {
  return typeof value === 'string';
}

export { RuntimeWorldError };
