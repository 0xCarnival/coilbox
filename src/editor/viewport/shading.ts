import * as THREE from 'three';

/**
 * Editor shading modes.
 *
 * The authored materials are the document's; these are ways of *looking* at them. A mode is applied
 * around a single render — every mesh under the scene root has its material swapped for a derived
 * one on the way in and restored on the way out — so nothing that reads `mesh.material` between
 * frames (the inspector, `applyMaterial`, the exporter) ever sees anything but the authored
 * material, and Play mode, which builds its own graph, is untouched.
 *
 * - `solid`: a Lambert copy under fixed studio lighting. Colour and texture survive; roughness,
 *   metalness, environment reflections and shadow maps do not, which is most of what makes the lit
 *   view expensive on a scene with thousands of objects.
 * - `unlit`: a flat, untonemapped copy — the texture and colour exactly as authored.
 * - `lit`: the authored materials as they are.
 * - `wireframe`: the same flat copy drawn as edges.
 */
export type ShadingMode = 'solid' | 'unlit' | 'lit' | 'wireframe';

export const SHADING_MODES: readonly ShadingMode[] = ['solid', 'unlit', 'lit', 'wireframe'];

export const SHADING_LABELS: Record<ShadingMode, string> = {
  solid: 'Solid',
  unlit: 'Unlit',
  lit: 'Lit',
  wireframe: 'Wireframe',
};

export function isShadingMode(value: unknown): value is ShadingMode {
  return SHADING_MODES.some((mode) => mode === value);
}

/** The subset of authored material state a derived material mirrors. */
interface DerivedSet {
  solid: THREE.MeshLambertMaterial;
  unlit: THREE.MeshBasicMaterial;
  wireframe: THREE.MeshBasicMaterial;
}

type Swappable = THREE.Material | THREE.Material[];

/** A material with the colour-and-map surface every derived copy is built from. */
type ColouredMaterial = THREE.Material & {
  color: THREE.Color;
  map: THREE.Texture | null;
  vertexColors: boolean;
  alphaTest: number;
};

function isColoured(material: THREE.Material): material is ColouredMaterial {
  return 'color' in material && material.color instanceof THREE.Color && 'map' in material;
}

export class ShadingPass {
  private mode: ShadingMode = 'solid';
  private readonly derived = new WeakMap<THREE.Material, DerivedSet>();
  /** Everything swapped this frame, so `restore` puts back exactly what `apply` took. */
  private readonly swappedMaterials: Array<{ mesh: THREE.Mesh; material: Swappable }> = [];
  private readonly hiddenLights: THREE.Light[] = [];
  /** Derived materials ever created, so `dispose` can release their programs. */
  private readonly created = new Set<THREE.Material>();

  current(): ShadingMode {
    return this.mode;
  }

  set(mode: ShadingMode): void {
    this.mode = mode;
  }

  /** Whether the authored lights should shine: only the lit view uses them. */
  usesSceneLights(): boolean {
    return this.mode === 'lit';
  }

  /** Whether the shadow pass is worth running: shadows are part of the lit view and nothing else. */
  usesShadows(): boolean {
    return this.mode === 'lit';
  }

  /**
   * Swap in the derived materials for one render. A no-op in the lit view, so the fast path costs a
   * single comparison.
   */
  apply(root: THREE.Object3D): void {
    if (this.mode === 'lit') return;
    const mode = this.mode;
    root.traverse((object) => {
      if (object instanceof THREE.Light) {
        if (object.visible) {
          object.visible = false;
          this.hiddenLights.push(object);
        }
        return;
      }
      if (!(object instanceof THREE.Mesh)) return;
      const authored: Swappable = object.material;
      const replacement = Array.isArray(authored)
        ? authored.map((entry) => this.derive(entry, mode))
        : this.derive(authored, mode);
      object.material = replacement;
      this.swappedMaterials.push({ mesh: object, material: authored });
    });
  }

  restore(): void {
    for (const { mesh, material } of this.swappedMaterials) mesh.material = material;
    this.swappedMaterials.length = 0;
    for (const light of this.hiddenLights) light.visible = true;
    this.hiddenLights.length = 0;
  }

  dispose(): void {
    this.restore();
    for (const material of this.created) material.dispose();
    this.created.clear();
  }

  private derive(source: THREE.Material, mode: Exclude<ShadingMode, 'lit'>): THREE.Material {
    if (!isColoured(source)) return source;
    let set = this.derived.get(source);
    if (!set) {
      set = {
        solid: new THREE.MeshLambertMaterial(),
        unlit: new THREE.MeshBasicMaterial({ toneMapped: false }),
        wireframe: new THREE.MeshBasicMaterial({ wireframe: true, toneMapped: false }),
      };
      this.created.add(set.solid).add(set.unlit).add(set.wireframe);
      this.derived.set(source, set);
    }
    const target = set[mode];
    mirror(source, target);
    return target;
  }
}

/**
 * Copy the authored surface onto a derived material.
 *
 * Cheap fields are copied every frame — a colour copy is three floats — so a material edit in the
 * inspector shows up without anyone having to invalidate anything. The texture slot is the one field
 * whose change needs a recompile, so it is compared before it is written.
 */
function mirror(source: ColouredMaterial, target: THREE.MeshLambertMaterial | THREE.MeshBasicMaterial): void {
  target.color.copy(source.color);
  if (target.map !== source.map) {
    target.map = source.map;
    target.needsUpdate = true;
  }
  target.transparent = source.transparent;
  target.opacity = source.opacity;
  target.side = source.side;
  target.visible = source.visible;
  target.alphaTest = source.alphaTest;
  target.depthWrite = source.depthWrite;
  if (target.vertexColors !== source.vertexColors) {
    target.vertexColors = source.vertexColors;
    target.needsUpdate = true;
  }
}
