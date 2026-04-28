import { Engine } from '../../core/engine/Engine';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { ResourceType } from '../../types/ResourceType.enum';
import { SkinningVertexData } from '../../types/SkinData.type';
import { Mesh, MeshOptions } from './Mesh';

export interface SkinnedMeshOptions extends MeshOptions {
  skinningData?: SkinningVertexData;
}

/**
 * A Mesh variant that carries a second GPU vertex buffer (slot 1) with
 * per-vertex joint indices (uint8x4) and blend weights (float32x4).
 *
 * The existing interleaved buffer (slot 0: pos/normal/uv/tangent, 48 bytes)
 * is inherited from Mesh unchanged.  Skinning data sits in a separate 20-byte
 * stride buffer so static mesh pipelines are unaffected.
 */
export class SkinnedMesh extends Mesh {
  // Skinning vertex data stored before GPU upload
  private joints!: Uint8Array; // vertexCount * 4
  private weights!: Float32Array; // vertexCount * 4

  // GPU buffer: [joints u8x4 | weights f32x4] per vertex, stride 20 bytes
  private skinningBuffer!: GPUBuffer;

  constructor(options: SkinnedMeshOptions) {
    super(options);
    if (options.skinningData) {
      this.joints = options.skinningData.joints;
      this.weights = options.skinningData.weights;
    }
  }

  // ── Factory ──────────────────────────────────────────────────────────────

  public static createFromData(
    meshData: MeshOptions['meshData'],
    skinningData: SkinningVertexData,
  ): SkinnedMesh {
    const id = Engine.generateDynamicId();
    const mesh = new SkinnedMesh({
      path: `skinned_mesh_${id}`,
      type: ResourceType.MESH,
      ...(meshData ? { meshData } : {}),
      skinningData,
    });
    ResourceManager.registerResource(mesh);
    return mesh;
  }

  // ── Load ─────────────────────────────────────────────────────────────────

  public override async loadAsync(): Promise<void> {
    // Super builds the interleaved position/normal/uv/tangent buffers
    await super.loadAsync();
    this.initSkinningBuffer();
  }

  public override load(): void {
    super.load();
    // load() is fire-and-forget; we piggyback on super's promise chain via a wrapper.
    // Because load() is sync-initiation, we defer the skinning buffer until the
    // interleaved buffer is ready. Simple approach: schedule after microtask queue.
    Promise.resolve().then(() => {
      if (this.joints && this.weights) {
        this.initSkinningBuffer();
      }
    });
  }

  // ── Skinning buffer init ──────────────────────────────────────────────────

  private initSkinningBuffer(): void {
    if (!this.joints || !this.weights) return;
    if (this.skinningBuffer) return; // already created

    const vertexCount = this.joints.length / 4;
    // Interleaved layout per vertex: [j0,j1,j2,j3 (4 bytes)] + [w0,w1,w2,w3 (16 bytes)] = 20 bytes
    const STRIDE = 20;
    const byteSize = vertexCount * STRIDE;

    this.skinningBuffer = this.device.createBuffer({
      label: `${this.getName()}_skinning`,
      size: byteSize,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });

    const mapped = this.skinningBuffer.getMappedRange();
    const u8view = new Uint8Array(mapped);
    const f32view = new Float32Array(mapped);

    for (let i = 0; i < vertexCount; i++) {
      const u8off = i * STRIDE;
      const f32off = (i * STRIDE + 4) / 4; // weights start at byte 4 → float32 offset 1
      // joints: 4 bytes
      u8view[u8off] = this.joints[i * 4]!;
      u8view[u8off + 1] = this.joints[i * 4 + 1]!;
      u8view[u8off + 2] = this.joints[i * 4 + 2]!;
      u8view[u8off + 3] = this.joints[i * 4 + 3]!;
      // weights: 4 floats
      f32view[f32off] = this.weights[i * 4]!;
      f32view[f32off + 1] = this.weights[i * 4 + 1]!;
      f32view[f32off + 2] = this.weights[i * 4 + 2]!;
      f32view[f32off + 3] = this.weights[i * 4 + 3]!;
    }

    this.skinningBuffer.unmap();
  }

  // ── GPU activation ───────────────────────────────────────────────────────

  public override activate(pass: GPURenderPassEncoder): void {
    super.activate(pass); // slot 0: interleaved pos/normal/uv/tangent + index buffer
    if (this.skinningBuffer) {
      pass.setVertexBuffer(1, this.skinningBuffer); // slot 1: joints + weights
    }
  }

  public override isGPUReady(): boolean {
    return super.isGPUReady() && this.skinningBuffer !== undefined;
  }

  // ── Disposal ─────────────────────────────────────────────────────────────

  public dispose(): void {
    this.skinningBuffer?.destroy();
  }

  // ── Static vertex buffer layout (for pipeline creation) ─────────────────

  /**
   * Returns a 2-slot vertex buffer layout:
   *   slot 0 — position / normal / uv / tangent  (48 bytes, inherited from Mesh)
   *   slot 1 — joints (uint8x4) / weights (float32x4)  (20 bytes)
   */
  public static getSkinnedVertexBufferLayout(): GPUVertexBufferLayout[] {
    return [
      // Slot 0: standard geometry (same as Mesh.getVertexBufferLayout()[0])
      {
        arrayStride: 48,
        stepMode: 'vertex',
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
          { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
          { shaderLocation: 2, offset: 24, format: 'float32x2' }, // uv
          { shaderLocation: 3, offset: 32, format: 'float32x4' }, // tangent
        ],
      },
      // Slot 1: skinning data
      {
        arrayStride: 20,
        stepMode: 'vertex',
        attributes: [
          { shaderLocation: 4, offset: 0, format: 'uint8x4' }, // joints
          { shaderLocation: 5, offset: 4, format: 'float32x4' }, // weights
        ],
      },
    ];
  }
}
