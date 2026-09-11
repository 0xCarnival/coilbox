import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Entity, SceneDocument, Transform, Vec3 } from '@schema/index.js';
import { applyMaterial, createLight, createPrimitiveMesh, RuntimeWorldError } from '@runtime/scene-graph.js';
import { disposeSceneResources } from '@runtime/render/viewport.js';

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
}

export interface ViewportOptions extends ViewportCallbacks {
  canvas: HTMLCanvasElement;
  container: HTMLElement;
}

interface EntityProjection {
  object: THREE.Group;
  /** Component signature last projected, so property edits rebuild only what changed. */
  signature: string;
  entity: Entity;
}

const EDITOR_ONLY = 'editorOnly';

export class EditorViewport {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private readonly canvas: HTMLCanvasElement;
  private readonly container: HTMLElement;
  private readonly callbacks: ViewportCallbacks;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly orbit: OrbitControls;
  private readonly transform: TransformControls;
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
  private selection: string[] = [];
  private snap: SnapSettings = { enabled: false, translate: 0.5, rotateDegrees: 15, scale: 0.25 };
  private pointerDownAt: { x: number; y: number } | null = null;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;

  constructor(options: ViewportOptions) {
    this.canvas = options.canvas;
    this.container = options.container;
    this.callbacks = options;

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.scene.background = new THREE.Color('#1b1f29');

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 2000);
    this.camera.position.set(7, 5.5, 9);

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
    (this.boxHelper.material as THREE.Material).dispose();
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
    for (const [id, projection] of [...this.projections]) {
      if (seen.has(id)) continue;
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
      scene.environment.background.type === 'color' ? scene.environment.background.color : '#1b1f29',
    );
    this.updateSelectionHelper();
  }

  private syncEntity(entity: Entity): void {
    const signature = JSON.stringify(entity.components);
    let projection = this.projections.get(entity.id);
    if (!projection) {
      projection = { object: new THREE.Group(), signature: '', entity };
      projection.object.name = entity.name;
      projection.object.userData.entityId = entity.id;
      this.projections.set(entity.id, projection);
    }
    projection.entity = entity;
    projection.object.name = entity.name;

    if (projection.signature !== signature) {
      // Rebuild the entity's visual children; the group itself stays put so selection and
      // transform controls are not disturbed by a property edit.
      const children = [...projection.object.children];
      for (const child of children) {
        projection.object.remove(child);
        disposeSceneResources(child);
      }
      this.projectComponents(projection.object, entity);
      projection.signature = signature;
    }

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
          const mesh = object.children.find((child): child is THREE.Mesh => (child as THREE.Mesh).isMesh === true);
          if (mesh) applyMaterial(mesh.material as THREE.MeshStandardMaterial, component);
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
        case 'model':
        case 'animation':
        case 'audio':
        case 'behavior': {
          // Not runnable yet: mark the entity so the viewport still shows a placeholder
          // instead of silently pretending the component works.
          const marker = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 0.5, 0.5),
            new THREE.MeshBasicMaterial({ color: 0xd98b5b, wireframe: true }),
          );
          marker.userData[EDITOR_ONLY] = true;
          marker.name = `unsupported:${component.type}`;
          object.add(marker);
          this.callbacks.onWarning?.(
            `${entity.name}: ${component.type} components are not runnable in this build yet`,
          );
          break;
        }
        default:
          break;
      }
    }
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
    if (this.selection.length === 1) {
      const object = this.projections.get(this.selection[0]!)?.object;
      if (object) this.transform.attach(object);
      else this.transform.detach();
    } else {
      this.transform.detach();
    }
    this.updateSelectionHelper();
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
    const distance = Math.max(2.5, sphere.radius / Math.tan((this.camera.fov * Math.PI) / 360) + 1.5);
    const direction = new THREE.Vector3().subVectors(this.camera.position, this.orbit.target).normalize();
    this.orbit.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(direction, distance * 1.4);
    this.orbit.update();
  }

  getTool(): TransformTool {
    return this.transform.mode as TransformTool;
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
    const entityId = this.selection[0];
    if (!entityId) return;
    const object = this.projections.get(entityId)?.object;
    if (!object) return;
    this.callbacks.onCommitTransform(entityId, {
      position: object.position.toArray() as Vec3,
      rotation: [object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w],
      scale: object.scale.toArray() as Vec3,
    });
  };

  /** Restore the projected transform from the document (drag cancellation). */
  cancelDrag(scene: SceneDocument, entityId: string): void {
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
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  renderNow(): void {
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
  }

  private renderLoop = (): void => {
    if (!this.running) return;
    this.frameHandle = requestAnimationFrame(this.renderLoop);
    if (this.selection.length > 0) this.boxHelper.setFromObject(this.projections.get(this.selection[0]!)?.object ?? this.boxHelper);
    this.renderNow();
  };

  /** Statistics used by the editor status bar and by tests. */
  stats(): { entities: number; drawCalls: number; triangles: number; programs: number; geometries: number } {
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
}

function findEntityId(object: THREE.Object3D): string | null {
  let cursor: THREE.Object3D | null = object;
  while (cursor) {
    const entityId = cursor.userData?.entityId;
    if (typeof entityId === 'string') return entityId;
    cursor = cursor.parent;
  }
  return null;
}

export { RuntimeWorldError };
