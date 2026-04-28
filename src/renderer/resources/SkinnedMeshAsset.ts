/**
 * SkinnedMeshAsset — cached, shareable parsed GLTF data for a skinned character.
 *
 * Holds everything that is identical across all instances of the same mesh:
 *   - SkeletonData (joint hierarchy, inverse-bind matrices, bind pose)
 *   - AnimationClip[] (keyframe data)
 *   - SkinnedMesh[] (shared GPU vertex / index buffers — read-only at runtime)
 *   - Material (already cached by Material.get())
 *   - evalOrder, rootJointIndex, rootPreRotation (derived from skeleton)
 *
 * Usage (try-catch pattern consistent with all other engine resources):
 *   const asset = await SkinnedMeshAsset.get('idle.gltf');
 *
 * The asset lives in ResourceManager keyed as `skinned_asset:<gltfName>` and is
 * never destroyed while the page is alive — GLTF parsing happens only once.
 */
import {
  WebIO,
  Node as GltfNode,
  Mesh as GltfMesh,
  Skin as GltfSkin,
  Animation as GltfAnimation,
} from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { mat4, quat } from 'gl-matrix';

import { BaseResource, IResourceOptions } from '../../core/resources/IResource';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { ResourceType } from '../../types/ResourceType.enum';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { Material } from './Material';
import { SkinnedMesh } from './SkinnedMesh';
import { SkeletonData, AnimationClip, AnimationChannel } from '../../types/SkinData.type';

export class SkinnedMeshAsset extends BaseResource {
  // ── Shared data (read-only at runtime) ──────────────────────────────────
  public skeleton!: SkeletonData;
  /** Base animation clips from the main GLTF. Immutable — do not push to this array. */
  public clips: AnimationClip[] = [];
  /** Shared GPU vertex/index buffers. Never call dispose() on these from a component. */
  public skinnedMeshes: SkinnedMesh[] = [];
  public material!: Material;

  /** Joint indices in parent-before-child topological order. */
  public evalOrder: number[] = [];
  /** Index of the root joint (parents[i] === -1). */
  public rootJointIndex: number = -1;
  /** Rotation extracted from rootPreTransform (for root-motion direction mapping). */
  public rootPreRotation: Float32Array = new Float32Array([0, 0, 0, 1]);

  // ── Factory ──────────────────────────────────────────────────────────────

  /**
   * Returns a cached SkinnedMeshAsset for `gltfName`, parsing it on first access.
   * Subsequent calls for the same file return immediately from ResourceManager.
   */
  public static async get(gltfName: string): Promise<SkinnedMeshAsset> {
    const key = `skinned_asset:${gltfName}`;
    try {
      return ResourceManager.getResource<SkinnedMeshAsset>(key);
    } catch {
      const asset = new SkinnedMeshAsset({ path: key, type: ResourceType.SKINNED_MESH_ASSET });
      ResourceManager.registerResource(asset);
      await asset.parse(gltfName);
      return asset;
    }
  }

  // BaseResource requires a sync load() — we use the async parse() path instead.
  public load(): void {}

  // ── GLTF parsing ─────────────────────────────────────────────────────────

