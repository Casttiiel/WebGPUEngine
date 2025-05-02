import { ResourceManager } from "../../core/engine/ResourceManager";
import { Technique } from "./technique";
import { Texture } from "./texture";


export class Material {
    private name!: string;
    private textures = new Map<string, Texture>();
    private technique!: Technique;
    private castsShadows!: boolean;
    private category!: string;
    private shadows!: boolean;

    constructor(name: string) {
        this.name = name;
    }

    public static async get(materialPath: string): Promise<Material> {
        if (ResourceManager.hasResource(materialPath)) {
            return ResourceManager.getResource<Material>(materialPath);
        }

        const material = new Material(materialPath);
        await material.load();
        ResourceManager.setResource(materialPath, material);
        return material;
    }

    public async load(): Promise<void> {
        const data = await ResourceManager.loadMaterialData(this.name);

        for (const [key, value] of Object.entries(data.textures) as [string, string][]) {
            const texture = await Texture.get(value);
            this.textures.set(key, texture);
        }
        
        this.technique = await Technique.get(data.technique);
        this.castsShadows = data.casts_shadows ?? false;
        this.category = data.category || "solid";
        this.shadows = data.shadows;
    }

    public activate(): void {
        this.technique.activate();
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
}