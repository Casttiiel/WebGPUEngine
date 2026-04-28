import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { Material } from '../../renderer/resources/Material';
import { SkinnedMesh } from '../../renderer/resources/SkinnedMesh';
import { RenderManagerV2 } from '../../renderer/core/managers/RenderManagerV2';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { SkeletonData, AnimationClip, AnimationChannel } from '../../types/SkinData.type';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { mat4, quat, vec3 } from 'gl-matrix';
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
  /**
   * Additional animation GLTF files to load, relative to assets/animations/.
   * Joints are matched by name against the skeleton loaded from the main gltf.
   */
  extraAnimations?: string[];
  /**
   * Automatically play a clip on a repeating interval.
   * The clip plays as a non-looping layer on top of the base animation,
   * then removes itself when finished so the base animation is restored.
   */
  autoPlayInterval?: {
    /** Clip name or index to play. */
    clip: string | number;
    /** Seconds between auto-play triggers. */
    intervalSeconds: number;
    /** Crossfade blend duration in seconds (default 0.2). */
    blendTime?: number;
  };
}

const MAX_JOINTS = 128; // Must match gbuffer_skinned.vs expectation
const MAT4_BYTES = 64; // 16 floats × 4 bytes

// Minimal GLTF JSON types used for raw animation parsing (avoids gltf-transform buffer bugs)
interface GltfRawJson {
  nodes?: { name?: string }[];
  buffers?: { uri?: string; byteLength: number }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number }[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
  }[];
  animations?: {
    name?: string;
    channels: { sampler: number; target: { node?: number; path: string } }[];
    samplers: { input: number; output: number; interpolation?: string }[];
  }[];
}

// ─── Animation layer options (public API) ─────────────────────────────────────
export interface AnimLayerOptions {
  /** Blend weight for this layer, 0–1 (default 1.0). */
  weight?: number;
  /** Seconds to blend this layer in (default 0 = instant). */
  blendInTime?: number;
  /** Whether to loop this layer's clip (default true). */
  loop?: boolean;
  /** Playback speed multiplier (default 1.0). */
  speed?: number;
  /**
   * Joint names that this layer affects (and all their children).
   * Omit to affect every joint.
   */
  jointMask?: string[];
}

interface InternalAnimLayer {
  id: number;
  clipIndex: number;
  time: number;
  weight: number; // target weight set by caller
  currentWeight: number; // actual weight (interpolated)
  blendInTime: number;
  fadingOut: boolean;
  fadeOutDuration: number;
  fadeOutElapsed: number;
  loop: boolean;
  speed: number;
  jointMask: boolean[] | null; // null = all joints
}
/**
 * Controls how the root joint's translation is handled.
 * - `'none'`    : root joint animated normally (in-place animations work fine).
 * - `'extract'` : root joint is locked to bind pose; per-frame delta is stored in
 *                 `rootMotionDelta` and available via `getRootMotionDelta()` for
 *                 consumption by a physics controller.
 * - `'apply'`   : like `'extract'` but also automatically moves the entity's
 *                 TransformComponent by the delta each frame.
 */
export type RootMotionMode = 'none' | 'extract' | 'apply';

// ─── IK / Procedural constraint types ────────────────────────────────────────

/**
 * Rotates a single joint so that its `forwardAxis` (local space) points at
 * a world-space `target` position.  Good for head look-at, eye tracking, etc.
 */
export interface LookAtConstraint {
  type: 'lookat';
  /** Name of the joint to rotate. */
  jointName: string;
  /** World-space target to look at.  Update in-place each frame. */
  target: vec3;
  /**
   * Which local-space axis of the joint is the "forward" direction.
   * Default [0, 0, 1] (+Z, standard GLTF/glTF).
   */
  forwardAxis?: vec3;
  /** Blend weight 0–1. */
  weight: number;
  /** Maximum rotation angle (degrees) from the joint's bind orientation. */
  limitAngleDeg?: number;
}

/**
 * Classic analytic two-bone IK (arm, leg).
 * Solves for root and mid rotations so that the tip reaches `target`.
 * `poleTarget` controls which side the mid joint bends toward.
 */
export interface TwoBoneIkConstraint {
  type: 'twobone';
  /** Upper bone root (shoulder / hip). */
  rootJointName: string;
  /** Mid joint (elbow / knee). */
  midJointName: string;
  /** End effector (wrist / ankle). */
  tipJointName: string;
  /** World-space IK target.  Update in-place each frame. */
  target: vec3;
  /** World-space pole vector (controls elbow/knee direction). */
  poleTarget?: vec3;
  /** Blend weight 0–1. */
  weight: number;
}

/**
 * Adds a procedural additive offset to a single joint's world-space transform
 * every frame.  Useful for breathing, secondary motion, jiggle, etc.
 * Update `rotationOffset` / `translationOffset` each frame from your own code.
 */
export interface ProceduralOffsetConstraint {
  type: 'procedural_offset';
  /** Name of the joint to offset. */
  jointName: string;
  /** Additive world-space translation (updated by caller). */
  translationOffset?: vec3;
  /**
   * Additive rotation applied on top of the animated rotation (world space,
   * right-multiplied).  Update in-place each frame.
   */
  rotationOffset?: quat;
  /** Blend weight 0–1. */
  weight: number;
}

