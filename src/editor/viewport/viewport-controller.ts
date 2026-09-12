import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Entity, SceneDocument, Transform } from '@schema/index.js';
import { applyMaterial, createLight, createPrimitiveMesh, RuntimeWorldError } from '@runtime/scene-graph.js';
import { disposeSceneResources } from '@runtime/render/viewport.js';
import { AnimationController } from '@runtime/animation.js';
import type { ModelInstance } from '@runtime/assets/loader.js';

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

export interface SnapSettings {
  enabled: boolean;
  translate: number;
  rotateDegrees: number;
  scale: number;
}

export interface ViewportCallbacks {
  onSelect(entityId: string | null, additive: boolean): void;
  onCommitTransform(entityId: string, transform: Partial<Transform>): void;
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
}

const EDITOR_ONLY = 'editorOnly';

/**
 * The editor's default field of view, and the world height an orthographic view shows.
 *
 * The orthographic frustum is derived from a *height* rather than a width so that switching
 * projection keeps the visible vertical extent: the view zooms by the same amount in both, and the
 * framing does not jump when the projection changes.
 */
const FIELD_OF_VIEW = 55;
const ORTHO_HEIGHT = 12;

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
 * What the stage is showing.
 *
 * `2d` is the plan view: a top-down orthographic camera whose orbit is locked to pan and zoom.
 * `split` draws both cameras into one canvas side by side, which is how a change in the third
 * dimension is checked against the plan without switching back and forth.
 */
export type ViewMode = '3d' | '2d' | 'split';

/**
 * How far above the target the 2D camera sits, and how far it can see.
 *
 * The plan view is orthographic, so distance does not change what is visible — only the frustum
 * height does. The height is large enough to clear anything a scene is likely to contain.
 */
