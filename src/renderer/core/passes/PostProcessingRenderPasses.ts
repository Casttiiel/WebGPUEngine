import { BaseRenderPass, RenderPassConfig } from './BaseRenderPass';
import { Engine } from '../../../core/engine/Engine';

/**
 * Base class for post-processing render passes
 */
export abstract class PostProcessingRenderPass extends BaseRenderPass {
    protected mesh: any; // Mesh type
    protected technique: any; // Technique type

    constructor(
        config: RenderPassConfig,
        mesh: any,
        technique: any,
    ) {
        super(config);
        this.mesh = mesh;
        this.technique = technique;
    }

    protected render(pass: GPURenderPassEncoder): void {
        // 1. Activate pipeline
        this.technique.activatePipeline(pass);

        // 2. Activate mesh data
        this.mesh.activate(pass);

        // 3. Set bind groups
        this.setBindGroups(pass);

        // 4. Draw the mesh
        this.mesh.renderGroup(pass);
    }

    /**
     * Abstract method for setting bind groups - each post-processing pass has different requirements
     */
    protected abstract setBindGroups(pass: GPURenderPassEncoder): void;
}

/**
 * Tone mapping post-processing render pass
 */
export class ToneMappingRenderPass extends PostProcessingRenderPass {
    private bindGroup: GPUBindGroup;

    constructor(
        config: RenderPassConfig,
        mesh: any,
        technique: any,
        bindGroup: GPUBindGroup,
    ) {
        super(config, mesh, technique);
        this.bindGroup = bindGroup;
    }

    protected setBindGroups(pass: GPURenderPassEncoder): void {
        pass.setBindGroup(0, this.bindGroup);
    }

    /**
     * Update the bind group for tone mapping
     */
    public updateBindGroup(bindGroup: GPUBindGroup): void {
        this.bindGroup = bindGroup;
    }
}

/**
 * Anti-aliasing (FXAA) post-processing render pass
 * This pass requires two bind groups: global camera uniforms and texture
 */
export class AntialiasingRenderPass extends PostProcessingRenderPass {
    private textureBindGroup: GPUBindGroup;

    constructor(
        config: RenderPassConfig,
        mesh: any,
        technique: any,
        textureBindGroup: GPUBindGroup,
    ) {
        super(config, mesh, technique);
        this.textureBindGroup = textureBindGroup;
    }

    protected setBindGroups(pass: GPURenderPassEncoder): void {
        // Antialiasing needs global bind group at 0 and texture at 1
        pass.setBindGroup(0, Engine.getRender().getGlobalBindGroup());
        pass.setBindGroup(1, this.textureBindGroup);
    }

    /**
     * Update the texture bind group for antialiasing
     */
    public updateTextureBindGroup(bindGroup: GPUBindGroup): void {
        this.textureBindGroup = bindGroup;
    }
}

/**
 * Ambient occlusion (SSAO) post-processing render pass  
 * This pass requires two bind groups: global camera uniforms and G-Buffer
 */
export class AmbientOcclusionRenderPass extends PostProcessingRenderPass {
    private gBufferBindGroup: GPUBindGroup;
    private ssaoParamsBindGroup?: GPUBindGroup | undefined;

    constructor(
        config: RenderPassConfig,
        mesh: any,
        technique: any,
        gBufferBindGroup: GPUBindGroup,
        ssaoParamsBindGroup?: GPUBindGroup,
    ) {
        super(config, mesh, technique);
        this.gBufferBindGroup = gBufferBindGroup;
        this.ssaoParamsBindGroup = ssaoParamsBindGroup;
    }

    protected setBindGroups(pass: GPURenderPassEncoder): void {
        // AO needs global bind group at 0, G-Buffer at 1, and optionally SSAO params at 2
        pass.setBindGroup(0, Engine.getRender().getGlobalBindGroup());
        pass.setBindGroup(1, this.gBufferBindGroup);
        if (this.ssaoParamsBindGroup) {
            pass.setBindGroup(2, this.ssaoParamsBindGroup);
        }
    }

    /**
     * Update the G-Buffer bind group for ambient occlusion
     */
    public updateGBufferBindGroup(bindGroup: GPUBindGroup): void {
        this.gBufferBindGroup = bindGroup;
    }

    /**
     * Update the SSAO parameters bind group
     */
    public updateSSAOParamsBindGroup(bindGroup: GPUBindGroup): void {
        this.ssaoParamsBindGroup = bindGroup;
    }
}

/**
 * AO Bilateral Filter post-processing render pass
 * This pass takes the raw AO texture and applies bilateral filtering using G-Buffer data
 */
export class AOBilateralFilterRenderPass extends PostProcessingRenderPass {
    private gBufferBindGroup: GPUBindGroup;
    private aoBindGroup: GPUBindGroup;

    constructor(
        config: RenderPassConfig,
        mesh: any,
        technique: any,
        gBufferBindGroup: GPUBindGroup,
        aoBindGroup: GPUBindGroup,
    ) {
        super(config, mesh, technique);
        this.gBufferBindGroup = gBufferBindGroup;
        this.aoBindGroup = aoBindGroup;
    }

    protected setBindGroups(pass: GPURenderPassEncoder): void {
        // AO bilateral filter needs global camera uniforms at group 0, G-Buffer at group 1, and AO texture at group 2
        pass.setBindGroup(0, Engine.getRender().getGlobalBindGroup());
        pass.setBindGroup(1, this.gBufferBindGroup);
        pass.setBindGroup(2, this.aoBindGroup);
    }

    /**
     * Update the G-Buffer bind group
     */
    public updateGBufferBindGroup(bindGroup: GPUBindGroup): void {
        this.gBufferBindGroup = bindGroup;
    }

    /**
     * Update the AO texture bind group
     */
    public updateAOBindGroup(bindGroup: GPUBindGroup): void {
        this.aoBindGroup = bindGroup;
    }
}