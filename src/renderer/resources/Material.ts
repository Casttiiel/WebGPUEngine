import { GPUResource, IGPUResourceOptions } from "../../core/resources/GPUResource";
import { ResourceType } from "../../types/ResourceType.enum";
import { ResourceManager } from "../../core/engine/ResourceManager";
import { RenderCategory } from "../../types/RenderCategory.enum";
import { MaterialDataType } from "../../types/MaterialData.type";
import { Technique } from "./Technique";
import { Texture } from "./Texture";

export interface MaterialTexturesOptions {
    albedo?: string;
    normal?: string;
    metallic?: string;
    roughness?: string;
    emissive?: string;
}

export interface MaterialBaseOptions {
    category?: RenderCategory;
    castsShadows?: boolean;
    shadows?: boolean;
    textures?: MaterialTexturesOptions;
    technique?: string;
}

export type MaterialCreateOptions = MaterialBaseOptions & Omit<IGPUResourceOptions, 'type'>;
export type MaterialOptions = Required<Pick<MaterialBaseOptions, 'textures' | 'technique'>> & Omit<MaterialCreateOptions, 'textures' | 'technique'> & IGPUResourceOptions;

export class Material extends GPUResource {
    private static idCounter = 0;
    private static nextId() {
        return ++Material.idCounter;
    }

    private static generateDynamicId(): string {
        return Material.nextId().toString().padStart(6, '0');
    }

    private technique?: Technique;
    private textures: Map<string, Texture> = new Map();
    private category: RenderCategory;
    private castsShadows: boolean;
    private shadows: boolean;
    private textureBindGroup?: GPUBindGroup;
    private techniqueFile: string;
    private textureFiles: MaterialTexturesOptions;

    constructor(options: MaterialOptions) {
        const dependencies = [options.technique];
        if (options.textures) {
            Object.values(options.textures).forEach(texture => {
                if (texture) {
                    dependencies.push(texture);
                }
            });
        }

        super({
            ...options,
            type: ResourceType.MATERIAL,
            dependencies
        });

        this.category = options.category || RenderCategory.SOLIDS;
        this.castsShadows = options.castsShadows ?? false;
        this.shadows = options.shadows ?? false;
        this.techniqueFile = options.technique;
        this.textureFiles = options.textures;
    }

    public static async get(pathOrData: string | MaterialDataType): Promise<Material> {
        if (typeof pathOrData === 'string') {
            try {
                return await ResourceManager.getResource<Material>(pathOrData);
            } catch {
                // Load material data from file if needed
                const materialData = await ResourceManager.loadMaterialData(pathOrData);
                const techniqueToUse = await this.resolveTechnique(materialData);
                if (!techniqueToUse) {
                    throw new Error(`Missing technique for material: ${pathOrData}`);
                }

                const textures: MaterialTexturesOptions = {
                    albedo: materialData?.textures.txAlbedo || "white.png",
                    normal: materialData?.textures.txNormal,
                    metallic: materialData?.textures.txMetallic || "black.png",
                    roughness: materialData?.textures.txRoughness || "black.png",
                    emissive: materialData?.textures.txEmissive || "black.png"
                };

                const material = new Material({
                    path: pathOrData,
                    type: ResourceType.MATERIAL,
                    technique: techniqueToUse,
                    textures,
                    category: materialData?.category,
                    castsShadows: materialData?.casts_shadows,
                    shadows: materialData?.shadows,
                });

                await ResourceManager.registerResource(material);
                return material;
            }
        } else {            // Handle direct material data
            const techniqueToUse = await this.resolveTechnique(pathOrData);
            if (!techniqueToUse) {
                throw new Error('Missing technique in material data');
            }

            const textures: MaterialTexturesOptions = {
                albedo: pathOrData.textures.txAlbedo || "white.png",
                normal: pathOrData.textures.txNormal,
                metallic: pathOrData.textures.txMetallic || "black.png",
                roughness: pathOrData.textures.txRoughness || "black.png",
                emissive: pathOrData.textures.txEmissive || "black.png",
            };
            const dynamicId = Material.generateDynamicId();
            const material = new Material({
                path: `dynamic_material_${dynamicId}`,
                type: ResourceType.MATERIAL,
                technique: techniqueToUse,
                textures,
                category: pathOrData?.category ?? RenderCategory.SOLIDS,
                castsShadows: pathOrData?.casts_shadows ?? false,
                shadows: pathOrData?.shadows ?? false,
            });

            await ResourceManager.registerResource(material);
            return material;
        }
    }

