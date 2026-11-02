import { mat4, vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { SkeletalMeshComponent } from './SkeletalMeshComponent';
import { AnimatorComponent } from './AnimatorComponent';
import { SkinnedMesh } from '../../renderer/resources/SkinnedMesh';
import { Material } from '../../renderer/resources/Material';
import { RenderManagerV2 } from '../../renderer/core/managers/RenderManagerV2';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { RenderCategory } from '../../types/RenderCategory.enum';

export interface CapeColliderData {
  from: string;
  to: string;
  radius: number;
}

export interface CapeComponentData {
  /** Bone the whole cape is anchored to (inertia + pin centre). */
  anchorBone?: string;
  /** Bones the outer ends of the top edge follow (shoulders). */
  leftBone?: string;
  rightBone?: string;
  /** Centre of the top edge in bind-pose model space (Y up, character faces +Z). */
  top?: [number, number, number];
  topWidth?: number;
  bottomWidth?: number;
  length?: number;
  /** How far the top corners wrap forward around the shoulders (m). */
  wrap?: number;
  /** Vertical pleats baked into the rest shape: count across the width and depth (m) at the hem. */
  folds?: number;
  foldDepth?: number;
  /** Particle grid (columns × rows ≤ 128, one bone per particle). */
  columns?: number;
  rows?: number;
  /** Render subdivisions per particle cell. */
  subdivisions?: number;
  thickness?: number;

  color?: [number, number, number];
  roughness?: number;

  gravity?: number;
  /** Air drag per second. */
  drag?: number;
  /** 0 = moves rigidly with the body, 1 = fully world-space (maximum lag/swing). */
  inertia?: number;
  /** Speed limit (m/s) so dashes and root-motion lunges don't fling the cloth. */
  maxSpeed?: number;
  iterations?: number;
  /** Max stretch over rest length along each column (long-range attachment). */
  maxStretch?: number;
  bendStiffness?: number;
  shearStiffness?: number;
  wind?: [number, number, number];
  windTurbulence?: number;

  colliders?: CapeColliderData[];
  colliderRadiusScale?: number;
}

const MAX_JOINTS = 128;
const MAT4_BYTES = 64;
const SUBSTEP_HZ = 120;
const MAX_SUBSTEPS = 6;
const TELEPORT_DISTANCE = 3;

// Mannequin (UE skeleton) body proxies, radii fitted to the Shardplate armor.
const DEFAULT_COLLIDERS: CapeColliderData[] = [
  { from: 'pelvis', to: 'spine_02', radius: 0.17 },
  { from: 'spine_02', to: 'neck_01', radius: 0.19 },
  { from: 'neck_01', to: 'Head', radius: 0.11 },
  { from: 'thigh_l', to: 'calf_l', radius: 0.12 },
  { from: 'thigh_r', to: 'calf_r', radius: 0.12 },
  { from: 'calf_l', to: 'foot_l', radius: 0.09 },
  { from: 'calf_r', to: 'foot_r', radius: 0.09 },
  { from: 'upperarm_l', to: 'lowerarm_l', radius: 0.09 },
  { from: 'upperarm_r', to: 'lowerarm_r', radius: 0.09 },
  { from: 'lowerarm_l', to: 'hand_l', radius: 0.07 },
  { from: 'lowerarm_r', to: 'hand_r', radius: 0.07 },
];

interface Collider {
  a: number;
  b: number;
  radius: number;
  // World endpoints: previous frame and current frame (lerped across substeps)
  prevA: vec3;
  prevB: vec3;
  curA: vec3;
  curB: vec3;
}

interface Constraint {
  i: number;
  j: number;
  rest: number;
  stiffness: number;
}

/**
 * CapeComponent — bone-driven cloth (the "Kawaii Physics / AnimDynamics" approach).
 *
 * A grid of particles is simulated with Verlet + PBD distance constraints; each particle is a
 * bone of a procedurally built two-sided cape mesh with its own joint palette. The top row is
 * pinned to the animated skeleton, the rest collides with capsules on the body bones.
 *
 * Rendering reuses the skinned gbuffer path untouched, so shadows, velocity and TSR work as
 * they do for any character. Must update after 'animator' so it reads this frame's pose.
 */
export class CapeComponent extends Component {
  // ── Config ───────────────────────────────────────────────────────────────────
  private anchorBone = 'spine_03';
  private leftBone = 'clavicle_l';
  private rightBone = 'clavicle_r';
  private top: [number, number, number] = [0, 1.47, -0.2];
  private topWidth = 0.44;
  private bottomWidth = 0.85;
  private length = 1.2;
  private wrap = 0.1;
  private folds = 3;
  private foldDepth = 0.045;
  private columns = 11;
  private rows = 11;
  private subdivisions = 3;
  private thickness = 0.012;
  private color: [number, number, number] = [0.32, 0.03, 0.04];
  private roughness = 0.85;

  public gravity = 9.81;
  public drag = 1.2;
  public inertia = 0.55;
  public maxSpeed = 9;
  public iterations = 6;
  public maxStretch = 1.04;
  public bendStiffness = 0.15;
  public shearStiffness = 0.6;
  public wind: [number, number, number] = [0, 0, 0];
  public windTurbulence = 0.6;
  public colliderRadiusScale = 1;
  private colliderData: CapeColliderData[] = DEFAULT_COLLIDERS;

  // ── Runtime ──────────────────────────────────────────────────────────────────
  private animator: AnimatorComponent | null = null;
  private skeletal: SkeletalMeshComponent | null = null;
  private transform: TransformComponent | null = null;
  private material: Material | null = null;
  private mesh: SkinnedMesh | null = null;

  private count = 0;
  private pos = new Float32Array(0);
  private prev = new Float32Array(0);
  private restPos = new Float32Array(0); // bind-pose model space
  private invRestFrames: mat4[] = [];
  private pinned: { idx: number; bones: number[]; weights: number[] }[] = [];
  private pinPrev = new Float32Array(0);
  private pinCur = new Float32Array(0);
  private constraints: Constraint[] = [];
  private columnRest = new Float32Array(0); // rest distance from each particle to its column's pin
  private colliders: Collider[] = [];

  private readonly ibmViews = new Map<number, mat4>();
  private anchorIdx = -1;
  private anchorPrev = mat4.create();
  private anchorCur = mat4.create();
  private initialized = false;
  private time = 0;

  private palette = new Float32Array(MAX_JOINTS * 16);
  private previousPalette = new Float32Array(MAX_JOINTS * 16);
  private jointBuffer!: GPUBuffer;
  private previousJointBuffer!: GPUBuffer;
  private skinBindGroup!: GPUBindGroup;
  private velocitySkinPairBindGroup!: GPUBindGroup;

  private readonly _m = mat4.create();
  private readonly _m2 = mat4.create();
  private readonly _invWorld = mat4.create();
  private readonly _v = vec3.create();
  private readonly _v2 = vec3.create();
  private readonly _x = vec3.create();
  private readonly _y = vec3.create();
  private readonly _z = vec3.create();
  private readonly _a = vec3.create();
  private readonly _b = vec3.create();

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  public async load(data: CapeComponentData): Promise<void> {
    if (data.anchorBone) this.anchorBone = data.anchorBone;
    if (data.leftBone) this.leftBone = data.leftBone;
    if (data.rightBone) this.rightBone = data.rightBone;
    if (data.top) this.top = data.top;
    if (data.topWidth !== undefined) this.topWidth = data.topWidth;
    if (data.bottomWidth !== undefined) this.bottomWidth = data.bottomWidth;
    if (data.length !== undefined) this.length = data.length;
    if (data.wrap !== undefined) this.wrap = data.wrap;
    if (data.folds !== undefined) this.folds = data.folds;
    if (data.foldDepth !== undefined) this.foldDepth = data.foldDepth;
    if (data.columns !== undefined) this.columns = data.columns;
    if (data.rows !== undefined) this.rows = data.rows;
    if (data.subdivisions !== undefined) this.subdivisions = data.subdivisions;
    if (data.thickness !== undefined) this.thickness = data.thickness;
    if (data.color) this.color = data.color;
    if (data.roughness !== undefined) this.roughness = data.roughness;
    if (data.gravity !== undefined) this.gravity = data.gravity;
    if (data.drag !== undefined) this.drag = data.drag;
    if (data.inertia !== undefined) this.inertia = data.inertia;
    if (data.maxSpeed !== undefined) this.maxSpeed = data.maxSpeed;
    if (data.iterations !== undefined) this.iterations = data.iterations;
    if (data.maxStretch !== undefined) this.maxStretch = data.maxStretch;
    if (data.bendStiffness !== undefined) this.bendStiffness = data.bendStiffness;
    if (data.shearStiffness !== undefined) this.shearStiffness = data.shearStiffness;
    if (data.wind) this.wind = data.wind;
    if (data.windTurbulence !== undefined) this.windTurbulence = data.windTurbulence;
    if (data.colliders) this.colliderData = data.colliders;
    if (data.colliderRadiusScale !== undefined) this.colliderRadiusScale = data.colliderRadiusScale;

    if (this.columns * this.rows > MAX_JOINTS) {
      console.warn(`[Cape] ${this.columns}x${this.rows} exceeds ${MAX_JOINTS} bones, clamping rows`);
      this.rows = Math.floor(MAX_JOINTS / this.columns);
    }
    this.count = this.columns * this.rows;
    this.buildRestGrid();
    this.buildConstraints();

    this.material = await Material.get({
      technique: 'gbuffer/gbuffer_skinned.tech',
      category: RenderCategory.SOLIDS,
      casts_shadows: true,
      textures: {
        txAlbedo: 'white.png',
        txNormal: 'no-normal.jpg',
        txMetallic: 'white.png',
        txRoughness: 'white.png',
        txEmissive: 'black.png',
      },
      baseColorFactor: [...this.color, 1],
      metallicFactor: 0,
      roughnessFactor: this.roughness,
      emissiveFactor: 0,
    } as any);

    this.mesh = this.buildMesh();
    await this.mesh.loadAsync();
    this.createGpuBuffers();
  }

  public override async onAttach(): Promise<void> {
    this.animator = this.getOwner().getComponent('animator') as AnimatorComponent | null;
    this.skeletal = this.getOwner().getComponent('skeletal_mesh') as SkeletalMeshComponent | null;
    this.transform = this.getOwner().getComponent('transform') as TransformComponent | null;
    if (!this.animator || !this.skeletal || !this.transform) {
      console.error('[Cape] needs transform + skeletal_mesh + animator on the same entity');
      return;
    }
    RenderManagerV2.getInstance().addKey(
      this as any,
      this.mesh as any,
      this.material!,
      this.transform,
      false,
      1,
      undefined,
      this.skinBindGroup,
    );
  }

  public update(dt: number): void {
    if (!this.animator || !this.transform || dt <= 0) return;
    if (!this.initialized && !this.tryInitialize()) return;
    if (this.animator.isPaused()) return; // hit stop: cloth freezes with the pose

    dt = Math.min(dt, 1 / 20);
    this.time += dt;

    this.readAnchor(this.anchorCur);
    const ax = this.anchorCur[12]! - this.anchorPrev[12]!;
    const ay = this.anchorCur[13]! - this.anchorPrev[13]!;
    const az = this.anchorCur[14]! - this.anchorPrev[14]!;
    if (ax * ax + ay * ay + az * az > TELEPORT_DISTANCE * TELEPORT_DISTANCE) {
      this.resetToPose();
      this.uploadPalette();
      return;
    }

    this.applyInertia();
    this.updatePins(this.pinCur);
    this.updateColliders();

    const substeps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dt * SUBSTEP_HZ)));
    const h = dt / substeps;
    for (let s = 1; s <= substeps; s++) this.step(h, s / substeps);

    mat4.copy(this.anchorPrev, this.anchorCur);
    this.pinPrev.set(this.pinCur);
    for (const c of this.colliders) {
      vec3.copy(c.prevA, c.curA);
      vec3.copy(c.prevB, c.curB);
    }
    this.uploadPalette();
  }

  public override renderDebug(): void {}

  public override dispose(): void {
    RenderManagerV2.getInstance().delKeys(this as any);
    this.jointBuffer?.destroy();
    this.previousJointBuffer?.destroy();
  }

  // Duck-typed by VelocityBufferManager to identify skinned render keys.
  public getVelocitySkinPairBindGroup(): GPUBindGroup {
    return this.velocitySkinPairBindGroup;
  }

  // ── Setup ────────────────────────────────────────────────────────────────────

  /** Rest grid in bind-pose model space: a trapezoid hanging down the back, top wrapping the shoulders. */
  private buildRestGrid(): void {
    const C = this.columns;
    const R = this.rows;
    this.restPos = new Float32Array(this.count * 3);
    for (let r = 0; r < R; r++) {
      const t = r / (R - 1);
      const width = this.topWidth + (this.bottomWidth - this.topWidth) * t;
      const wrap = this.wrap * (1 - t) * (1 - t);
      // Pleats open up towards the hem, like fabric gathered at the shoulders
      const fold = this.foldDepth * (0.25 + 0.75 * t);
      for (let c = 0; c < C; c++) {
        const u = c / (C - 1) * 2 - 1; // -1..1
        const i = (r * C + c) * 3;
        this.restPos[i] = this.top[0] + u * width * 0.5;
        this.restPos[i + 1] = this.top[1] - t * this.length;
        this.restPos[i + 2] =
          this.top[2] + wrap * u * u - 0.04 * t + fold * Math.sin((u + 1) * Math.PI * this.folds);
      }
    }
    this.invRestFrames = [];
    const frame = mat4.create();
    for (let k = 0; k < this.count; k++) {
      this.computeFrame(this.restPos, k, frame);
      this.invRestFrames.push(mat4.invert(mat4.create(), frame));
    }
    this.pos = new Float32Array(this.count * 3);
    this.prev = new Float32Array(this.count * 3);
    this.pinPrev = new Float32Array(C * 3);
    this.pinCur = new Float32Array(C * 3);
  }

  private buildConstraints(): void {
    const C = this.columns;
    const R = this.rows;
    const P = this.restPos;
    const dist = (i: number, j: number): number =>
      Math.hypot(P[i * 3]! - P[j * 3]!, P[i * 3 + 1]! - P[j * 3 + 1]!, P[i * 3 + 2]! - P[j * 3 + 2]!);
    const add = (i: number, j: number, stiffness: number): void => {
      this.constraints.push({ i, j, rest: dist(i, j), stiffness });
    };
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const k = r * C + c;
        if (c + 1 < C) add(k, k + 1, 1);
        if (r + 1 < R) add(k, k + C, 1);
        if (c + 1 < C && r + 1 < R) {
          add(k, k + C + 1, this.shearStiffness);
          add(k + 1, k + C, this.shearStiffness);
        }
        if (c + 2 < C) add(k, k + 2, this.bendStiffness);
        if (r + 2 < R) add(k, k + 2 * C, this.bendStiffness);
      }
    }
    this.columnRest = new Float32Array(this.count);
    for (let c = 0; c < C; c++) {
      let acc = 0;
      for (let r = 1; r < R; r++) {
        acc += dist((r - 1) * C + c, r * C + c);
        this.columnRest[r * C + c] = acc;
      }
    }
  }

  /**
   * Two sheets (outer + inner, offset by `thickness`) so the cape renders from both sides with
   * back-face culling. Each vertex is bilinearly weighted to the 4 particles of its cell.
   */
  private buildMesh(): SkinnedMesh {
    const C = this.columns;
    const R = this.rows;
    const S = this.subdivisions;
    const VC = (C - 1) * S + 1;
    const VR = (R - 1) * S + 1;
    const perSheet = VC * VR;
    const N = perSheet * 2;
    const positions = new Float32Array(N * 3);
    const normals = new Float32Array(N * 3);
    const uvs = new Float32Array(N * 2);
    const joints = new Uint8Array(N * 4);
    const weights = new Float32Array(N * 4);
    const indices = new Uint32Array((VC - 1) * (VR - 1) * 6 * 2);

    const P = this.restPos;
    const normalAt = (k: number, out: vec3): vec3 => {
      const m = this.invRestFrames[k]!;
      // Rest frame Z is the outward normal; the inverse's third row holds it
      return vec3.normalize(out, vec3.set(out, m[2]!, m[6]!, m[10]!));
    };
    const n00 = vec3.create(), n10 = vec3.create(), n01 = vec3.create(), n11 = vec3.create();

    for (let sheet = 0; sheet < 2; sheet++) {
      const sign = sheet === 0 ? 1 : -1;
      for (let vr = 0; vr < VR; vr++) {
        for (let vc = 0; vc < VC; vc++) {
          const gx = vc / S;
          const gy = vr / S;
          const c0 = Math.min(Math.floor(gx), C - 2);
          const r0 = Math.min(Math.floor(gy), R - 2);
          const a = gx - c0;
          const b = gy - r0;
          const k00 = r0 * C + c0, k10 = k00 + 1, k01 = k00 + C, k11 = k01 + 1;
          const w = [(1 - a) * (1 - b), a * (1 - b), (1 - a) * b, a * b];
          const ks = [k00, k10, k01, k11];

          normalAt(k00, n00); normalAt(k10, n10); normalAt(k01, n01); normalAt(k11, n11);
          const n = vec3.create();
          vec3.scaleAndAdd(n, n, n00, w[0]!);
          vec3.scaleAndAdd(n, n, n10, w[1]!);
          vec3.scaleAndAdd(n, n, n01, w[2]!);
          vec3.scaleAndAdd(n, n, n11, w[3]!);
          vec3.normalize(n, n);

          const v = sheet * perSheet + vr * VC + vc;
          for (let d = 0; d < 3; d++) {
            let p = 0;
            for (let q = 0; q < 4; q++) p += P[ks[q]! * 3 + d]! * w[q]!;
            // Inner sheet sits towards the body
            positions[v * 3 + d] = p - (sheet === 1 ? n[d]! * this.thickness : 0);
            normals[v * 3 + d] = n[d]! * sign;
          }
          uvs[v * 2] = vc / (VC - 1);
          uvs[v * 2 + 1] = vr / (VR - 1);
          for (let q = 0; q < 4; q++) {
            joints[v * 4 + q] = ks[q]!;
            weights[v * 4 + q] = w[q]!;
          }
        }
      }
    }

    // Triangulate, flipping winding so the CCW face normal matches the sheet's normal
    let o = 0;
    const e1 = vec3.create(), e2 = vec3.create(), fn = vec3.create(), vn = vec3.create();
    for (let sheet = 0; sheet < 2; sheet++) {
      const base = sheet * perSheet;
      for (let vr = 0; vr < VR - 1; vr++) {
        for (let vc = 0; vc < VC - 1; vc++) {
          const i0 = base + vr * VC + vc, i1 = i0 + 1, i2 = i0 + VC, i3 = i2 + 1;
          const p = (i: number, out: vec3): vec3 =>
            vec3.set(out, positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
          vec3.sub(e1, p(i1, e1), p(i0, this._v));
          vec3.sub(e2, p(i2, e2), p(i0, this._v));
          vec3.cross(fn, e1, e2);
          vec3.set(vn, normals[i0 * 3]!, normals[i0 * 3 + 1]!, normals[i0 * 3 + 2]!);
          if (vec3.dot(fn, vn) >= 0) {
            indices.set([i0, i1, i2, i1, i3, i2], o);
          } else {
            indices.set([i0, i2, i1, i1, i2, i3], o);
          }
          o += 6;
        }
      }
    }

    return SkinnedMesh.createFromData(
      { attributes: { POSITION: positions, NORMAL: normals, TEXCOORD_0: uvs }, indices } as any,
      { joints, weights },
    );
  }

  private createGpuBuffers(): void {
    const device = GPUUtils.getDevice();
    const bgl = BindGroupFactory.getSkinMatricesLayout();
    this.jointBuffer = device.createBuffer({
      label: 'cape_joints',
      size: MAX_JOINTS * MAT4_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.previousJointBuffer = device.createBuffer({
      label: 'cape_prevJoints',
      size: MAX_JOINTS * MAT4_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.skinBindGroup = device.createBindGroup({
      label: 'cape_skinBG',
      layout: bgl,
      entries: [{ binding: 0, resource: { buffer: this.jointBuffer } }],
    });
    this.velocitySkinPairBindGroup = device.createBindGroup({
      label: 'cape_velSkinPairBG',
      layout: BindGroupFactory.getSkinMatricesPairLayout(),
      entries: [
        { binding: 0, resource: { buffer: this.jointBuffer } },
        { binding: 1, resource: { buffer: this.previousJointBuffer } },
      ],
    });
    // Identity until the skeleton is ready, so the cape shows in its rest shape
    for (let k = 0; k < this.count; k++) mat4.identity(this.palette.subarray(k * 16, k * 16 + 16) as mat4);
    device.queue.writeBuffer(this.jointBuffer, 0, this.palette, 0, this.count * 16);
    device.queue.writeBuffer(this.previousJointBuffer, 0, this.palette, 0, this.count * 16);
    this.previousPalette.set(this.palette);
  }

  /** Resolves bones once the animator has evaluated its first pose. */
  private tryInitialize(): boolean {
    const animator = this.animator!;
    this.anchorIdx = animator.getJointIndex(this.anchorBone);
    if (this.anchorIdx < 0 || !animator.getJointModelMatrix(this.anchorIdx)) return false;

    const left = animator.getJointIndex(this.leftBone);
    const right = animator.getJointIndex(this.rightBone);
    const C = this.columns;
    this.pinned = [];
    for (let c = 0; c < C; c++) {
      const u = c / (C - 1) * 2 - 1;
      // Outer pins follow the shoulders, the middle follows the upper spine
      const side = u < 0 ? right : left; // character faces +Z: -X is its right
      const sw = side >= 0 ? Math.abs(u) * 0.7 : 0;
      this.pinned.push({
        idx: c,
        bones: side >= 0 ? [this.anchorIdx, side] : [this.anchorIdx],
        weights: side >= 0 ? [1 - sw, sw] : [1],
      });
    }

    this.colliders = [];
    for (const d of this.colliderData) {
      const a = animator.getJointIndex(d.from);
      const b = animator.getJointIndex(d.to);
      if (a < 0 || b < 0) continue;
      this.colliders.push({
        a,
        b,
        radius: d.radius,
        prevA: vec3.create(),
        prevB: vec3.create(),
        curA: vec3.create(),
        curB: vec3.create(),
      });
    }

    this.initialized = true;
    this.resetToPose();
    // Pre-roll one second so the cape starts draped instead of falling into place
    for (let i = 0; i < 60; i++) {
      for (let s = 1; s <= 2; s++) this.step(1 / 120, 1);
    }
    this.uploadPalette();
    return true;
  }

  /** Snaps every particle onto the animated rest shape (spawn / teleport). */
  private resetToPose(): void {
    this.readAnchor(this.anchorCur);
    mat4.copy(this.anchorPrev, this.anchorCur);
    const skin = this.anchorSkinWorld(this._m);
    for (let k = 0; k < this.count; k++) {
      vec3.set(this._v, this.restPos[k * 3]!, this.restPos[k * 3 + 1]!, this.restPos[k * 3 + 2]!);
      vec3.transformMat4(this._v, this._v, skin);
      this.pos.set(this._v, k * 3);
    }
    this.prev.set(this.pos);
    this.updatePins(this.pinCur);
    this.pinPrev.set(this.pinCur);
    this.updateColliders();
    for (const c of this.colliders) {
      vec3.copy(c.prevA, c.curA);
      vec3.copy(c.prevB, c.curB);
    }
  }

  // ── Simulation ───────────────────────────────────────────────────────────────

  private worldMatrix(): mat4 {
    return this.transform!.getTransform().getWorldMatrix() as mat4;
  }

  /** World matrix of the anchor joint. */
  private readAnchor(out: mat4): mat4 {
    return mat4.mul(out, this.worldMatrix(), this.animator!.getJointModelMatrix(this.anchorIdx) as mat4);
  }

  /** Bind-pose model space → current world space, following joint `idx`. */
  private jointSkinWorld(idx: number, out: mat4): mat4 {
    let ibm = this.ibmViews.get(idx);
    if (!ibm) {
      const all = this.skeletal!.asset.skeleton.inverseBindMatrices;
      ibm = all.subarray(idx * 16, idx * 16 + 16) as unknown as mat4;
      this.ibmViews.set(idx, ibm);
    }
    mat4.mul(out, this.animator!.getJointModelMatrix(idx) as mat4, ibm);
    return mat4.mul(out, this.worldMatrix(), out);
  }

  private anchorSkinWorld(out: mat4): mat4 {
    return this.jointSkinWorld(this.anchorIdx, out);
  }

  /**
   * Carries part of the anchor's motion over to the particles (and their history, so it adds
   * no velocity). The rest of the motion is left for the simulation to "feel" as inertia.
   */
  private applyInertia(): void {
    const follow = 1 - this.inertia;
    if (follow <= 0) return;
    mat4.invert(this._m2, this.anchorPrev);
    const delta = mat4.mul(this._m, this.anchorCur, this._m2);
    this.carry(this.pos, delta, follow);
    this.carry(this.prev, delta, follow);
  }

  private carry(buf: Float32Array, delta: mat4, follow: number): void {
    for (let k = 0; k < this.count; k++) {
      const o = k * 3;
      vec3.set(this._v, buf[o]!, buf[o + 1]!, buf[o + 2]!);
      vec3.transformMat4(this._v2, this._v, delta);
      vec3.lerp(this._v, this._v, this._v2, follow);
      buf.set(this._v, o);
    }
  }

  private updatePins(out: Float32Array): void {
    for (const pin of this.pinned) {
      const o = pin.idx * 3;
      vec3.set(this._a, this.restPos[o]!, this.restPos[o + 1]!, this.restPos[o + 2]!);
      vec3.set(this._b, 0, 0, 0);
      for (let q = 0; q < pin.bones.length; q++) {
        vec3.transformMat4(this._v, this._a, this.jointSkinWorld(pin.bones[q]!, this._m));
        vec3.scaleAndAdd(this._b, this._b, this._v, pin.weights[q]!);
      }
      out.set(this._b, pin.idx * 3);
    }
  }

  private updateColliders(): void {
    const W = this.worldMatrix();
    for (const c of this.colliders) {
      const A = this.animator!.getJointModelMatrix(c.a)!;
      const B = this.animator!.getJointModelMatrix(c.b)!;
      vec3.transformMat4(c.curA, vec3.set(this._v, A[12]!, A[13]!, A[14]!), W);
      vec3.transformMat4(c.curB, vec3.set(this._v, B[12]!, B[13]!, B[14]!), W);
    }
  }

  /** One substep. `t` (0..1] is how far through the frame we are, for pin/collider lerps. */
  private step(h: number, t: number): void {
    const N = this.count;
    const C = this.columns;
    const pos = this.pos;
    const prev = this.prev;
    const keep = Math.exp(-this.drag * h);
    const h2 = h * h;
    const maxMove = this.maxSpeed * h;

    // Wind with a cheap travelling gust so the cape never looks frozen in place
    const gust = 1 + this.windTurbulence * Math.sin(this.time * 1.7) * Math.sin(this.time * 0.63 + 1.3);
    const wx = this.wind[0] * gust, wy = this.wind[1] * gust, wz = this.wind[2] * gust;

    for (let k = C; k < N; k++) {
      const o = k * 3;
      let vx = (pos[o]! - prev[o]!) * keep;
      let vy = (pos[o + 1]! - prev[o + 1]!) * keep;
      let vz = (pos[o + 2]! - prev[o + 2]!) * keep;
      const sp = Math.hypot(vx, vy, vz);
      if (sp > maxMove) {
        const s = maxMove / sp;
        vx *= s; vy *= s; vz *= s;
      }
      // Lower rows catch more wind
      const row = Math.floor(k / C) / (this.rows - 1);
      prev[o] = pos[o]!;
      prev[o + 1] = pos[o + 1]!;
      prev[o + 2] = pos[o + 2]!;
      pos[o] = pos[o]! + vx + wx * row * h2;
      pos[o + 1] = pos[o + 1]! + vy + (wy * row - this.gravity) * h2;
      pos[o + 2] = pos[o + 2]! + vz + wz * row * h2;
    }

    // Pins: interpolate between last frame and this frame so fast swings don't tunnel
    for (let c = 0; c < C; c++) {
      const o = c * 3;
      for (let d = 0; d < 3; d++) {
        const p = this.pinPrev[o + d]! + (this.pinCur[o + d]! - this.pinPrev[o + d]!) * t;
        prev[o + d] = pos[o + d]!;
        pos[o + d] = p;
      }
    }
    for (let it = 0; it < this.iterations; it++) {
      for (const c of this.constraints) this.solveDistance(c);
      this.solveTethers();
    }
    // Collisions last so they win over the constraints; substeps keep the error small
    this.collide(t);
  }

  private solveDistance(c: Constraint): void {
    const p = this.pos;
    const i = c.i * 3;
    const j = c.j * 3;
    const wi = c.i < this.columns ? 0 : 1;
    const wj = c.j < this.columns ? 0 : 1;
    const wsum = wi + wj;
    if (wsum === 0) return;
    const dx = p[j]! - p[i]!;
    const dy = p[j + 1]! - p[i + 1]!;
    const dz = p[j + 2]! - p[i + 2]!;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return;
    const corr = ((len - c.rest) / len) * c.stiffness / wsum;
    p[i] = p[i]! + dx * corr * wi;
    p[i + 1] = p[i + 1]! + dy * corr * wi;
    p[i + 2] = p[i + 2]! + dz * corr * wi;
    p[j] = p[j]! - dx * corr * wj;
    p[j + 1] = p[j + 1]! - dy * corr * wj;
    p[j + 2] = p[j + 2]! - dz * corr * wj;
  }

  /** Long-range attachments: no particle may drift further than its rest length from its pin. */
  private solveTethers(): void {
    const p = this.pos;
    const C = this.columns;
    for (let k = C; k < this.count; k++) {
      const pin = (k % C) * 3;
      const o = k * 3;
      const dx = p[o]! - p[pin]!;
      const dy = p[o + 1]! - p[pin + 1]!;
      const dz = p[o + 2]! - p[pin + 2]!;
      const len = Math.hypot(dx, dy, dz);
      const max = this.columnRest[k]! * this.maxStretch;
      if (len <= max) continue;
      const s = max / len;
      p[o] = p[pin]! + dx * s;
      p[o + 1] = p[pin + 1]! + dy * s;
      p[o + 2] = p[pin + 2]! + dz * s;
    }
  }

  private collide(t: number): void {
    const p = this.pos;
    const A = this._a;
    const B = this._b;
    const ab = this._x;
    const groundY = this.worldMatrix()[13]! + this.thickness;
    for (const c of this.colliders) {
      vec3.lerp(A, c.prevA, c.curA, t);
      vec3.lerp(B, c.prevB, c.curB, t);
      vec3.sub(ab, B, A);
      const abLen2 = vec3.dot(ab, ab);
      const r = c.radius * this.colliderRadiusScale + this.thickness;
      for (let k = this.columns; k < this.count; k++) {
        const o = k * 3;
        const px = p[o]! - A[0]!, py = p[o + 1]! - A[1]!, pz = p[o + 2]! - A[2]!;
        let s = abLen2 > 1e-8 ? (px * ab[0]! + py * ab[1]! + pz * ab[2]!) / abLen2 : 0;
        s = s < 0 ? 0 : s > 1 ? 1 : s;
        const dx = px - ab[0]! * s, dy = py - ab[1]! * s, dz = pz - ab[2]! * s;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r * r || d2 < 1e-10) continue;
        const d = Math.sqrt(d2);
        const push = (r - d) / d;
        p[o] = p[o]! + dx * push;
        p[o + 1] = p[o + 1]! + dy * push;
        p[o + 2] = p[o + 2]! + dz * push;
      }
    }
    for (let k = this.columns; k < this.count; k++) {
      if (p[k * 3 + 1]! < groundY) p[k * 3 + 1] = groundY;
    }
  }

  // ── Skinning ─────────────────────────────────────────────────────────────────

  /**
   * Orthonormal frame at particle k: X along the row, Z the outward normal, origin at the
   * particle. Central differences inside the grid, one-sided on the borders.
   */
  private computeFrame(P: Float32Array, k: number, out: mat4): mat4 {
    const C = this.columns;
    const r = Math.floor(k / C);
    const c = k % C;
    const l = r * C + Math.max(0, c - 1);
    const rr = r * C + Math.min(C - 1, c + 1);
    const u = Math.max(0, r - 1) * C + c;
    const d = Math.min(this.rows - 1, r + 1) * C + c;
    const x = vec3.set(this._x, P[rr * 3]! - P[l * 3]!, P[rr * 3 + 1]! - P[l * 3 + 1]!, P[rr * 3 + 2]! - P[l * 3 + 2]!);
    const down = vec3.set(this._y, P[d * 3]! - P[u * 3]!, P[d * 3 + 1]! - P[u * 3 + 1]!, P[d * 3 + 2]! - P[u * 3 + 2]!);
    vec3.normalize(x, x);
    const z = vec3.normalize(this._z, vec3.cross(this._z, x, down));
    const y = vec3.cross(this._y, z, x);
    return mat4.set(
      out,
      x[0]!, x[1]!, x[2]!, 0,
      y[0]!, y[1]!, y[2]!, 0,
      z[0]!, z[1]!, z[2]!, 0,
      P[k * 3]!, P[k * 3 + 1]!, P[k * 3 + 2]!, 1,
    );
  }

  private uploadPalette(): void {
    mat4.invert(this._invWorld, this.worldMatrix());
    for (let k = 0; k < this.count; k++) {
      this.computeFrame(this.pos, k, this._m);
      mat4.mul(this._m, this._invWorld, this._m);
      mat4.mul(this._m, this._m, this.invRestFrames[k]!);
      this.palette.set(this._m as Float32Array, k * 16);
    }
    const device = GPUUtils.getDevice();
    const floats = this.count * 16;
    device.queue.writeBuffer(this.previousJointBuffer, 0, this.previousPalette, 0, floats);
    device.queue.writeBuffer(this.jointBuffer, 0, this.palette, 0, floats);
    this.previousPalette.set(this.palette.subarray(0, floats));
  }

  // ── Editor ───────────────────────────────────────────────────────────────────

  public override renderInMenu(folder: any): void {
    const f = folder.addFolder('Cape');
    f.add(this, 'inertia', 0, 1, 0.01).name('Inertia');
    f.add(this, 'drag', 0, 6, 0.05).name('Drag');
    f.add(this, 'gravity', 0, 20, 0.1).name('Gravity');
    f.add(this, 'maxSpeed', 1, 30, 0.5).name('Max speed');
    f.add(this, 'iterations', 1, 16, 1).name('Iterations');
    f.add(this, 'maxStretch', 1, 1.3, 0.01).name('Max stretch');
    f.add(this, 'colliderRadiusScale', 0.5, 1.5, 0.01).name('Collider scale');
    f.add(this.wind, '0', -10, 10, 0.1).name('Wind X');
    f.add(this.wind, '2', -10, 10, 0.1).name('Wind Z');
    f.add(this, 'windTurbulence', 0, 2, 0.05).name('Wind gust');
    f.add({ reset: () => this.initialized && this.resetToPose() }, 'reset').name('Reset');
  }
}
