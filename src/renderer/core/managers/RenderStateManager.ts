/**
 * Manages render state to minimize redundant GPU state changes
 */
export class RenderStateManager {
    private currentPipeline: GPURenderPipeline | null = null;
    private currentMeshBuffers: string | null = null;
    private currentMaterialBindings: string | null = null;
    private currentBindGroups: Map<number, GPUBindGroup> = new Map();

    /**
     * Sets the render pipeline if it has changed
     */
    public setPipeline(pass: GPURenderPassEncoder, pipeline: GPURenderPipeline, techniqueActivator: () => void): boolean {
        if (this.currentPipeline !== pipeline) {
            techniqueActivator();
            this.currentPipeline = pipeline;
            return true;
        }
        return false;
    }

    /**
     * Sets mesh buffers if they have changed
     */
    public setMeshBuffers(pass: GPURenderPassEncoder, meshId: string, meshActivator: () => void): boolean {
        if (this.currentMeshBuffers !== meshId) {
            meshActivator();
            this.currentMeshBuffers = meshId;
            return true;
        }
        return false;
    }

    /**
     * Sets material bindings if they have changed
     */
    public setMaterialBindings(
        pass: GPURenderPassEncoder,
        materialId: string,
        bindGroup: GPUBindGroup | undefined,
        groupIndex: number,
    ): boolean {
        if (this.currentMaterialBindings !== materialId && bindGroup) {
            pass.setBindGroup(groupIndex, bindGroup);
            this.currentMaterialBindings = materialId;
            return true;
        }
        return false;
    }

    /**
     * Sets a bind group if it has changed
     */
    public setBindGroup(
        pass: GPURenderPassEncoder,
        groupIndex: number,
        bindGroup: GPUBindGroup,
    ): boolean {
        const currentBindGroup = this.currentBindGroups.get(groupIndex);
        if (currentBindGroup !== bindGroup) {
            pass.setBindGroup(groupIndex, bindGroup);
            this.currentBindGroups.set(groupIndex, bindGroup);
            return true;
        }
        return false;
    }

    /**
     * Forces setting a bind group (always sets, used for dynamic data)
     */
    public forceSetBindGroup(
        pass: GPURenderPassEncoder,
        groupIndex: number,
        bindGroup: GPUBindGroup,
    ): void {
        pass.setBindGroup(groupIndex, bindGroup);
        this.currentBindGroups.set(groupIndex, bindGroup);
    }

    /**
     * Resets all cached state (call at beginning of frame or render pass)
     */
    public reset(): void {
        this.currentPipeline = null;
        this.currentMeshBuffers = null;
        this.currentMaterialBindings = null;
        this.currentBindGroups.clear();
    }

    /**
     * Gets the current pipeline
     */
    public getCurrentPipeline(): GPURenderPipeline | null {
        return this.currentPipeline;
    }

    /**
     * Gets the current mesh buffers ID
     */
    public getCurrentMeshBuffers(): string | null {
        return this.currentMeshBuffers;
    }

    /**
     * Gets the current material bindings ID
     */
    public getCurrentMaterialBindings(): string | null {
        return this.currentMaterialBindings;
    }
}
