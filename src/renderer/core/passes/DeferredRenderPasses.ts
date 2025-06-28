import { BaseRenderPass, RenderPassConfig } from './BaseRenderPass';
import { RenderCategory } from '../../../types/RenderCategory.enum';
import { RenderManagerV2 as RenderManager } from '../managers/RenderManagerV2';
import { Render } from '../Render';
import { GPUUtils } from '../utils/GPUUtils';

/**
 * G-Buffer render pass for deferred rendering using BaseRenderPass
 */
export class GBufferRenderPass extends BaseRenderPass {
    constructor(config: RenderPassConfig) {
        super(config);
    }

    /**
     * Renders geometry to G-Buffer targets
     */
    protected render(
        pass: GPURenderPassEncoder,
        category?: RenderCategory,
        renderKeys?: any[],
    ): void {
        // Configure viewport for the pass
        const viewport = this.config.viewport;
        if (viewport) {
            GPUUtils.configureViewportAndScissor(pass, viewport.width, viewport.height);
        } else {
            GPUUtils.configureViewportAndScissor(pass, Render.width, Render.height);
        }

        // Render solid geometry to G-Buffer
        const renderCategory = category || RenderCategory.SOLIDS;
        RenderManager.getInstance().render(renderCategory, pass);
    }
}

/**
 * Decals render pass for G-Buffer
 */
export class DecalRenderPass extends BaseRenderPass {
    constructor(config: RenderPassConfig) {
        super(config);
    } protected render(
        pass: GPURenderPassEncoder,
        _category?: RenderCategory,
        _renderKeys?: any[],
    ): void {
        // Configure viewport for decals
        const viewport = this.config.viewport;
        if (viewport) {
            GPUUtils.configureViewportAndScissor(pass, viewport.width, viewport.height);
        } else {
            GPUUtils.configureViewportAndScissor(pass, Render.width, Render.height);
        }

        // Render decals on top of G-Buffer
        RenderManager.getInstance().render(RenderCategory.DECALS, pass);
    }
}

/**
 * Transparent objects render pass
 */
export class TransparentRenderPass extends BaseRenderPass {
    constructor(config: RenderPassConfig) {
        super(config);
    } protected render(
        pass: GPURenderPassEncoder,
        _category?: RenderCategory,
        _renderKeys?: any[],
    ): void {
        // Configure viewport for transparent objects
        const viewport = this.config.viewport;
        if (viewport) {
            GPUUtils.configureViewportAndScissor(pass, viewport.width, viewport.height);
        } else {
            GPUUtils.configureViewportAndScissor(pass, Render.width, Render.height);
        }

        // Render transparent objects
        RenderManager.getInstance().render(RenderCategory.TRANSPARENT, pass);
    }
}
