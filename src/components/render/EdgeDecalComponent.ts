import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { RenderManagerV2 } from '../../renderer/core/managers/RenderManagerV2';
import { Material } from '../../renderer/resources/Material';
import { Mesh } from '../../renderer/resources/Mesh';
import { MeshData } from '../../types/MeshData.type';

export type EdgeDecalComponentData = {
  /** Decal material (technique gbuffer/decal_edge.tech). */
  material: string;
  /** Strip width in metres on each face (the shader's wear/bevel live inside it). */
  width?: number;
  /** Also decorate the edges touching the floor. Default false. */
  bottom?: boolean;
};

// Outward offset of the strips (metres): just enough to win the depth test against the
// face they lie on without visibly floating.
const LIFT = 0.001;

/**
 * Edge decals for box-shaped entities (unit_cube.obj × scale): generates thin strips lying
 * on the faces along each of the 12 edges and draws them in the decal pass, which bends
 * the G-buffer normal into a bevel and wears the edge (decal_edge.fs).
 *
 * A layer on top of the object's material, not a material: it works over any surface
 * shader and the object keeps its own. The strips are built in the cube's local space
 * from the entity's scale, so widths stay in metres on stretched boxes.
 *
 * Strip vertex data (read by decal_edge.fs):
 *   normal  = the face the strip lies on
 *   tangent = the other face of the edge (bevel direction)
 *   uv      = (distance to the edge, position along the edge), both in metres
 */
export class EdgeDecalComponent extends Component {
  private materialPath = '';
  private width = 0.12;
  private bottom = false;
  private readonly keyOwner = {};
  private static readonly meshCache = new Map<string, Promise<Mesh>>();

  public async load(data: EdgeDecalComponentData): Promise<void> {
    this.materialPath = data.material;
    this.width = data.width ?? this.width;
    this.bottom = data.bottom ?? false;
  }

  public override async onAttach(): Promise<void> {
    const transform = this.getOwner().getComponent('transform') as TransformComponent;
    const scale = transform.getTransform().getWorldScale();
    const [mesh, material] = await Promise.all([
      EdgeDecalComponent.getMesh([scale[0], scale[1], scale[2]], this.width, this.bottom),
      Material.get(this.materialPath),
    ]);
    RenderManagerV2.getInstance().addKey(this.keyOwner as any, mesh, material, transform);
  }

  public update(_dt: number): void {}

  public override dispose(): void {
    RenderManagerV2.getInstance().delKeys(this.keyOwner as any);
  }

  private static getMesh(scale: [number, number, number], width: number, bottom: boolean): Promise<Mesh> {
    const key = `${scale.map((s) => s.toFixed(3)).join('x')}_${width}_${bottom}`;
    let mesh = this.meshCache.get(key);
    if (!mesh) {
      mesh = Mesh.getAsync(this.buildStrips(scale, width, bottom));
      this.meshCache.set(key, mesh);
    }
    return mesh;
  }

  private static buildStrips(scale: [number, number, number], width: number, bottom: boolean): MeshData {
    const pos: number[] = [];
    const nrm: number[] = [];
    const uv: number[] = [];
    const tan: number[] = [];
    const idx: number[] = [];
    const half = scale.map((s) => s / 2);

    // Every edge: two face axes (a, b) with signs, running along the third axis.
    for (let along = 0; along < 3; along++) {
      const [a, b] = [0, 1, 2].filter((k) => k !== along) as [number, number];
      for (const sa of [-1, 1]) {
        for (const sb of [-1, 1]) {
          const touchesFloor = (a === 1 && sa < 0) || (b === 1 && sb < 0);
          if (touchesFloor && !bottom) continue;
          // Strip on face a (offset inward along b) and on face b (inward along a).
          for (const [face, sf, other, so] of [
            [a, sa, b, sb],
            [b, sb, a, sa],
          ] as const) {
            if (face === 1 && sf < 0) continue; // the underside is never seen
            const w = Math.min(width, half[other]!);
            const base = pos.length / 3;
            for (const [t, inset] of [
              [-1, 0],
              [1, 0],
              [1, w],
              [-1, w],
            ] as const) {
              // Metres in world (box-local axes), then back to unit-cube units.
              const p = [0, 0, 0];
              p[along] = t * half[along]!;
              p[face] = sf * (half[face]! + LIFT);
              p[other] = so * (half[other]! - inset);
              pos.push(p[0]! / scale[0], p[1]! / scale[1], p[2]! / scale[2]);
              const n = [0, 0, 0];
              n[face] = sf;
              nrm.push(n[0]!, n[1]!, n[2]!);
              const o = [0, 0, 0];
              o[other] = so;
              tan.push(o[0]!, o[1]!, o[2]!, 1);
              uv.push(inset, t * half[along]!);
            }
            // Front-facing: ccw seen from outside the face, like the cube itself.
            if (this.facesOutward(face, sf, along, other, so)) {
              idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
            } else {
              idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
            }
          }
        }
      }
    }

    return {
      attributes: {
        POSITION: new Float32Array(pos),
        NORMAL: new Float32Array(nrm),
        TEXCOORD_0: new Float32Array(uv),
        TANGENT: new Float32Array(tan),
      },
      indices: new Uint32Array(idx),
    } as unknown as MeshData;
  }

  /**
   * Winding of the quad (v0 → v1 → v2) seen from outside its face: its geometric normal
   * is (v1 − v0) × (v2 − v0) = (2·e_along) × (−so·w·e_other), which must match sf·e_face.
   */
  private static facesOutward(face: number, sf: number, along: number, other: number, so: number): boolean {
    const e = (k: number) => {
      const v = [0, 0, 0];
      v[k] = 1;
      return v;
    };
    const u = e(along);
    const v = e(other).map((x) => -so * x);
    const c = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    return c[face]! * sf > 0;
  }
}
