import { BaseResource, IResourceOptions } from "./IResource";
import { Render } from "../../renderer/core/render";
import { ResourceManager } from "../engine/ResourceManager";

export interface IGPUResourceOptions extends IResourceOptions {
    label?: string;
}

export abstract class GPUResource extends BaseResource {
    protected device: GPUDevice;
    protected label: string;
    private destroyed: boolean = false;

    constructor(options: IGPUResourceOptions) {
        super(options);
        this.device = Render.getInstance().getDevice();
        this.label = options.label || options.path;
    }

    public override async load(): Promise<void> {
        if (this.isLoaded) return;
        
        try {
            await this.loadDependencies();
            await this.createGPUResources();
            this.setLoaded();
        } catch (error) {
            await this.destroyGPUResources();
            throw error;
        }
    }

    public override async unload(): Promise<void> {
        if (!this.isLoaded || this.destroyed) return;

        try {
            await this.destroyGPUResources();
            this.destroyed = true;
            await super.unload();
        } catch (error) {
            console.error(`Error unloading GPU resource ${this.path}: ${error}`);
            throw error;
        }
    }

    private async loadDependencies(): Promise<void> {
        if (this.dependencies.size === 0) return;

        const loadPromises = Array.from(this.dependencies).map(async (dep) => {
            const resource = await ResourceManager.getResource<GPUResource>(dep);
            if (!resource.isLoaded) {
                await resource.load();
            }
        });

        await Promise.all(loadPromises);
    }

    protected abstract createGPUResources(): Promise<void>;
    protected abstract destroyGPUResources(): Promise<void>;
}
