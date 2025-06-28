import { RenderPassConfig } from './BaseRenderPass';
import { RenderToTexture } from '../RenderToTexture';

/**
 * Utility class for creating common render pass configurations
 */
export class RenderPassFactory {
    /**
     * Creates a G-Buffer render pass configuration
     */
    public static createGBufferPassConfig(
        albedos: RenderToTexture,
        normals: RenderToTexture,
        selfIllum: RenderToTexture,
        linearDepth: RenderToTexture,
        msaaDepthView: GPUTextureView,
        viewport?: { width: number; height: number },
    ): RenderPassConfig {
        // Create color attachments with proper MSAA support
        const colorAttachments: GPURenderPassColorAttachment[] = [
            {
                view: albedos.getRenderView()!,
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store',
                ...(albedos.getResolveTarget() && { resolveTarget: albedos.getResolveTarget()! }),
            },
            {
                view: normals.getRenderView()!,
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store',
                ...(normals.getResolveTarget() && { resolveTarget: normals.getResolveTarget()! }),
            },
            {
                view: selfIllum.getRenderView()!,
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store',
                ...(selfIllum.getResolveTarget() && { resolveTarget: selfIllum.getResolveTarget()! }),
            },
            {
                view: linearDepth.getRenderView()!,
                clearValue: { r: 1, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store',
                ...(linearDepth.getResolveTarget() && { resolveTarget: linearDepth.getResolveTarget()! }),
            },
        ];

        return {
            label: 'G-Buffer Pass',
            colorAttachments,
            depthStencilAttachment: {
                view: msaaDepthView,
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
            viewport,
        };
    }

    /**
     * Creates a decals render pass configuration
     */
    public static createDecalPassConfig(
        albedos: RenderToTexture,
        selfIllum: RenderToTexture,
        msaaDepthView: GPUTextureView,
        viewport?: { width: number; height: number },): RenderPassConfig {
        // Create color attachments with proper MSAA support
        const colorAttachments: GPURenderPassColorAttachment[] = [
            {
                view: albedos.getRenderView()!,
                loadOp: 'load',
                storeOp: 'store',
                ...(albedos.getResolveTarget() && { resolveTarget: albedos.getResolveTarget()! }),
            },
            {
                view: selfIllum.getRenderView()!,
                loadOp: 'load',
                storeOp: 'store',
                ...(selfIllum.getResolveTarget() && { resolveTarget: selfIllum.getResolveTarget()! }),
            },
        ];

        return {
            label: 'Decal Pass',
            colorAttachments,
            depthStencilAttachment: {
                view: msaaDepthView,
                depthLoadOp: 'load',
                depthStoreOp: 'store',
            },
            viewport,
        };
    }

    /**
     * Creates a transparent render pass configuration
     */
    public static createTransparentPassConfig(
        accLight: RenderToTexture,
        depthView: GPUTextureView,
        viewport?: { width: number; height: number },
    ): RenderPassConfig {
        return {
            label: 'Transparent Pass',
            colorAttachments: [
                {
                    view: accLight.getView()!,
                    loadOp: 'load',
                    storeOp: 'store',
                },
            ],
            depthStencilAttachment: {
                view: depthView,
                depthLoadOp: 'load',
                depthStoreOp: 'store',
            },
            viewport,
        };
    }    /**
     * Creates a fullscreen post-processing pass configuration
     */
    public static createPostProcessPassConfig(
        target: RenderToTexture,
        viewport?: { width: number; height: number },
    ): RenderPassConfig {
        return {
            label: 'Post Process Pass',
            colorAttachments: [
                {
                    view: target.getView()!,
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
            viewport,
        };
    }

    /**
     * Creates a fullscreen post-processing pass configuration with MSAA support
     */
    public static createPostProcessPassConfigMSAA(
        target: RenderToTexture,
        viewport?: { width: number; height: number },
    ): RenderPassConfig {
        return {
            label: 'Post Process Pass (MSAA)',
            colorAttachments: [
                {
                    view: target.getRenderView()!,
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    loadOp: 'clear',
                    storeOp: 'store',
                    ...(target.getResolveTarget() && { resolveTarget: target.getResolveTarget()! }),
                },
            ],
            viewport,
        };
    }

    /**
     * Creates configuration for point light render pass
     */
    public static createPointLightPassConfig(
        accLight: RenderToTexture,
        singleDepthView: GPUTextureView,
    ): RenderPassConfig {
        return {
            label: 'Point Lights Render Pass',
            colorAttachments: [
                {
                    view: accLight.getView()!,
                    loadOp: 'load', // Load existing lighting data
                    storeOp: 'store',
                },
            ],
            depthStencilAttachment: {
                view: singleDepthView,
                depthLoadOp: 'load', // Load existing depth
                depthStoreOp: 'store',
            },
        };
    }

    /**
     * Creates configuration for spot light render pass
     */
    public static createSpotLightPassConfig(
        accLight: RenderToTexture,
        singleDepthView: GPUTextureView,
    ): RenderPassConfig {
        return {
            label: 'Spot Lights Render Pass',
            colorAttachments: [
                {
                    view: accLight.getView()!,
                    loadOp: 'load', // Load existing lighting data
                    storeOp: 'store',
                },
            ],
            depthStencilAttachment: {
                view: singleDepthView,
                depthLoadOp: 'load', // Load existing depth
                depthStoreOp: 'store',
            },
        };
    }
}
