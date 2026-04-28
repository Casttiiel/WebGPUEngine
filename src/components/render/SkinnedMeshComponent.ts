import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { Material } from '../../renderer/resources/Material';
import { SkinnedMesh } from '../../renderer/resources/SkinnedMesh';
import { RenderManagerV2 } from '../../renderer/core/managers/RenderManagerV2';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { SkeletonData, AnimationClip, AnimationChannel } from '../../types/SkinData.type';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { mat4, quat } from 'gl-matrix';
import {
  WebIO,
  Node as GltfNode,
  Mesh as GltfMesh,
  Skin as GltfSkin,
  Animation as GltfAnimation,
} from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

// ─── JSON data expected in scene file ──────────────────────────────────────────
export interface SkinnedMeshComponentData {
  /** GLB filename (without path). Loaded from assets/meshes/<name>/<name>.glb */
  gltf: string;
  /** Index or name of the animation to play (default 0). */
  animation?: number | string;
  /** Whether to loop the animation (default true). */
  loop?: boolean;
  /** Playback speed multiplier (default 1.0). */
  playbackSpeed?: number;
}

const MAX_JOINTS = 128; // Must match gbuffer_skinned.vs expectation
const MAT4_BYTES = 64; // 16 floats × 4 bytes

export class SkinnedMeshComponent extends Component {
  // Render resources (one SkinnedMesh per mesh node; shared material + skinBindGroup)
  private skinnedMeshes: SkinnedMesh[] = [];
  private material!: Material;
  private jointMatrixBuffer!: GPUBuffer;
  private skinBindGroup!: GPUBindGroup;

  // Skeleton
  private skeleton!: SkeletonData;
  private jointCount: number = 0;

  // Animation state
  private clips: AnimationClip[] = [];
  private activeClipIndex: number = 0;
  private playbackTime: number = 0;
  private loop: boolean = true;
  private playbackSpeed: number = 1.0;
  private playing: boolean = true;

  // Cached CPU-side joint matrices (reused every frame to avoid allocations)
  private evalOrder: number[] = []; // joint indices in parent-before-child order
  private localT: Float32Array[] = []; // per-joint translation
  private localR: Float32Array[] = []; // per-joint rotation (quat xyzw)
  private localS: Float32Array[] = []; // per-joint scale
  private globalMats: mat4[] = [];
  private jointPalette: Float32Array; // flattened mat4 array for GPU upload

  constructor() {
    super();
    this.jointPalette = new Float32Array(MAX_JOINTS * 16);
  }

  // ── Component lifecycle ────────────────────────────────────────────────────

