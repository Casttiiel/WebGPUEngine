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
        await img.decode();

        // Crear el bitmap para poder subirlo a la GPU
        const imageBitmap = await createImageBitmap(img);

        // Crear la textura en GPU
        this.gpuTexture = device.createTexture({
            size: {
                width: imageBitmap.width,
                height: imageBitmap.height,
                depthOrArrayLayers: 1,
            },
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });

        // Copiar los datos de la imagen a la textura
        device.queue.copyExternalImageToTexture(
            { source: imageBitmap },
            { texture: this.gpuTexture },
            { width: imageBitmap.width, height: imageBitmap.height }
        );

        // Crear la vista de la textura
        this.gpuTextureView = this.gpuTexture.createView();

        // Crear el sampler
        this.gpuSampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'repeat'
        });
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