  private async parse(gltfName: string): Promise<void> {
    const io = new WebIO().registerExtensions(ALL_EXTENSIONS);
    const folderName = gltfName.split('.')[0]!;
    const gltfUrl = `assets/meshes/${folderName}/${gltfName}`;

    const jsonResponse = await fetch(gltfUrl);
    const gltfJson = await jsonResponse.json();

    // Stub images so gltf-transform never fetches textures (we resolve URIs ourselves).
    const resources: Record<string, Uint8Array> = {};
    for (const image of (gltfJson.images ?? []) as { uri?: string }[]) {
      if (image.uri && !image.uri.startsWith('data:')) resources[image.uri] = new Uint8Array(0);
    }
    for (const buffer of (gltfJson.buffers ?? []) as { uri?: string }[]) {
      if (buffer.uri && !buffer.uri.startsWith('data:')) {
        const r = await fetch(`assets/meshes/${folderName}/${buffer.uri}`);
        resources[buffer.uri] = new Uint8Array(await r.arrayBuffer());
      }
    }

    const doc = await io.readJSON({ json: gltfJson, resources });
    const root = doc.getRoot();
    const scene = root.getDefaultScene();
    if (!scene) throw new Error(`SkinnedMeshAsset: no default scene in ${gltfName}`);

    // ── Collect skinned mesh nodes ───────────────────────────────────────
    const meshNodes: { mesh: GltfMesh; node: GltfNode }[] = [];
    const traverse = (node: GltfNode): void => {
      const m = node.getMesh();
      if (m && m.listPrimitives()[0]?.getAttribute('JOINTS_0')) meshNodes.push({ mesh: m, node });
      node.listChildren().forEach(traverse);
    };
    scene.listChildren().forEach(traverse);
    if (meshNodes.length === 0)
      throw new Error(`SkinnedMeshAsset: no skinned primitive in ${gltfName}`);

    // ── Build shared GPU meshes ──────────────────────────────────────────
    this.skinnedMeshes = await Promise.all(
      meshNodes.map(({ mesh }) => this.buildMesh(mesh, folderName)),
    );

    // ── Build shared material ────────────────────────────────────────────
    const firstPrim = meshNodes[0]!.mesh.listPrimitives()[0]!;
    const matData = firstPrim.getMaterial();
    const albedoTex = matData?.getBaseColorTexture();
    const normalTex = matData?.getNormalTexture();
    const mrTex = matData?.getMetallicRoughnessTexture();

    const getTexName = (tex: { getURI: () => string } | null | undefined): string => {
      if (!tex) return 'white.png';
      const uri = tex.getURI();
      return uri ? `${folderName}/${uri.split('/').pop()!}` : 'white.png';
    };

    this.material = await Material.get({
      technique: 'gbuffer/gbuffer_skinned.tech',
      category: RenderCategory.SOLIDS,
      casts_shadows: false,
      textures: {
        txAlbedo: getTexName(albedoTex),
        txNormal: normalTex ? getTexName(normalTex) : 'no-normal.jpg',
        txMetallic: getTexName(mrTex),
        txRoughness: getTexName(mrTex),
        txEmissive: 'black.png',
      },
      baseColorFactor: (matData?.getBaseColorFactor() ?? [1, 1, 1, 1]) as [
        number,
        number,
        number,
        number,
      ],
      metallicFactor: matData?.getMetallicFactor() ?? 0.0,
      roughnessFactor: matData?.getRoughnessFactor() ?? 0.8,
      emissiveFactor: 0,
    });

    // ── Extract skeleton ─────────────────────────────────────────────────
    const skin = root.listSkins()[0];
    if (!skin) throw new Error(`SkinnedMeshAsset: no skin in ${gltfName}`);
    this.skeleton = this.extractSkeleton(skin, root.listNodes());

    // ── Derived skeleton data ────────────────────────────────────────────
    this.evalOrder = this.computeTopoOrder(this.skeleton.parents);
    this.rootJointIndex = this.skeleton.parents.indexOf(-1);

    const rpRot = quat.create();
    mat4.getRotation(rpRot as unknown as quat, this.skeleton.rootPreTransform as unknown as mat4);
    quat.normalize(rpRot as unknown as quat, rpRot as unknown as quat);
    this.rootPreRotation = new Float32Array(rpRot);

    // ── Extract animation clips ──────────────────────────────────────────
    this.clips = this.extractAnimations(root.listAnimations(), root.listNodes());

    console.log(
      `[SkinnedMeshAsset] parsed "${gltfName}" — joints: ${this.skeleton.joints.length}, clips: ${this.clips.length}`,
      this.clips.map((c) => `"${c.name}" ${c.duration.toFixed(2)}s`).join(', '),
    );
  }

  // ── Build a single GPU SkinnedMesh from a GLTF mesh ──────────────────────

