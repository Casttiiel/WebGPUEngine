import { Render } from '../Render';

/**
 * Utility class for common GPU operations and configurations
 */
export class GPUUtils {
    private static device: GPUDevice;

    public static initialize(device: GPUDevice): void {
        this.device = device;
    }

    public static getDevice(): GPUDevice {
        if (!this.device) {
            this.device = Render.getInstance().getDevice();
        }
        return this.device;
    }
    /**
     * Creates a standard render pass descriptor with viewport and scissor configuration
     */
    public static createRenderPassDescriptor(
        label: string,
        colorAttachments: GPURenderPassColorAttachment[],
        depthStencilAttachment?: GPURenderPassDepthStencilAttachment,
    ): GPURenderPassDescriptor {
        const descriptor: GPURenderPassDescriptor = {
            label,
            colorAttachments,
        };

        if (depthStencilAttachment) {
            descriptor.depthStencilAttachment = depthStencilAttachment;
        }

        return descriptor;
    }

    /**
     * Configures standard viewport and scissor for a render pass
     */
    public static configureViewportAndScissor(
        pass: GPURenderPassEncoder,
        width?: number,
        height?: number,
    ): void {
        const w = width ?? Render.width;
        const h = height ?? Render.height;

        pass.setViewport(0, 0, w, h, 0.0, 1.0);
        pass.setScissorRect(0, 0, w, h);
    }

    /**
     * Creates a color attachment with common defaults
     */
    public static createColorAttachment(
        view: GPUTextureView,
        loadOp: GPULoadOp = 'clear',
        storeOp: GPUStoreOp = 'store',
        clearValue: GPUColor = { r: 0, g: 0, b: 0, a: 1 },
        resolveTarget?: GPUTextureView,
    ): GPURenderPassColorAttachment {
        const attachment: GPURenderPassColorAttachment = {
            view,
            loadOp,
            storeOp,
            clearValue,
        };

        if (resolveTarget) {
            attachment.resolveTarget = resolveTarget;
        }

        return attachment;
    }

    /**
     * Creates a depth stencil attachment with common defaults
     */
    public static createDepthStencilAttachment(
        view: GPUTextureView,
        depthLoadOp: GPULoadOp = 'clear',
        depthStoreOp: GPUStoreOp = 'store',
        depthClearValue = 1.0,
    ): GPURenderPassDepthStencilAttachment {
        return {
            view,
            depthLoadOp,
            depthStoreOp,
            depthClearValue,
        };
    }

    /**
     * Creates a buffer with common patterns
     */
    public static createBuffer(
        label: string,
        size: number,
        usage: GPUBufferUsageFlags,
        data?: ArrayBuffer | ArrayBufferView,
    ): GPUBuffer {
        const buffer = this.device.createBuffer({
            label,
            size,
            usage,
            mappedAtCreation: !!data,
        });

        if (data) {
            new Uint8Array(buffer.getMappedRange()).set(
                new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer),
            );
            buffer.unmap();
        }

        return buffer;
    }

    /**
     * Creates a texture with common patterns
     */
    public static createTexture(
        label: string,
        width: number,
        height: number,
        format: GPUTextureFormat,
        usage: GPUTextureUsageFlags,
        sampleCount = 1,
    ): GPUTexture {
        return this.device.createTexture({
            label,
            size: { width, height },
            format,
            usage,
            sampleCount,
        });
    }

    /**
     * Creates a texture with mipmaps and complex configuration
     */
    public static createTextureWithMipmaps(
        label: string,
        width: number,
        height: number,
        format: GPUTextureFormat,
        usage: GPUTextureUsageFlags,
        mipLevelCount: number,
        depthOrArrayLayers = 1,
        sampleCount = 1,
    ): GPUTexture {
        return this.device.createTexture({
            label,
            size: {
                width,
                height,
                depthOrArrayLayers,
            },
            format,
            usage,
            mipLevelCount,
            sampleCount,
        });
    }

    /**
     * Creates a cubemap texture
     */
    public static createCubemapTexture(
        label: string,
        faceSize: number,
        format: GPUTextureFormat,
        usage: GPUTextureUsageFlags,
        mipLevelCount = 1,
    ): GPUTexture {
        return this.device.createTexture({
            label,
            size: [faceSize, faceSize, 6],
            format,
            usage,
            mipLevelCount,
        });
    }

    /**
     * Creates a GPU sampler with the given descriptor
     */
    public static createSampler(descriptor: GPUSamplerDescriptor): GPUSampler {
        return this.device.createSampler(descriptor);
    }

    /**
     * Writes data to a buffer with offset
     */
    public static writeBuffer(
        buffer: GPUBuffer,
        offset: number,
        data: ArrayBuffer | ArrayBufferView,
    ): void {
        this.device.queue.writeBuffer(buffer, offset, data);
    }
}
