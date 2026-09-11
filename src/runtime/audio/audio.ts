import type { AssetId } from '@schema/index.js';
import type { AssetResolver } from '../assets/resolver.js';

/**
 * Audio playback (plan §4, §16).
 *
 * A small WebAudio layer: decode once per asset, play many times, with volume and optional
 * 3D positioning. Browsers refuse to start an AudioContext before a user gesture, so the
 * context is created on demand and resumed on the first interaction; a game that is not yet
 * activated reports that instead of failing silently.
 */

export interface AudioPlayOptions {
  volume?: number;
  loop?: boolean;
  /** World position for 3D sounds. */
  position?: [number, number, number];
  /** Reference distance for spatial falloff, in metres. */
  maxDistance?: number;
  rate?: number;
}

export interface AudioSystemOptions {
  resolver: AssetResolver;
  fetchImpl?: typeof fetch;
  onWarning?: (message: string) => void;
}

interface LoadedSound {
  buffer: AudioBuffer | null;
  element: HTMLAudioElement | null;
  url: string;
}

export class AudioSystem {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly resolver: AssetResolver;
  private readonly fetchImpl: typeof fetch;
  private readonly onWarning: (message: string) => void;
  private readonly sounds = new Map<AssetId, Promise<LoadedSound>>();
  private readonly active = new Set<AudioBufferSourceNode>();
  private activated = false;
  private disposed = false;

  constructor(options: AudioSystemOptions) {
    this.resolver = options.resolver;
    this.fetchImpl =
      options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    this.onWarning = options.onWarning ?? (() => {});
  }

  get isActivated(): boolean {
    return this.activated;
  }

  /** True when the platform can play audio at all. */
  get supported(): boolean {
    return typeof globalThis.AudioContext !== 'undefined' || typeof globalThis.Audio !== 'undefined';
  }

  /**
   * Create or resume the audio context. Call this from a user gesture (or from
   * `prepareAudio` in a behavior that runs after one).
   */
  async activate(): Promise<boolean> {
    if (this.disposed) return false;
    try {
      this.ensureContext();
      if (this.context && this.context.state === 'suspended') await this.context.resume();
      this.activated = this.context?.state === 'running';
      return this.activated;
    } catch (error) {
      this.onWarning(`audio could not start: ${String(error)}`);
      return false;
    }
  }

  /** Decode an asset so the first play is not late; failures are reported once. */
  prepare(assetId: AssetId): void {
    void this.load(assetId).catch((error: unknown) => this.onWarning(String(error)));
  }

  async load(assetId: AssetId): Promise<LoadedSound> {
    const cached = this.sounds.get(assetId);
    if (cached) return cached;
    const promise = this.loadUncached(assetId).catch((error: unknown) => {
      this.sounds.delete(assetId);
      throw error;
    });
    this.sounds.set(assetId, promise);
    return promise;
  }

  private async loadUncached(assetId: AssetId): Promise<LoadedSound> {
    const url = this.resolver.resolveUrl(assetId);
    if (!url) throw new Error(`audio asset "${assetId}" is not in this project's asset manifest`);
    this.ensureContext();
    if (!this.context) {
      // No WebAudio: fall back to an element so a cue still plays.
      const element = new globalThis.Audio(url);
      element.preload = 'auto';
      return { buffer: null, element, url };
    }
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`audio asset "${assetId}" returned HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const buffer = await this.context.decodeAudioData(bytes.slice(0));
    return { buffer, element: null, url };
  }

  /** Play an asset. Returns false when it could not be played (and says why through onWarning). */
  play(assetId: AssetId, options: AudioPlayOptions = {}): boolean {
    if (this.disposed) return false;
    const cached = this.sounds.get(assetId);
    if (!cached) {
      this.prepare(assetId);
      this.onWarning(`audio "${assetId}" is still loading; the first play may be silent`);
      return false;
    }
    void cached
      .then((sound) => this.playLoaded(sound, options))
      .catch((error: unknown) => this.onWarning(String(error)));
    return true;
  }

  private playLoaded(sound: LoadedSound, options: AudioPlayOptions): void {
    const volume = options.volume ?? 1;
    if (sound.element) {
      sound.element.volume = Math.max(0, Math.min(1, volume));
      sound.element.loop = options.loop ?? false;
      void sound.element.play().catch(() => this.onWarning('the browser blocked audio playback until you interact'));
      return;
    }
    if (!sound.buffer || !this.context || !this.master) return;

    const source = this.context.createBufferSource();
    source.buffer = sound.buffer;
    source.loop = options.loop ?? false;
    if (options.rate !== undefined) source.playbackRate.value = options.rate;

    const gain = this.context.createGain();
    gain.gain.value = Math.max(0, Math.min(1, volume));

    if (options.position) {
      const panner = this.context.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 1;
      panner.maxDistance = options.maxDistance ?? 20;
      panner.positionX.value = options.position[0];
      panner.positionY.value = options.position[1];
      panner.positionZ.value = options.position[2];
      source.connect(gain).connect(panner).connect(this.master);
    } else {
      source.connect(gain).connect(this.master);
    }

    this.active.add(source);
    source.onended = () => {
      this.active.delete(source);
      gain.disconnect();
    };
    source.start();
  }

  stopAll(): void {
    for (const source of this.active) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    this.active.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAll();
    this.sounds.clear();
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.master = null;
  }

  get loadedCount(): number {
    return this.sounds.size;
  }

  private ensureContext(): void {
    if (this.context || typeof globalThis.AudioContext === 'undefined') return;
    try {
      this.context = new globalThis.AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = 1;
      this.master.connect(this.context.destination);
    } catch (error) {
      this.onWarning(`WebAudio is unavailable: ${String(error)}`);
      this.context = null;
      this.master = null;
    }
  }
}