  public async load(data: SkinnedMeshComponentData): Promise<void> {
    const gltfName = data.gltf;
    this.loop = data.loop ?? true;
    this.playbackSpeed = data.playbackSpeed ?? 1.0;

    // ── Parse GLTF (use readJSON to preserve external texture URIs) ─────────
    const io = new WebIO().registerExtensions(ALL_EXTENSIONS);
    const folderName = gltfName.split('.')[0]!;
    const gltfUrl = `assets/meshes/${folderName}/${gltfName}`;

    const jsonResponse = await fetch(gltfUrl);
    const gltfJson = await jsonResponse.json();

    // Provide empty stubs for images so gltf-transform never fetches them.
    // This preserves texture.getURI() so we can resolve paths ourselves.
    const resources: Record<string, Uint8Array> = {};
    for (const image of (gltfJson.images ?? []) as { uri?: string }[]) {
      if (image.uri && !image.uri.startsWith('data:')) {
        resources[image.uri] = new Uint8Array(0);
      }
    }
    // Fetch actual geometry buffers (.bin)
    for (const buffer of (gltfJson.buffers ?? []) as { uri?: string }[]) {
      if (buffer.uri && !buffer.uri.startsWith('data:')) {
        const r = await fetch(`assets/meshes/${folderName}/${buffer.uri}`);
        resources[buffer.uri] = new Uint8Array(await r.arrayBuffer());
      }
    }

    const doc = await io.readJSON({ json: gltfJson, resources });

    const root = doc.getRoot();
    const scene = root.getDefaultScene();
    if (!scene) throw new Error(`SkinnedMeshComponent: no default scene in ${gltfName}`);

    // ── Collect ALL skinned mesh nodes ──────────────────────────────────────
    const meshNodes: { mesh: GltfMesh; node: GltfNode }[] = [];

    const traverse = (node: GltfNode): void => {
      const m = node.getMesh();
      if (m) {
        const prim = m.listPrimitives()[0];
        if (prim?.getAttribute('JOINTS_0')) {
          meshNodes.push({ mesh: m, node });
        }
      }
      node.listChildren().forEach(traverse);
    };
    scene.listChildren().forEach(traverse);

    if (meshNodes.length === 0) {
      throw new Error(`SkinnedMeshComponent: no skinned primitive found in ${gltfName}`);
    }

    // ── Build SkinnedMesh for each mesh node ─────────────────────────────────
    const buildSkinnedMesh = async (mesh: GltfMesh): Promise<SkinnedMesh> => {
      const prim = mesh.listPrimitives()[0]!;
      const posAttr = prim.getAttribute('POSITION')!;
      const normAttr = prim.getAttribute('NORMAL')!;
      const uvAttr = prim.getAttribute('TEXCOORD_0');
      const tanAttr = prim.getAttribute('TANGENT');
      const jointsAttr = prim.getAttribute('JOINTS_0')!;
      const weightsAttr = prim.getAttribute('WEIGHTS_0')!;
      const indicesAcc = prim.getIndices()!;

      const positions = posAttr.getArray()! as Float32Array;
      const normals = normAttr.getArray()! as Float32Array;
      const uvs = uvAttr?.getArray() as Float32Array | undefined;
      const tangents = tanAttr?.getArray() as Float32Array | undefined;
      const indices = indicesAcc.getArray() as Uint16Array | Uint32Array;

      const jointsRaw = jointsAttr.getArray()!;
      const joints8 = new Uint8Array(jointsRaw.length);
      for (let i = 0; i < jointsRaw.length; i++) joints8[i] = (jointsRaw[i] as number) & 0xff;
      const weights = new Float32Array(weightsAttr.getArray()!);

      const sm = SkinnedMesh.createFromData(
        {
          attributes: {
            POSITION: positions,
            NORMAL: normals,
            TEXCOORD_0: uvs ?? new Float32Array((positions.length / 3) * 2),
            TANGENT: tangents,
          },
          indices: indices as Uint16Array | Uint32Array,
        } as any,
        { joints: joints8, weights },
      );
      await sm.loadAsync();
      return sm;
    };

    this.skinnedMeshes = await Promise.all(meshNodes.map(({ mesh }) => buildSkinnedMesh(mesh)));

    // ── Build shared material (from first primitive) ─────────────────────────
    const firstPrim = meshNodes[0]!.mesh.listPrimitives()[0]!;
    const materialData = firstPrim.getMaterial();
    const albedoTex = materialData?.getBaseColorTexture();
    const normalTex = materialData?.getNormalTexture();
    const mrTex = materialData?.getMetallicRoughnessTexture();

    const getTexName = (tex: { getURI: () => string } | null | undefined): string => {
      if (!tex) return 'white.png';
      const uri = tex.getURI();
      if (uri) return `${folderName}/${uri.split('/').pop()!}`;
      return 'white.png';
    };

    this.material = await Material.get({
      technique: 'gbuffer/gbuffer_skinned.tech',
      category: RenderCategory.SOLIDS,
      casts_shadows: false,
      textures: {
        txAlbedo: albedoTex ? getTexName(albedoTex) : 'white.png',
        txNormal: normalTex ? getTexName(normalTex) : 'no-normal.jpg',
        txMetallic: mrTex ? getTexName(mrTex) : 'black.png',
        txRoughness: mrTex ? getTexName(mrTex) : 'white.png',
        txEmissive: 'black.png',
      },
      baseColorFactor: (materialData?.getBaseColorFactor() ?? [1, 1, 1, 1]) as [
        number,
        number,
        number,
        number,
      ],
      metallicFactor: materialData?.getMetallicFactor() ?? 0.0,
      roughnessFactor: materialData?.getRoughnessFactor() ?? 0.8,
      emissiveFactor: 0,
    });

    // ── Extract skeleton ─────────────────────────────────────────────────────
    const skin = root.listSkins()[0];
    if (!skin) throw new Error(`SkinnedMeshComponent: no skin in ${gltfName}`);

    this.skeleton = this.extractSkeleton(skin, root.listNodes());
    this.jointCount = this.skeleton.joints.length;

    // Preallocate per-joint TRS working buffers
    for (let i = 0; i < this.jointCount; i++) {
      this.localT.push(new Float32Array([0, 0, 0]));
      this.localR.push(new Float32Array([0, 0, 0, 1]));
      this.localS.push(new Float32Array([1, 1, 1]));
      this.globalMats.push(mat4.create());
    }

    // Precompute topological order (parents before children).
    // Mixamo exports joints leaf-first, so we can't just iterate 0..n.
    this.evalOrder = this.computeTopoOrder(this.skeleton.parents);

    // ── Extract animation clips ──────────────────────────────────────────────
    this.clips = this.extractAnimations(root.listAnimations(), root.listNodes());

    console.log(
      `[SkinnedMesh] ${gltfName} — joints: ${this.jointCount}, evalOrder[0]: ${this.evalOrder[0]} (root), clips: ${this.clips.length}`,
    );
    this.clips.forEach((c, i) =>
      console.log(
        `  clip[${i}] "${c.name}" dur=${c.duration.toFixed(2)}s channels=${c.channels.length}`,
      ),
    );
    console.log(`  evalOrder (first 10):`, this.evalOrder.slice(0, 10));
    console.log(`  parents (first 10):`, this.skeleton.parents.slice(0, 10));
    console.log(
      `  bindPoseLocal root T:`,
      this.skeleton.bindPoseLocal.slice(this.evalOrder[0]! * 10, this.evalOrder[0]! * 10 + 3),
    );
    console.log(
      `  skeleton names (topo order, first 10):`,
      this.evalOrder.slice(0, 10).map((i) => this.skeleton.names[i]),
    );

    // Resolve active clip
    if (typeof data.animation === 'string') {
      const idx = this.clips.findIndex((c) => c.name === data.animation);
      this.activeClipIndex = idx >= 0 ? idx : 0;
    } else {
      this.activeClipIndex = Math.min(data.animation ?? 0, this.clips.length - 1);
    }

    // ── Create GPU joint matrix buffer + bind group ───────────────────────────
    this.jointMatrixBuffer = GPUUtils.getDevice().createBuffer({
      label: `${gltfName}_jointMatrices`,
      size: MAX_JOINTS * MAT4_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const bgl = BindGroupFactory.getSkinMatricesLayout();
    this.skinBindGroup = GPUUtils.getDevice().createBindGroup({
      label: `${gltfName}_skinBG`,
      layout: bgl,
      entries: [{ binding: 0, resource: { buffer: this.jointMatrixBuffer } }],
    });

    // ── Register all meshes with RenderManager ───────────────────────────────
    const renderManager = RenderManagerV2.getInstance();
    const transform = this.getOwner().getComponent('transform') as TransformComponent;
    for (const sm of this.skinnedMeshes) {
      renderManager.addKey(
        this as any,
        sm as any,
        this.material,
        transform,
        false,
        1,
        undefined,
        this.skinBindGroup, // group(3) — joint palette
      );
    }

    // Do a first evaluation so the skeleton is in a valid pose before first render
    this.evaluateAnimation(0);
    this.uploadJointMatrices();

    // Debug: verify joint palette has non-identity values after first eval
    const p = this.jointPalette;
    const rootIdx = this.evalOrder[0]!;
    const b = rootIdx * 16;
    console.log(
      `[SkinnedMesh] initial palette root joint[${rootIdx}] diagonal:`,
      (p[b] ?? 0).toFixed(3),
      (p[b + 5] ?? 0).toFixed(3),
      (p[b + 10] ?? 0).toFixed(3),
      (p[b + 15] ?? 0).toFixed(3),
    );
    console.log(`[SkinnedMesh] skinBindGroup:`, this.skinBindGroup?.label ?? 'MISSING');
    console.log(`[SkinnedMesh] render keys registered: ${this.skinnedMeshes.length}`);
  }

  private _debugFrames = 0;

  public update(dt: number): void {
    if (!this.playing || this.clips.length === 0) {
      if (this._debugFrames < 3) {
        console.warn(
          `[SkinnedMesh] update() early exit — playing:${this.playing} clips:${this.clips.length}`,
        );
        this._debugFrames++;
      }
      return;
    }

    const clip = this.clips[this.activeClipIndex];
    if (!clip) return;

    this.playbackTime += dt * this.playbackSpeed;

    if (this.playbackTime > clip.duration) {
      if (this.loop) {
        this.playbackTime = this.playbackTime % clip.duration;
      } else {
        this.playbackTime = clip.duration;
        this.playing = false;
      }
    }

    this.evaluateAnimation(this.playbackTime);
    this.uploadJointMatrices();

    if (this._debugFrames < 5) {
      const rootIdx = this.evalOrder[0]!;
      const base = rootIdx * 16;
      console.log(
        `[SkinnedMesh] frame ${this._debugFrames} t=${this.playbackTime.toFixed(3)} root palette diag:`,
        (this.jointPalette[base] ?? 0).toFixed(3),
        (this.jointPalette[base + 5] ?? 0).toFixed(3),
        (this.jointPalette[base + 10] ?? 0).toFixed(3),
        (this.jointPalette[base + 15] ?? 0).toFixed(3),
      );
      this._debugFrames++;
    }
  }

  public renderDebug(): void {}

  public override dispose(): void {
    const renderManager = RenderManagerV2.getInstance();
    renderManager.delKeys(this as any);
    this.jointMatrixBuffer?.destroy();
    for (const sm of this.skinnedMeshes) sm.dispose();
  }

  // ── Public animation controls ──────────────────────────────────────────────

  public play(indexOrName?: number | string): void {
    if (indexOrName !== undefined) {
      if (typeof indexOrName === 'string') {
        const idx = this.clips.findIndex((c) => c.name === indexOrName);
        if (idx >= 0) this.activeClipIndex = idx;
      } else {
        this.activeClipIndex = Math.min(indexOrName, this.clips.length - 1);
      }
      this.playbackTime = 0;
    }
    this.playing = true;
  }

  public pause(): void {
    this.playing = false;
  }
  public resume(): void {
    this.playing = true;
  }
  public setSpeed(s: number): void {
    this.playbackSpeed = s;
  }
  public getClips(): string[] {
    return this.clips.map((c) => c.name);
  }

  // ── Topological sort ──────────────────────────────────────────────────────
  // Returns joint indices sorted so every parent appears before its children.
  // Required because Mixamo exports joints leaf-first in the skin joint array.
  private computeTopoOrder(parents: number[]): number[] {
    const n = parents.length;
    const order: number[] = [];
    const done = new Uint8Array(n); // 0=pending, 1=processed
    let added = 1;
    while (added > 0) {
      added = 0;
      for (let i = 0; i < n; i++) {
        if (done[i]) continue;
        const p = parents[i]!;
        if (p < 0 || done[p]) {
          order.push(i);
          done[i] = 1;
          added++;
        }
      }
    }
    return order;
  }

  // ── Skeleton extraction ────────────────────────────────────────────────────

  private extractSkeleton(skin: GltfSkin, allNodes: GltfNode[]): SkeletonData {
    const jointNodes = skin.listJoints();
    const ibmAcc = skin.getInverseBindMatrices();
    const ibmArray = ibmAcc ? (ibmAcc.getArray() as Float32Array) : null;
    const n = jointNodes.length;

    const inverseBindMatrices = new Float32Array(n * 16);
    if (ibmArray) {
      inverseBindMatrices.set(ibmArray.subarray(0, n * 16));
    } else {
      for (let i = 0; i < n; i++)
        mat4.identity(inverseBindMatrices.subarray(i * 16, i * 16 + 16) as any);
    }

    // Build node-index → joint-index map
    const nodeToJoint = new Map<GltfNode, number>();
    jointNodes.forEach((node, i) => nodeToJoint.set(node, i));

    // Parent indices: walk up the node tree within the joint set
    const parents: number[] = new Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const parent = jointNodes[i]!.getParentNode?.();
      if (parent && nodeToJoint.has(parent)) {
        parents[i] = nodeToJoint.get(parent)!;
      }
    }

    // Bind-pose local TRS
    const bindPoseLocal = new Float32Array(n * 10);
    for (let i = 0; i < n; i++) {
      const node = jointNodes[i]!;
      const t = node.getTranslation();
      const r = node.getRotation();
      const s = node.getScale();
      const off = i * 10;
      bindPoseLocal[off] = t[0];
      bindPoseLocal[off + 1] = t[1];
      bindPoseLocal[off + 2] = t[2];
      bindPoseLocal[off + 3] = r[0];
      bindPoseLocal[off + 4] = r[1];
      bindPoseLocal[off + 5] = r[2];
      bindPoseLocal[off + 6] = r[3];
      bindPoseLocal[off + 7] = s[0];
      bindPoseLocal[off + 8] = s[1];
      bindPoseLocal[off + 9] = s[2];
    }

    // ── Compute rootPreTransform ──────────────────────────────────────────────
    // Walk up the GLTF hierarchy from the first root joint, accumulating the
    // transforms of all non-joint ancestor nodes (e.g. the Blender Armature
    // that carries a Z-up→Y-up rotation and cm→m scale).
    // These are baked into the IBMs but absent from the joint local transforms,
    // so we must re-introduce them when computing joint world matrices.
    const rootPreTransformMat = mat4.create(); // identity by default
    const firstRootIdx = parents.indexOf(-1);
    if (firstRootIdx >= 0) {
      const ancestors: GltfNode[] = [];
      let ancestor = jointNodes[firstRootIdx]!.getParentNode?.() ?? null;
      while (ancestor) {
        ancestors.push(ancestor);
        ancestor = ancestor.getParentNode?.() ?? null;
      }
      // Multiply from root down (ancestors[last] is outermost)
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const a = ancestors[i]!;
        const at = a.getTranslation();
        const ar = a.getRotation();
        const as_ = a.getScale();
        const am = mat4.fromRotationTranslationScale(
          mat4.create(),
          ar as any,
          at as any,
          as_ as any,
        );
        mat4.mul(rootPreTransformMat, rootPreTransformMat, am);
      }
    }
    const rootPreTransform = new Float32Array(rootPreTransformMat);

    console.log(
      '[SkinnedMesh] rootPreTransform diagonal:',
      (rootPreTransform[0] ?? 0).toFixed(4),
      (rootPreTransform[5] ?? 0).toFixed(4),
      (rootPreTransform[10] ?? 0).toFixed(4),
      (rootPreTransform[15] ?? 0).toFixed(4),
    );

    // GLTF node indices for each joint
    const jointGltfIndices = jointNodes.map((node) => allNodes.indexOf(node));

    return {
      inverseBindMatrices,
      joints: jointGltfIndices,
      parents,
      names: jointNodes.map((nd) => nd.getName()),
      bindPoseLocal,
      rootPreTransform,
    };
  }

