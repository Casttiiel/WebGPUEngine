import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { Render } from '../../renderer/core/pipeline/Render';
import { Mesh } from '../../renderer/resources/Mesh';
import { Material } from '../../renderer/resources/Material';
import { RenderManagerV2 } from '../../renderer/core/managers/RenderManagerV2';
import { RenderComponent } from '../render/RenderComponent';
import { TransformComponent } from '../core/TransformComponent';
import { CameraComponent } from '../render/CameraComponent';

export type TrailType = 'ribbon' | 'spline';

export interface TrailRendererComponentData {
  /** 'ribbon' (default) or 'spline' (Catmull-Rom smoothed) */
  type?: TrailType;
  /** Maximum control nodes stored in the ring buffer. Default 32. */
  maxNodes?: number;
  /** Minimum world-space distance between recorded nodes. Default 0.05. */
  minNodeDistance?: number;
  /** Width of the ribbon in world units. Used only in single-emitter mode. Default 0.1. */
  width?: number;
  /** How long each node lives before fading out (seconds). Default 0.3. */
  lifetime?: number;
  /** Color at the head (newest) of the trail [r,g,b,a]. Default [1, 0.9, 0.5, 1]. */
  startColor?: number[];
  /** Color at the tail (oldest) of the trail [r,g,b,a]. Default [1, 0.2, 0, 0]. */
  endColor?: number[];
  /** Catmull-Rom subdivisions between each control node. Only for 'spline'. Default 4. */
  splineSubdivisions?: number;
  /** Material path. Default 'trail.mat'. */
  material?: string;
  /** Whether to start emitting immediately on load. Default true. */
  emitting?: boolean;
  /**
   * Dual-emitter mode: name of a scene entity to use as the second ribbon edge.
   * When set, the ribbon spans between this entity and the owner entity each frame,
   * exactly covering the distance between the two points (e.g. sword hilt → tip).
   * The `width` parameter is ignored in dual-emitter mode.
   */
  secondaryEmitterName?: string;
  /**
   * Blade mode (recommended for weapons): automatically computes tip and hilt from the
   * owner entity's world matrix Z column, which includes scale. This avoids any child
   * entity world-position issues and correctly spans the full visible blade length.
   * When true, `secondaryEmitterName` is ignored.
   */
  bladeMode?: boolean;
}

// Interleaved vertex stride mirrors the engine mesh format (12 floats = 48 bytes)
const VERTEX_STRIDE = 12;

interface TrailNode {
  pos: vec3; // primary emitter world position
  posB: vec3; // secondary emitter world position (dual mode only; pre-allocated)
  age: number;
}

export class TrailRendererComponent extends Component {
  private trailType: TrailType = 'ribbon';
  private maxNodes: number = 32;
  private minNodeDistance: number = 0.05;
  private width: number = 0.1;
  private nodeLifetime: number = 0.3;
  private startColor: readonly [number, number, number, number] = [1, 0.9, 0.5, 1];
  private endColor: readonly [number, number, number, number] = [1, 0.2, 0, 0];
  private splineSubdivisions: number = 4;
  private materialPath: string = 'trail.mat';

  // ── Dual-emitter mode ────────────────────────────────────────────────────────
  private secondaryEntityName: string | null = null;
  private secondaryTransform: TransformComponent | null = null;
  private secondaryResolved: boolean = false;
  private bladeMode: boolean = false;

  // ── Ring buffer ──────────────────────────────────────────────────────────────
  private nodes: TrailNode[] = [];
  private head: number = 0;
  private activeCount: number = 0;

  // ── GPU resources ────────────────────────────────────────────────────────────
  private trailMesh!: Mesh;
  private trailMaterial!: Material;
  private renderComp!: RenderComponent;
  private transformComp!: TransformComponent;
  private indirectBuffer!: GPUBuffer;
  private dummyBindGroup!: GPUBindGroup;

  // ── CPU geometry scratch buffer (reused every frame, no alloc) ───────────────
  private vertexCPU!: Float32Array;

  // ── Reusable vec3 temporaries ────────────────────────────────────────────────
  private readonly tempForward = vec3.create();
  private readonly tempCamDir = vec3.create();
  private readonly tempRight = vec3.create();

  // ── Position tracking ────────────────────────────────────────────────────────
  private readonly lastPos = vec3.create();
  private hasLastPos = false;

  private emitting: boolean = true;
  private maxRenderVerts: number = 0;

