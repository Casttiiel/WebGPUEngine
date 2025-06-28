import { BaseRenderPass } from './BaseRenderPass';
import { GBufferRenderPass, DecalRenderPass, TransparentRenderPass } from './DeferredRenderPasses';
import { RenderPassFactory } from './RenderPassFactory';
import { RenderToTexture } from '../RenderToTexture';
import { RenderCategory } from '../../../types/RenderCategory.enum';
import { Render } from '../Render';

/**
 * Manager for coordinating multiple render passes in the deferred rendering pipeline
 */
export class RenderPassManager {
    private renderPasses: Map<string, BaseRenderPass> = new Map();

    /**
     * Initialize all render passes for deferred rendering
     */
    public initializeDeferredPasses(
        albedos: RenderToTexture,
        normals: RenderToTexture,
        selfIllum: RenderToTexture,
        linearDepth: RenderToTexture,
        accLight: RenderToTexture,
        msaaDepthView: GPUTextureView,
        singleDepthView: GPUTextureView,
    ): void {
        // Create G-Buffer pass
        const gBufferConfig = RenderPassFactory.createGBufferPassConfig(
            albedos,
            normals,
            selfIllum,
            linearDepth,
            msaaDepthView,
        );
        const gBufferPass = new GBufferRenderPass(gBufferConfig);
        this.renderPasses.set('gbuffer', gBufferPass);

        // Create Decal pass
        const decalConfig = RenderPassFactory.createDecalPassConfig(
            albedos,
            selfIllum,
            msaaDepthView,
        );
        const decalPass = new DecalRenderPass(decalConfig);
        this.renderPasses.set('decals', decalPass);

        // Create Transparent pass
        const transparentConfig = RenderPassFactory.createTransparentPassConfig(
            accLight,
            singleDepthView,
        );
        const transparentPass = new TransparentRenderPass(transparentConfig);
        this.renderPasses.set('transparent', transparentPass);
    }

    /**
     * Execute a specific render pass
     */
    public executePass(
        passName: string,
        category?: RenderCategory,
        renderKeys?: any[],
    ): void {
        const pass = this.renderPasses.get(passName);
        if (!pass) {
            throw new Error(`Render pass '${passName}' not found`);
        }

        const encoder = Render.getInstance().getCommandEncoder();
        pass.execute(encoder, category, renderKeys);
    }

    /**
     * Execute the complete deferred rendering pipeline
     */
    public executeDeferredPipeline(): void {
        // Execute G-Buffer pass
        this.executePass('gbuffer', RenderCategory.SOLIDS);

        // Execute Decal pass
        this.executePass('decals', RenderCategory.DECALS);

        // Transparent pass would be executed after lighting passes
        // this.executePass('transparent', RenderCategory.TRANSPARENT);
    }

    /**
     * Get a render pass by name
     */
    public getPass(passName: string): BaseRenderPass | undefined {
        return this.renderPasses.get(passName);
    }

    /**
     * Add a custom render pass
     */
    public addPass(name: string, pass: BaseRenderPass): void {
        this.renderPasses.set(name, pass);
    }

    /**
     * Remove a render pass
     */
    public removePass(name: string): boolean {
        return this.renderPasses.delete(name);
    }

    /**
     * Clear all render passes
     */
    public clear(): void {
        this.renderPasses.clear();
    }
}