  // ── Animation extraction ───────────────────────────────────────────────────

  private extractAnimations(animations: GltfAnimation[], allNodes: GltfNode[]): AnimationClip[] {
    return animations.map((anim) => {
      let duration = 0;
      const channels: AnimationChannel[] = [];

      for (const channel of anim.listChannels()) {
        const targetNode = channel.getTargetNode();
        if (!targetNode) continue;

        const nodeIdx = allNodes.indexOf(targetNode);
        const jointIndex = this.skeleton.joints.indexOf(nodeIdx);
        if (jointIndex < 0) continue; // not a joint in our skin

        const sampler = channel.getSampler();
        if (!sampler) continue;

        const timesAcc = sampler.getInput();
        const valuesAcc = sampler.getOutput();
        if (!timesAcc || !valuesAcc) continue;

        const times = new Float32Array(timesAcc.getArray()!);
        const values = new Float32Array(valuesAcc.getArray()!);
        const path = channel.getTargetPath() as 'translation' | 'rotation' | 'scale';
        const interp = (sampler.getInterpolation() ??
          'LINEAR') as AnimationChannel['interpolation'];

        if (times.length > 0) {
          duration = Math.max(duration, times[times.length - 1]!);
        }

        channels.push({ jointIndex, path, times, values, interpolation: interp });
      }

      return { name: anim.getName() || 'animation', duration, channels };
    });
  }

