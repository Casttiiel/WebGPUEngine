import { RenderCategory } from '../../../types/RenderCategory.enum';
import { GPUUtils } from '../utils/GPUUtils';
import { RenderKeyManager, RenderKey } from '../managers/RenderKeyManager';
import { Engine } from '../../../core/engine/Engine';

export interface RenderPassConfig {
    label: string;
    colorAttachments: GPURenderPassColorAttachment[];
    depthStencilAttachment?: GPURenderPassDepthStencilAttachment;
    viewport?: { width: number; height: number };
}

/**
 * Base class for render passes with common functionality
 */
export abstract class BaseRenderPass {
    protected config: RenderPassConfig;

    constructor(config: RenderPassConfig) {
        this.config = config;
    }
    /**
     * Executes the render pass
     */
    public execute(
        commandEncoder: GPUCommandEncoder,
        category?: RenderCategory,
        renderKeys?: RenderKey[],
    ): void {
        const descriptor: GPURenderPassDescriptor = {
            label: this.config.label,
            colorAttachments: this.config.colorAttachments,
        };

        if (this.config.depthStencilAttachment) {
            descriptor.depthStencilAttachment = this.config.depthStencilAttachment;
        }

        const pass = commandEncoder.beginRenderPass(descriptor);

        // Configure viewport and scissor
        const viewport = this.config.viewport;
        if (viewport) {
            GPUUtils.configureViewportAndScissor(pass, viewport.width, viewport.height);
        } else {
            GPUUtils.configureViewportAndScissor(pass);
        }

        // Execute the pass-specific rendering
        this.render(pass, category, renderKeys);

        pass.end();
    }

    /**
     * Pass-specific rendering implementation
     */
    protected abstract render(
        pass: GPURenderPassEncoder,
        category?: RenderCategory,
        renderKeys?: RenderKey[],
    ): void;

    /**
     * Updates the pass configuration
     */
    public updateConfig(config: Partial<RenderPassConfig>): void {
        this.config = { ...this.config, ...config };
    }
}

/**
 * Standard geometry render pass
 */
export class GeometryRenderPass extends BaseRenderPass {
    private renderKeyManager: RenderKeyManager;

    constructor(config: RenderPassConfig, renderKeyManager: RenderKeyManager) {
        super(config);
        this.renderKeyManager = renderKeyManager;
    }

    protected render(
        pass: GPURenderPassEncoder,
        category?: RenderCategory,
        renderKeys?: RenderKey[],
    ): void {
        if (!category) {
            console.warn('GeometryRenderPass: No category specified');
            return;
        }

        // Use provided keys or get from manager
        const keysToRender = renderKeys || this.renderKeyManager.getKeysByCategory(category);

        // Sort keys for optimal rendering
        this.renderKeyManager.sortKeys(keysToRender, category);

        // Render the keys
        this.renderKeys(keysToRender, pass);
    }

    private renderKeys(keys: RenderKey[], pass: GPURenderPassEncoder): void {
        let currentPipeline: GPURenderPipeline | null = null;
        let currentMeshBuffers: string | null = null;
        let currentMaterialBindings: string | null = null;

        for (const key of keys) {
            if (!key.material || !key.mesh || !key.transform) {
                console.warn('Invalid render key - missing components');
                continue;
            }

            const technique = key.material.getTechnique();
            if (!technique) {
                console.warn('Invalid render key - missing technique');
                continue;
            }

            const pipeline = technique.getPipeline();
            if (!pipeline) {
                console.warn('Invalid render key - missing pipeline');
                continue;
            }

            // 1. Set pipeline only if changed
            if (currentPipeline !== pipeline) {
                technique.activatePipeline(pass);
                currentPipeline = pipeline;
            }

            // 2. Set mesh data only if changed
            const meshId = key.mesh.getName();
            if (currentMeshBuffers !== meshId) {
                key.mesh.activate(pass);
                currentMeshBuffers = meshId;
            }

            // 3. Set bind groups
            pass.setBindGroup(0, Engine.getRender().getGlobalBindGroup()); // Camera uniforms
            pass.setBindGroup(1, key.transform.getModelBindGroup()); // Object uniforms

            // 4. Set material bind group only if changed
            const materialId = key.material.getName();
            if (currentMaterialBindings !== materialId) {
                const textureBindGroup = key.material.getTextureBindGroup();
                if (textureBindGroup) {
                    pass.setBindGroup(2, textureBindGroup);
                    currentMaterialBindings = materialId;
                }
            }

            // 5. Draw the mesh
            key.mesh.renderGroup(pass);
        }
    }
}

/**
 * Full-screen quad render pass for post-processing
 */
export class FullScreenPass extends BaseRenderPass {
    private mesh: any; // Mesh type
    private technique: any; // Technique type
    private bindGroup: GPUBindGroup;

    constructor(
        config: RenderPassConfig,
        mesh: any,
        technique: any,
        bindGroup: GPUBindGroup,
    ) {
        super(config);
        this.mesh = mesh;
        this.technique = technique;
        this.bindGroup = bindGroup;
    }

    protected render(pass: GPURenderPassEncoder): void {
        // 1. Set pipeline
        this.technique.activatePipeline(pass);

        // 2. Set mesh
        this.mesh.activate(pass);

        // 3. Set bind group
        pass.setBindGroup(0, this.bindGroup);

        // 4. Draw
        this.mesh.renderGroup(pass);
    }

    /**
     * Updates the bind group for this pass
     */
    public updateBindGroup(bindGroup: GPUBindGroup): void {
        this.bindGroup = bindGroup;
    }
}
