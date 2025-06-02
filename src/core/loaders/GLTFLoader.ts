import { quat, vec3 } from "gl-matrix";
import { EntityDataType } from "../../types/SceneData.type";
import { TransformComponentDataType } from "../../types/TransformComponentData.type";
import { RenderComponentDataType } from "../../types/RenderComponentData.type";

export class GLTFLoader {
    private static async loadBinaryFile(url: string): Promise<ArrayBuffer> {
        const response = await fetch(url);
        return response.arrayBuffer();
    }

    public static async loadGLTF(path: string): Promise<Array<EntityDataType>> {
        const folderName = path.split(".")[0];
        // 1. Cargar el archivo GLTF
        const gltfResponse = await fetch(`/assets/meshes/${folderName}/${path}`);
        const gltf = await gltfResponse.json();

        // 2. Cargar el archivo .bin asociado si existe
        let binData: ArrayBuffer | null = null;
        if (gltf.buffers && gltf.buffers[0]) {
            const binPath = gltf.buffers[0].uri;
            const fullBinPath = `/assets/meshes/${folderName}/${binPath}`;
            binData = await this.loadBinaryFile(fullBinPath);
        }

        const gltfNodes: Array<EntityDataType> = [];

        // 3. Procesar cada nodo del GLTF y crear entidades
        if (gltf.scenes) {
            for (const nodeIndex of gltf.scenes[0].nodes) {
                const primitiveList = gltf.meshes[gltf.nodes[nodeIndex].mesh].primitives;
                const transform = this.getNodeTransform(gltf.nodes[nodeIndex]);
                for (const primitive of primitiveList) {
                    const render = this.processPrimitive(gltf, binData, primitive);
                    const res = {
                        children: [],
                        components: {
                            transform,
                            render
                        }
                    } as EntityDataType;
                    gltfNodes.push(res);
                }
            }
        }

        return gltfNodes;
    }

    private static processPrimitive(
        gltf: any,
        binData: ArrayBuffer,
        primitive: any
    ): RenderComponentDataType {
        //MESH ATTRIBUTES
        const attributes = {};
        for (const [key, accessorIndex] of Object.entries(primitive.attributes)) {
            const accessor = gltf.accessors[accessorIndex];
            const bufferView = gltf.bufferViews[accessor.bufferView];

            const data = GLTFLoader.getBufferData(binData, accessor, bufferView);
            attributes[key] = {
                data: Array.from(data), // Devuelve los datos como array
                size: GLTFLoader.getAccessorSize(accessor.type),
            };
        }

        //MESH INDICES
        const accessor = gltf.accessors[primitive.indices];
        const bufferView = gltf.bufferViews[accessor.bufferView];
        const data = GLTFLoader.getBufferData(binData, accessor, bufferView, true);
        const indices = {
            data: Array.from(data), // Devuelve los índices como array
            count: accessor.count,
            type: accessor.componentType,
        };

        //MATERIAL
        let materialDef = gltf.materials[primitive.material];
        const pbr = materialDef.pbrMetallicRoughness || {};
        let technique = "gbuffer.tech";
        let category = "solids";
        //TODO MORE TECHNIQUES BASED ON MASK AND DOUBLE SIDED
        const textures = {
            txEmissive: "black.png"
        };
        if(pbr.baseColorTexture) textures["txAlbedo"] = GLTFLoader.getTextureName(gltf, gltf.textures[pbr.baseColorTexture.index]);
        if(materialDef.normalTexture) textures["txNormal"] = GLTFLoader.getTextureName(gltf, gltf.textures[materialDef.normalTexture.index]);
        if(pbr.metallicRoughnessTexture) textures["txMetallic"] = GLTFLoader.getTextureName(gltf, gltf.textures[pbr.metallicRoughnessTexture.index]);
        if(pbr.metallicRoughnessTexture) textures["txRoughness"] = GLTFLoader.getTextureName(gltf, gltf.textures[pbr.metallicRoughnessTexture.index]);

        const material = {
            technique: technique,
            casts_shadows: false,
            category: category,
            shadows: false,
            textures
        };

        let render = {
            meshes: [
                {
                    meshData: {
                        attributes,
                        indices
                    },
                    materialData: material
                }
            ]
        } as unknown as RenderComponentDataType;


        return render;
    }

    private static getNodeTransform(node: any): TransformComponentDataType {
        let transform = {} as TransformComponentDataType;

        if (node.matrix) {
            throw new Error("GLTF Node Matrix needs to be parsed!");
        } else {
            if (node.translation) transform.position = node.translation;
            if (node.rotation) transform.rotation = GLTFLoader.getEuler(node.rotation);
            if (node.scale) transform.scale = node.scale;
        }

        return transform;
    }

    private static getTextureName(gltf: unknown, data: unknown): string {
        const file = gltf.buffers[0].uri;
        const file_name = file.split(".")[0];
        if (data.name) return file_name + "/" + data.name;
        return file_name + "/" + gltf.images[data.source].uri;
    }

    private static getEuler(quat: quat): vec3 {
        const [x, y, z, w] = quat;
        const x2 = x * x, y2 = y * y, z2 = z * z, w2 = w * w;

        const unit = x2 + y2 + z2 + w2;
        const test = x * w - y * z;

        const radToDeg = 180 / Math.PI;
        let out = vec3.create();

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

    private static getBufferData(bin: ArrayBuffer, accessor: unknown, bufferView: unknown, isIndex = false) {
        const byteOffset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
        const byteLength = accessor.count * GLTFLoader.getComponentSize(accessor.componentType) * GLTFLoader.getAccessorSize(accessor.type);

        if (isIndex) {
            return new Uint16Array(bin, byteOffset, byteLength / 2); // Suponiendo Uint16
        } else {
            return new Float32Array(bin, byteOffset, byteLength / 4); // Suponiendo Float32
        }
    }

    private static getComponentSize(componentType: number): number {
        switch (componentType) {
            case 5126: return 4; // Float32
            case 5123: return 2; // Uint16
            case 5125: return 4; //Uint
            default: throw new Error("Tipo de componente no soportado");
        }
    }

    private static getAccessorSize(type: string): number {
        switch (type) {
            case "SCALAR": return 1;
            case "VEC2": return 2;
            case "VEC3": return 3;
            case "VEC4": return 4;
            default: throw new Error("Tipo de accesor no soportado");
        }
    }
}
