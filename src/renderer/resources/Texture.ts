import { Render } from "../core/render";
import { ResourceManager } from "../../core/engine/ResourceManager";

export class Texture {
    private name: string;
    private gpuTexture!: GPUTexture;
    private gpuTextureView!: GPUTextureView;
    private gpuSampler!: GPUSampler;

    constructor(name: string) {
        this.name = name;
    }

    public static async get(texturePath: string): Promise<Texture> {
        if (ResourceManager.hasResource(texturePath)) {
            return ResourceManager.getResource<Texture>(texturePath);
        }

        const texture = new Texture(texturePath);
        await texture.load();
        ResourceManager.setResource(texturePath, texture);
        return texture;
    }

    public async load(): Promise<void> {
        const device = Render.getInstance().getDevice();

        // Cargar la imagen
        const img = new Image();
        img.src = `/assets/textures/${this.name}`;
        try {
            await img.decode();
            // Crear el bitmap para poder subirlo a la GPU
            const imageBitmap = await createImageBitmap(img);

            // Calcular niveles de mipmap
            const mipLevelCount = Math.floor(Math.log2(Math.max(imageBitmap.width, imageBitmap.height))) + 1;

            // Crear la textura en GPU con soporte para storage binding para generación de mipmaps
            this.gpuTexture = device.createTexture({
                size: {
                    width: imageBitmap.width,
                    height: imageBitmap.height,
                    depthOrArrayLayers: 1,
                },
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | 
                       GPUTextureUsage.COPY_DST | 
                       GPUTextureUsage.RENDER_ATTACHMENT |
                       GPUTextureUsage.STORAGE_BINDING,
                mipLevelCount: mipLevelCount
            });

            // Copiar los datos de la imagen al nivel 0 de mipmap
            device.queue.copyExternalImageToTexture(
                { source: imageBitmap },
                { texture: this.gpuTexture },
                { width: imageBitmap.width, height: imageBitmap.height }
            );

            // Generar los mipmaps
            await this.generateMipmaps();

            // Crear la vista de la textura con todos los niveles de mipmap
            this.gpuTextureView = this.gpuTexture.createView({
                baseMipLevel: 0,
                mipLevelCount: mipLevelCount
            });

            // Crear el sampler con configuración de mipmaps
            this.gpuSampler = device.createSampler({
                magFilter: 'linear',
                minFilter: 'linear',
                mipmapFilter: 'linear',
                addressModeU: 'repeat',
                addressModeV: 'repeat',
                maxAnisotropy: 16 // Añadir filtrado anisotrópico para mejorar la calidad
            });
        } catch (e) {
            console.log(e, img.src);
        }
    }

    private static mipmapPipeline: GPUComputePipeline;
    private static mipmapBindGroupLayout: GPUBindGroupLayout;
    private static async initMipmapPipeline() {
        if (this.mipmapPipeline) return;

        const device = Render.getInstance().getDevice();
        const shaderModule = device.createShaderModule({
            label: "Mipmap generation shader",
            code: await (await fetch('/assets/shaders/generate_mipmap.wgsl')).text()
        });

        this.mipmapBindGroupLayout = device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: {
                        sampleType: 'float',
                        viewDimension: '2d'
                    }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: {
                        access: 'write-only',
                        format: 'rgba8unorm',
                        viewDimension: '2d'
                    }
                }
            ]
        });

        const pipelineLayout = device.createPipelineLayout({
            bindGroupLayouts: [this.mipmapBindGroupLayout]
        });

        this.mipmapPipeline = device.createComputePipeline({
            layout: pipelineLayout,
            compute: {
                module: shaderModule,
                entryPoint: 'main'
            }
        });
    }

    private async generateMipmaps() {
        const device = Render.getInstance().getDevice();
        
        // Asegurarnos de que el pipeline está inicializado
        await Texture.initMipmapPipeline();

        const commandEncoder = device.createCommandEncoder();

        for (let level = 0; level < this.gpuTexture.mipLevelCount - 1; level++) {
            const srcView = this.gpuTexture.createView({
                baseMipLevel: level,
                mipLevelCount: 1,
            });

            const dstView = this.gpuTexture.createView({
                baseMipLevel: level + 1,
                mipLevelCount: 1,
            });

            const bindGroup = device.createBindGroup({
                layout: Texture.mipmapBindGroupLayout,
                entries: [
                    { binding: 0, resource: srcView },
                    { binding: 1, resource: dstView }
                ]
            });

            const passEncoder = commandEncoder.beginComputePass();
            passEncoder.setPipeline(Texture.mipmapPipeline);
            passEncoder.setBindGroup(0, bindGroup);

            const width = Math.max(1, this.gpuTexture.width >> (level + 1));
            const height = Math.max(1, this.gpuTexture.height >> (level + 1));
            
            passEncoder.dispatchWorkgroups(
                Math.ceil(width / 8),
                Math.ceil(height / 8)
            );
            
            passEncoder.end();
        }

        device.queue.submit([commandEncoder.finish()]);
    }

    public getTextureView(): GPUTextureView {
        return this.gpuTextureView;
    }

    public getSampler(): GPUSampler {
        return this.gpuSampler;
    }

    public getName(): string {
        return this.name;
    }
}