import * as THREE from 'three';
import type { AnimationComponent } from '@schema/index.js';

/**
 * Per-instance animation playback (plan §4, §9).
 *
 * "Play imported clips; choose clip, loop, speed" — that is the whole contract. There is no
 * timeline authoring, no retargeting, and no state machine. Each instance owns its mixer, so
 * two copies of the same model animate independently.
 */

export interface AnimationState {
  clip: string | null;
  clipNames: string[];
  playing: boolean;
  loop: boolean;
  speed: number;
  time: number;
  duration: number;
}

export class AnimationController {
  readonly mixer: THREE.AnimationMixer;
  private action: THREE.AnimationAction | null = null;
  private component: AnimationComponent;
  private readonly object: THREE.Object3D;
  private readonly clips: THREE.AnimationClip[];
  private readonly warnings: string[] = [];

  constructor(object: THREE.Object3D, clips: THREE.AnimationClip[], component: AnimationComponent) {
    this.object = object;
    this.clips = clips;
    this.component = component;
    this.mixer = new THREE.AnimationMixer(object);

    if (clips.length > 0) {
      this.play(component.clip, { autoplay: component.autoplay, loop: component.loop, speed: component.speed });
    } else if (component.autoplay) {
      this.warnings.push('the model has no animation clips, so the animation component has nothing to play');
    }
  }

  get clipNames(): string[] {
    return this.clips.map((clip, index) => clip.name || `clip-${index}`);
  }

  get currentClip(): string | null {
    return this.action?.getClip().name ?? null;
  }

  get warningList(): string[] {
    return [...this.warnings];
  }

  /** Play a named clip, or the first clip when `name` is null/empty. */
  play(name: string | null, options: { autoplay?: boolean; loop?: boolean; speed?: number } = {}): void {
    const clip = this.resolveClip(name);
    if (!clip) {
      if (name) this.warnings.push(`clip "${name}" is not in this model; available: ${this.clipNames.join(', ') || 'none'}`);
      return;
    }
    if (this.action) this.action.stop();
    this.action = this.mixer.clipAction(clip);
    this.action.setLoop(options.loop ?? this.component.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    this.action.clampWhenFinished = !(options.loop ?? this.component.loop);
    this.action.timeScale = options.speed ?? this.component.speed;
    this.action.reset();
    if (options.autoplay ?? this.component.autoplay) this.action.play();
    this.action.paused = !(options.autoplay ?? this.component.autoplay);
  }

  private resolveClip(name: string | null): THREE.AnimationClip | null {
    if (name === null || name.length === 0) return this.clips[0] ?? null;
    return (
      this.clips.find((clip) => clip.name === name) ??
      this.clips.find((clip, index) => (clip.name || `clip-${index}`) === name) ??
      null
    );
  }

  setPlaying(playing: boolean): void {
    this.component = { ...this.component, playing };
    if (!this.action) return;
    this.action.paused = !playing;
    if (playing) this.action.play();
  }

  setLoop(loop: boolean): void {
    this.component = { ...this.component, loop };
    if (!this.action) return;
    this.action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    this.action.clampWhenFinished = !loop;
  }

  setSpeed(speed: number): void {
    this.component = { ...this.component, speed };
    if (this.action) this.action.timeScale = speed;
  }

  /** Advance by a fixed simulation delta so Pause/Step behave predictably. */
  update(delta: number): void {
    if (!this.component.playing) return;
    this.mixer.update(delta);
  }

  seek(time: number): void {
    if (!this.action) return;
    this.action.time = time;
    this.mixer.update(0);
  }

  getState(): AnimationState {
    return {
      clip: this.currentClip,
      clipNames: this.clipNames,
      playing: this.component.playing && !(this.action?.paused ?? true),
      loop: this.component.loop,
      speed: this.component.speed,
      time: this.action?.time ?? 0,
      duration: this.action?.getClip().duration ?? 0,
    };
  }

  dispose(): void {
    this.action?.stop();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.object);
    this.action = null;
  }
}
