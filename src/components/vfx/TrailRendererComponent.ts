import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
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
  /** Width of the ribbon in world units. Default 0.1. */
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
}

// Interleaved vertex stride mirrors the engine mesh format (12 floats = 48 bytes)
const VERTEX_STRIDE = 12;

interface TrailNode {
  pos: vec3;
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

  // Ring buffer state
  private nodes: TrailNode[] = [];
  private head: number = 0;
  private activeCount: number = 0;

  // GPU resources
  private trailMesh!: Mesh;
  private trailMaterial!: Material;
  private renderComp!: RenderComponent;
  private transformComp!: TransformComponent;

  // CPU geometry scratch buffer (reused every frame, no alloc)
  private vertexCPU!: Float32Array;

  // Reusable vec3 temporaries (avoid per-frame alloc)
  private readonly tempForward = vec3.create();
  private readonly tempCamDir = vec3.create();
  private readonly tempRight = vec3.create();

  // Position tracking for node distance check
  private readonly lastPos = vec3.create();
  private hasLastPos = false;

  // Max render vertices (may exceed maxNodes for spline)
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

    // Pre-allocate ring buffer nodes (reuse objects every frame)
    this.nodes = Array.from({ length: this.maxNodes }, () => ({
      pos: vec3.create(),
      age: 0,
    }));

    // Maximum number of vertices the ribbon can produce
    // For spline: each gap between control nodes is subdivided
    const maxSplineNodes =
      this.trailType === 'spline'
        ? (this.maxNodes - 1) * this.splineSubdivisions + 1
        : this.maxNodes;
    this.maxRenderVerts = maxSplineNodes * 2;

    // CPU vertex scratch buffer (world-space ribbon, uploaded to GPU each frame)
    this.vertexCPU = new Float32Array(this.maxRenderVerts * VERTEX_STRIDE);

    // Pre-bake a fixed index buffer for the maximum ribbon size.
    // Triangle strip pattern for N nodes → N-1 quad segments:
    //   seg k → verts [2k, 2k+1, 2k+2, 2k+3] → 2 triangles
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

    // Create a dynamic mesh pre-allocated to max capacity.
    // The raw-array shape matches what Mesh.setData() actually consumes at runtime.
    this.trailMesh = await Mesh.getAsync({
      attributes: {
        POSITION: new Float32Array(this.maxRenderVerts * 3) as any,
        NORMAL: new Float32Array(this.maxRenderVerts * 3) as any,
        TEXCOORD_0: new Float32Array(this.maxRenderVerts * 2) as any,
        TANGENT: new Float32Array(this.maxRenderVerts * 4) as any,
      },
      indices: indexData as any,
    } as any);

    // Start with zero-index draw (invisible until data arrives)
    this.trailMesh.setActiveIndexCount(0);

    this.trailMaterial = await Material.get(this.materialPath);
    this.transformComp = this.getOwner().getComponent('transform') as TransformComponent;

