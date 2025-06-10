import { GPUResource, IGPUResourceOptions } from "../../core/resources/GPUResource";
import { ResourceType } from "../../types/ResourceType.enum";
import { ResourceManager } from "../../core/engine/ResourceManager";
import { BlendModes } from "../../types/BlendModes.enum";
import { DepthModes } from "../../types/DepthModes.enum";
import { FragmentShaderTargets } from "../../types/FragmentShaderTargets.enum";
import { PipelineBindGroupLayouts } from "../../types/PipelineBindGroupLayouts.enum";
import { RasterizationMode } from "../../types/RasterizationMode.enum";

export interface TechniqueCreateOptions extends Omit<IGPUResourceOptions, 'type'> {
    vs: string;
    fs: string;
    vsEntryPoint?: string;
    fsEntryPoint?: string;
    blend?: BlendModes;
    rs?: RasterizationMode;
    z?: DepthModes;
    writesOn?: FragmentShaderTargets;
    uniforms?: ReadonlyArray<PipelineBindGroupLayouts>;
}

export type TechniqueOptions = TechniqueCreateOptions & IGPUResourceOptions;

export class Technique extends GPUResource {
    // Pipeline resources
    private pipeline?: GPURenderPipeline;
    private pipelineLayouts?: GPUBindGroupLayout[];
    private pipelineLayoutPromise?: Promise<GPUBindGroupLayout[]>;
    private pipelinePromise?: Promise<GPURenderPipeline>;

    // Shader modules
    private vsModule?: GPUShaderModule;
    private fsModule?: GPUShaderModule;
    
    // Configuration
    private blendMode: BlendModes;
    private rasterizationMode: RasterizationMode;
    private depthTest: DepthModes;
    private writesOn: FragmentShaderTargets;
    private uniformsLayout: ReadonlyArray<PipelineBindGroupLayouts>;
    private vsFile: string;
    private fsFile: string;
    private vsEntryPoint: string;
    private fsEntryPoint: string;

    constructor(options: TechniqueOptions) {
        super({
            ...options,
            type: ResourceType.TECHNIQUE,
            dependencies: []
        });

        this.blendMode = options.blend || BlendModes.DEFAULT;
        this.rasterizationMode = options.rs || RasterizationMode.DEFAULT;
        this.depthTest = options.z || DepthModes.DEFAULT;
        this.writesOn = options.writesOn || FragmentShaderTargets.SCREEN;
        this.uniformsLayout = options.uniforms || [];
        this.vsFile = options.vs;
        this.fsFile = options.fs;
        this.vsEntryPoint = options.vsEntryPoint || 'vs';
        this.fsEntryPoint = options.fsEntryPoint || 'fs';
    }

    public static async get(path: string, options?: Partial<TechniqueCreateOptions>): Promise<Technique> {
        try {
            return await ResourceManager.getResource<Technique>(path);
        } catch {
            const data = !options?.vs || !options?.fs
                ? await ResourceManager.loadTechniqueData(path)
                : null;

            // Los shaders ya vienen con su ruta correcta desde el archivo .tech
            const technique = new Technique({
                path,
                type: ResourceType.TECHNIQUE,
                vs: options?.vs || data?.vs || '',
                fs: options?.fs || data?.fs || '',
                blend: options?.blend || data?.blend,
                rs: options?.rs || data?.rs,
                z: options?.z || data?.z,
                writesOn: options?.writesOn || data?.writesOn,
                uniforms: options?.uniforms || data?.uniforms
            });

            if (!technique.vsFile || !technique.fsFile) {
                throw new Error(`Missing shader files for technique: ${path}`);
            }

            await ResourceManager.registerResource(technique);
            return technique;
        }
    }

    protected override async createGPUResources(): Promise<void> {
        await this.createShaderModules();
        await this.createPipelineLayout();
        await this.createPipeline();
    }

    private async createShaderModules(): Promise<void> {
        // Load vertex shader
        const vsCode = await ResourceManager.loadShader(this.vsFile);
        if (!vsCode) throw new Error(`Failed to load vertex shader: ${this.vsFile}`);
        this.vsModule = this.device.createShaderModule({
            label: `${this.label}_vs`,
            code: vsCode
        });

        // Load fragment shader
        const fsCode = await ResourceManager.loadShader(this.fsFile);
        if (!fsCode) throw new Error(`Failed to load fragment shader: ${this.fsFile}`);
        this.fsModule = this.device.createShaderModule({
            label: `${this.label}_fs`,
            code: fsCode
        });
    }