const PLAN_CAMERA_HEIGHT = 120;
const PLAN_FRUSTUM_HEIGHT = 24;

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
  /**
   * The top-down camera, kept alongside the working one rather than swapped in.
   *
   * `split` needs both at once, so they are a pair from construction. The active camera is whichever
   * the current view mode is driving; the other still exists and still renders in split.
   */
  readonly planCamera: THREE.OrthographicCamera;

  private readonly canvas: HTMLCanvasElement;
  private readonly container: HTMLElement;
  private readonly callbacks: ViewportCallbacks;
  private readonly renderer: THREE.WebGLRenderer;
  private orbit: OrbitControls;
  private transform: TransformControls;
  /** The projection currently in use, so a resize knows which camera to refit. */
  private project: ProjectionKind = 'perspective';
  /** What the stage is showing. */
  private mode: ViewMode = '3d';
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly root = new THREE.Group();
  private readonly helpers = new THREE.Group();
  private readonly grid: THREE.GridHelper;
  private readonly projections = new Map<string, EntityProjection>();
  private readonly boxHelper: THREE.BoxHelper;

  private frameHandle: number | null = null;
  private running = false;
  private dragging = false;
  /** Set while a cancelled drag waits for its release, so the release records nothing. */
  private cancelPending = false;
  private pointerId = 1;
  private selection: string[] = [];
  private snap: SnapSettings = { enabled: false, translate: 0.5, rotateDegrees: 15, scale: 0.25 };
  private pointerDownAt: { x: number; y: number } | null = null;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;
  /** The last canvas size, so a render can set its own viewport without measuring the DOM. */
  private width = 1;
  private height = 1;
  private assetProvider: ViewportAssetProvider | null = null;
  private readonly clock = new THREE.Clock();
  private readonly pendingLoads = new Set<string>();

  constructor(options: ViewportOptions) {
    this.canvas = options.canvas;
    this.container = options.container;
    this.callbacks = options;

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.scene.background = new THREE.Color('#141519');

    this.camera = createCamera('perspective');
    this.camera.position.set(7, 5.5, 9);

    const planCamera: THREE.OrthographicCamera = new THREE.OrthographicCamera(
      -PLAN_FRUSTUM_HEIGHT / 2,
      PLAN_FRUSTUM_HEIGHT / 2,
      PLAN_FRUSTUM_HEIGHT / 2,
      -PLAN_FRUSTUM_HEIGHT / 2,
      0.05,
      2000,
    );
    this.planCamera = planCamera;
    // Straight down, looking at the origin, with `up` along -Z so the plan reads as a floor plan:
    // +X to the right and +Z down the screen, which is the convention every plan view uses.
    this.planCamera.position.set(0, PLAN_CAMERA_HEIGHT, 0);
    this.planCamera.up.set(0, 0, -1);
    this.planCamera.lookAt(0, 0, 0);

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

    this.grid = new THREE.GridHelper(60, 60, 0x3a4256, 0x272d3a);
    this.grid.userData[EDITOR_ONLY] = true;
    this.helpers.add(this.grid);

    // Editor-only fill light so an unlit document is still authorable. Play mode uses the
    // document's own lights through the runtime, so this never affects gameplay.
    const editorAmbient = new THREE.HemisphereLight(0x9fb4d8, 0x2a2f3a, 0.55);
    editorAmbient.userData[EDITOR_ONLY] = true;
    const editorKey = new THREE.DirectionalLight(0xffffff, 0.85);
    editorKey.position.set(6, 10, 6);
    editorKey.userData[EDITOR_ONLY] = true;
    this.helpers.add(editorAmbient, editorKey);

    this.scene.add(this.root, this.helpers);

    this.transform = new TransformControls(this.camera, this.canvas);
    this.transform.setSize(0.9);
    this.transform.addEventListener('dragging-changed', this.handleDraggingChanged);
    this.transform.addEventListener('mouseUp', this.handleTransformCommit);
    const helper = this.transform.getHelper();
    helper.userData[EDITOR_ONLY] = true;
    this.scene.add(helper);

    this.boxHelper = new THREE.BoxHelper(new THREE.Object3D(), 0x5b9dff);
    this.boxHelper.visible = false;
    this.boxHelper.userData[EDITOR_ONLY] = true;
    this.scene.add(this.boxHelper);

    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
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
    for (const projection of this.projections.values()) this.disposeProjectionChildren(projection);
    this.stop();
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerCancel);
    this.transform.removeEventListener('dragging-changed', this.handleDraggingChanged);
    this.transform.removeEventListener('mouseUp', this.handleTransformCommit);
    this.transform.detach();
    this.transform.dispose();
    this.orbit.dispose();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    disposeSceneResources(this.root);
    this.boxHelper.geometry.dispose();
    if (this.boxHelper.material instanceof THREE.Material) this.boxHelper.material.dispose();
    this.scene.clear();
    this.renderer.dispose();
  }

  // ------------------------------------------------------------------ projection

  /** Project the authored scene into the viewport, creating/updating/removing as needed. */
  sync(scene: SceneDocument): void {
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
    this.scene.background = new THREE.Color(
      scene.environment.background.type === 'color' ? scene.environment.background.color : '#141519',
    );
    this.updateSelectionHelper();
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
      this.projectComponents(projection.object, entity);
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
    projection.object.visible = entity.enabled && entity.editor.visible;
  }

  private projectComponents(object: THREE.Object3D, entity: Entity): void {
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
          if (mesh && mesh.material instanceof THREE.MeshStandardMaterial) applyMaterial(mesh.material, component);
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
            new THREE.MeshBasicMaterial({ color: component.isSensor ? 0x54d1a0 : 0x5b9dff, wireframe: true, transparent: true, opacity: 0.32 }),
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
            new THREE.MeshBasicMaterial({ color: 0x5b9dff, wireframe: true, transparent: true, opacity: 0.6 }),
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
  }

  setAssetProvider(provider: ViewportAssetProvider | null): void {
    this.assetProvider = provider;
  }

  private async loadModelFor(projection: EntityProjection, assetId: string): Promise<void> {
    const provider = this.assetProvider;
    projection.pendingAssetId = assetId;
    if (!provider) return;
    const key = `${projection.entity.id}:${assetId}`;
    if (this.pendingLoads.has(key)) return;
    this.pendingLoads.add(key);
    try {
      const instance = await provider.instantiate(assetId);
      // The projection may have been rebuilt or removed while the load was in flight.
      const current = this.projections.get(projection.entity.id);
      if (!current || current !== projection || current.pendingAssetId !== assetId || this.disposed) return;
      this.disposeProjectionModel(current);
      current.model = instance;
      current.object.add(instance.object);
      const clipNames = instance.clips.map((clip, index) => clip.name || `clip-${index}`);
      this.callbacks.onModelLoaded?.(projection.entity.id, clipNames);
      this.syncProjectionAnimation(current, current.entity);
    } catch (error) {
      const current = this.projections.get(projection.entity.id);
      if (current && current === projection) current.failed = true;
      const message = error instanceof Error ? error.message : String(error);
      this.callbacks.onModelFailed?.(projection.entity.id, message);
      this.callbacks.onWarning?.(message);
    } finally {
      this.pendingLoads.delete(key);
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
    this.attachTransform();
    this.updateSelectionHelper();
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
    this.transform.detach();
  }

  private updateSelectionHelper(): void {
    if (this.selection.length === 0) {
      this.boxHelper.visible = false;
      return;
    }
    const object = this.projections.get(this.selection[0]!)?.object;
    if (!object) {
      this.boxHelper.visible = false;
      return;
    }
    this.boxHelper.setFromObject(object);
    this.boxHelper.visible = true;
  }

  // ------------------------------------------------------------------ tools

  setTool(tool: TransformTool): void {
    this.transform.setMode(tool);
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
  }

  focusSelection(): void {
    const object = this.selection.length === 1 ? this.projections.get(this.selection[0]!)?.object : this.root;
    if (!object) return;
    const box = new THREE.Box3().setFromObject(object);
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
    this.orbit.update();
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
    this.orbit.enabled = !this.dragging;
    this.callbacks.onDragStateChange?.(this.dragging);
  };

  private handleTransformCommit = (): void => {
    // A cancelled drag still ends with a release; it must not become an undoable command.
    if (this.cancelPending) {
      this.cancelPending = false;
      return;
    }
    const entityId = this.selection[0];
    if (!entityId) return;
    const object = this.projections.get(entityId)?.object;
    if (!object) return;
    this.callbacks.onCommitTransform(entityId, {
      position: [object.position.x, object.position.y, object.position.z],
      rotation: [object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w],
      scale: [object.scale.x, object.scale.y, object.scale.z],
    });
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
    const entityId = this.selection[0];
    if (scene && entityId) this.restoreProjection(scene, entityId);
    try {
      this.canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: this.pointerId, button: 0, bubbles: true }));
    } catch {
      // The pointer may already be gone; the drag is cancelled either way.
    }
    this.dragging = false;
    this.orbit.enabled = true;
    this.callbacks.onDragStateChange?.(false);
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
  };

  private handlePointerCancel = (): void => {
    this.pointerDownAt = null;
  };

  private handlePointerUp = (event: PointerEvent): void => {
    const down = this.pointerDownAt;
    this.pointerDownAt = null;
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
      const entityId = findEntityId(hit.object);
      if (entityId) {
        this.callbacks.onSelect(entityId, event.shiftKey || event.metaKey || event.ctrlKey);
        return;
      }
    }
    this.callbacks.onSelect(null, false);
  };

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
    fitCamera(this.camera, width, height);
    /**
     * The plan camera is fitted to half the canvas in split mode and the whole canvas otherwise, so
     * both halves show the same world extent rather than the plan being squeezed into half of it.
     */
    fitCamera(this.planCamera, this.mode === 'split' ? width / 2 : width, height, PLAN_FRUSTUM_HEIGHT);
  }

  /**
   * Switch the editor view between perspective and orthographic.
   *
   * `OrbitControls` and `TransformControls` each capture the camera at construction, so replacing the
   * camera means rebuilding both. The orbit target and the camera's position are carried across, so
   * the view does not jump — only the projection changes, which is the whole point of the switch.
   */
  setProjection(next: ProjectionKind): void {
    if (next === this.project) return;
    const target = this.orbit.target.clone();
    const position = this.camera.position.clone();

    const helper = this.transform.getHelper();
    this.transform.detach();
    this.transform.removeEventListener('dragging-changed', this.handleDraggingChanged);
    this.transform.removeEventListener('mouseUp', this.handleTransformCommit);
    this.scene.remove(helper);
    this.transform.dispose();
    this.orbit.dispose();

    this.project = next;
    this.camera = createCamera(next);
    this.camera.position.copy(position);

    this.orbit = new OrbitControls(this.camera, this.canvas);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.target.copy(target);
    this.orbit.screenSpacePanning = true;
    this.orbit.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };

    this.transform = new TransformControls(this.camera, this.canvas);
    this.transform.setSize(0.9);
    this.transform.addEventListener('dragging-changed', this.handleDraggingChanged);
    this.transform.addEventListener('mouseUp', this.handleTransformCommit);
    const nextHelper = this.transform.getHelper();
    nextHelper.userData[EDITOR_ONLY] = true;
    this.scene.add(nextHelper);
    this.attachTransform();

    this.resize();
    this.renderNow();
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

  /** The projection in use, for the display panel's switch. */
  projection(): ProjectionKind {
    return this.project;
  }

  /** What the stage is showing. */
  viewMode(): ViewMode {
    return this.mode;
  }

  /**
   * Switch between the 3D view, the plan view, and both at once.
   *
   * In `2d` the working camera *becomes* the plan camera: the gizmo, the raycaster, and the orbit
   * controls all follow `this.camera`, so pointing them at the plan camera is what makes every tool
   * work in the plan view without a second code path. `split` restores the perspective working camera
   * and draws the plan camera beside it.
   */
  setViewMode(next: ViewMode): void {
    if (next === this.mode) return;
    const target = this.orbit.target.clone();
    const planTarget = new THREE.Vector3(target.x, 0, target.z);

    const helper = this.transform.getHelper();
    this.transform.detach();
    this.transform.removeEventListener('dragging-changed', this.handleDraggingChanged);
    this.transform.removeEventListener('mouseUp', this.handleTransformCommit);
    this.scene.remove(helper);
    this.transform.dispose();
    this.orbit.dispose();

    this.mode = next;
    this.camera = next === '2d' ? this.planCamera : createCamera(this.project);
    if (next === '2d') {
      this.planCamera.position.set(planTarget.x, PLAN_CAMERA_HEIGHT, planTarget.z);
      this.planCamera.lookAt(planTarget.x, 0, planTarget.z);
    } else if (next === '3d') {
      this.camera.position.set(target.x + 7, target.y + 5.5, target.z + 9);
    } else {
      // Split keeps the perspective framing and gives the plan its own centre.
      this.camera.position.set(target.x + 7, target.y + 5.5, target.z + 9);
      this.planCamera.position.set(planTarget.x, PLAN_CAMERA_HEIGHT, planTarget.z);
      this.planCamera.lookAt(planTarget.x, 0, planTarget.z);
    }

    this.orbit = new OrbitControls(this.camera, this.canvas);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.target.copy(next === '2d' ? planTarget : target);
    this.orbit.screenSpacePanning = true;
    if (next === '2d') {
      /**
       * A plan view that can be orbited is not a plan view.
       *
       * The whole value of looking straight down is that "up" means something; letting the camera
       * tumble turns it into a worse 3D view. Rotation is off and pan and zoom stay, which is the
       * subset of orbit a plan actually needs.
       */
      this.orbit.enableRotate = false;
    }
    this.orbit.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };

    this.transform = new TransformControls(this.camera, this.canvas);
    this.transform.setSize(0.9);
    this.transform.addEventListener('dragging-changed', this.handleDraggingChanged);
    this.transform.addEventListener('mouseUp', this.handleTransformCommit);
    const nextHelper = this.transform.getHelper();
    nextHelper.userData[EDITOR_ONLY] = true;
    this.scene.add(nextHelper);
    this.attachTransform();

    this.resize();
    this.renderNow();
  }

  /** Show or hide the ground grid. */
  setGridVisible(visible: boolean): void {
    this.grid.visible = visible;
    this.renderNow();
  }

  gridVisible(): boolean {
    return this.grid.visible;
  }

  /** Show or hide the helpers that draw cast shadows in the editor. */
  setShadowsVisible(visible: boolean): void {
    this.renderer.shadowMap.enabled = visible;
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
    this.renderNow();
  }

  shadowsVisible(): boolean {
    return this.renderer.shadowMap.enabled;
  }

  /**
   * Draw the current view mode.
   *
   * `split` uses the renderer's scissor test to draw two cameras into one canvas: the perspective
   * view on the left half, the plan on the right. A single canvas rather than two is what keeps the
   * gizmo, the raycasting, and the resize observer on one surface — two canvases would mean two of
   * each and a second place for them to disagree.
   *
   * The plan half renders the *plan* camera even when the working camera is the perspective one, so
   * the two halves always show what their labels say.
   */
  renderNow(): void {
    this.orbit.update();
    if (this.mode !== 'split') {
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, this.width, this.height);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    const half = Math.floor(this.width / 2);
    const planHalf = this.width - half;

    this.renderer.setScissorTest(true);

    this.renderer.setViewport(0, 0, half, this.height);
    this.renderer.setScissor(0, 0, half, this.height);
    this.renderer.render(this.scene, this.camera);

    this.renderer.setViewport(half, 0, planHalf, this.height);
    this.renderer.setScissor(half, 0, planHalf, this.height);
    this.renderer.render(this.scene, this.planCamera);

    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, this.width, this.height);
  }

  private renderLoop = (): void => {
    if (!this.running) return;
    this.frameHandle = requestAnimationFrame(this.renderLoop);
    const delta = Math.min(this.clock.getDelta(), 0.1);
    for (const projection of this.projections.values()) projection.animation?.update(delta);
    if (this.selection.length > 0) this.boxHelper.setFromObject(this.projections.get(this.selection[0]!)?.object ?? this.boxHelper);
    this.renderNow();
  };

  /** Statistics used by the editor status bar and by tests. */
  stats(): ViewportStats {
    return {
      entities: this.projections.size,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      programs: this.renderer.info.programs?.length ?? 0,
      geometries: this.renderer.info.memory.geometries,
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