    // Register once with the transparent render pipeline
    this.renderComp = new RenderComponent();
    this.renderComp.setOwner(this.getOwner());
    RenderManagerV2.getInstance().addKey(
      this.renderComp,
      this.trailMesh,
      this.trailMaterial,
      this.transformComp,
    );
  }

  /** Clear all trail nodes and hide the ribbon (no-op draw). */
  public reset(): void {
    this.head = 0;
    this.activeCount = 0;
    this.hasLastPos = false;
    if (this.trailMesh) this.trailMesh.setActiveIndexCount(0);
  }

  public override update(dt: number): void {
    if (!this.trailMesh) return;

    const ownerPos = this.transformComp.getTransform().getWorldPosition();

    // Record a new control node when the emitter has moved far enough
    if (!this.hasLastPos) {
      this.pushNode(ownerPos);
      vec3.copy(this.lastPos, ownerPos);
      this.hasLastPos = true;
    } else if (vec3.distance(ownerPos, this.lastPos) >= this.minNodeDistance) {
      this.pushNode(ownerPos);
      vec3.copy(this.lastPos, ownerPos);
    }

    // Age every active node
    for (let i = 0; i < this.activeCount; i++) {
      const idx = (this.head - 1 - i + this.maxNodes) % this.maxNodes;
      this.nodes[idx]!.age += dt;
    }

    // Prune expired nodes from the tail (oldest first)
    while (this.activeCount > 0) {
      const tailIdx = (this.head - this.activeCount + this.maxNodes) % this.maxNodes;
      if (this.nodes[tailIdx]!.age >= this.nodeLifetime) {
        this.activeCount--;
      } else {
        break;
      }
    }

    if (this.activeCount < 2) {
      this.trailMesh.setActiveIndexCount(0);
      return;
    }

    // Collect ordered positions [newest=0 … oldest=N-1]
    const count = this.activeCount;
    const controlPositions: vec3[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const idx = (this.head - 1 - i + this.maxNodes) % this.maxNodes;
      controlPositions[i] = this.nodes[idx]!.pos;
    }

    // Apply Catmull-Rom subdivision for spline trails
    const finalPositions: vec3[] =
      this.trailType === 'spline' && count >= 3
        ? this.catmullRomSubdivide(controlPositions)
        : controlPositions;

    const cameraPos = this.getCameraWorldPos();
    const N = finalPositions.length;

    this.buildRibbonGeometry(finalPositions, cameraPos, N);

    this.trailMesh.writeVertexData(this.vertexCPU.subarray(0, N * 2 * VERTEX_STRIDE));
    this.trailMesh.setActiveIndexCount((N - 1) * 6);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private pushNode(pos: vec3): void {
    const node = this.nodes[this.head]!;
    vec3.copy(node.pos, pos);
    node.age = 0;
    this.head = (this.head + 1) % this.maxNodes;
    this.activeCount = Math.min(this.activeCount + 1, this.maxNodes);
  }

  private buildRibbonGeometry(positions: vec3[], cameraPos: vec3, N: number): void {
    const halfWidth = this.width * 0.5;

    for (let i = 0; i < N; i++) {
      const pos = positions[i]!;
      // t: 0 = newest (head), 1 = oldest (tail)
      const t = N > 1 ? i / (N - 1) : 0;

      // Forward direction along the trail (pointing from current to next node)
      if (i < N - 1) {
        vec3.subtract(this.tempForward, positions[i]!, positions[i + 1]!);
      } else {
        vec3.subtract(this.tempForward, positions[N - 2]!, positions[N - 1]!);
      }
      const fwdLen = vec3.length(this.tempForward);
      if (fwdLen > 0.0001) {
        vec3.scale(this.tempForward, this.tempForward, 1 / fwdLen);
      } else {
        vec3.set(this.tempForward, 0, 0, 1);
      }

      // Camera-perpendicular right vector — makes the ribbon face the camera
      vec3.subtract(this.tempCamDir, cameraPos, pos);
      const camLen = vec3.length(this.tempCamDir);
      if (camLen > 0.0001) {
        vec3.scale(this.tempCamDir, this.tempCamDir, 1 / camLen);
      } else {
        vec3.set(this.tempCamDir, 0, 1, 0);
      }

      vec3.cross(this.tempRight, this.tempCamDir, this.tempForward);
      const rightLen = vec3.length(this.tempRight);
      if (rightLen > 0.0001) {
        vec3.scale(this.tempRight, this.tempRight, 1 / rightLen);
      } else {
        vec3.set(this.tempRight, 1, 0, 0);
      }

      // Interpolate color (startColor → endColor as t goes 0 → 1)
      const r = this.startColor[0] + (this.endColor[0] - this.startColor[0]) * t;
      const g = this.startColor[1] + (this.endColor[1] - this.startColor[1]) * t;
      const b = this.startColor[2] + (this.endColor[2] - this.startColor[2]) * t;
      const a = this.startColor[3] + (this.endColor[3] - this.startColor[3]) * t;

      // Left vertex: pos - right * halfWidth  (uv.x = 0)
      const li = i * 2 * VERTEX_STRIDE;
      this.vertexCPU[li + 0] = pos[0] - this.tempRight[0] * halfWidth;
      this.vertexCPU[li + 1] = pos[1] - this.tempRight[1] * halfWidth;
      this.vertexCPU[li + 2] = pos[2] - this.tempRight[2] * halfWidth;
      this.vertexCPU[li + 3] = 0; // normal.x
      this.vertexCPU[li + 4] = 1; // normal.y
      this.vertexCPU[li + 5] = 0; // normal.z
      this.vertexCPU[li + 6] = 0; // uv.x = left edge
      this.vertexCPU[li + 7] = t; // uv.y = position along trail
      this.vertexCPU[li + 8] = r;
      this.vertexCPU[li + 9] = g;
      this.vertexCPU[li + 10] = b;
      this.vertexCPU[li + 11] = a;

      // Right vertex: pos + right * halfWidth  (uv.x = 1)
      const ri = (i * 2 + 1) * VERTEX_STRIDE;
      this.vertexCPU[ri + 0] = pos[0] + this.tempRight[0] * halfWidth;
      this.vertexCPU[ri + 1] = pos[1] + this.tempRight[1] * halfWidth;
      this.vertexCPU[ri + 2] = pos[2] + this.tempRight[2] * halfWidth;
      this.vertexCPU[ri + 3] = 0;
      this.vertexCPU[ri + 4] = 1;
      this.vertexCPU[ri + 5] = 0;
      this.vertexCPU[ri + 6] = 1; // uv.x = right edge
      this.vertexCPU[ri + 7] = t;
      this.vertexCPU[ri + 8] = r;
      this.vertexCPU[ri + 9] = g;
      this.vertexCPU[ri + 10] = b;
      this.vertexCPU[ri + 11] = a;
    }
  }

  /**
   * Catmull-Rom spline subdivision.
   * Produces (N-1)*subdivisions + 1 smooth points from N control points.
   */
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
  }

  public renderDebug(): void {}
}
