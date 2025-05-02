import { Material } from "../../renderer/resources/material";
import { Mesh } from "../../renderer/resources/mesh";
import { Technique } from "../../renderer/resources/technique";
import { Texture } from "../../renderer/resources/texture";
import { MaterialDataType } from "../../types/MaterialData.type";
import { TechniqueDataType } from "../../types/TechniqueData.type";

type Resource = Mesh | Material | Technique | object | string | Texture;// | Cubemap

export class ResourceManager {
    private static resources: Map<string, Resource> = new Map();

    constructor() {
        throw new Error("Cannot create instances of this class");
    }

    public static async loadPrefab(prefabName: string): Promise<object> {
        if (!this.resources.has(prefabName)) {
            const prefab = await fetch(`/prefabs/${prefabName}`).then(res => res.json());
            this.resources.set(prefabName, prefab);
        }
        return this.resources.get(prefabName) as object;
    }

    public static async loadMeshData(meshPath: string): Promise<string> {
        return await fetch(`/assets/meshes/${meshPath}`).then(res => res.text());
    }

    public static async loadMaterialData(materialPath: string): Promise<MaterialDataType> {
        return await fetch(`/assets/materials/${materialPath}`).then(res => res.json());
    }

    public static async loadTechniqueData(techniquePath: string): Promise<TechniqueDataType> {
        return await fetch(`/assets/techniques/${techniquePath}`).then(res => res.json());
    }

    public static async loadShader(shaderPath: string): Promise<string> {
        return await fetch(`/assets/shaders/${shaderPath}`).then(res => res.text());
    }

    /*static async loadGLTF(path: string): Promise<object> {
        if (!this.resources.has(path)) {
            const gltf = await fetch(`/meshes/${path}`).then(res => res.json());
            const binResponse = await fetch(`/meshes/${gltf.buffers[0].uri}`).then(res => res);
            const binArrayBuffer = await binResponse.arrayBuffer();
            const scene = GLTFLoader.processScene(gltf, binArrayBuffer);
            this.resources.set(path, scene);
        }
        return this.resources.get(path) as object;
    }*/

    /*static async loadTexture(texturePath: string): Promise<Texture> {
        if (!this.resources.has(texturePath)) {
            const image = new Image();
            image.src = `/textures/${texturePath}`;
            await new Promise<void>(resolve => (image.onload = () => resolve()));
            const texture = new Texture(texturePath, image);
            this.resources.set(texturePath, texture);
        }
        return this.resources.get(texturePath) as Texture;
    }

    static async loadCubemap(texturePath: string): Promise<Cubemap> {
        if (!this.resources.has(texturePath)) {
            const image = new Image();
            image.src = `/textures/${texturePath}`;
            await new Promise<void>(resolve => (image.onload = () => resolve()));
            const texture = new Cubemap(texturePath, image);
            this.resources.set(texturePath, texture);
        }
        return this.resources.get(texturePath) as Cubemap;
    }*/

    public static getResource<T extends Resource>(key: string): T {
        const resource = this.resources.get(key);
        if (!resource) {
            throw new Error(`Resource could not be found: ${key}`);
        }
        return resource as T;
    }

    public static setResource(name: string, resource: Resource): void {
        this.resources.set(name, resource);
    }

    public static hasResource(name: string): boolean {
        return this.resources.has(name);
    }
}