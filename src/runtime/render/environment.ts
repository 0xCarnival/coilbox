import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Environment, Fog, Sky as SkyDocument } from '@schema/index.js';

/**
 * Projects a scene document's `environment` onto a three.js scene: background, image-based
 * lighting, and fog.
 *
 * The sky and the studio light box are rendered once into prefiltered (PMREM) cube maps and
 * reused until their inputs change, so a scene with a sky pays for it on load and when the sun
 * moves, not per frame. One instance belongs to one renderer; the editor viewport and the runtime
 * viewport each own one, which is what keeps the editor's preview and Play in agreement.
 */
export class EnvironmentProjection {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private pmrem: THREE.PMREMGenerator | null = null;
  private skyTarget: THREE.WebGLRenderTarget | null = null;
  private skyKey: string | null = null;
  private studioTarget: THREE.WebGLRenderTarget | null = null;
  private disposed = false;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    this.renderer = renderer;
    this.scene = scene;
  }

  apply(environment: Environment): void {
    if (this.disposed) return;
    const { background, lighting, sky } = environment;
    const needsSky = background.type === 'sky' || lighting.type === 'sky';
    const skyTexture = needsSky ? this.skyMap(sky) : null;
    if (!needsSky) this.releaseSky();

    switch (background.type) {
      case 'color':
        this.scene.background = new THREE.Color(background.color);
        this.scene.backgroundBlurriness = 0;
        break;
      case 'sky':
        this.scene.background = skyTexture;
        this.scene.backgroundBlurriness = background.blur;
        break;
      default:
        this.scene.background = null;
        this.scene.backgroundBlurriness = 0;
        break;
    }

    switch (lighting.type) {
      case 'studio':
        this.scene.environment = this.studioMap();
        this.scene.environmentIntensity = lighting.intensity;
        break;
      case 'sky':
        this.scene.environment = skyTexture;
        this.scene.environmentIntensity = lighting.intensity;
        break;
      default:
        this.scene.environment = null;
        this.scene.environmentIntensity = 1;
        this.studioTarget?.dispose();
        this.studioTarget = null;
        break;
    }

    this.scene.fog = fogFromDocument(environment.fog);
  }

  /** Direction *towards* the sun for the given sky, for lights that should agree with it. */
  static sunDirection(sky: SkyDocument): THREE.Vector3 {
    const phi = THREE.MathUtils.degToRad(90 - sky.elevation);
    const theta = THREE.MathUtils.degToRad(sky.azimuth);
    return new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseSky();
    this.studioTarget?.dispose();
    this.studioTarget = null;
    this.pmrem?.dispose();
    this.pmrem = null;
    this.scene.background = null;
    this.scene.environment = null;
  }

  private generator(): THREE.PMREMGenerator {
    return (this.pmrem ??= new THREE.PMREMGenerator(this.renderer));
  }

  private skyMap(sky: SkyDocument): THREE.Texture {
    const key = `${sky.elevation}|${sky.azimuth}|${sky.turbidity}|${sky.rayleigh}`;
    if (this.skyTarget && this.skyKey === key) return this.skyTarget.texture;
    this.releaseSky();

    const mesh = new Sky();
    const uniforms = mesh.material.uniforms;
    uniforms.turbidity.value = sky.turbidity;
    uniforms.rayleigh.value = sky.rayleigh;
    uniforms.mieCoefficient.value = 0.005;
    uniforms.mieDirectionalG.value = 0.8;
    uniforms.sunPosition.value.copy(EnvironmentProjection.sunDirection(sky));
    // fromScene renders from the origin, so the sky box just has to enclose the near plane.
    mesh.scale.setScalar(10);

    const skyScene = new THREE.Scene();
    skyScene.add(mesh);
    this.skyTarget = this.generator().fromScene(skyScene, 0, 0.1, 100);
    this.skyKey = key;
    mesh.geometry.dispose();
    mesh.material.dispose();
    return this.skyTarget.texture;
  }

  private studioMap(): THREE.Texture {
    if (this.studioTarget) return this.studioTarget.texture;
    const room = new RoomEnvironment();
    this.studioTarget = this.generator().fromScene(room, 0.04);
    room.dispose();
    return this.studioTarget.texture;
  }

  private releaseSky(): void {
    this.skyTarget?.dispose();
    this.skyTarget = null;
    this.skyKey = null;
  }
}

export function fogFromDocument(fog: Fog): THREE.Fog | THREE.FogExp2 | null {
  switch (fog.type) {
    case 'linear':
      return new THREE.Fog(new THREE.Color(fog.color), fog.near, fog.far);
    case 'exponential':
      return new THREE.FogExp2(new THREE.Color(fog.color), fog.density);
    default:
      return null;
  }
}