  private async buildMesh(mesh: GltfMesh, folderName: string): Promise<SkinnedMesh> {
    const prim = mesh.listPrimitives()[0]!;
    const positions = prim.getAttribute('POSITION')!.getArray()! as Float32Array;
    const normals = prim.getAttribute('NORMAL')!.getArray()! as Float32Array;
    const uvs = prim.getAttribute('TEXCOORD_0')?.getArray() as Float32Array | undefined;
    const tangents = prim.getAttribute('TANGENT')?.getArray() as Float32Array | undefined;
    const jointsRaw = prim.getAttribute('JOINTS_0')!.getArray()!;
    const weights = new Float32Array(prim.getAttribute('WEIGHTS_0')!.getArray()!);
    const indices = prim.getIndices()!.getArray() as Uint16Array | Uint32Array;

    const joints8 = new Uint8Array(jointsRaw.length);
    for (let i = 0; i < jointsRaw.length; i++) joints8[i] = (jointsRaw[i] as number) & 0xff;

    const sm = SkinnedMesh.createFromData(
      {
        attributes: {
          POSITION: positions,
          NORMAL: normals,
          TEXCOORD_0: uvs ?? new Float32Array((positions.length / 3) * 2),
          TANGENT: tangents,
        },
        indices,
      } as any,
      { joints: joints8, weights },
    );
    await sm.loadAsync();
    return sm;
  }

  // ── Skeleton extraction ───────────────────────────────────────────────────

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

    const nodeToJoint = new Map<GltfNode, number>();
    jointNodes.forEach((node, i) => nodeToJoint.set(node, i));

    const parents: number[] = new Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const parent = jointNodes[i]!.getParentNode?.();
      if (parent && nodeToJoint.has(parent)) parents[i] = nodeToJoint.get(parent)!;
    }

    const bindPoseLocal = new Float32Array(n * 10);
    for (let i = 0; i < n; i++) {
      const node = jointNodes[i]!;
      const t = node.getTranslation(),
        r = node.getRotation(),
        s = node.getScale();
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

    // Accumulate transforms of non-joint ancestor nodes (e.g. Blender armature)
    const rootPreTransformMat = mat4.create();
    const firstRootIdx = parents.indexOf(-1);
    if (firstRootIdx >= 0) {
      const ancestors: GltfNode[] = [];
      let ancestor = jointNodes[firstRootIdx]!.getParentNode?.() ?? null;
      while (ancestor) {
        ancestors.push(ancestor);
        ancestor = ancestor.getParentNode?.() ?? null;
      }
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const a = ancestors[i]!;
        const am = mat4.fromRotationTranslationScale(
          mat4.create(),
          a.getRotation() as any,
          a.getTranslation() as any,
          a.getScale() as any,
        );
        mat4.mul(rootPreTransformMat, rootPreTransformMat, am);
      }
    }

    return {
      inverseBindMatrices,
      joints: jointNodes.map((node) => allNodes.indexOf(node)),
      parents,
      names: jointNodes.map((nd) => nd.getName()),
      bindPoseLocal,
      rootPreTransform: new Float32Array(rootPreTransformMat),
    };
  }

  // ── Animation clip extraction ─────────────────────────────────────────────

  private extractAnimations(animations: GltfAnimation[], allNodes: GltfNode[]): AnimationClip[] {
    return animations.map((anim) => {
      let duration = 0;
      const channels: AnimationChannel[] = [];

      for (const channel of anim.listChannels()) {
        const targetNode = channel.getTargetNode();
        if (!targetNode) continue;
        const nodeIdx = allNodes.indexOf(targetNode);
        const jointIndex = this.skeleton.joints.indexOf(nodeIdx);
        if (jointIndex < 0) continue;

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

        if (times.length > 0) duration = Math.max(duration, times[times.length - 1]!);
        channels.push({ jointIndex, path, times, values, interpolation: interp });
      }

      return { name: anim.getName() || 'animation', duration, channels };
    });
  }

  // ── Topological sort ──────────────────────────────────────────────────────

  private computeTopoOrder(parents: number[]): number[] {
    const n = parents.length;
    const order: number[] = [];
    const done = new Uint8Array(n);
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
}
