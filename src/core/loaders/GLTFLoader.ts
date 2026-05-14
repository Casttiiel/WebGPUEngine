import { EntityDataType } from '../../types/SceneData.type';
import { TransformComponentDataType } from '../../types/TransformComponentData.type';
import { RenderComponentDataType } from '../../types/RenderComponentData.type';
import { MaterialDataType } from '../../types/MaterialData.type';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { RasterizationMode } from '../../types/RasterizationMode.enum';
import { FragmentShaderTargets } from '../../types/FragmentShaderTargets.enum';
import { PipelineBindGroupLayouts } from '../../types/PipelineBindGroupLayouts.enum';
import { Node, WebIO, Material, Primitive, Texture } from '@gltf-transform/core';
import { Transmission } from '@gltf-transform/extensions';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { mat4 } from 'gl-matrix';
import { BlendModes } from '../../types/BlendModes.enum';
import { DepthModes } from '../../types/DepthModes.enum';
import { QualitySettings } from '../engine/QualitySettings';
import { NavMeshBuilder } from '../../ai/nav/NavMeshBuilder';
import type { Mesh } from '../../renderer/resources/Mesh';
import { ResourceManager } from '../engine/ResourceManager';
import { ResourceType } from '../../types/ResourceType.enum';

export class GLTFLoader {
  // Singleton para no re-registrar ~40 extensiones en cada carga
  private static io = new WebIO().registerExtensions(ALL_EXTENSIONS);

