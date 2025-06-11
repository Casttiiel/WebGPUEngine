import { GPUResource, IGPUResourceOptions } from '../../core/resources/GPUResource';
import { ResourceType } from '../../types/ResourceType.enum';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { BlendModes } from '../../types/BlendModes.enum';
import { DepthModes } from '../../types/DepthModes.enum';
import { FragmentShaderTargets } from '../../types/FragmentShaderTargets.enum';
import { PipelineBindGroupLayouts } from '../../types/PipelineBindGroupLayouts.enum';
import { RasterizationMode } from '../../types/RasterizationMode.enum';
import { Mesh } from './Mesh';
import { Render } from '../core/render';
import { Engine } from '../../core/engine/Engine';

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
      dependencies: [],
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

  public static async get(
    pathOrData: string | Partial<TechniqueCreateOptions>,
  ): Promise<Technique> {
    let techniqueData = null;
    if (typeof pathOrData === 'string') {
      try {
        return ResourceManager.getResource<Technique>(pathOrData);
      } catch {
        techniqueData = await ResourceManager.loadTechniqueData(pathOrData);
      }
    } else {
      techniqueData = pathOrData;
    }
    const path =
      typeof pathOrData === 'string'
        ? pathOrData
        : `dynamic_technique${Engine.generateDynamicId()}`;

    const technique = new Technique({
      path,
      type: ResourceType.TECHNIQUE,
      vs: techniqueData?.vs ?? '',
      fs: techniqueData?.fs ?? '',
      blend: techniqueData?.blend ?? BlendModes.DEFAULT,
      rs: techniqueData?.rs ?? RasterizationMode.DEFAULT,
      z: techniqueData?.z ?? DepthModes.DEFAULT,
      writesOn: techniqueData?.writesOn ?? FragmentShaderTargets.SCREEN,
      uniforms: techniqueData?.uniforms ?? [],
    });

    if (!technique.vsFile || !technique.fsFile) {
      throw new Error(`Missing shader files for technique: ${path}`);
    }
    await technique.load();
    ResourceManager.registerResource(technique);
    return technique;
  }

  public override async load(): Promise<void> {
    await this.createShaderModules();
    this.createPipelineLayout();
    this.createPipeline();
  }

  private async createShaderModules(): Promise<void> {
    // Load vertex shader
    const vsCode = await ResourceManager.loadShader(this.vsFile);
    if (!vsCode) throw new Error(`Failed to load vertex shader: ${this.vsFile}`);
    this.vsModule = this.device.createShaderModule({
      label: `${this.label}_vs`,
      code: vsCode,
    });

    // Load fragment shader
    const fsCode = await ResourceManager.loadShader(this.fsFile);
    if (!fsCode) throw new Error(`Failed to load fragment shader: ${this.fsFile}`);
    this.fsModule = this.device.createShaderModule({
      label: `${this.label}_fs`,
      code: fsCode,
    });
  }

  private createPipelineLayout(): void {
    if (!this.vsModule || !this.fsModule) {
      throw new Error(
        `Cannot create pipeline layout for technique ${this.path}: Shader modules not loaded`,
      );
    }

    const layouts: GPUBindGroupLayout[] = [];

    // Create bind group layouts based on uniform configuration
    if (this.uniformsLayout && this.uniformsLayout.length > 0) {
      for (const layout of this.uniformsLayout) {
        layouts.push(this.createBindGroupLayout(layout));
      }
    }

    this.pipelineLayouts = layouts;
  }

  private createBindGroupLayout(layout: PipelineBindGroupLayouts): GPUBindGroupLayout {
    switch (layout) {
      case PipelineBindGroupLayouts.CAMERA_UNIFORMS: {
        return this.device.createBindGroupLayout({
          label: 'camera uniforms bind group layout',
          entries: [
            {
              binding: 0,
              visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
              buffer: { type: 'uniform' },
            },
          ],
        });
      }
      case PipelineBindGroupLayouts.MATERIAL_TEXTURES: {
        return this.device.createBindGroupLayout({
          label: 'material textures uniforms bind group layout',
          entries: [
            {
              binding: 0,
              visibility: GPUShaderStage.FRAGMENT,
              texture: { sampleType: 'float' },
            },
            {
              binding: 1,
              visibility: GPUShaderStage.FRAGMENT,
              texture: { sampleType: 'float' },
            },
            {
              binding: 2,
              visibility: GPUShaderStage.FRAGMENT,
              texture: { sampleType: 'float' },
            },
            {
              binding: 3,
              visibility: GPUShaderStage.FRAGMENT,
              texture: { sampleType: 'float' },
            },
            {
              binding: 4,
              visibility: GPUShaderStage.FRAGMENT,
              texture: { sampleType: 'float' },
            },
            {
              binding: 5,
              visibility: GPUShaderStage.FRAGMENT,
              sampler: { type: 'filtering' },
            },
          ],
        });
      }
      case PipelineBindGroupLayouts.OBJECT_UNIFORMS: {
        return this.device.createBindGroupLayout({
          label: 'object uniforms bind group layout',
          entries: [
            {
              binding: 0,
              visibility: GPUShaderStage.VERTEX,
              buffer: { type: 'uniform' },
            },
          ],
        });
      }
      case PipelineBindGroupLayouts.SINGLE_TEXTURE: {
        return this.device.createBindGroupLayout({
          label: 'single texture bind group layout',
          entries: [
            {
              binding: 0,
              visibility: GPUShaderStage.FRAGMENT,
              texture: { sampleType: 'float' },
            },
            {
              binding: 1,
              visibility: GPUShaderStage.FRAGMENT,
              sampler: { type: 'filtering' },
            },
          ],
        });
      }
      case PipelineBindGroupLayouts.GBUFFER_UNIFORMS: {
        return this.device.createBindGroupLayout({
          label: 'g buffer uniforms bind group layout',
          entries: [
            // Albedo texture
            {
              binding: 0,
              visibility: GPUShaderStage.FRAGMENT,
              texture: { sampleType: 'float' },
            },
            // Normal texture
            {
              binding: 1,
              visibility: GPUShaderStage.FRAGMENT,
              texture: { sampleType: 'float' },
            },
            // Linear depth texture
            {
              binding: 2,
              visibility: GPUShaderStage.FRAGMENT,
              texture: { sampleType: 'float' },
            },
            // Self illumination texture
            {
              binding: 3,
              visibility: GPUShaderStage.FRAGMENT,
              texture: { sampleType: 'float' },
            },
            // AO texture
            {
              binding: 4,
              visibility: GPUShaderStage.FRAGMENT,
              texture: { sampleType: 'float' },
            },
            // Shared sampler for all textures
            {
              binding: 5,
              visibility: GPUShaderStage.FRAGMENT,
              sampler: { type: 'filtering' },
            },
          ],
        });
      }
      case PipelineBindGroupLayouts.CUBEMAP_TEXTURE: {
        return this.device.createBindGroupLayout({
          label: 'cubemap texture bind group layout',
          entries: [
            {
              binding: 0,
              visibility: GPUShaderStage.FRAGMENT,
              texture: {
                viewDimension: 'cube',
                sampleType: 'float',
                multisampled: false,
              },
            },
            {
              binding: 1,
              visibility: GPUShaderStage.FRAGMENT,
              sampler: { type: 'filtering' },
            },
          ],
        });
      }
      default: {
        throw new Error(`${this.label}: Unknown uniform layout`);
      }
    }
  }

  private createPipeline(): void {
    if (!this.vsModule || !this.fsModule) {
      throw new Error(
        `Cannot create pipeline for technique ${this.path}: Shader modules not loaded`,
      );
    }

    const layouts = this.pipelineLayouts;
    if (!layouts) {
      throw new Error(`Cannot create pipeline for technique ${this.path}: No layouts available`);
    }

    const pipelineLayout = this.device.createPipelineLayout({
      label: `${this.label}_pipelineLayout`,
      bindGroupLayouts: layouts,
    });

    const vsModule = this.vsModule;
    const fsModule = this.fsModule;
    if (!vsModule || !fsModule) throw new Error('Shader modules not available');

    const pipelineParams = {
      label: this.label,
      layout: pipelineLayout,
      vertex: {
        module: vsModule,
        entryPoint: this.vsEntryPoint,
        buffers: Mesh.getVertexBufferLayout(),
      },
      fragment: {
        module: fsModule,
        entryPoint: this.fsEntryPoint,
        targets: this.getFragmentShaderTarget(),
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: this.getRasterizationConfig(),
        frontFace: 'ccw',
      },
    } as GPURenderPipelineDescriptor;

    if (this.depthTest && this.depthTest !== DepthModes.DISABLE_ALL) {
      pipelineParams.depthStencil = this.getDepthConfig();
    }

    this.pipeline = this.device.createRenderPipeline(pipelineParams);
  }

  private getRasterizationConfig(): GPUCullMode {
    switch (this.rasterizationMode) {
      case RasterizationMode.DEFAULT: {
        return 'back';
      }
      case RasterizationMode.DOUBLE_SIDED: {
        return 'none';
      }
      default: {
        throw new Error(`${this.label}: Unknown Rasterization Mode`);
      }
    }
  }

  private getFragmentShaderTarget(): GPUColorTargetState[] {
    switch (this.writesOn) {
      case FragmentShaderTargets.GBUFFER: {
        return [
          {
            format: 'rgba16float',
          },
          {
            format: 'rgba16float',
          },
          {
            format: 'rgba16float',
          },
          {
            format: 'r16float',
          },
        ];
      }
      case FragmentShaderTargets.TEXTURE: {
        return [
          {
            format: 'rgba16float',
            blend: this.getBlendState(),
          },
        ];
      }
      case FragmentShaderTargets.SCREEN: {
        return [
          {
            format: Render.getInstance().getFormat(),
            blend: {
              color: {
                srcFactor: 'one',
                dstFactor: 'zero',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'zero',
                operation: 'add',
              },
            },
          },
        ];
      }
      default: {
        throw new Error(`${this.label}: Unknown Fragment Shader Target`);
      }
    }
  }

  private getBlendState(): GPUBlendState {
    switch (this.blendMode) {
      case BlendModes.ADDITIVE_BY_SRC_ALPHA:
        return {
          color: {
            srcFactor: 'src-alpha',
            dstFactor: 'one',
            operation: 'add',
          },
          alpha: {
            srcFactor: 'one',
            dstFactor: 'one',
            operation: 'add',
          },
        };
      default:
        return {
          color: {
            srcFactor: 'one',
            dstFactor: 'zero',
            operation: 'add',
          },
          alpha: {
            srcFactor: 'one',
            dstFactor: 'zero',
            operation: 'add',
          },
        };
    }
  }

  private getDepthConfig(): GPUDepthStencilState {
    switch (this.depthTest) {
      case DepthModes.TEST_BUT_NO_WRITE: {
        return {
          depthWriteEnabled: false,
          depthCompare: 'less',
          format: 'depth32float',
        };
      }
      case DepthModes.TEST_EQUAL: {
        return {
          depthWriteEnabled: false,
          depthCompare: 'equal',
          format: 'depth32float',
        };
      }
      case DepthModes.DEFAULT: {
        return {
          format: 'depth32float',
          depthWriteEnabled: true,
          depthCompare: 'less',
        };
      }
      default: {
        throw new Error(`${this.label}: Unknown Depth mode`);
      }
    }
  }

  public activatePipeline(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.pipeline!);
  }

  public getPipeline(): GPURenderPipeline {
    if (!this.pipeline) {
      throw new Error(`Pipeline not initialized for technique ${this.path}`);
    }
    return this.pipeline;
  }

  public getBindGroupLayout(idx: number): GPUBindGroupLayout | undefined {
    return this.pipelineLayouts[idx];
  }
}
