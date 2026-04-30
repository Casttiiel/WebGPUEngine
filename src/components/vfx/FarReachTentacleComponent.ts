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
import { ArcaneKnightControllerComponent } from '../game/ArcaneKnightControllerComponent';
import type { GrappleSystem } from '../game/movement/GrappleSystem';

// Interleaved vertex stride mirrors the engine mesh format (12 floats = 48 bytes):
//   offset  0 : position  (float32x3)
//   offset  3 : normal    (float32x3)
//   offset  6 : uv        (float32x2)
//   offset  8 : color     (float32x4)  — packed in the tangent slot
const VERTEX_STRIDE = 12;

export interface FarReachTentacleData {
  /** Number of ribbon control points. Default 14. */
  segments?: number;
  /** Maximum ribbon width at the centre (world units). Default 0.12. */
  width?: number;
  /** Wobble spatial frequency (oscillations per unit of tentacle length). Default 5. */
  wobbleFreq?: number;
  /** Maximum wobble displacement (world units). Default 0.18. */
  wobbleAmplitude?: number;
  /** Animation speed of the wobble (radians/second). Default 12. */
  wobbleAnimSpeed?: number;
  /** RGBA head colour. Default [0.4, 0.9, 1.0, 1.0] (cyan). */
  color?: number[];
  /** Material path. Default 'far_reach.mat'. */
  material?: string;
}

/**
 * FarReachTentacleComponent — Procedural ribbon VFX for the Far Reach ability.
 *
 * Renders a camera-facing sinusoidal ribbon from the player to the grapple target.
 * Reuses the trail vertex format and trail/trail.tech shader pipeline.
 *
 * Phase behaviour:
 *  REACHING — tentacle grows from player toward the target (driven by reach progress 0→1).
 *  PULLING  — start follows the live player position; end is fixed at the target.
 *             The tentacle shrinks naturally as the player flies toward the point.
 *  INACTIVE — invisible (indirectBuffer index count = 0).
 */
export class FarReachTentacleComponent extends Component {
  // ── Parameters ────────────────────────────────────────────────────────────
  private segments: number = 14;
  private maxHalfWidth: number = 0.06;
  private wobbleFreq: number = 5;
  private wobbleAmplitude: number = 0.18;
  private wobbleAnimSpeed: number = 12;
  private color: [number, number, number, number] = [0.4, 0.9, 1.0, 1.0];
  private materialPath: string = 'far_reach.mat';

  // ── Runtime state ─────────────────────────────────────────────────────────
  private time: number = 0;
  private initialDist: number = 0;
  private wasActive: boolean = false;

  // ── GPU resources ─────────────────────────────────────────────────────────
  private tentacleMesh!: Mesh;
  private tentacleMaterial!: Material;
  private renderComp!: RenderComponent;
  private indirectBuffer!: GPUBuffer;
  private dummyBindGroup!: GPUBindGroup;

  // ── CPU scratch (pre-allocated — zero per-frame heap allocs) ──────────────
  private vertexCPU!: Float32Array;

  // ── References ────────────────────────────────────────────────────────────
  private grapple: GrappleSystem | null = null;
  private transformComp!: TransformComponent;

  // ── Reusable vec3 temporaries ─────────────────────────────────────────────
  private readonly tmpLine = vec3.create();
  private readonly tmpLineDir = vec3.create();
  private readonly tmpPerp1 = vec3.create();
  private readonly tmpPerp2 = vec3.create();
  private readonly tmpUp = vec3.fromValues(0, 1, 0);
  private readonly tmpCamDir = vec3.create();
  private readonly tmpRight = vec3.create();
  private readonly tmpPos = vec3.create();

