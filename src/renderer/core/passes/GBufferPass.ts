import { RenderToTexture } from '../RenderToTexture';
import { GPUUtils } from '../utils/GPUUtils';
import { Render } from '../Render';

/**
 * G-Buffer render pass for deferred rendering
 * Renders geometry to multiple render targets (albedo, normal, depth, etc.)
 */
export class GBufferPass {
    private rtAlbedos!: RenderToTexture;
    private rtNormals!: RenderToTexture;
    private rtSelfIllum!: RenderToTexture;
    private rtLinearDepth!: RenderToTexture;
    private depthStencil!: GPUTexture;
    private depthStencilView!: GPUTextureView;
    private msaaDepthStencil!: GPUTexture;
    private msaaDepthStencilView!: GPUTextureView | null;

    constructor() {
        // Empty constructor
    }

    public async load(): Promise<void> {
        await this.createRenderTargets();
    }

    private async createRenderTargets(): Promise<void> {
        const width = Render.width;
        const height = Render.height;        // Create G-Buffer render targets with formats matching gbuffer.tech pipeline
        this.rtAlbedos = new RenderToTexture();
        this.rtAlbedos.createRT('gbuffer_albedos', width, height, 'rgba16float', true);

        this.rtNormals = new RenderToTexture();
        this.rtNormals.createRT('gbuffer_normals', width, height, 'rgba16float', true);

        this.rtSelfIllum = new RenderToTexture();
        this.rtSelfIllum.createRT('gbuffer_selfillum', width, height, 'rgba16float', true);

        this.rtLinearDepth = new RenderToTexture();
        this.rtLinearDepth.createRT('gbuffer_linear_depth', width, height, 'r16float', true);// Create depth buffers (both MSAA and single-sample)
        this.depthStencil = GPUUtils.createTexture(
            'gbuffer_depth_single',
            width,
            height,
            'depth32float',
            GPUTextureUsage.RENDER_ATTACHMENT,);
        this.depthStencilView = this.depthStencil.createView({
            aspect: 'depth-only'
        });

        this.msaaDepthStencil = GPUUtils.createTexture(
            'gbuffer_depth_msaa',
            width,
            height,
            'depth32float',
            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            4,
        );
        this.msaaDepthStencilView = this.msaaDepthStencil.createView({
            aspect: 'depth-only'
        });
    }

    public execute(encoder: GPUCommandEncoder, renderCallback: (pass: GPURenderPassEncoder) => void): void {
        const colorAttachments: GPURenderPassColorAttachment[] = [
            GPUUtils.createColorAttachment(this.rtAlbedos.getRenderView(), 'clear'),
            GPUUtils.createColorAttachment(this.rtNormals.getRenderView(), 'clear'),
            GPUUtils.createColorAttachment(this.rtSelfIllum.getRenderView(), 'clear'),
            GPUUtils.createColorAttachment(this.rtLinearDepth.getRenderView(), 'clear'),
        ];

        // Add resolve targets for MSAA if available
        const albedoResolve = this.rtAlbedos.getResolveTarget();
        const normalResolve = this.rtNormals.getResolveTarget();
        const selfIllumResolve = this.rtSelfIllum.getResolveTarget();
        const linearDepthResolve = this.rtLinearDepth.getResolveTarget(); if (albedoResolve) colorAttachments[0]!.resolveTarget = albedoResolve;
        if (normalResolve) colorAttachments[1]!.resolveTarget = normalResolve;
        if (selfIllumResolve) colorAttachments[2]!.resolveTarget = selfIllumResolve;
        if (linearDepthResolve) colorAttachments[3]!.resolveTarget = linearDepthResolve;

        const depthStencilAttachment = GPUUtils.createDepthStencilAttachment(
            this.msaaDepthStencilView!,
            'clear',
            'store'
        );

        const passDescriptor: GPURenderPassDescriptor = {
            label: 'G-Buffer Pass',
            colorAttachments,
            depthStencilAttachment,
        };

        const pass = encoder.beginRenderPass(passDescriptor);

        // Configure viewport and scissor using GPUUtils
        GPUUtils.configureViewportAndScissor(pass);

        renderCallback(pass);
        pass.end();
    }

    public getRenderTargets(): {
        albedos: RenderToTexture;
        normals: RenderToTexture;
        selfIllum: RenderToTexture;
        linearDepth: RenderToTexture;
    } {
        return {
            albedos: this.rtAlbedos,
            normals: this.rtNormals,
            selfIllum: this.rtSelfIllum,
            linearDepth: this.rtLinearDepth,
        };
    }

    public getDepthTextures(): {
        msaaDepth: GPUTexture;
        singleDepth: GPUTexture;
        msaaDepthView: GPUTextureView;
        singleDepthView: GPUTextureView;
    } {
        return {
            msaaDepth: this.msaaDepthStencil,
            singleDepth: this.depthStencil,
            msaaDepthView: this.msaaDepthStencilView!,
            singleDepthView: this.depthStencilView,
        };
    }

    public async resize(): Promise<void> {
        this.dispose();
        await this.createRenderTargets();
    }

    public dispose(): void {
        this.rtAlbedos?.destroy();
        this.rtNormals?.destroy();
        this.rtSelfIllum?.destroy();
        this.rtLinearDepth?.destroy();
        this.depthStencil?.destroy();
        this.msaaDepthStencil?.destroy();
    }
}