  /**
   * Loads the first renderable mesh primitive from a GLTF file as a cached Mesh resource.
   * @param path GLTF filename (e.g. 'leaf_uv.gltf'). File must live in assets/meshes/<basename>/.
   */
  public static async loadAsMesh(path: string): Promise<Mesh> {
    // Cache hit
    try {
      return ResourceManager.getResource<Mesh>(path);
    } catch {
      /* not cached — load it */
    }

    const folderName = path.split('.')[0];
    const gltfUrl = `assets/meshes/${folderName}/${path}`;

    // Fetch GLTF JSON
    const jsonResponse = await fetch(gltfUrl);
    const json = await jsonResponse.json();

    // Fetch geometry buffers only — skip textures (same as loadGLTF)
    const resources: Record<string, Uint8Array> = {};
    for (const image of (json.images ?? []) as { uri?: string }[]) {
      if (image.uri && !image.uri.startsWith('data:')) {
        resources[image.uri] = new Uint8Array(0);
      }
    }
    const buffers = ((json.buffers ?? []) as { uri?: string }[]).filter(
      (b) => b.uri && !b.uri.startsWith('data:'),
    );
    await Promise.all(
      buffers.map(async (buffer) => {
        const res = await fetch(`assets/meshes/${folderName}/${buffer.uri}`);
        resources[buffer.uri!] = new Uint8Array(await res.arrayBuffer());
      }),
    );

    const doc = await GLTFLoader.io.readJSON({ json, resources });

    // Find first primitive with geometry
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        const posAccessor = prim.getAttribute('POSITION');
        const idxAccessor = prim.getIndices();
        if (!posAccessor || !idxAccessor) continue;

        const meshData = {
          attributes: {
            POSITION: posAccessor.getArray()!,
            NORMAL: prim.getAttribute('NORMAL')?.getArray() ?? new Float32Array(0),
            TEXCOORD_0: prim.getAttribute('TEXCOORD_0')?.getArray() ?? new Float32Array(0),
            TANGENT: prim.getAttribute('TANGENT')?.getArray() ?? undefined,
          },
          indices: idxAccessor.getArray()!,
        };

        // Dynamic import avoids the static-import cycle:
        // Mesh → GPUResource → GPUUtils → Render → Texture → GPUResource (TDZ)
        const { Mesh: MeshCtor } = await import('../../renderer/resources/Mesh');
        const result = new MeshCtor({
          path,
          type: ResourceType.MESH,
          meshData: meshData as never,
        });
        ResourceManager.registerResource(result);
        await result.loadAsync(); // hasData already true → skips fetch, calls initBuffers()
        return result as Mesh;
      }
    }

    throw new Error(`[GLTFLoader.loadAsMesh] No mesh primitive found in: ${path}`);
  }

  public static async loadGLTF(path: string): Promise<Array<EntityDataType>> {
    const folderName = path.split('.')[0];
    const gltfUrl = `assets/meshes/${folderName}/${path}`;

    // ── Fetch only the .gltf JSON file ──────────────────────────────────
    // We avoid using io.read() because it fetches ALL external resources,
    // including textures that may not exist — producing 404 console errors.
    // Instead we manually provide resources to readJSON() so gltf-transform
    // never makes any additional HTTP requests.
    const jsonResponse = await fetch(gltfUrl);
    const json = await jsonResponse.json();

    // ── Build resources map ──────────────────────────────────────────────
    // - Geometry buffers (.bin): actually fetched (mesh data is required).
    // - Images (textures):       empty Uint8Array — only the URI strings are
    //                            needed by this loader (via texture.getURI()).
    const resources: Record<string, Uint8Array> = {};

    for (const image of (json.images ?? []) as { uri?: string }[]) {
      if (image.uri && !image.uri.startsWith('data:')) {
        resources[image.uri] = new Uint8Array(0);
      }
    }

    // Fetch all geometry buffers in parallel
    const buffers = ((json.buffers ?? []) as { uri?: string }[]).filter(
      (b) => b.uri && !b.uri.startsWith('data:'),
    );
    await Promise.all(
      buffers.map(async (buffer) => {
        const bufResponse = await fetch(`assets/meshes/${folderName}/${buffer.uri}`);
        resources[buffer.uri!] = new Uint8Array(await bufResponse.arrayBuffer());
      }),
    );

    // ── Parse with gltf-transform (no extra fetches) ─────────────────────
    const doc = await GLTFLoader.io.readJSON({ json, resources });

    // ── Get default scene ────────────────────────────────────────────────
    const scene = doc.getRoot().getDefaultScene();

    if (!scene) {
      throw new Error('El glTF no tiene una escena por defecto');
    }

    const res: EntityDataType = {
      children: [],
      components: {
        transform: {
          matrix: Array.from(mat4.create()) as [
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
          ],
        },
      },
    };

    const childs = await this.processNodeList(scene.listChildren(), folderName);
    res.children = childs;
    return res;
  }

  private static async processNodeList(
    nodeList: Node[],
    folderName: string,
  ): Promise<Array<EntityDataType>> {
    const res = [];
    for (const node of nodeList) {
      const mesh = node.getMesh();
      let nodeEntity = null;
      if (mesh) {
        const meshExtras = node.getExtras() as Record<string, unknown> | null;
        if (meshExtras && meshExtras['type'] === 'navmesh') {
          await this.processNavMeshNode(node);
          // Invisible placeholder — navmesh is never rendered
          nodeEntity = { children: [], components: { transform: {} } };
        } else {
          nodeEntity = this.processMeshNode(node, folderName);
        }
      } else {
        const extras = node.getExtras() as Record<string, unknown> | null;
        if (extras && extras['type'] === 'player_spawn') {
          nodeEntity = {
            children: [],
            components: {
              transform: this.getNodeTransform(node),
              player_spawn: {},
            },
          };
        } else {
          nodeEntity = {
            children: [],
            components: {
              transform: {},
            },
          };
        }
      }

      if (node.listChildren().length > 0) {
        nodeEntity.children = await this.processNodeList(node.listChildren(), folderName);
      }
      res.push(nodeEntity);
    }

    return res;
  }

  private static processMeshNode(node: Node, folderName: string): EntityDataType {
    const transform = this.getNodeTransform(node);
    const render = this.getNodeRender(node, folderName);

    // Check if node has extras with collider field
    const extras = node.getExtras();
    const shouldCreateCollider = !(
      extras &&
      typeof extras === 'object' &&
      'collider' in extras &&
      (extras as any).collider === 'none'
    );

    const res: EntityDataType = {
      children: [],
      components: {
        transform,
        render,
      },
    };

    // Only add mesh_collider if not explicitly disabled
    if (shouldCreateCollider) {
      const collider = this.getNodeCollider(render, node);
      res.components.mesh_collider = collider;
    }

    return res;
  }

  private static getNodeRender(node: Node, folderName: string): RenderComponentDataType {
    const mesh = node.getMesh();
    if (!mesh) {
      throw new Error('Node has no mesh');
    }

    const res = {
      meshes: [],
    };

    const primitives = mesh.listPrimitives();
    if (!primitives || primitives.length === 0) {
      throw new Error('Mesh has no primitives');
    }

    for (const prim of primitives) {
      const materialResult = this.getPrimitiveMaterial(prim, folderName);

      const primitiveInfo: any = {
        meshData: {
          attributes: {
            POSITION: prim.getAttribute('POSITION')?.getArray(),
            NORMAL: prim.getAttribute('NORMAL')?.getArray(),
            TEXCOORD_0: prim.getAttribute('TEXCOORD_0')?.getArray(),
            TANGENT: prim.getAttribute('TANGENT')?.getArray(),
          },
          indices: prim.getIndices()?.getArray(),
        },
      };

      // If materialResult is a string, use 'material', otherwise use 'materialData'
      if (typeof materialResult === 'string') {
        primitiveInfo.material = materialResult;
      } else {
        primitiveInfo.materialData = materialResult;
      }

      res.meshes.push(primitiveInfo);
    }

    return res;
  }

  private static getPrimitiveMaterial(
    primitive: Primitive,
    folderName: string,
  ): MaterialDataType | string {
    const materialData = primitive.getMaterial();
    if (!materialData) {
      throw new Error('Primitive has no material');
    }

    // Check if material has extras with materialToUse
    const extras = materialData.getExtras();
    if (extras && typeof extras === 'object' && 'materialToUse' in extras) {
      const materialToUse = (extras as any).materialToUse;
      if (typeof materialToUse === 'string') {
        return materialToUse; // Return material name directly
      }
    }

    const emissiveFactor = materialData.getEmissiveFactor();
    const hasEmissive = emissiveFactor.some((value) => value !== 0);

    let material: MaterialDataType = {
      category: this.getCategory(materialData),
      textures: {
        txAlbedo: materialData.getBaseColorTexture()
          ? this.getTextureName(materialData.getBaseColorTexture()!, folderName)
          : 'white.png',
        txNormal: materialData.getNormalTexture()
          ? this.getTextureName(materialData.getNormalTexture()!, folderName)
          : 'no-normal.jpg',
        txMetallic: materialData.getMetallicRoughnessTexture()
          ? this.getTextureName(materialData.getMetallicRoughnessTexture()!, folderName)
          : 'black.png',
        txRoughness: materialData.getMetallicRoughnessTexture()
          ? this.getTextureName(materialData.getMetallicRoughnessTexture()!, folderName)
          : 'white.png',
        txEmissive: materialData.getEmissiveTexture()
          ? this.getTextureName(materialData.getEmissiveTexture()!, folderName)
          : hasEmissive
            ? 'white.png'
            : 'black.png',
      },
      baseColorFactor: materialData.getBaseColorFactor() || [1, 1, 1, 1],
      metallicFactor: materialData.getMetallicFactor() || 1,
      roughnessFactor: materialData.getRoughnessFactor() || 1,
      emissiveFactor: hasEmissive ? 5 : 0,
    };

    // Glass (KHR_materials_transmission): el baseColorFactor RGB viene en [0,0,0] porque
    // es un modelo de transmisión física — no sirve para rasterización simple.
    // Sustituir por tinte neutro; el alpha real es (1 - transmissionFactor) —
    // baseColorFactor[3] suele ser 1.0 para estos materiales (opaco por defecto en GLTF).
    if (this.isGlass(materialData)) {
      const transmission = materialData.getExtension<Transmission>('KHR_materials_transmission');
      // getTransmissionFactor() defaults to 0.0 in gltf-transform when not set in the GLTF.
      // A material that passed isGlass() but has factor=0 is glass with unset factor — treat as
      // fully transmissive (factor=1). Using || 1.0 covers both null/undefined and 0.
      const transmissionFactor = transmission?.getTransmissionFactor() || 1.0;
      // transmissionFactor=1 → fully transparent (alpha=0.05 min so it isn't invisible)
      // transmissionFactor=0.5 → semi-transparent glass (alpha=0.5)
      const alpha = Math.max(0.08, 1.0 - transmissionFactor);
      material = { ...material, baseColorFactor: [0.85, 0.95, 1.0, alpha] };
    }

    material = this.addTechniqueData(materialData, material);
    return material;
  }

  private static addTechniqueData(
    materialData: Material,
    material: MaterialDataType,
  ): MaterialDataType {
    const isGlass = this.isGlass(materialData);
    const isDecal = this.isDecal(materialData);
    const isBlend = materialData.getAlphaMode() === 'BLEND';
    const isMask = materialData.getAlphaMode() === 'MASK';
    const isDither = QualitySettings.getInstance().getSettings().ditheringMode === 'psx';

    // Resolve technique and fragment shader
    let technique = 'gbuffer/gbuffer.tech';
    let fs = 'gbuffer/gbuffer.fs';
    if (isDecal) {
      technique = 'gbuffer/decal.tech';
      fs = 'gbuffer/decal.fs';
    } else if (isMask) {
      if (isDither) {
        technique = 'gbuffer/gbuffer_dither.tech';
        fs = 'gbuffer/gbuffer_dither.fs';
      } else {
        technique = 'gbuffer/gbuffer_mask.tech';
        fs = 'gbuffer/gbuffer_mask.fs';
      }
    } else if (isGlass) {
      technique = 'utility/oit_gather.tech';
      fs = 'utility/oit_gather.fs';
    } else if (isBlend) {
      if (isDither) {
        technique = 'gbuffer/gbuffer_dither.tech';
        fs = 'gbuffer/gbuffer_dither.fs';
      } else {
        technique = 'utility/transparent.tech';
        fs = 'utility/transparent.fs';
      }
    }

    // Decals always need an inline techniqueData (GBufferUniforms at group 3).
    // decal_flat uses the mesh's own UV coords and blends by alpha — designed for
    // artist-placed flat planes (e.g. GLTF dirt decals), not projected cube decals.
    if (isDecal) {
      material.techniqueData = {
        vs: 'gbuffer/gbuffer.vs',
        fs: 'gbuffer/decal_flat.fs',
        uniforms: [
          PipelineBindGroupLayouts.CAMERA_UNIFORMS,
          PipelineBindGroupLayouts.MATERIAL_TEXTURES,
          PipelineBindGroupLayouts.OBJECT_UNIFORMS,
          PipelineBindGroupLayouts.GBUFFER_UNIFORMS,
        ] as const,
        writesOn: FragmentShaderTargets.PARTIAL_GBUFFER,
        rs: RasterizationMode.DOUBLE_SIDED,
        z: DepthModes.LESS_EQUAL_NO_WRITE,
        blend: BlendModes.DEFAULT,
      };
      return material;
    }

    if (materialData.getDoubleSided()) {
      const uniforms = isGlass
        ? ([
            PipelineBindGroupLayouts.CAMERA_UNIFORMS,
            PipelineBindGroupLayouts.MATERIAL_TEXTURES,
            PipelineBindGroupLayouts.OBJECT_UNIFORMS,
            PipelineBindGroupLayouts.OIT_GLASS_ENV,
          ] as const)
        : ([
            PipelineBindGroupLayouts.CAMERA_UNIFORMS,
            PipelineBindGroupLayouts.MATERIAL_TEXTURES,
            PipelineBindGroupLayouts.OBJECT_UNIFORMS,
          ] as const);

      material.techniqueData = {
        vs: 'gbuffer/gbuffer.vs',
        fs,
        uniforms,
        writesOn: isGlass
          ? FragmentShaderTargets.OIT_GATHER
          : isBlend
            ? FragmentShaderTargets.TEXTURE
            : FragmentShaderTargets.GBUFFER,
        rs: RasterizationMode.DOUBLE_SIDED,
        z: isGlass || isBlend ? DepthModes.TEST_BUT_NO_WRITE : DepthModes.LESS_EQUAL_WRITE,
        blend: isBlend ? BlendModes.ADDITIVE_BY_SRC_ALPHA : BlendModes.DEFAULT,
      };
    } else {
      material.technique = technique;
    }

    return material;
  }

  private static getNodeCollider(render: RenderComponentDataType, _node: Node): any {
    const meshData = render.meshes[0]?.meshData;

    if (!meshData) {
      return {
        vertices: [],
        indices: [],
      };
    }

    // Vertices are in local mesh space; ColliderComponent applies world scale at load time.
    const positionArray = meshData.attributes.POSITION as Float32Array | null;
    const indexArray = meshData.indices as any;

    const vertices = positionArray ? Array.from(positionArray) : [];
    const indices = indexArray ? Array.from(indexArray) : [];

    return {
      vertices,
      indices,
    };
  }

  private static isGlass(material: Material): boolean {
    return material.getExtension<Transmission>('KHR_materials_transmission') !== null;
  }

  /**
   * A GLTF MASK material with alphaCutoff == 0.0 is semantically a decal:
   * alphaCutoff=0 means "keep all pixels where alpha > 0", which is not a
   * hard cutout — the artist is using alpha as a blend weight over the GBuffer.
   * Real cutout geometry (leaves, fences) always uses alphaCutoff > 0 (e.g. 0.5).
   */
  private static isDecal(material: Material): boolean {
    return material.getAlphaMode() === 'MASK' && material.getAlphaCutoff() === 0.0;
  }

  private static getCategory(material: Material): RenderCategory {
    if (this.isDecal(material)) {
      return RenderCategory.DECALS;
    }
    if (this.isGlass(material)) {
      return RenderCategory.GLASS;
    }
    if (material.getAlphaMode() === 'BLEND') {
      return RenderCategory.TRANSPARENT;
    }
    return RenderCategory.SOLIDS;
  }

  private static getTextureName(texture: Texture, gltfBaseName: string): string {
    // Strip leading "./" so URIs like "./textures/foo.png" don't produce double path segments
    const texName = texture.getURI().replace(/^\.\//, '');
    return `${gltfBaseName}/${texName}`;
  }

  private static async processNavMeshNode(node: Node): Promise<void> {
    const mesh = node.getMesh()!;
    const primitive = mesh.listPrimitives()[0];
    if (!primitive) return;

    const posAttr = primitive.getAttribute('POSITION');
    const indicesAcc = primitive.getIndices();
    if (!posAttr || !indicesAcc) {
      console.warn('[GLTFLoader] NavMesh node has no POSITION or indices — skipped.');
      return;
    }

    const positions = posAttr.getArray() as Float32Array;
    const indices = indicesAcc.getArray() as Uint32Array | Uint16Array;
    const worldMatrix = this.getNodeMatrix(node);
    await NavMeshBuilder.build(positions, indices, worldMatrix);
  }

  /** Reconstructs the node's local-to-parent matrix from its TRS (or stored matrix). */
  private static getNodeMatrix(node: Node): mat4 {
    const out = mat4.create();
    const stored = node.getMatrix();
    if (stored) {
      for (let i = 0; i < 16; i++) out[i] = stored[i]!;
      return out;
    }
    const t = node.getTranslation();
    const r = node.getRotation();
    const s = node.getScale();
    mat4.fromRotationTranslationScale(out, r as any, t as any, s as any);
    return out;
  }

  private static getNodeTransform(node: Node): TransformComponentDataType {
    const transform: Partial<TransformComponentDataType> = {};

    if (node.getMatrix()) {
      transform.matrix = node.getMatrix();
    } else {
      if (node.getTranslation()) {
        transform.position = node.getTranslation();
      }
      if (node.getRotation()) {
        transform.quaternion = node.getRotation();
      }
      if (node.getScale()) {
        transform.scale = node.getScale();
      }
    }

    return transform as TransformComponentDataType;
  }
}
