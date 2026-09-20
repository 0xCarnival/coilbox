import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * First-person flight for the editor camera.
 *
 * Orbiting is the right tool for an object and the wrong one for a kilometre of track: every turn
 * is about a target that is usually behind a wall. Flight moves the eye instead — W/A/S/D on the
 * camera's own axes, Q/E straight down and up, the arrows as aliases, right-drag to look, the wheel
 * to change speed, Shift to sprint. The orbit target is carried along at its current distance, so
 * the orbit and the transform gizmo pick up where the flight leaves off.
 *
 * Keys are read on the window and filtered by target, so the flight works with the canvas or the
 * empty stage focused, and stops the moment a text field has focus.
 */

/** Metres per second at the default speed; the wheel scales it between the bounds. */
const DEFAULT_SPEED = 12;
const MIN_SPEED = 0.25;
const MAX_SPEED = 400;
const SPRINT = 3;
/** Radians of turn per pixel of right-drag. */
const LOOK_RATE = 0.0035;
/** Kept a hair short of straight up or down, where the orbit's spherical maths degenerates. */
const PITCH_LIMIT = Math.PI / 2 - 0.02;

type Axis = 'forward' | 'back' | 'left' | 'right' | 'up' | 'down';

/** Keyboard `code` to movement axis. */
const KEY_AXES: ReadonlyMap<string, Axis> = new Map<string, Axis>([
  ['KeyW', 'forward'],
  ['KeyS', 'back'],
  ['KeyA', 'left'],
  ['KeyD', 'right'],
  ['KeyE', 'up'],
  ['KeyQ', 'down'],
  ['ArrowUp', 'forward'],
  ['ArrowDown', 'back'],
  ['ArrowLeft', 'left'],
  ['ArrowRight', 'right'],
  ['PageUp', 'up'],
  ['PageDown', 'down'],
]);

export const FLY_KEY_CODES: ReadonlySet<string> = new Set(KEY_AXES.keys());

function axisFor(code: string): Axis | null {
  return KEY_AXES.get(code) ?? null;
}

interface Rig {
  camera: THREE.Camera;
  orbit: OrbitControls;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export class FlyNavigator {
  private active = false;
  private currentSpeed = DEFAULT_SPEED;
  private readonly held = new Set<Axis>();
  private sprinting = false;
  private look: { pointerId: number; x: number; y: number } | null = null;
  private readonly velocity = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly spherical = new THREE.Spherical();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    /** Read on every use: the controller rebuilds both when the projection changes. */
    private readonly rig: () => Rig,
    private readonly onChange: () => void,
  ) {}

  enabled(): boolean {
    return this.active;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.active) return;
    this.active = enabled;
    if (enabled) {
      window.addEventListener('keydown', this.handleKeyDown);
      window.addEventListener('keyup', this.handleKeyUp);
      window.addEventListener('blur', this.releaseKeys);
      this.canvas.addEventListener('pointerdown', this.handlePointerDown);
      this.canvas.addEventListener('pointermove', this.handlePointerMove);
      this.canvas.addEventListener('pointerup', this.handlePointerUp);
      this.canvas.addEventListener('pointercancel', this.handlePointerUp);
      this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    } else {
      window.removeEventListener('keydown', this.handleKeyDown);
      window.removeEventListener('keyup', this.handleKeyUp);
      window.removeEventListener('blur', this.releaseKeys);
      this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
      this.canvas.removeEventListener('pointermove', this.handlePointerMove);
      this.canvas.removeEventListener('pointerup', this.handlePointerUp);
      this.canvas.removeEventListener('pointercancel', this.handlePointerUp);
      this.canvas.removeEventListener('wheel', this.handleWheel);
      this.releaseKeys();
      this.look = null;
    }
  }

  speed(): number {
    return this.currentSpeed;
  }

  setSpeed(speed: number): void {
    if (!Number.isFinite(speed)) return;
    this.currentSpeed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
  }

  /** Advance the flight by `delta` seconds; true when the camera moved. */
  update(delta: number): boolean {
    if (!this.active || this.held.size === 0) return false;
    const { camera, orbit } = this.rig();
    camera.getWorldDirection(this.forward);
    this.right.crossVectors(this.forward, camera.up).normalize();
    this.velocity.set(0, 0, 0);
    if (this.held.has('forward')) this.velocity.add(this.forward);
    if (this.held.has('back')) this.velocity.sub(this.forward);
    if (this.held.has('right')) this.velocity.add(this.right);
    if (this.held.has('left')) this.velocity.sub(this.right);
    if (this.held.has('up')) this.velocity.add(camera.up);
    if (this.held.has('down')) this.velocity.sub(camera.up);
    if (this.velocity.lengthSq() === 0) return false;
    this.velocity.normalize().multiplyScalar(this.currentSpeed * (this.sprinting ? SPRINT : 1) * delta);
    camera.position.add(this.velocity);
    orbit.target.add(this.velocity);
    return true;
  }

  dispose(): void {
    this.setEnabled(false);
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (isTextEntry(event.target)) return;
    if (event.key === 'Shift') {
      this.sprinting = true;
      return;
    }
    const axis = axisFor(event.code);
    if (!axis || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    this.held.add(axis);
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    if (event.key === 'Shift') this.sprinting = false;
    const axis = axisFor(event.code);
    if (axis) this.held.delete(axis);
  };

  private readonly releaseKeys = (): void => {
    this.held.clear();
    this.sprinting = false;
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 2) return;
    this.look = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    this.canvas.setPointerCapture(event.pointerId);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const look = this.look;
    if (!look || event.pointerId !== look.pointerId) return;
    const deltaX = event.clientX - look.x;
    const deltaY = event.clientY - look.y;
    look.x = event.clientX;
    look.y = event.clientY;
    this.turn(-deltaX * LOOK_RATE, -deltaY * LOOK_RATE);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (!this.look || event.pointerId !== this.look.pointerId) return;
    this.look = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
  };

  /** The wheel sets the speed rather than dollying: distance is what the keys are for. */
  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    this.setSpeed(this.currentSpeed * factor);
  };

  /**
   * Turn the eye, keeping the orbit target at its distance in front of it.
   *
   * Expressed through the orbit's own spherical coordinates so a look and an orbit compose: the
   * target is swung about the camera rather than the camera about the target.
   */
  private turn(yaw: number, pitch: number): void {
    const { camera, orbit } = this.rig();
    this.offset.subVectors(orbit.target, camera.position);
    this.spherical.setFromVector3(this.offset);
    this.spherical.theta += yaw;
    this.spherical.phi = Math.min(Math.PI - (Math.PI / 2 - PITCH_LIMIT), Math.max(Math.PI / 2 - PITCH_LIMIT, this.spherical.phi - pitch));
    this.spherical.makeSafe();
    this.offset.setFromSpherical(this.spherical);
    orbit.target.copy(camera.position).add(this.offset);
    camera.lookAt(orbit.target);
    this.onChange();
  }
}
