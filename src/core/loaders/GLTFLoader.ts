import { vec3 } from 'gl-matrix';
import { EntityDataType } from '../../types/SceneData.type';
import { TransformComponentDataType } from '../../types/TransformComponentData.type';
import {
  RenderComponentDataType,
  RenderComponentMeshDataType,
} from '../../types/RenderComponentData.type';
import { MaterialDataType } from '../../types/MaterialData.type';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { RasterizationMode } from '../../types/RasterizationMode.enum';
import { FragmentShaderTargets } from '../../types/FragmentShaderTargets.enum';
import { PipelineBindGroupLayouts } from '../../types/PipelineBindGroupLayouts.enum';
import {
  GLTF,
  GLTFNode,
  GLTFMeshPrimitive,
  GLTFAccessor,
  GLTFBufferView,
  GLTFTexture,
} from '../../types/GLTF.type';

export class GLTFLoader {
  private static async loadBinaryFile(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url);
    return response.arrayBuffer();
  }

  public static async loadGLTF(path: string): Promise<Array<EntityDataType>> {
    const folderName = path.split('.')[0];
    // 1. Cargar el archivo GLTF
    const gltfResponse = await fetch(`/assets/meshes/${folderName}/${path}`);
    const gltf: GLTF = await gltfResponse.json();

    // 2. Cargar el archivo .bin asociado si existe
    let binData: ArrayBuffer | null = null;
    if (gltf.buffers?.[0]?.uri) {
      const binPath = gltf.buffers[0].uri;
      const fullBinPath = `/assets/meshes/${folderName}/${binPath}`;
      binData = await this.loadBinaryFile(fullBinPath);
    }

    const gltfNodes: Array<EntityDataType> = [];

    // 3. Procesar cada nodo del GLTF y crear entidades
    if (gltf.scenes?.[0]?.nodes) {
      for (const nodeIndex of gltf.scenes[0].nodes) {
        const node = gltf.nodes?.[nodeIndex];
        if (!node || node.mesh === undefined || !gltf.meshes?.[node.mesh]) {
          continue;
        }

        const mesh = gltf.meshes[node.mesh];
        if (!mesh) continue;
        const primitiveList = mesh.primitives;
        const transform = this.getNodeTransform(node);

        const meshes: RenderComponentMeshDataType[] = [];

        for (const primitive of primitiveList) {
          if (binData) {
            meshes.push(this.processPrimitive(gltf, binData, primitive));
          }
        }

        const render: RenderComponentDataType = {
          meshes,
        };

        const res: EntityDataType = {
          children: [],
          components: {
            transform,
            render,
          },
        };
        gltfNodes.push(res);
      }
    }

    return gltfNodes;
  }

  private static processPrimitive(
    gltf: GLTF,
    binData: ArrayBuffer,
    primitive: GLTFMeshPrimitive,
  ): RenderComponentMeshDataType {
    // MESH ATTRIBUTES - convertir a la estructura esperada
    const attributesMap: Record<string, { data: number[]; size: number }> = {};

    for (const [key, accessorIndex] of Object.entries(primitive.attributes)) {
      const accessor = gltf.accessors?.[accessorIndex];
      if (!accessor) continue;

      const bufferView = gltf.bufferViews?.[accessor.bufferView ?? 0];
      if (!bufferView) continue;

      const data = GLTFLoader.getBufferData(binData, accessor, bufferView);
      attributesMap[key] = {
        data: Array.from(data),
        size: GLTFLoader.getAccessorSize(accessor.type),
      };
    }

    // MESH INDICES
    let indicesData: { data: number[]; count: number; type: number } | undefined;
    if (primitive.indices !== undefined) {
      const accessor = gltf.accessors?.[primitive.indices];
      if (accessor) {
        const bufferView = gltf.bufferViews?.[accessor.bufferView ?? 0];
        if (bufferView) {
          const data = GLTFLoader.getBufferData(binData, accessor, bufferView, true);
          indicesData = {
            data: Array.from(data),
            count: accessor.count,
            type: accessor.componentType,
          };
        }
      }
    }

    // MATERIAL
    const materialDef =
      primitive.material !== undefined ? gltf.materials?.[primitive.material] : undefined;
    const pbr = materialDef?.pbrMetallicRoughness ?? {};
    const category = RenderCategory.SOLIDS;
    const textures: Record<string, string> = {
      txEmissive: 'black.png',
    };

    if (pbr.baseColorTexture?.index !== undefined && gltf.textures?.[pbr.baseColorTexture.index]) {
      const texture = gltf.textures[pbr.baseColorTexture.index];
      if (texture) {
        textures.txAlbedo = GLTFLoader.getTextureName(gltf, texture);
      }
    }

    if (
      materialDef?.normalTexture?.index !== undefined &&
      gltf.textures?.[materialDef.normalTexture.index]
    ) {
      const texture = gltf.textures[materialDef.normalTexture.index];
      if (texture) {
        textures.txNormal = GLTFLoader.getTextureName(gltf, texture);
      }
    }

    if (
      pbr.metallicRoughnessTexture?.index !== undefined &&
      gltf.textures?.[pbr.metallicRoughnessTexture.index]
    ) {
      const texture = gltf.textures[pbr.metallicRoughnessTexture.index];
      if (texture) {
        textures.txMetallic = GLTFLoader.getTextureName(gltf, texture);
        textures.txRoughness = GLTFLoader.getTextureName(gltf, texture);
      }
    }

    const material: MaterialDataType = materialDef?.doubleSided
      ? {
          category: category,
          textures,
          baseColorFactor: pbr.baseColorFactor || [1, 1, 1, 1],
          techniqueData: {
            vs: 'gbuffer.vs',
            fs: materialDef.alphaMode === 'MASK' ? 'gbuffer_mask.fs' : 'gbuffer.fs',
            uniforms: [
              PipelineBindGroupLayouts.CAMERA_UNIFORMS,
              PipelineBindGroupLayouts.MATERIAL_TEXTURES,
              PipelineBindGroupLayouts.OBJECT_UNIFORMS,
            ] as const,
            writesOn: FragmentShaderTargets.GBUFFER,
            rs: RasterizationMode.DOUBLE_SIDED,
          },
        }
      : {
          category: category,
          baseColorFactor: pbr.baseColorFactor || [1, 1, 1, 1],
          textures,
          technique: materialDef?.alphaMode === 'MASK' ? 'gbuffer_mask.tech' : 'gbuffer.tech',
        };

    // Crear la estructura compatible con RenderComponentMeshDataType
    const renderMeshData: RenderComponentMeshDataType = {
      meshData: {
        attributes: {
          POSITION: attributesMap.POSITION,
          NORMAL: attributesMap.NORMAL,
          TEXCOORD_0: attributesMap.TEXCOORD_0,
          TANGENT: attributesMap.TANGENT,
        },
        indices: indicesData,
      },
      materialData: material,
    };

    return renderMeshData;
  }

  private static getNodeTransform(node: GLTFNode): TransformComponentDataType {
    const transform: Partial<TransformComponentDataType> = {};

    if (node.matrix) {
      throw new Error('GLTF Node Matrix needs to be parsed!');
    } else {
      if (node.translation) {
        const position = vec3.create();
        vec3.set(
          position,
          node.translation[0] || 0,
          node.translation[1] || 0,
          node.translation[2] || 0,
        );
        transform.position = position;
      }
      if (node.rotation) {
        transform.rotation = GLTFLoader.getEuler(node.rotation);
      }
      if (node.scale) {
        const scale = vec3.create();
        vec3.set(scale, node.scale[0] || 1, node.scale[1] || 1, node.scale[2] || 1);
        transform.scale = scale;
      }
    }

    return transform as TransformComponentDataType;
  }

  private static getTextureName(gltf: GLTF, data: GLTFTexture): string {
    const file = gltf.buffers?.[0]?.uri;
    if (!file) return 'default.png';

    const file_name = file.split('.')[0];
    if (data.name) return file_name + '/' + data.name;

    if (data.source !== undefined && gltf.images?.[data.source]?.uri) {
      return file_name + '/' + gltf.images[data.source]!.uri;
    }

    return 'default.png';
  }

  private static getEuler(quatArray: number[]): vec3 {
    if (quatArray.length !== 4) {
      throw new Error('Quaternion must have 4 components');
    }

    const x = quatArray[0]!;
    const y = quatArray[1]!;
    const z = quatArray[2]!;
    const w = quatArray[3]!;

    const x2 = x * x,
      y2 = y * y,
      z2 = z * z,
      w2 = w * w;

    const unit = x2 + y2 + z2 + w2;
    const test = x * w - y * z;

    const radToDeg = 180 / Math.PI;
    const out = vec3.create();

    if (test > 0.499995 * unit) {
      // Singularity at north pole
      out[0] = 90;
      out[1] = 2 * Math.atan2(y, x) * radToDeg;
      out[2] = 0;
    } else if (test < -0.499995 * unit) {
      // Singularity at south pole
      out[0] = -90;
      out[1] = 2 * Math.atan2(y, x) * radToDeg;
      out[2] = 0;
    } else {
      out[0] = Math.asin(2 * (x * z - w * y)) * radToDeg;
      out[1] = Math.atan2(2 * (x * w + y * z), 1 - 2 * (z2 + w2)) * radToDeg;
      out[2] = Math.atan2(2 * (x * y + z * w), 1 - 2 * (y2 + z2)) * radToDeg;
    }

    return out;
  }

  private static getBufferData(
    bin: ArrayBuffer,
    accessor: GLTFAccessor,
    bufferView: GLTFBufferView,
    isIndex = false,
  ): Float32Array | Uint16Array {
    const byteOffset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
    const byteLength =
      accessor.count *
      GLTFLoader.getComponentSize(accessor.componentType) *
      GLTFLoader.getAccessorSize(accessor.type);

    if (isIndex) {
      return new Uint16Array(bin, byteOffset, byteLength / 2); // Suponiendo Uint16
    } else {
      return new Float32Array(bin, byteOffset, byteLength / 4); // Suponiendo Float32
    }
  }

  private static getComponentSize(componentType: number): number {
    switch (componentType) {
      case 5126:
        return 4; // Float32
      case 5123:
        return 2; // Uint16
      case 5125:
        return 4; //Uint
      default:
        throw new Error('Tipo de componente no soportado');
    }
  }

  private static getAccessorSize(type: string): number {
    switch (type) {
      case 'SCALAR':
        return 1;
      case 'VEC2':
        return 2;
      case 'VEC3':
        return 3;
      case 'VEC4':
        return 4;
      default:
        throw new Error('Tipo de accesor no soportado');
    }
  }
}