  // ── Animation evaluation ───────────────────────────────────────────────────

  private evaluateAnimation(time: number): void {
    const clip = this.clips[this.activeClipIndex];

    // Reset to bind pose
    for (let i = 0; i < this.jointCount; i++) {
      const off = i * 10;
      const bp = this.skeleton.bindPoseLocal;
      this.localT[i]!.set([bp[off]!, bp[off + 1]!, bp[off + 2]!]);
      this.localR[i]!.set([bp[off + 3]!, bp[off + 4]!, bp[off + 5]!, bp[off + 6]!]);
      this.localS[i]!.set([bp[off + 7]!, bp[off + 8]!, bp[off + 9]!]);
    }

    if (clip) {
      for (const channel of clip.channels) {
        const { jointIndex, path, times, values, interpolation } = channel;
        if (jointIndex >= this.jointCount) continue;

        if (path === 'translation') {
          sampleVec3(times, values, time, interpolation, this.localT[jointIndex]!);
        } else if (path === 'rotation') {
          sampleQuat(times, values, time, interpolation, this.localR[jointIndex]!);
        } else if (path === 'scale') {
          sampleVec3(times, values, time, interpolation, this.localS[jointIndex]!);
        }
      }
    }

    // Compute global matrices in topological order (parents guaranteed before children)
    const ibm = this.skeleton.inverseBindMatrices;
    const parents = this.skeleton.parents;
    const rootPre = this.skeleton.rootPreTransform as unknown as mat4;

    for (const i of this.evalOrder) {
      const local = mat4.fromRotationTranslationScale(
        mat4.create(),
        this.localR[i] as any,
        this.localT[i] as any,
        this.localS[i] as any,
      );

      const parentIdx = parents[i]!;
      if (parentIdx < 0) {
        // Root joint: prepend the non-joint ancestor transform (e.g. Armature's rotation+scale)
        this.globalMats[i] = mat4.mul(mat4.create(), rootPre, local);
      } else {
        this.globalMats[i] = mat4.mul(mat4.create(), this.globalMats[parentIdx]!, local);
      }

      const ibmSlice = ibm.subarray(i * 16, i * 16 + 16) as unknown as mat4;
      this.jointPalette.set(mat4.mul(mat4.create(), this.globalMats[i]!, ibmSlice), i * 16);
    }
  }

