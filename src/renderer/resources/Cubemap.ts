import { Render } from "../core/render";
import { ResourceManager } from "../../core/engine/ResourceManager";

export class Cubemap {
    private name: string;
    private gpuTexture!: GPUTexture;
    private gpuTextureView!: GPUTextureView;
    private gpuSampler!: GPUSampler;

    constructor(name: string) {
        this.name = name;
    }

    public static async get(texturePath: string): Promise<Cubemap> {
        if (ResourceManager.hasResource(texturePath)) {
            return ResourceManager.getResource<Cubemap>(texturePath);
        }

        const texture = new Cubemap(texturePath);
        await texture.load();
        ResourceManager.setResource(texturePath, texture);
        return texture;
    }

    public async load(): Promise<void> {
        const device = Render.getInstance().getDevice();

        const image = await createImageBitmap(await fetch(`/assets/textures/${this.name}`).then(r => r.blob()));

        const faceSize = image.width / 4; // Asumimos imagen 4x3 caras
        const faceCoords = {
            0: [2, 1], // +X
            1: [0, 1], // -X
            2: [1, 0], // +Y
            3: [1, 2], // -Y
            4: [1, 1], // +Z
            5: [3, 1], // -Z
        };

        const canvas = new OffscreenCanvas(faceSize, faceSize);
        const ctx = canvas.getContext('2d');
        const faces: ImageBitmap[] = [];

        for (let i = 0; i < 6; i++) {
            const [col, row] = faceCoords[i];
            ctx.clearRect(0, 0, faceSize, faceSize);
            ctx.drawImage(
                image,
                col * faceSize, row * faceSize, faceSize, faceSize,
                0, 0, faceSize, faceSize
            );
            const face = await createImageBitmap(canvas);
            faces.push(face);
        }

        // Crear la textura en GPU
        this.gpuTexture = device.createTexture({
            size: [faceSize, faceSize, 6],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });

        for (let i = 0; i < 6; i++) {
            device.queue.copyExternalImageToTexture(
                { source: faces[i] },
                { texture: this.gpuTexture, origin: { x: 0, y: 0, z: i } },
                [faceSize, faceSize]
            );
        }

        // Crear la vista de la textura
        this.gpuTextureView = this.gpuTexture.createView({ dimension: 'cube' });

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