    private async createPipelineLayout(): Promise<void> {
        if (!this.vsModule || !this.fsModule) {
            throw new Error(`Cannot create pipeline layout for technique ${this.path}: Shader modules not loaded`);
        }

        this.pipelineLayoutPromise = (async () => {
            const layouts: GPUBindGroupLayout[] = [];

            // Create bind group layouts based on uniform configuration
            if (this.uniformsLayout && this.uniformsLayout.length > 0) {
                for (const layout of this.uniformsLayout) {
                    layouts.push(await this.createBindGroupLayout(layout));
                }
            }

            this.pipelineLayouts = layouts;
            return layouts;
        })();
    }

    private async createPipeline(): Promise<void> {
        if (!this.vsModule || !this.fsModule) {
            throw new Error(`Cannot create pipeline for technique ${this.path}: Shader modules not loaded`);
        }

        const layouts = await this.pipelineLayoutPromise;
        if (!layouts) {
            throw new Error(`Cannot create pipeline for technique ${this.path}: No layouts available`);
        }

        this.pipelinePromise = (async () => {
            const pipelineLayout = this.device.createPipelineLayout({
                label: `${this.label}_pipelineLayout`,
                bindGroupLayouts: layouts
            });

            const vsModule = this.vsModule;
            const fsModule = this.fsModule;
            if (!vsModule || !fsModule) throw new Error('Shader modules not available');

            this.pipeline = this.device.createRenderPipeline({
                label: this.label,
                layout: pipelineLayout,
                vertex: {
                    module: vsModule,
                    entryPoint: this.vsEntryPoint,
                    buffers: [] // Updated when pipeline is bound to mesh
                },
                fragment: {
                    module: fsModule,
                    entryPoint: this.fsEntryPoint,
                    targets: [
                        {
                            format: 'bgra8unorm',
                            blend: this.getBlendState(),
                            writeMask: GPUColorWrite.ALL
                        }
                    ]
                },
                primitive: {
                    topology: 'triangle-list',
                    cullMode: this.rasterizationMode === RasterizationMode.DOUBLE_SIDED ? 'none' : 'back',
                    frontFace: 'ccw'
                },
                depthStencil: {
                    format: 'depth24plus',
                    depthWriteEnabled: this.depthTest !== DepthModes.DISABLE_ALL,
                    depthCompare: this.getDepthCompare()
                }
            });

            return this.pipeline;
        })();
    }

    protected override async destroyGPUResources(): Promise<void> {
        this.pipeline = undefined;
        this.pipelineLayouts = undefined;
        this.pipelineLayoutPromise = undefined;
        this.pipelinePromise = undefined;
        this.vsModule = undefined;
        this.fsModule = undefined;
    }

    private getBlendState(): GPUBlendState {
        switch (this.blendMode) {
            case BlendModes.ADDITIVE_BY_SRC_ALPHA:
                return {
                    color: {
                        srcFactor: 'src-alpha',
                        dstFactor: 'one',
                        operation: 'add'
                    },
                    alpha: {
                        srcFactor: 'one',
                        dstFactor: 'one',
                        operation: 'add'
                    }
                };
            default:
                return {
                    color: {
                        srcFactor: 'one',
                        dstFactor: 'zero',
                        operation: 'add'
                    },
                    alpha: {
                        srcFactor: 'one',
                        dstFactor: 'zero',
                        operation: 'add'
                    }
                };
        }
    }

    private getDepthCompare(): GPUCompareFunction {
        switch (this.depthTest) {
            case DepthModes.TEST_BUT_NO_WRITE:
                return 'less';
            case DepthModes.TEST_EQUAL:
                return 'equal';
            case DepthModes.DISABLE_ALL:
                return 'always';
            default:
                return 'less';
        }
    }

    private async createBindGroupLayout(layout: PipelineBindGroupLayouts): Promise<GPUBindGroupLayout> {
        // Implementation depends on your specific bind group layout requirements
        // This is a placeholder that creates a basic layout for testing
        return this.device.createBindGroupLayout({
            label: `${this.label}_bindGroupLayout_${layout}`,
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: {
                        type: 'uniform'
                    }
                }
            ]
        });
    }

    public async getPipeline(): Promise<GPURenderPipeline | undefined> {
        return this.pipelinePromise;
    }

    public getBindGroupLayout(idx:number): GPUBindGroupLayout | undefined {
        return this.pipelineLayouts[idx];
    }
}