  private uploadJointMatrices(): void {
    GPUUtils.getDevice().queue.writeBuffer(
      this.jointMatrixBuffer,
      0,
      this.jointPalette,
      0,
      this.jointCount * 16,
    );
  }
}

// ── Animation sampling helpers ─────────────────────────────────────────────────

function findKeyframe(times: Float32Array, t: number): number {
  let lo = 0;
  let hi = times.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function sampleVec3(
  times: Float32Array,
  values: Float32Array,
  t: number,
  interp: AnimationChannel['interpolation'],
  out: Float32Array,
): void {
  const n = times.length;
  if (n === 0) return;
  if (t <= times[0]!) {
    out.set(values.subarray(0, 3));
    return;
  }
  if (t >= times[n - 1]!) {
    out.set(values.subarray((n - 1) * 3, n * 3));
    return;
  }

  const i = findKeyframe(times, t);
  const t0 = times[i]!,
    t1 = times[i + 1]!;
  const alpha = (t - t0) / (t1 - t0);

  if (interp === 'STEP') {
    out.set(values.subarray(i * 3, i * 3 + 3));
  } else {
    // LINEAR (CUBICSPLINE treated as linear for simplicity)
    const stride = interp === 'CUBICSPLINE' ? 3 : 1;
    const base = interp === 'CUBICSPLINE' ? 1 : 0; // value is middle triplet
    const i0 = (i * stride + base) * 3;
    const i1 = ((i + 1) * stride + base) * 3;
    out[0] = values[i0]! + (values[i1]! - values[i0]!) * alpha;
    out[1] = values[i0 + 1]! + (values[i1 + 1]! - values[i0 + 1]!) * alpha;
    out[2] = values[i0 + 2]! + (values[i1 + 2]! - values[i0 + 2]!) * alpha;
  }
}

function sampleQuat(
  times: Float32Array,
  values: Float32Array,
  t: number,
  interp: AnimationChannel['interpolation'],
  out: Float32Array,
): void {
  const n = times.length;
  if (n === 0) return;
  if (t <= times[0]!) {
    out.set(values.subarray(0, 4));
    return;
  }
  if (t >= times[n - 1]!) {
    out.set(values.subarray((n - 1) * 4, n * 4));
    return;
  }

  const i = findKeyframe(times, t);
  const t0 = times[i]!,
    t1 = times[i + 1]!;
  const alpha = (t - t0) / (t1 - t0);

  if (interp === 'STEP') {
    out.set(values.subarray(i * 4, i * 4 + 4));
  } else {
    const stride = interp === 'CUBICSPLINE' ? 3 : 1;
    const base = interp === 'CUBICSPLINE' ? 1 : 0;
    const i0 = (i * stride + base) * 4;
    const i1 = ((i + 1) * stride + base) * 4;

    const qa = values.subarray(i0, i0 + 4) as any;
    const qb = values.subarray(i1, i1 + 4) as any;
    const result = quat.slerp(quat.create(), qa, qb, alpha);
    out.set(result);
  }
}