  public async load(data: FarReachTentacleData): Promise<void> {
    this.segments = Math.max(4, data.segments ?? 14);
    this.maxHalfWidth = (data.width ?? 0.12) * 0.5;
    this.wobbleFreq = data.wobbleFreq ?? 5;
    this.wobbleAmplitude = data.wobbleAmplitude ?? 0.18;
    this.wobbleAnimSpeed = data.wobbleAnimSpeed ?? 12;
    this.color = (data.color as [number, number, number, number]) ?? [0.4, 0.9, 1.0, 1.0];
    this.materialPath = data.material ?? 'far_reach.mat';

    const N = this.segments;
    const maxVerts = N * 2;

    // CPU vertex scratch
    this.vertexCPU = new Float32Array(maxVerts * VERTEX_STRIDE);

    // Pre-bake fixed index buffer: (N-1) quad segments, 6 indices each
    const maxSegments = N - 1;
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

    // Dynamic mesh pre-allocated to max capacity
    this.tentacleMesh = await Mesh.getAsync({
      attributes: {
        POSITION: new Float32Array(maxVerts * 3) as any,
        NORMAL: new Float32Array(maxVerts * 3) as any,
        TEXCOORD_0: new Float32Array(maxVerts * 2) as any,
        TANGENT: new Float32Array(maxVerts * 4) as any,
      },
      indices: indexData as any,
    } as any);

    this.tentacleMesh.setActiveIndexCount(0);

    this.tentacleMaterial = await Material.get(this.materialPath);
    this.transformComp = this.getOwner().getComponent('transform') as TransformComponent;

    const device = Render.getInstance().getDevice();

    // Self-managed indirect draw buffer — prevents GPUCullingManager from hijacking the draw call
    this.indirectBuffer = device.createBuffer({
      label: 'far-reach-tentacle-indirect',
      size: 20,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indirectBuffer, 0, new Uint32Array([0, 1, 0, 0, 0]));

    // Empty bind group at group 3 — signals to RenderManagerV2 that this key owns its indirect buffer
    const emptyLayout = device.createBindGroupLayout({
      label: 'far-reach-tentacle-dummy-bgl',
      entries: [],
    });
    this.dummyBindGroup = device.createBindGroup({
      label: 'far-reach-tentacle-dummy-bg',
      layout: emptyLayout,
      entries: [],
    });

    this.renderComp = new RenderComponent();
    this.renderComp.setOwner(this.getOwner());
    RenderManagerV2.getInstance().addKey(
      this.renderComp,
      this.tentacleMesh,
      this.tentacleMaterial,
      this.transformComp,
      false, // isInstanced
      1,
      undefined,
      this.dummyBindGroup,
      this.indirectBuffer,
    );

    // Resolve GrappleSystem from the controller on the same entity
    const controller = this.getOwner().getComponent(
      'arcane_knight_controller',
    ) as ArcaneKnightControllerComponent | null;
    this.grapple = controller?.getGrappleSystem() ?? null;

    if (!this.grapple) {
      console.warn('FarReachTentacleComponent: arcane_knight_controller not found on entity.');
    }
  }

  public override update(dt: number): void {
    if (!this.tentacleMesh || !this.grapple) return;

    this.time += dt;

    const active = this.grapple.isActive();

    if (!active) {
      if (this.wasActive) {
        // Hide immediately on deactivation
        Render.getInstance()
          .getDevice()
          .queue.writeBuffer(this.indirectBuffer, 0, new Uint32Array([0, 1, 0, 0, 0]));
        this.wasActive = false;
        this.initialDist = 0;
      }
      return;
    }

    const pulling = this.grapple.isPulling();
    const targetPos = this.grapple.getTargetPoint();

    // Start = current player position during PULLING (tentacle shrinks naturally),
    //         fixed activation position during REACHING.
    const startPos: vec3 = pulling
      ? this.transformComp.getTransform().getWorldPosition()
      : this.grapple.getStartPoint();

    // Capture initial distance the first time we see the grapple active
    if (!this.wasActive) {
      this.initialDist = vec3.distance(startPos, targetPos);
      this.wasActive = true;
    }

    // Number of points to draw:
    // REACHING — grows from 2 to N as progress goes 0→1
    // PULLING  — always N (tentacle shrinks as start follows player)
    const progress = this.grapple.getReachProgress();
    const activeN = pulling
      ? this.segments
      : Math.max(2, Math.round(progress * (this.segments - 1)) + 1);

    this.buildGeometry(startPos, targetPos, activeN, pulling);

    this.tentacleMesh.writeVertexData(this.vertexCPU.subarray(0, activeN * 2 * VERTEX_STRIDE));
    const indexCount = (activeN - 1) * 6;
    Render.getInstance()
      .getDevice()
      .queue.writeBuffer(this.indirectBuffer, 0, new Uint32Array([indexCount, 1, 0, 0, 0]));
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private buildGeometry(start: vec3, target: vec3, N: number, pulling: boolean): void {
    vec3.subtract(this.tmpLine, target, start);
    const totalLen = vec3.length(this.tmpLine);
    if (totalLen < 0.001) return;

    // Normalised line direction
    vec3.scale(this.tmpLineDir, this.tmpLine, 1 / totalLen);

    // Two world-space axes perpendicular to the line — used for wobble
    vec3.cross(this.tmpPerp1, this.tmpLineDir, this.tmpUp);
    if (vec3.length(this.tmpPerp1) < 0.001) {
      vec3.set(this.tmpPerp1, 1, 0, 0); // line is nearly vertical — fallback to world X
    } else {
      vec3.normalize(this.tmpPerp1, this.tmpPerp1);
    }
    vec3.cross(this.tmpPerp2, this.tmpLineDir, this.tmpPerp1);
    vec3.normalize(this.tmpPerp2, this.tmpPerp2);

    // Camera position for billboard orientation
    const cameraPos = this.getCameraWorldPos();

    // Alpha: full during REACHING; fades as the tentacle shrinks during PULLING
    const baseAlpha = pulling ? Math.min(1, totalLen / Math.max(this.initialDist, 0.001)) : 1.0;

    const [r, g, b, a0] = this.color;

    for (let i = 0; i < N; i++) {
      const t = N > 1 ? i / (N - 1) : 0;

      // Base position: linear interpolation along the line
      this.tmpPos[0] = start[0] + this.tmpLine[0] * t;
      this.tmpPos[1] = start[1] + this.tmpLine[1] * t;
      this.tmpPos[2] = start[2] + this.tmpLine[2] * t;

      // Sinusoidal wobble with bell-curve envelope (0 at endpoints, max at centre)
      const envelope = Math.sin(t * Math.PI);
      const phase1 = t * totalLen * this.wobbleFreq + this.time * this.wobbleAnimSpeed;
      const phase2 = phase1 + Math.PI * 0.5; // 90° offset for second axis
      const w1 = Math.sin(phase1) * this.wobbleAmplitude * envelope;
      const w2 = Math.sin(phase2) * this.wobbleAmplitude * 0.4 * envelope;

      this.tmpPos[0] += this.tmpPerp1[0] * w1 + this.tmpPerp2[0] * w2;
      this.tmpPos[1] += this.tmpPerp1[1] * w1 + this.tmpPerp2[1] * w2;
      this.tmpPos[2] += this.tmpPerp1[2] * w1 + this.tmpPerp2[2] * w2;

      // Ribbon width: gaussian bell (0 at endpoints, maxHalfWidth at centre)
      const halfWidth = this.maxHalfWidth * envelope;

      // Camera-facing right vector for the billboard
      vec3.subtract(this.tmpCamDir, cameraPos, this.tmpPos);
      const camLen = vec3.length(this.tmpCamDir);
      if (camLen > 0.0001) {
        vec3.scale(this.tmpCamDir, this.tmpCamDir, 1 / camLen);
      } else {
        vec3.set(this.tmpCamDir, 0, 1, 0);
      }
      vec3.cross(this.tmpRight, this.tmpCamDir, this.tmpLineDir);
      const rightLen = vec3.length(this.tmpRight);
      if (rightLen > 0.0001) {
        vec3.scale(this.tmpRight, this.tmpRight, 1 / rightLen);
      } else {
        vec3.set(this.tmpRight, 1, 0, 0);
      }

      const a = a0 * baseAlpha;

      // Left vertex (uv.x = 0)
      const li = i * 2 * VERTEX_STRIDE;
      this.vertexCPU[li + 0] = this.tmpPos[0] - this.tmpRight[0] * halfWidth;
      this.vertexCPU[li + 1] = this.tmpPos[1] - this.tmpRight[1] * halfWidth;
      this.vertexCPU[li + 2] = this.tmpPos[2] - this.tmpRight[2] * halfWidth;
      this.vertexCPU[li + 3] = 0;
      this.vertexCPU[li + 4] = 1;
      this.vertexCPU[li + 5] = 0;
      this.vertexCPU[li + 6] = 0; // uv.x = left edge
      this.vertexCPU[li + 7] = t; // uv.y = position along tentacle
      this.vertexCPU[li + 8] = r;
      this.vertexCPU[li + 9] = g;
      this.vertexCPU[li + 10] = b;
      this.vertexCPU[li + 11] = a;

      // Right vertex (uv.x = 1)
      const ri = (i * 2 + 1) * VERTEX_STRIDE;
      this.vertexCPU[ri + 0] = this.tmpPos[0] + this.tmpRight[0] * halfWidth;
      this.vertexCPU[ri + 1] = this.tmpPos[1] + this.tmpRight[1] * halfWidth;
      this.vertexCPU[ri + 2] = this.tmpPos[2] + this.tmpRight[2] * halfWidth;
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

  private getCameraWorldPos(): vec3 {
    try {
      const cam = Engine.getEntities().getEntityByName('MainCamera');
      const comp = cam?.getComponent('camera') as CameraComponent | null;
      if (comp) return comp.getCamera().getPosition();
    } catch {
      // fallback
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