  public async load(data: TrailRendererComponentData): Promise<void> {
    this.trailType = data.type ?? 'ribbon';
    this.maxNodes = Math.max(2, data.maxNodes ?? 32);
    this.minNodeDistance = data.minNodeDistance ?? 0.05;
    this.width = data.width ?? 0.1;
    this.nodeLifetime = data.lifetime ?? 0.3;
    this.startColor = (data.startColor as [number, number, number, number]) ?? [1, 0.9, 0.5, 1];
    this.endColor = (data.endColor as [number, number, number, number]) ?? [1, 0.2, 0, 0];
    this.splineSubdivisions = Math.max(1, data.splineSubdivisions ?? 4);
    this.materialPath = data.material ?? 'trail.mat';
    this.emitting = data.emitting !== false;
    this.bladeMode = data.bladeMode ?? false;
    this.secondaryEntityName = data.bladeMode ? null : (data.secondaryEmitterName ?? null);

    // Pre-allocate ring buffer — posB is always allocated to avoid branching
    this.nodes = Array.from({ length: this.maxNodes }, () => ({
      pos: vec3.create(),
      posB: vec3.create(),
      age: 0,
    }));

    const maxSplineNodes =
      this.trailType === 'spline'
        ? (this.maxNodes - 1) * this.splineSubdivisions + 1
        : this.maxNodes;
    this.maxRenderVerts = maxSplineNodes * 2;

    this.vertexCPU = new Float32Array(this.maxRenderVerts * VERTEX_STRIDE);

    const maxSegments = maxSplineNodes - 1;
    const indexData = new Uint16Array(maxSegments * 6);
    for (let k = 0; k < maxSegments; k++) {
      const b = k * 6;
      indexData[b + 0] = k * 2;
      indexData[b + 1] = k * 2 + 1;
      indexData[b + 2] = k * 2 + 2;
      indexData[b + 3] = k * 2 + 1;
      indexData[b + 4] = k * 2 + 3;
      indexData[b + 5] = k * 2 + 2;
    }

    this.trailMesh = await Mesh.getAsync({
      attributes: {
        POSITION: new Float32Array(this.maxRenderVerts * 3) as any,
        NORMAL: new Float32Array(this.maxRenderVerts * 3) as any,
        TEXCOORD_0: new Float32Array(this.maxRenderVerts * 2) as any,
        TANGENT: new Float32Array(this.maxRenderVerts * 4) as any,
      },
      indices: indexData as any,
    } as any);

    this.trailMesh.setActiveIndexCount(0);

    this.trailMaterial = await Material.get(this.materialPath);
    this.transformComp = this.getOwner().getComponent('transform') as TransformComponent;

    const device = Render.getInstance().getDevice();
    this.indirectBuffer = device.createBuffer({
      label: 'trail-indirect',
      size: 20,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indirectBuffer, 0, new Uint32Array([0, 1, 0, 0, 0]));

    const emptyLayout = device.createBindGroupLayout({ label: 'trail-dummy-bgl', entries: [] });
    this.dummyBindGroup = device.createBindGroup({
      label: 'trail-dummy-bg',
      layout: emptyLayout,
      entries: [],
    });

    this.renderComp = new RenderComponent();
    this.renderComp.setOwner(this.getOwner());
    RenderManagerV2.getInstance().addKey(
      this.renderComp,
      this.trailMesh,
      this.trailMaterial,
      this.transformComp,
      false,
      1,
      undefined,
      this.dummyBindGroup,
      this.indirectBuffer,
    );
  }

  public reset(): void {
    this.head = 0;
    this.activeCount = 0;
    this.hasLastPos = false;
    this.emitting = true;
    this.enabled = true;
    if (this.indirectBuffer) {
      Render.getInstance()
        .getDevice()
        .queue.writeBuffer(this.indirectBuffer, 0, new Uint32Array([0, 1, 0, 0, 0]));
    }
  }

  public startEmitting(): void {
    this.emitting = true;
    this.enabled = true;
    this.hasLastPos = false;
  }

  public stopEmitting(): void {
    this.emitting = false;
  }

  public override update(dt: number): void {
    if (!this.trailMesh) return;

    // Lazy-resolve secondary transform on first update tick (entity-name mode only)
    if (!this.secondaryResolved && !this.bladeMode) this.resolveSecondary();

    const isDual = this.bladeMode || this.secondaryTransform !== null;

    if (this.emitting) {
      let posA: vec3;
      let posB: vec3 | null = null;

      if (this.bladeMode) {
        // Read Z column of world matrix — its length = scale_z = half-blade * 2.
        // This correctly computes tip (posA) and hilt (posB) regardless of child-transform scaling.
        const worldMat = this.transformComp.getTransform().getWorldMatrix();
        const zCol = vec3.fromValues(worldMat[8]!, worldMat[9]!, worldMat[10]!);
        const halfLen = vec3.length(zCol) * 0.5;
        const dir = vec3.scale(zCol, zCol, 1 / (halfLen * 2));
        const center = this.transformComp.getTransform().getWorldPosition();
        posA = vec3.scaleAndAdd(vec3.create(), center, dir, halfLen);   // tip
        posB = vec3.scaleAndAdd(vec3.create(), center, dir, -halfLen);  // hilt
      } else {
        posA = this.transformComp.getTransform().getWorldPosition();
        posB = this.secondaryTransform
          ? this.secondaryTransform.getTransform().getWorldPosition()
          : null;
      }

      if (!this.hasLastPos) {
        vec3.copy(this.lastPos, posA);
        this.hasLastPos = true;
      } else if (vec3.distance(posA, this.lastPos) >= this.minNodeDistance) {
        this.pushNode(posA, posB);
        vec3.copy(this.lastPos, posA);
      }
    }

    // Age every active node
    for (let i = 0; i < this.activeCount; i++) {
      const idx = (this.head - 1 - i + this.maxNodes) % this.maxNodes;
      this.nodes[idx]!.age += dt;
    }

    // Prune expired nodes from the tail
    while (this.activeCount > 0) {
      const tailIdx = (this.head - this.activeCount + this.maxNodes) % this.maxNodes;
      if (this.nodes[tailIdx]!.age >= this.nodeLifetime) {
        this.activeCount--;
      } else {
        break;
      }
    }

    if (this.activeCount < 2) {
      Render.getInstance()
        .getDevice()
        .queue.writeBuffer(this.indirectBuffer, 0, new Uint32Array([0, 1, 0, 0, 0]));
      if (!this.emitting && this.hasLastPos) this.enabled = false;
      return;
    }

    // Collect ordered positions [newest=0 … oldest=N-1]
    const count = this.activeCount;
    const posA: vec3[] = new Array(count);
    const posB: vec3[] = isDual ? new Array(count) : [];

    for (let i = 0; i < count; i++) {
      const idx = (this.head - 1 - i + this.maxNodes) % this.maxNodes;
      posA[i] = this.nodes[idx]!.pos;
      if (isDual) posB[i] = this.nodes[idx]!.posB;
    }

    // Catmull-Rom subdivision applied independently to both edge arrays
    let finalA: vec3[];
    let finalB: vec3[];
    if (this.trailType === 'spline' && count >= 3) {
      finalA = this.catmullRomSubdivide(posA);
      finalB = isDual ? this.catmullRomSubdivide(posB) : [];
    } else {
      finalA = posA;
      finalB = posB;
    }

    const N = finalA.length;

    if (isDual) {
      this.buildDualRibbonGeometry(finalA, finalB, N);
    } else {
      this.buildRibbonGeometry(finalA, this.getCameraWorldPos(), N);
    }

    this.trailMesh.writeVertexData(this.vertexCPU.subarray(0, N * 2 * VERTEX_STRIDE));
    const activeIndexCount = (N - 1) * 6;
    Render.getInstance()
      .getDevice()
      .queue.writeBuffer(this.indirectBuffer, 0, new Uint32Array([activeIndexCount, 1, 0, 0, 0]));
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private resolveSecondary(): void {
    this.secondaryResolved = true;
    if (!this.secondaryEntityName) return;
    try {
      const entity = Engine.getEntities().getEntityByName(this.secondaryEntityName);
      if (entity) {
        this.secondaryTransform = entity.getComponent('transform') as TransformComponent | null;
      }
    } catch {}
  }

  private pushNode(pos: vec3, posB: vec3 | null): void {
    const node = this.nodes[this.head]!;
    vec3.copy(node.pos, pos);
    if (posB) vec3.copy(node.posB, posB);
    node.age = 0;
    this.head = (this.head + 1) % this.maxNodes;
    this.activeCount = Math.min(this.activeCount + 1, this.maxNodes);
  }

  /**
   * Single-emitter mode: camera-facing ribbon of constant `width` centered on the emitter path.
   */
  private buildRibbonGeometry(positions: vec3[], cameraPos: vec3, N: number): void {
    const halfWidth = this.width * 0.5;

    for (let i = 0; i < N; i++) {
      const pos = positions[i]!;
      const t = N > 1 ? i / (N - 1) : 0;

      if (i < N - 1) {
        vec3.subtract(this.tempForward, positions[i]!, positions[i + 1]!);
      } else {
        vec3.subtract(this.tempForward, positions[N - 2]!, positions[N - 1]!);
      }
      const fwdLen = vec3.length(this.tempForward);
      if (fwdLen > 0.0001) vec3.scale(this.tempForward, this.tempForward, 1 / fwdLen);
      else vec3.set(this.tempForward, 0, 0, 1);

      vec3.subtract(this.tempCamDir, cameraPos, pos);
      const camLen = vec3.length(this.tempCamDir);
      if (camLen > 0.0001) vec3.scale(this.tempCamDir, this.tempCamDir, 1 / camLen);
      else vec3.set(this.tempCamDir, 0, 1, 0);

      vec3.cross(this.tempRight, this.tempCamDir, this.tempForward);
      const rightLen = vec3.length(this.tempRight);
      if (rightLen > 0.0001) vec3.scale(this.tempRight, this.tempRight, 1 / rightLen);
      else vec3.set(this.tempRight, 1, 0, 0);

      const r = this.startColor[0] + (this.endColor[0] - this.startColor[0]) * t;
      const g = this.startColor[1] + (this.endColor[1] - this.startColor[1]) * t;
      const b = this.startColor[2] + (this.endColor[2] - this.startColor[2]) * t;
      const a = this.startColor[3] + (this.endColor[3] - this.startColor[3]) * t;

      const li = i * 2 * VERTEX_STRIDE;
      this.vertexCPU[li + 0] = pos[0] - this.tempRight[0] * halfWidth;
      this.vertexCPU[li + 1] = pos[1] - this.tempRight[1] * halfWidth;
      this.vertexCPU[li + 2] = pos[2] - this.tempRight[2] * halfWidth;
      this.vertexCPU[li + 3] = 0;
      this.vertexCPU[li + 4] = 1;
      this.vertexCPU[li + 5] = 0;
      this.vertexCPU[li + 6] = 0;
      this.vertexCPU[li + 7] = t;
      this.vertexCPU[li + 8] = r;
      this.vertexCPU[li + 9] = g;
      this.vertexCPU[li + 10] = b;
      this.vertexCPU[li + 11] = a;

      const ri = (i * 2 + 1) * VERTEX_STRIDE;
      this.vertexCPU[ri + 0] = pos[0] + this.tempRight[0] * halfWidth;
      this.vertexCPU[ri + 1] = pos[1] + this.tempRight[1] * halfWidth;
      this.vertexCPU[ri + 2] = pos[2] + this.tempRight[2] * halfWidth;
      this.vertexCPU[ri + 3] = 0;
      this.vertexCPU[ri + 4] = 1;
      this.vertexCPU[ri + 5] = 0;
      this.vertexCPU[ri + 6] = 1;
      this.vertexCPU[ri + 7] = t;
      this.vertexCPU[ri + 8] = r;
      this.vertexCPU[ri + 9] = g;
      this.vertexCPU[ri + 10] = b;
      this.vertexCPU[ri + 11] = a;
    }
  }

  /**
   * Dual-emitter mode: each ribbon quad spans exactly from posA[i] to posB[i].
   * The ribbon covers the full distance between the two emitters (e.g. sword tip → hilt).
   * `width` is not used — the visual width is determined by the world-space gap between emitters.
   */
  private buildDualRibbonGeometry(positionsA: vec3[], positionsB: vec3[], N: number): void {
    for (let i = 0; i < N; i++) {
      const pA = positionsA[i]!;
      const pB = positionsB[i]!;
      const t = N > 1 ? i / (N - 1) : 0;

      // Normal: perpendicular to both blade direction and trail forward
      const bladeDir = vec3.sub(this.tempRight, pB, pA);
      const bladeDirLen = vec3.length(bladeDir);
      if (bladeDirLen > 0.0001) vec3.scale(bladeDir, bladeDir, 1 / bladeDirLen);
      else vec3.set(bladeDir, 1, 0, 0);

      const nextA = positionsA[Math.min(i + 1, N - 1)]!;
      vec3.sub(this.tempForward, pA, nextA);
      const fwdLen = vec3.length(this.tempForward);
      if (fwdLen > 0.0001) vec3.scale(this.tempForward, this.tempForward, 1 / fwdLen);
      else vec3.set(this.tempForward, 0, 0, 1);

      vec3.cross(this.tempCamDir, bladeDir, this.tempForward); // reuse tempCamDir as normal
      const nLen = vec3.length(this.tempCamDir);
      if (nLen > 0.0001) vec3.scale(this.tempCamDir, this.tempCamDir, 1 / nLen);
      else vec3.set(this.tempCamDir, 0, 1, 0);

      const nx = this.tempCamDir[0],
        ny = this.tempCamDir[1],
        nz = this.tempCamDir[2];

      const r = this.startColor[0] + (this.endColor[0] - this.startColor[0]) * t;
      const g = this.startColor[1] + (this.endColor[1] - this.startColor[1]) * t;
      const b = this.startColor[2] + (this.endColor[2] - this.startColor[2]) * t;
      const a = this.startColor[3] + (this.endColor[3] - this.startColor[3]) * t;

      // Edge A (primary emitter, uv.x = 0)
      const li = i * 2 * VERTEX_STRIDE;
      this.vertexCPU[li + 0] = pA[0];
      this.vertexCPU[li + 1] = pA[1];
      this.vertexCPU[li + 2] = pA[2];
      this.vertexCPU[li + 3] = nx;
      this.vertexCPU[li + 4] = ny;
      this.vertexCPU[li + 5] = nz;
      this.vertexCPU[li + 6] = 0;
      this.vertexCPU[li + 7] = t;
      this.vertexCPU[li + 8] = r;
      this.vertexCPU[li + 9] = g;
      this.vertexCPU[li + 10] = b;
      this.vertexCPU[li + 11] = a;

      // Edge B (secondary emitter, uv.x = 1)
      const ri = (i * 2 + 1) * VERTEX_STRIDE;
      this.vertexCPU[ri + 0] = pB[0];
      this.vertexCPU[ri + 1] = pB[1];
      this.vertexCPU[ri + 2] = pB[2];
      this.vertexCPU[ri + 3] = nx;
      this.vertexCPU[ri + 4] = ny;
      this.vertexCPU[ri + 5] = nz;
      this.vertexCPU[ri + 6] = 1;
      this.vertexCPU[ri + 7] = t;
      this.vertexCPU[ri + 8] = r;
      this.vertexCPU[ri + 9] = g;
      this.vertexCPU[ri + 10] = b;
      this.vertexCPU[ri + 11] = a;
    }
  }

  private catmullRomSubdivide(pts: vec3[]): vec3[] {
    const sub = this.splineSubdivisions;
    const result: vec3[] = [];
    const last = pts.length - 1;

    for (let i = 0; i < last; i++) {
      const p0 = pts[Math.max(0, i - 1)]!;
      const p1 = pts[i]!;
      const p2 = pts[i + 1]!;
      const p3 = pts[Math.min(last, i + 2)]!;

      for (let s = 0; s < sub; s++) {
        result.push(this.catmullRomPoint(p0, p1, p2, p3, s / sub));
      }
    }
    result.push(pts[last]!);
    return result;
  }

  private catmullRomPoint(p0: vec3, p1: vec3, p2: vec3, p3: vec3, t: number): vec3 {
    const t2 = t * t;
    const t3 = t2 * t;
    const out = vec3.create();
    for (let c = 0; c < 3; c++) {
      out[c] =
        0.5 *
        (2 * p1[c]! +
          (-p0[c]! + p2[c]!) * t +
          (2 * p0[c]! - 5 * p1[c]! + 4 * p2[c]! - p3[c]!) * t2 +
          (-p0[c]! + 3 * p1[c]! - 3 * p2[c]! + p3[c]!) * t3);
    }
    return out;
  }

  private getCameraWorldPos(): vec3 {
    try {
      const cam = Engine.getEntities().getEntityByName('MainCamera');
      const comp = cam?.getComponent('camera') as CameraComponent | null;
      if (comp) return comp.getCamera().getPosition();
    } catch {
      // fallback below
    }
    return vec3.fromValues(0, 100, 0);
  }

  public override dispose(): void {
    if (this.renderComp) {
      RenderManagerV2.getInstance().delKeys(this.renderComp);
    }
    this.indirectBuffer?.destroy();
  }

  public renderDebug(): void {}
}