    private static async resolveTechnique(data: MaterialDataType | null): Promise<string | undefined> {
        if (!data) return undefined;

        // If techniqueData is provided, create a dynamic technique
        if (data.techniqueData) {
            const techniquePath = `dynamic_technique_${Material.generateDynamicId()}.tech`;
            await Technique.get(techniquePath, data.techniqueData);
            return techniquePath;
        }

        return data.technique;
    }

    protected async createGPUResources(): Promise<void> {
        try {
            // Load technique
            this.technique = await Technique.get(this.techniqueFile);

            // Load textures secuencialmente para evitar race conditions
            await this.loadTexture('albedo', this.textureFiles.albedo);
            await this.loadTexture('normal', this.textureFiles.normal);
            await this.loadTexture('metallic', this.textureFiles.metallic);
            await this.loadTexture('roughness', this.textureFiles.roughness);
            await this.loadTexture('emissive', this.textureFiles.emissive);

            // Note: Bind group will be created later when we have the pipeline
        } catch (error) {
            throw new Error(`Failed to create GPU resources for material ${this.path}: ${error}`);
        }
    }

    public async createBindGroup(renderPipeline: GPURenderPipeline): Promise<void> {
        if (!this.technique) {
            throw new Error("Technique not loaded");
        }
        const entries: GPUBindGroupEntry[] = [];
        let bindingIndex = 0;

        const textureTypes = ['albedo', 'normal', 'metallic', 'roughness', 'emissive'];
        for (const type of textureTypes) {
            const texture = this.textures.get(type);
            if (!texture) {
                throw new Error(`Missing texture: ${type}`);
            }

            const view = texture.getTextureView();
            const sampler = texture.getSampler();

            if (!view || !sampler) {
                throw new Error(`Texture ${type} view or sampler not available`);
            }

            entries.push(
                {
                    binding: bindingIndex,
                    resource: view
                },
                {
                    binding: bindingIndex + 1,
                    resource: sampler
                }
            );
            bindingIndex += 2;
        }

        // Get bind group layout from pipeline
        const bindGroupLayout = renderPipeline.getBindGroupLayout(1); // Material textures are in group 1

        // Create bind group
        this.textureBindGroup = this.device.createBindGroup({
            label: `${this.label}_texture_bindgroup`,
            layout: bindGroupLayout,
            entries
        });
    }

    protected override async destroyGPUResources(): Promise<void> {
        this.textureBindGroup = undefined;

        // Release textures
        for (const [_, texture] of this.textures) {
            texture.release();
        }
        this.textures.clear();

        // Release technique
        if (this.technique) {
            this.technique.release();
            this.technique = undefined;
        }
    } 
    
    private async loadTexture(type: string, path?: string): Promise<void> {
        const texturePath = path || (type === 'albedo' ? 'white.png' : 'black.png');
        const texture = await Texture.get(texturePath);
        this.textures.set(type, texture);
    }

    public getCategory(): RenderCategory {
        return this.category;
    }

    public getCastsShadows(): boolean {
        return this.castsShadows;
    }

    public getShadows(): boolean {
        return this.shadows;
    }

    public getTechnique(): Technique | undefined {
        return this.technique;
    }

    public getTextureBindGroup(): GPUBindGroup | undefined {
        return this.textureBindGroup;
    }

    public override async load(): Promise<void> {
        if (this.isLoaded) return;
        try {
            await this.createGPUResources();
            await super.load();
            this.setLoaded();
        } catch (error) {
            throw new Error(`Failed to load material ${this.path}: ${error}`);
        }
    }
}