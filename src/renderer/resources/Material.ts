import { ResourceManager } from "../../core/engine/ResourceManager";
import { MaterialDataType } from "../../types/MaterialData.type";
import { RenderCategory } from "../../types/RenderCategory.enum";
import { Render } from "../core/render";
import { Technique } from "./Technique";
import { Texture } from "./Texture";


export class Material {
    private name!: string;
    private textures = new Map<string, Texture>();
    private technique!: Technique;
    private castsShadows!: boolean;
    private category!: RenderCategory;
    private shadows!: boolean;
    private textureBindGroup!: GPUBindGroup;

    constructor(name: string) {
        this.name = name;
    }

    public static async get(materialData: string | MaterialDataType): Promise<Material> {
        if (typeof materialData === 'string') {
            if (ResourceManager.hasResource(materialData)) {
                return ResourceManager.getResource<Material>(materialData);
            }

            const material = new Material(materialData);
            const data = await ResourceManager.loadMaterialData(material.name);
            await material.load(data);
            ResourceManager.setResource(materialData, material);
            return material;
        } else {
            const material = new Material("unknown material name");
            await material.load(materialData);
            return material;
        }

    }

    public async load(data: MaterialDataType): Promise<void> {
        // Cargar la técnica primero para tener acceso al layout
        this.technique = await Technique.get(data.technique);

        const texture = await Texture.get(data.textures.txAlbedo || "white.png");
        this.textures.set('albedo', texture);
        const texture2 = await Texture.get(data.textures.txNormal || "white.png");
        this.textures.set('normal', texture2);
        const texture3 = await Texture.get(data.textures.txMetallic || "white.png");
        this.textures.set('metallic', texture3);
        const texture4 = await Texture.get(data.textures.txRoughness || "white.png");
        this.textures.set('roughness', texture4);
        const texture5 = await Texture.get(data.textures.txEmissive || "white.png");
        this.textures.set('emissive', texture5);

        const textureBingGroupLayout = Render.getInstance().getDevice().createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'float' }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: 'filtering' }
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'float' }
                },
                {
                    binding: 3,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: 'filtering' }
                },
                {
                    binding: 4,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'float' }
                },
                {
                    binding: 5,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: 'filtering' }
                },
                {
                    binding: 6,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'float' }
                },
                {
                    binding: 7,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: 'filtering' }
                },
                {
                    binding: 8,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'float' }
                },
                {
                    binding: 9,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: 'filtering' }
                }
            ]
        });

        // Crear el bind group para estas texturas
        this.textureBindGroup = Render.getInstance().getDevice().createBindGroup({
            layout: textureBingGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: texture.getTextureView()
                },
                {
                    binding: 1,
                    resource: texture.getSampler()
                },
                {
                    binding: 2,
                    resource: texture2.getTextureView()
                },
                {
                    binding: 3,
                    resource: texture2.getSampler()
                },
                {
                    binding: 4,
                    resource: texture3.getTextureView()
                },
                {
                    binding: 5,
                    resource: texture3.getSampler()
                },
                {
                    binding: 6,
                    resource: texture4.getTextureView()
                },
                {
                    binding: 7,
                    resource: texture4.getSampler()
                },
                {
                    binding: 8,
                    resource: texture5.getTextureView()
                },
                {
                    binding: 9,
                    resource: texture5.getSampler()
                }
            ]
        });

        this.castsShadows = data.casts_shadows ?? false;
        this.category = data.category || RenderCategory.SOLIDS;
        this.shadows = data.shadows;
    }



    public getCategory(): RenderCategory {
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