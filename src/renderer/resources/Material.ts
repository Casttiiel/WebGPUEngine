import { ResourceManager } from "../../core/engine/ResourceManager";
import { Technique } from "./Technique";
import { Texture } from "./Texture";


export class Material {
    private name!: string;
    private textures = new Map<string, Texture>();
    private technique!: Technique;
    private castsShadows!: boolean;
    private category!: string;
    private shadows!: boolean;
    private textureBindGroup!: GPUBindGroup;

    constructor(name: string) {
        this.name = name;
    }

    public static async get(materialPath: string): Promise<Material> {
        if (ResourceManager.hasResource(materialPath)) {
            //return ResourceManager.getResource<Material>(materialPath);
        }

        const material = new Material(materialPath);
        await material.load();
        ResourceManager.setResource(materialPath, material);
        return material;
    }

    public async load(): Promise<void> {
        const data = await ResourceManager.loadMaterialData(this.name);

        // Cargar la técnica primero para tener acceso al layout
        this.technique = await Technique.get(data.technique);

        // Cargar la textura principal (por ahora solo usaremos txAlbedo)
        for (const texData of data.textures) {
            if ('txAlbedo' in texData) {
                const texture = await Texture.get(texData.txAlbedo);
                this.textures.set('albedo', texture);
                // Crear el bind group para esta textura
                this.textureBindGroup = this.technique.createTextureBindGroup(texture);
                break;
            }
        }

        this.castsShadows = data.casts_shadows ?? false;
        this.category = data.category || "solid";
        this.shadows = data.shadows;
    }

    public getCategory(): string {
        return this.category;
    }

    public getPriority(): number {
        return 0;
    }

    public getCastsShadows(): boolean {
        return this.castsShadows;
    }

    public getShadowsMaterial(): Material {
        return this;
    }

    public getTechnique(): Technique {
        return this.technique;
    }

    public getName(): string {
        return this.name;
    }

    public getTextureBindGroup(): GPUBindGroup {
        return this.textureBindGroup;
    }

}