export type IkConstraint = LookAtConstraint | TwoBoneIkConstraint | ProceduralOffsetConstraint;
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
  private tempT: Float32Array[] = []; // scratch for blending
  private tempR: Float32Array[] = [];
  private tempS: Float32Array[] = [];
  private globalMats: mat4[] = [];
  private jointPalette: Float32Array; // flattened mat4 array for GPU upload

  // ── Crossfade state (base-layer transition) ──────────────────────────────
  private crossfadeFrom: { clipIndex: number; time: number } | null = null;
  private crossfadeDuration: number = 0;
  private crossfadeElapsed: number = 0;

  // ── Animation layers ─────────────────────────────────────────────────────
  private animLayers: InternalAnimLayer[] = [];
  private nextLayerId: number = 0;

  // ── Auto-play interval ───────────────────────────────────────────────────
  private autoPlayIntervalSeconds: number = 0;
  private autoPlayClip: string | number | null = null;
  private autoPlayBlendTime: number = 0.2;
  private autoPlayTimer: number = 0;

  // ── Root motion ───────────────────────────────────────────────────────────
  private rootMotionMode: RootMotionMode = 'none';
  private rootMotionIncludeY: boolean = false;
  private rootMotionDelta: vec3 = vec3.create();
  private rootJointIndex: number = -1;
  private prevRootLocalT: Float32Array = new Float32Array(3);
  private rootPreRotation: quat = quat.create();
  private _rootMotionFirstFrame: boolean = true;
  private _rootMotionDidLoop: boolean = false;

  // ── IK / Procedural constraints ───────────────────────────────────────────
  private ikConstraints: IkConstraint[] = [];
  private _ikFrozenJoints: Set<number> = new Set();

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
      this.tempT.push(new Float32Array([0, 0, 0]));
      this.tempR.push(new Float32Array([0, 0, 0, 1]));
      this.tempS.push(new Float32Array([1, 1, 1]));
      this.globalMats.push(mat4.create());
    }

    // Precompute topological order (parents before children).
    // Mixamo exports joints leaf-first, so we can't just iterate 0..n.
    this.evalOrder = this.computeTopoOrder(this.skeleton.parents);

    // Root joint index (first joint with no parent)
    this.rootJointIndex = this.skeleton.parents.indexOf(-1);

    // Extract rotation part of rootPreTransform for root motion direction mapping
    mat4.getRotation(
      this.rootPreRotation as unknown as quat,
      this.skeleton.rootPreTransform as unknown as mat4,
    );
    quat.normalize(
      this.rootPreRotation as unknown as quat,
      this.rootPreRotation as unknown as quat,
    );

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

    // Load extra animations from assets/animations/ (matched by joint name)
    if (data.extraAnimations && data.extraAnimations.length > 0) {
      await this.loadExtraAnimations(data.extraAnimations);
    }

    // Resolve active clip
    if (typeof data.animation === 'string') {
      const idx = this.clips.findIndex((c) => c.name === data.animation);
      this.activeClipIndex = idx >= 0 ? idx : 0;
    } else {
      this.activeClipIndex = Math.min(data.animation ?? 0, this.clips.length - 1);
    }

    // Configure auto-play interval
    if (data.autoPlayInterval) {
      this.autoPlayClip = data.autoPlayInterval.clip;
      this.autoPlayIntervalSeconds = data.autoPlayInterval.intervalSeconds;
      this.autoPlayBlendTime = data.autoPlayInterval.blendTime ?? 0.2;
      this.autoPlayTimer = 0;
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

    // ── Auto-play interval ─────────────────────────────────────────────────
    if (this.autoPlayIntervalSeconds > 0 && this.autoPlayClip !== null) {
      this.autoPlayTimer += dt;
      if (this.autoPlayTimer >= this.autoPlayIntervalSeconds) {
        this.autoPlayTimer = 0;
        this.addLayer(this.autoPlayClip, {
          weight: 1.0,
          blendInTime: this.autoPlayBlendTime,
          loop: false,
          speed: 1.0,
        });
      }
    }

    // ── Advance base clip ──────────────────────────────────────────────────
    const clip = this.clips[this.activeClipIndex];
    if (!clip) return;

    this.playbackTime += dt * this.playbackSpeed;
    if (this.playbackTime > clip.duration) {
      if (this.loop) {
        this.playbackTime = this.playbackTime % clip.duration;
        this._rootMotionDidLoop = true;
      } else {
        this.playbackTime = clip.duration;
        this.playing = false;
      }
    }

    // ── Advance crossfade ──────────────────────────────────────────────────
    if (this.crossfadeFrom) {
      this.crossfadeElapsed += dt;
      const fromClip = this.clips[this.crossfadeFrom.clipIndex];
      if (fromClip) {
        this.crossfadeFrom.time += dt * this.playbackSpeed;
        if (this.crossfadeFrom.time > fromClip.duration) {
          this.crossfadeFrom.time = this.crossfadeFrom.time % fromClip.duration;
        }
      }
      if (this.crossfadeElapsed >= this.crossfadeDuration) {
        this.crossfadeFrom = null;
      }
    }

    // ── Advance layers ─────────────────────────────────────────────────────
    for (let i = this.animLayers.length - 1; i >= 0; i--) {
      const layer = this.animLayers[i]!;
      const layerClip = this.clips[layer.clipIndex];
      if (!layerClip) continue;

      layer.time += dt * layer.speed;
      if (layer.time > layerClip.duration) {
        if (layer.loop) {
          layer.time = layer.time % layerClip.duration;
        } else {
          layer.time = layerClip.duration;
          if (!layer.fadingOut) {
            layer.fadingOut = true;
            layer.fadeOutDuration = layer.blendInTime > 0 ? layer.blendInTime : 0;
            layer.fadeOutElapsed = 0;
          }
        }
      }

      if (!layer.fadingOut) {
        // Blend in
        if (layer.blendInTime > 0) {
          layer.currentWeight = Math.min(
            layer.currentWeight + dt / layer.blendInTime,
            layer.weight,
          );
        } else {
          layer.currentWeight = layer.weight;
        }
      } else {
        // Fade out
        layer.fadeOutElapsed += dt;
        if (layer.fadeOutDuration > 0) {
          layer.currentWeight =
            layer.weight * Math.max(1 - layer.fadeOutElapsed / layer.fadeOutDuration, 0);
        } else {
          layer.currentWeight = 0;
        }
        if (layer.currentWeight <= 0) {
          this.animLayers.splice(i, 1);
          continue;
        }
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

  /**
   * Play a clip by index or name.
   * @param indexOrName  Clip index or name. Omit to resume current.
   * @param blendTime    Seconds to crossfade from the current pose (0 = instant).
   */
  public play(indexOrName?: number | string, blendTime: number = 0): void {
    let targetIndex = this.activeClipIndex;
    if (indexOrName !== undefined) {
      if (typeof indexOrName === 'string') {
        const idx = this.clips.findIndex((c) => c.name === indexOrName);
        if (idx >= 0) targetIndex = idx;
      } else {
        targetIndex = Math.min(indexOrName, this.clips.length - 1);
      }
    }

    if (blendTime > 0 && targetIndex !== this.activeClipIndex) {
      // Save current state as the blend-from snapshot
      this.crossfadeFrom = { clipIndex: this.activeClipIndex, time: this.playbackTime };
      this.crossfadeDuration = blendTime;
      this.crossfadeElapsed = 0;
    } else {
      this.crossfadeFrom = null;
    }

    this.activeClipIndex = targetIndex;
    this.playbackTime = 0;
    this.playing = true;
    this._rootMotionFirstFrame = true; // reset root motion baseline on clip change
  }

  /**
   * Add an override animation layer on top of the base animation.
   * Returns a layer ID used with removeLayer / setLayerWeight.
   */
  public addLayer(clipIndexOrName: number | string, options?: AnimLayerOptions): number {
    let clipIndex: number;
    if (typeof clipIndexOrName === 'string') {
      // Case-insensitive search
      const lower = clipIndexOrName.toLowerCase();
      const idx = this.clips.findIndex((c) => c.name.toLowerCase() === lower);
      if (idx < 0) {
        console.warn(
          `[SkinnedMesh] addLayer: clip "${clipIndexOrName}" not found. Available:`,
          this.clips.map((c) => `"${c.name}"`).join(', '),
        );
        return -1;
      }
      clipIndex = idx;
    } else {
      clipIndex = Math.min(clipIndexOrName, this.clips.length - 1);
    }

    const weight = options?.weight ?? 1.0;
    const blendInTime = options?.blendInTime ?? 0;

    // Build joint mask if requested (propagate to children)
    let jointMask: boolean[] | null = null;
    if (options?.jointMask && options.jointMask.length > 0) {
      jointMask = new Array(this.jointCount).fill(false);
      for (const name of options.jointMask) {
        const idx = this.skeleton.names.indexOf(name);
        if (idx >= 0) this.markJointAndChildren(idx, jointMask);
      }
    }

    const id = this.nextLayerId++;
    this.animLayers.push({
      id,
      clipIndex,
      time: 0,
      weight,
      currentWeight: blendInTime > 0 ? 0 : weight,
      blendInTime,
      fadingOut: false,
      fadeOutDuration: 0,
      fadeOutElapsed: 0,
      loop: options?.loop ?? true,
      speed: options?.speed ?? 1.0,
      jointMask,
    });
    return id;
  }

  /**
   * Remove a layer by ID.
   * @param fadeOutTime  Seconds to fade the layer out before removing (0 = instant).
   */
  public removeLayer(id: number, fadeOutTime: number = 0): void {
    const layer = this.animLayers.find((l) => l.id === id);
    if (!layer) return;

    if (fadeOutTime > 0 && !layer.fadingOut) {
      layer.fadingOut = true;
      layer.fadeOutDuration = fadeOutTime;
      layer.fadeOutElapsed = 0;
    } else {
      const idx = this.animLayers.findIndex((l) => l.id === id);
      if (idx >= 0) this.animLayers.splice(idx, 1);
    }
  }

  /** Set the target blend weight for a layer (0–1). */
  public setLayerWeight(id: number, weight: number): void {
    const layer = this.animLayers.find((l) => l.id === id);
    if (layer) layer.weight = Math.max(0, Math.min(1, weight));
  }

  /**
   * Configure root motion handling.
   * @param mode
   *   - `'none'`    : default — root joint animated normally (good for in-place clips).
   *   - `'extract'` : root translation locked to bind pose; delta available via `getRootMotionDelta()`.
   *   - `'apply'`   : like `'extract'` but the delta is also applied to the entity's Transform.
   * @param includeY  If true, vertical (Y) displacement is included in the delta (e.g. for jump animations).
   */
  public setRootMotion(mode: RootMotionMode, includeY: boolean = false): void {
    this.rootMotionMode = mode;
    this.rootMotionIncludeY = includeY;
    this._rootMotionFirstFrame = true; // reset baseline when mode changes
    vec3.set(this.rootMotionDelta, 0, 0, 0);
  }

  /**
   * Returns the root motion displacement in world space accumulated this frame.
   * Only non-zero when rootMotionMode is `'extract'` or `'apply'`.
   * Read this in a physics controller to drive a character body.
   */
  public getRootMotionDelta(): Readonly<vec3> {
    return this.rootMotionDelta;
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

  // ── Extra animation loading ────────────────────────────────────────────────

  /**
   * Loads additional AnimationClips from separate GLTF files in assets/animations/.
   * Joints are matched by name against the already-loaded skeleton, so the mesh GLTF
   * and the animation GLTF don't need to share node indices.
   */
  private async loadExtraAnimations(paths: string[]): Promise<void> {
    // Build name → joint-index map from the existing skeleton.
    // Lowercase keys for case-insensitive matching against animation node names.
    const nameToJointIdx = new Map<string, number>();
    this.skeleton.names.forEach((name, idx) => nameToJointIdx.set(name.toLowerCase(), idx));

    for (const path of paths) {
      const baseUrl = `assets/animations/`;
      const url = `${baseUrl}${path}`;

      // Parse GLTF JSON directly — avoids gltf-transform buffer-length mismatches.
      let gltfJson: GltfRawJson;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        gltfJson = (await res.json()) as GltfRawJson;
      } catch (e) {
        console.warn(`[SkinnedMesh] loadExtraAnimations: could not fetch "${url}"`, e);
        continue;
      }

      // Fetch all binary buffer sidecars referenced by this GLTF.
      const bufferData: ArrayBuffer[] = [];
      for (const buf of gltfJson.buffers ?? []) {
        if (!buf.uri) {
          bufferData.push(new ArrayBuffer(0));
        } else if (buf.uri.startsWith('data:')) {
          const b64 = buf.uri.split(',')[1]!;
          const binary = atob(b64);
          const ab = new ArrayBuffer(binary.length);
          const u8 = new Uint8Array(ab);
          for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
          bufferData.push(ab);
        } else {
          try {
            const r = await fetch(`${baseUrl}${buf.uri}`);
            bufferData.push(await r.arrayBuffer());
          } catch {
            bufferData.push(new ArrayBuffer(0));
          }
        }
      }

      /** Read a flat Float32Array from a GLTF accessor index. */
      const readAccessor = (accIdx: number): Float32Array | null => {
        const acc = gltfJson.accessors?.[accIdx];
        if (!acc || acc.bufferView === undefined) return null;
        const bv = gltfJson.bufferViews?.[acc.bufferView];
        if (!bv) return null;
        const buffer = bufferData[bv.buffer];
        if (!buffer) return null;
        const componentCount =
          acc.type === 'SCALAR'
            ? 1
            : acc.type === 'VEC2'
              ? 2
              : acc.type === 'VEC3'
                ? 3
                : acc.type === 'VEC4'
                  ? 4
                  : acc.type === 'MAT4'
                    ? 16
                    : 1;
        const byteOffset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
        const elementBytes = acc.componentType === 5126 ? 4 : 1; // FLOAT=5126
        const totalBytes = acc.count * componentCount * elementBytes;
        // Guard against out-of-bounds access (malformed GLTF)
        if (byteOffset + totalBytes > buffer.byteLength) {
          console.warn(`[SkinnedMesh] accessor ${accIdx} out of bounds, skipping`);
          return null;
        }
        if (acc.componentType === 5126) {
          return new Float32Array(buffer, byteOffset, acc.count * componentCount);
        }
        // For non-float, convert via DataView
        const out = new Float32Array(acc.count * componentCount);
        const dv = new DataView(buffer, byteOffset);
        for (let i = 0; i < out.length; i++) out[i] = dv.getUint8(i);
        return out;
      };

      const newClips = (gltfJson.animations ?? []).map((anim) => {
        let duration = 0;
        const channels: AnimationChannel[] = [];

        for (const ch of anim.channels) {
          const nodeIdx = ch.target.node;
          if (nodeIdx === undefined) continue;
          const nodeName = gltfJson.nodes?.[nodeIdx]?.name;
          if (!nodeName) continue;

          // Case-insensitive name match
          const jointIndex = nameToJointIdx.get(nodeName.toLowerCase());
          if (jointIndex === undefined) continue;

          const sampler = anim.samplers[ch.sampler];
          if (!sampler) continue;
          const times = readAccessor(sampler.input);
          const values = readAccessor(sampler.output);
          if (!times || !values) continue;

          const animPath = ch.target.path as 'translation' | 'rotation' | 'scale';
          const interp = (sampler.interpolation ?? 'LINEAR') as AnimationChannel['interpolation'];

          if (times.length > 0) duration = Math.max(duration, times[times.length - 1]!);
          channels.push({
            jointIndex,
            path: animPath,
            times: new Float32Array(times),
            values: new Float32Array(values),
            interpolation: interp,
          });
        }

        // Mixamo exports all clips as "mixamo.com" — use the filename instead.
        const filenameBase = path.replace(/\.[^.]+$/, '');
        const clipName = !anim.name || anim.name === 'mixamo.com' ? filenameBase : anim.name;
        return { name: clipName, duration, channels };
      });

      this.clips.push(...newClips);
      console.log(
        `[SkinnedMesh] extra animations from "${path}":`,
        newClips
          .map((c) => `"${c.name}" dur=${c.duration.toFixed(2)}s channels=${c.channels.length}`)
          .join(', '),
        `| skeleton joints matched: ${newClips.reduce((s, c) => s + c.channels.length, 0)}`,
      );
    }
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

  /**
   * Evaluate a single clip into the provided per-joint TRS arrays.
   * Resets to bind pose first, then applies the clip's channels.
   */
  private evaluateClip(
    clipIndex: number,
    time: number,
    outT: Float32Array[],
    outR: Float32Array[],
    outS: Float32Array[],
  ): void {
    const bp = this.skeleton.bindPoseLocal;
    for (let i = 0; i < this.jointCount; i++) {
      const off = i * 10;
      outT[i]!.set([bp[off]!, bp[off + 1]!, bp[off + 2]!]);
      outR[i]!.set([bp[off + 3]!, bp[off + 4]!, bp[off + 5]!, bp[off + 6]!]);
      outS[i]!.set([bp[off + 7]!, bp[off + 8]!, bp[off + 9]!]);
    }
    const clip = this.clips[clipIndex];
    if (!clip) return;
    for (const channel of clip.channels) {
      const { jointIndex, path, times, values, interpolation } = channel;
      if (jointIndex >= this.jointCount) continue;
      if (path === 'translation') {
        sampleVec3(times, values, time, interpolation, outT[jointIndex]!);
      } else if (path === 'rotation') {
        sampleQuat(times, values, time, interpolation, outR[jointIndex]!);
      } else if (path === 'scale') {
        sampleVec3(times, values, time, interpolation, outS[jointIndex]!);
      }
    }
  }

  private evaluateAnimation(time: number): void {
    // ── Step 1: evaluate active ("to") clip ───────────────────────────────
    this.evaluateClip(this.activeClipIndex, time, this.localT, this.localR, this.localS);

    // ── Step 2: crossfade blend ───────────────────────────────────────────
    if (this.crossfadeFrom) {
      const alpha = Math.min(this.crossfadeElapsed / this.crossfadeDuration, 1.0);
      this.evaluateClip(
        this.crossfadeFrom.clipIndex,
        this.crossfadeFrom.time,
        this.tempT,
        this.tempR,
        this.tempS,
      );
      // Blend: result = from*(1-alpha) + to*alpha
      for (let i = 0; i < this.jointCount; i++) {
        const lT = this.localT[i]!;
        const tT = this.tempT[i]!;
        lT[0] = tT[0]! + (lT[0]! - tT[0]!) * alpha;
        lT[1] = tT[1]! + (lT[1]! - tT[1]!) * alpha;
        lT[2] = tT[2]! + (lT[2]! - tT[2]!) * alpha;
        const lS = this.localS[i]!;
        const tS = this.tempS[i]!;
        lS[0] = tS[0]! + (lS[0]! - tS[0]!) * alpha;
        lS[1] = tS[1]! + (lS[1]! - tS[1]!) * alpha;
        lS[2] = tS[2]! + (lS[2]! - tS[2]!) * alpha;
        quat.slerp(this.localR[i] as any, this.tempR[i] as any, this.localR[i] as any, alpha);
      }
    }

    // ── Step 3: apply override layers ────────────────────────────────────
    for (const layer of this.animLayers) {
      if (layer.currentWeight <= 0) continue;
      this.evaluateClip(layer.clipIndex, layer.time, this.tempT, this.tempR, this.tempS);
      const w = layer.currentWeight;
      for (let i = 0; i < this.jointCount; i++) {
        if (layer.jointMask && !layer.jointMask[i]) continue;
        const lT = this.localT[i]!;
        const tT = this.tempT[i]!;
        const lT0 = lT[0]!,
          lT1 = lT[1]!,
          lT2 = lT[2]!;
        lT[0] = lT0 + (tT[0]! - lT0) * w;
        lT[1] = lT1 + (tT[1]! - lT1) * w;
        lT[2] = lT2 + (tT[2]! - lT2) * w;
        const lS = this.localS[i]!;
        const tS = this.tempS[i]!;
        const lS0 = lS[0]!,
          lS1 = lS[1]!,
          lS2 = lS[2]!;
        lS[0] = lS0 + (tS[0]! - lS0) * w;
        lS[1] = lS1 + (tS[1]! - lS1) * w;
        lS[2] = lS2 + (tS[2]! - lS2) * w;
        quat.slerp(this.localR[i] as any, this.localR[i] as any, this.tempR[i] as any, w);
      }
    }

    // ── Step 4 (optional): root motion extraction ─────────────────────────
    if (this.rootMotionMode !== 'none' && this.rootJointIndex >= 0) {
      const rootT = this.localT[this.rootJointIndex]!;

      if (this._rootMotionFirstFrame || this._rootMotionDidLoop) {
        // First frame or loop boundary: store baseline, no displacement
        this.prevRootLocalT.set(rootT);
        vec3.set(this.rootMotionDelta, 0, 0, 0);
        this._rootMotionFirstFrame = false;
        this._rootMotionDidLoop = false;
      } else {
        // Compute local-space delta
        const dx = rootT[0]! - this.prevRootLocalT[0]!;
        const dy = this.rootMotionIncludeY ? rootT[1]! - this.prevRootLocalT[1]! : 0;
        const dz = rootT[2]! - this.prevRootLocalT[2]!;
        const delta = vec3.fromValues(dx, dy, dz);

        // Map through rootPreTransform rotation (e.g. Blender armature Z→Y up)
        vec3.transformQuat(delta, delta, this.rootPreRotation as unknown as quat);

        // Map through entity world rotation so delta is in world space
        const ownerTransform = (
          this.getOwner().getComponent('transform') as TransformComponent | null
        )?.getTransform();
        if (ownerTransform) {
          vec3.transformQuat(delta, delta, ownerTransform.getWorldRotation());
        }

        vec3.copy(this.rootMotionDelta, delta);
        this.prevRootLocalT.set(rootT);
      }

      // Lock root joint to bind pose (prevent mesh from drifting from entity origin)
      const bp = this.skeleton.bindPoseLocal;
      const bpOff = this.rootJointIndex * 10;
      this.localT[this.rootJointIndex]!.set([bp[bpOff]!, bp[bpOff + 1]!, bp[bpOff + 2]!]);

      // Optionally drive entity transform directly
      if (this.rootMotionMode === 'apply') {
        const ownerTransform = (
          this.getOwner().getComponent('transform') as TransformComponent | null
        )?.getTransform();
        if (ownerTransform) {
          const pos = ownerTransform.getLocalPosition();
          ownerTransform.setLocalPosition(vec3.add(vec3.create(), pos, this.rootMotionDelta));
        }
      }
    }

    // ── Step 5: compute global matrices (parents before children) ─────────
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
        this.globalMats[i] = mat4.mul(mat4.create(), rootPre, local);
      } else {
        this.globalMats[i] = mat4.mul(mat4.create(), this.globalMats[parentIdx]!, local);
      }
    }

    // ── Step 6: IK & procedural constraints ──────────────────────────────
    if (this.ikConstraints.length > 0) {
      this.applyIkConstraints();
    }

    // ── Step 7: compute joint palette from final global matrices ──────────
    const ibm = this.skeleton.inverseBindMatrices;
    for (let i = 0; i < this.jointCount; i++) {
      const ibmSlice = ibm.subarray(i * 16, i * 16 + 16) as unknown as mat4;
      this.jointPalette.set(mat4.mul(mat4.create(), this.globalMats[i]!, ibmSlice), i * 16);
    }
  }

  /** Recursively marks jointIdx and all its children as true in mask. */
  private markJointAndChildren(jointIdx: number, mask: boolean[]): void {
    mask[jointIdx] = true;
    const parents = this.skeleton.parents;
    for (let i = 0; i < this.jointCount; i++) {
      if (parents[i] === jointIdx && !mask[i]) {
        this.markJointAndChildren(i, mask);
      }
    }
  }

  // ── IK / Procedural constraint solvers ────────────────────────────────────

  private applyIkConstraints(): void {
    this._ikFrozenJoints.clear();
    for (const c of this.ikConstraints) {
      if (c.weight <= 0) continue;
      if (c.type === 'lookat') this.applyLookAt(c);
      else if (c.type === 'twobone') this.applyTwoBoneIK(c);
      else if (c.type === 'procedural_offset') this.applyProceduralOffset(c);
    }
    if (this._ikFrozenJoints.size > 0) this.repropagateMats();
  }

  /**
   * After IK modifies some globalMats, re-traverse in topological order
   * so that non-frozen joints downstream of frozen ones are updated.
   */
  private repropagateMats(): void {
    const parents = this.skeleton.parents;
    const rootPre = this.skeleton.rootPreTransform as unknown as mat4;

    for (const i of this.evalOrder) {
      if (this._ikFrozenJoints.has(i)) continue;
      const parentIdx = parents[i]!;
      // Only re-propagate if parent was touched (frozen or already re-propagated)
      if (parentIdx >= 0 && !this._ikFrozenJoints.has(parentIdx)) continue;

      const local = mat4.fromRotationTranslationScale(
        mat4.create(),
        this.localR[i] as any,
        this.localT[i] as any,
        this.localS[i] as any,
      );
      if (parentIdx < 0) {
        const rootPre2 = this.skeleton.rootPreTransform as unknown as mat4;
        this.globalMats[i] = mat4.mul(mat4.create(), rootPre2, local);
      } else {
        this.globalMats[i] = mat4.mul(mat4.create(), this.globalMats[parentIdx]!, local);
      }
      // Mark as updated so its children get re-propagated too
      this._ikFrozenJoints.add(i);
    }
    void rootPre; // suppress unused warning
  }

  // ── LookAt ────────────────────────────────────────────────────────────────

  private applyLookAt(c: LookAtConstraint): void {
    const jointIdx = this.skeleton.names.indexOf(c.jointName);
    if (jointIdx < 0) return;

    const M = this.globalMats[jointIdx]!;
    const pos = vec3.fromValues(M[12]!, M[13]!, M[14]!);

    const toTarget = vec3.sub(vec3.create(), c.target, pos);
    const dist = vec3.length(toTarget);
    if (dist < 0.0001) return;
    vec3.scale(toTarget, toTarget, 1.0 / dist);

    // Current world rotation
    const currentRot = quat.create();
    mat4.getRotation(currentRot as unknown as quat, M as unknown as mat4);
    quat.normalize(currentRot as unknown as quat, currentRot as unknown as quat);

    // Forward axis in world space
    const fwdLocal = c.forwardAxis ?? [0, 0, 1];
    const worldFwd = vec3.transformQuat(
      vec3.create(),
      fwdLocal as vec3,
      currentRot as unknown as quat,
    );

    // Shortest-arc rotation from current forward to target direction
    const q = quat.create();
    quat.rotationTo(q as unknown as quat, worldFwd, toTarget);

    // Apply angular limit
    if (c.limitAngleDeg !== undefined) {
      const limitRad = c.limitAngleDeg * (Math.PI / 180);
      // angle of a quaternion: theta = 2*acos(|w|)
      const w = Math.min(1, Math.abs((q as unknown as Float32Array)[3]!));
      const angle = 2 * Math.acos(w);
      if (angle > limitRad && angle > 0.0001) {
        quat.slerp(
          q as unknown as quat,
          quat.create() as unknown as quat,
          q as unknown as quat,
          limitRad / angle,
        );
      }
    }

    // Blend with weight
    quat.slerp(
      q as unknown as quat,
      quat.create() as unknown as quat,
      q as unknown as quat,
      c.weight,
    );

    // Apply delta rotation to current world rotation
    const newRot = quat.mul(
      quat.create() as unknown as quat,
      q as unknown as quat,
      currentRot as unknown as quat,
    );
    quat.normalize(newRot as unknown as quat, newRot as unknown as quat);

    const scale = vec3.create();
    mat4.getScaling(scale, M as unknown as mat4);
    mat4.fromRotationTranslationScale(M as unknown as mat4, newRot as unknown as quat, pos, scale);
    this._ikFrozenJoints.add(jointIdx);
  }

  // ── Two-bone IK ───────────────────────────────────────────────────────────

  private applyTwoBoneIK(c: TwoBoneIkConstraint): void {
    const rootIdx = this.skeleton.names.indexOf(c.rootJointName);
    const midIdx = this.skeleton.names.indexOf(c.midJointName);
    const tipIdx = this.skeleton.names.indexOf(c.tipJointName);
    if (rootIdx < 0 || midIdx < 0 || tipIdx < 0) return;

    const MR = this.globalMats[rootIdx]!;
    const MM = this.globalMats[midIdx]!;
    const MT = this.globalMats[tipIdx]!;

    const pA = vec3.fromValues(MR[12]!, MR[13]!, MR[14]!);
    const pB = vec3.fromValues(MM[12]!, MM[13]!, MM[14]!);
    const pC = vec3.fromValues(MT[12]!, MT[13]!, MT[14]!);

    const d1 = vec3.distance(pA, pB);
    const d2 = vec3.distance(pB, pC);
    if (d1 < 0.0001 || d2 < 0.0001) return;

    // Direction from root to target
    const toTarget = vec3.sub(vec3.create(), c.target, pA);
    let rawDist = vec3.length(toTarget);
    if (rawDist < 0.0001) return;

    // Clamp to reachable distance
    const maxReach = d1 + d2 - 0.001;
    const minReach = Math.abs(d1 - d2) + 0.001;
    const clampedDist = Math.max(minReach, Math.min(maxReach, rawDist));
    const dir = vec3.scale(vec3.create(), toTarget, 1 / rawDist);

    // Pole direction: perpendicular to dir, using poleTarget or original mid joint
    const poleSource = c.poleTarget ?? pB;
    const toPole = vec3.sub(vec3.create(), poleSource, pA);
    const dp = vec3.dot(toPole, dir);
    const polePerp = vec3.sub(vec3.create(), toPole, vec3.scale(vec3.create(), dir, dp));
    const poleLen = vec3.length(polePerp);
    if (poleLen < 0.0001) {
      // Degenerate: pole is colinear with target, use world up
      vec3.set(polePerp, 0, 1, 0);
    } else {
      vec3.scale(polePerp, polePerp, 1 / poleLen);
    }

    // Law of cosines: angle at root between (root→target) and upper bone
    const cosA = Math.max(
      -1,
      Math.min(1, (d1 * d1 + clampedDist * clampedDist - d2 * d2) / (2 * d1 * clampedDist)),
    );
    const angleA = Math.acos(cosA);

    // New mid-joint position: pA + d1*(cos(angleA)*dir + sin(angleA)*polePerp)
    const pB_new = vec3.add(
      vec3.create(),
      pA,
      vec3.add(
        vec3.create(),
        vec3.scale(vec3.create(), dir, Math.cos(angleA) * d1),
        vec3.scale(vec3.create(), polePerp, Math.sin(angleA) * d1),
      ),
    );

    // Clamped target position
    const pT_adj = vec3.add(vec3.create(), pA, vec3.scale(vec3.create(), dir, clampedDist));

    // --- Update root joint ---
    const origAB = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), pB, pA));
    const newAB = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), pB_new, pA));
    const qRoot = quat.create();
    quat.rotationTo(qRoot as unknown as quat, origAB, newAB);

    // Apply weight as a partial delta
    quat.slerp(
      qRoot as unknown as quat,
      quat.create() as unknown as quat,
      qRoot as unknown as quat,
      c.weight,
    );

    const rootRot = quat.create();
    mat4.getRotation(rootRot as unknown as quat, MR as unknown as mat4);
    quat.normalize(rootRot as unknown as quat, rootRot as unknown as quat);
    const newRootRot = quat.mul(
      quat.create() as unknown as quat,
      qRoot as unknown as quat,
      rootRot as unknown as quat,
    );
    quat.normalize(newRootRot as unknown as quat, newRootRot as unknown as quat);

    const rootScale = vec3.create();
    mat4.getScaling(rootScale, MR as unknown as mat4);
    mat4.fromRotationTranslationScale(
      MR as unknown as mat4,
      newRootRot as unknown as quat,
      pA,
      rootScale,
    );
    this._ikFrozenJoints.add(rootIdx);

    // Blended mid-joint and target positions
    const pB_final = c.weight < 1 ? vec3.lerp(vec3.create(), pB, pB_new, c.weight) : pB_new;
    const pT_final = c.weight < 1 ? vec3.lerp(vec3.create(), pC, pT_adj, c.weight) : pT_adj;

    // --- Update mid joint ---
    const origBC = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), pC, pB));
    const newBC = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), pT_final, pB_final));
    const qMid = quat.create();
    quat.rotationTo(qMid as unknown as quat, origBC, newBC);

    const midRot = quat.create();
    mat4.getRotation(midRot as unknown as quat, MM as unknown as mat4);
    quat.normalize(midRot as unknown as quat, midRot as unknown as quat);
    const newMidRot = quat.mul(
      quat.create() as unknown as quat,
      qMid as unknown as quat,
      midRot as unknown as quat,
    );
    quat.normalize(newMidRot as unknown as quat, newMidRot as unknown as quat);

    const midScale = vec3.create();
    mat4.getScaling(midScale, MM as unknown as mat4);
    mat4.fromRotationTranslationScale(
      MM as unknown as mat4,
      newMidRot as unknown as quat,
      pB_final,
      midScale,
    );
    this._ikFrozenJoints.add(midIdx);

    // Tip is re-propagated automatically (not frozen); its world mat becomes
    // MM_new * localMat[tip], placing the wrist/ankle at roughly pT_final.
    void tipIdx;
  }

  // ── Procedural offset ─────────────────────────────────────────────────────

  private applyProceduralOffset(c: ProceduralOffsetConstraint): void {
    const jointIdx = this.skeleton.names.indexOf(c.jointName);
    if (jointIdx < 0) return;

    const M = this.globalMats[jointIdx]!;
    const pos = vec3.fromValues(M[12]!, M[13]!, M[14]!);
    const scale = vec3.create();
    mat4.getScaling(scale, M as unknown as mat4);
    const rot = quat.create();
    mat4.getRotation(rot as unknown as quat, M as unknown as mat4);
    quat.normalize(rot as unknown as quat, rot as unknown as quat);

    if (c.rotationOffset) {
      const blendedRot = quat.slerp(
        quat.create() as unknown as quat,
        quat.create() as unknown as quat,
        c.rotationOffset as unknown as quat,
        c.weight,
      );
      quat.mul(rot as unknown as quat, rot as unknown as quat, blendedRot as unknown as quat);
      quat.normalize(rot as unknown as quat, rot as unknown as quat);
    }

    if (c.translationOffset) {
      const scaledOffset = vec3.scale(vec3.create(), c.translationOffset, c.weight);
      vec3.add(pos, pos, scaledOffset);
    }

    mat4.fromRotationTranslationScale(M as unknown as mat4, rot as unknown as quat, pos, scale);
    this._ikFrozenJoints.add(jointIdx);
  }

  // ── Public IK API ─────────────────────────────────────────────────────────

  /**
   * Register an IK or procedural constraint.
   * Returns the constraint object itself — update its `target` / `weight` /
   * `rotationOffset` fields in-place each frame.
   */
  public addIkConstraint<T extends IkConstraint>(constraint: T): T {
    this.ikConstraints.push(constraint);
    return constraint;
  }

  /**
   * Remove a constraint by reference.
   */
  public removeIkConstraint(constraint: IkConstraint): void {
    const idx = this.ikConstraints.indexOf(constraint);
    if (idx >= 0) this.ikConstraints.splice(idx, 1);
  }

  /** Remove all IK / procedural constraints. */
  public clearIkConstraints(): void {
    this.ikConstraints.length = 0;
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
