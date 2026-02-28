import { GPUResource, IGPUResourceOptions } from '../../core/resources/GPUResource';
import { ResourceType } from '../../types/ResourceType.enum';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { BlendModes } from '../../types/BlendModes.enum';
import { DepthModes } from '../../types/DepthModes.enum';
import { FragmentShaderTargets } from '../../types/FragmentShaderTargets.enum';
import { PipelineBindGroupLayouts } from '../../types/PipelineBindGroupLayouts.enum';
import { RasterizationMode } from '../../types/RasterizationMode.enum';
import { Mesh } from './Mesh';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { PipelineFactory, PipelineConfig } from '../core/factories/PipelineFactory';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Render } from '../core/pipeline/Render';

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
  instanced?: boolean;
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
  private isInstanced: boolean;
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
    this.isInstanced = options.instanced || false;
    this.vsFile = options.vs;
    this.fsFile = options.fs;
    this.vsEntryPoint = options.vsEntryPoint || 'vs';
    this.fsEntryPoint = options.fsEntryPoint || 'fs';
  }

  public static async getAsync(
    pathOrData: string | Partial<TechniqueCreateOptions>,
  ): Promise<Technique> {
    const path = this.generatePath(pathOrData);

    // Try to get existing resource
    try {
      return ResourceManager.getResource<Technique>(path);
    } catch {
      // Resource doesn't exist, create new one
    }

    const techniqueData = await this.loadTechniqueData(pathOrData);
    const technique = this.createTechnique(path, techniqueData);

    await technique.loadAsync();
    ResourceManager.registerResource(technique);
    return technique;
  }

  private static generatePath(pathOrData: string | Partial<TechniqueCreateOptions>): string {
    return typeof pathOrData === 'string' ? pathOrData : `${pathOrData?.vs}-${pathOrData?.fs}`;
  }

  private static async loadTechniqueData(
    pathOrData: string | Partial<TechniqueCreateOptions>,
  ): Promise<Partial<TechniqueCreateOptions>> {
    if (typeof pathOrData === 'string') {
      return await ResourceManager.loadTechniqueData(pathOrData);
    }
    return pathOrData;
  }

  private static createTechnique(
    path: string,
    techniqueData: Partial<TechniqueCreateOptions>,
  ): Technique {
    if (!techniqueData?.vs || !techniqueData?.fs) {
      throw new Error(`Missing shader files for technique: ${path}`);
    }

    const options: TechniqueOptions = {
      path,
      type: ResourceType.TECHNIQUE,
      vs: techniqueData.vs,
      fs: techniqueData.fs,
      blend: techniqueData.blend ?? BlendModes.DEFAULT,
      rs: techniqueData.rs ?? RasterizationMode.DEFAULT,
      z: techniqueData.z ?? DepthModes.DEFAULT,
      writesOn: techniqueData.writesOn ?? FragmentShaderTargets.SCREEN,
      uniforms: techniqueData.uniforms ?? [],
      instanced: techniqueData.instanced ?? false,
    };

    // Add optional properties only if they exist
    if (techniqueData.vsEntryPoint) {
      options.vsEntryPoint = techniqueData.vsEntryPoint;
    }
    if (techniqueData.fsEntryPoint) {
      options.fsEntryPoint = techniqueData.fsEntryPoint;
    }

    return new Technique(options);
  }

  public async loadAsync(): Promise<void> {
    await this.createShaderModules();
    this.createPipelineLayout();
    this.createPipeline();
  }

  private async createShaderModules(): Promise<void> {
    // Load both shaders in parallel
    const [vsCode, fsCode] = await Promise.all([
      ResourceManager.loadShader(this.vsFile),
      ResourceManager.loadShader(this.fsFile),
    ]);

    if (!vsCode) throw new Error(`Failed to load vertex shader: ${this.vsFile}`);
    if (!fsCode) throw new Error(`Failed to load fragment shader: ${this.fsFile}`);

    this.vsModule = this.device.createShaderModule({
      label: `${this.label}_vs`,
      code: vsCode,
    });

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
    return BindGroupFactory.getLayoutFromEnum(layout);
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
    const pipelineLayout = PipelineFactory.createPipelineLayout(
      `${this.label}_pipelineLayout`,
      layouts,
    );

    const vsModule = this.vsModule;
    const fsModule = this.fsModule;
    if (!vsModule || !fsModule) throw new Error('Shader modules not available');
    const pipelineConfig: PipelineConfig = {
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
    };
    if (this.depthTest && this.depthTest !== DepthModes.DISABLE_ALL) {
      pipelineConfig.depthStencil = this.getDepthConfig();
    }

    this.pipeline = PipelineFactory.createPipeline(pipelineConfig);
  }

  // ============================================================================
  // PIPELINE CONFIGURATION METHODS
  // ============================================================================

  private getRasterizationConfig(): GPUCullMode {
    switch (this.rasterizationMode) {
      case RasterizationMode.DEFAULT: {
        return 'back';
      }
      case RasterizationMode.REVERSE_CULLING: {
        return 'front';
      }
      case RasterizationMode.DOUBLE_SIDED: {
        return 'none';
      }
      case RasterizationMode.SHADOWS: {
        return 'back';
      }
      default: {
        throw new Error(`${this.label}: Unknown Rasterization Mode`);
      }
    }
  }

  // ============================================================================
  // FRAGMENT TARGET CONFIGURATION METHODS
  // ============================================================================

  private getFragmentShaderTarget(): GPUColorTargetState[] {
    switch (this.writesOn) {
      case FragmentShaderTargets.GBUFFER:
        return this.createGBufferTargets();
      case FragmentShaderTargets.PARTIAL_GBUFFER:
        return this.createPartialGBufferTargets();
      case FragmentShaderTargets.TEXTURE:
        return this.createTextureTarget();
      case FragmentShaderTargets.SINGLE_CHANNEL:
        return this.createSingleChannelTarget();
      case FragmentShaderTargets.SCREEN:
        return this.createScreenTarget();
      case FragmentShaderTargets.DEPTH_ONLY:
        return []; // No color targets, only depth output
      default:
        throw new Error(`${this.label}: Unknown Fragment Shader Target`);
    }
  }

  private createGBufferTargets(): GPUColorTargetState[] {
    // Get current G-Buffer texture formats based on quality settings;
    return [
      { format: QualitySettings.getInstance().getSettings().albedoTexture }, // Albedo + metallic
      { format: QualitySettings.getInstance().getSettings().normalTexture }, // Normal + roughness + emissive
      { format: QualitySettings.getInstance().getSettings().linearDepthTexture }, // Linear depth
    ];
  }

  private createPartialGBufferTargets(): GPUColorTargetState[] {
    // Get current G-Buffer texture formats for partial G-Buffer

    return [
      { format: QualitySettings.getInstance().getSettings().albedoTexture }, // Albedo + metallic
      { format: QualitySettings.getInstance().getSettings().normalTexture }, // Normal + roughness + emissive
    ];
  }

  private createTextureTarget(): GPUColorTargetState[] {
    return [
      {
        format: QualitySettings.getInstance().getSettings().hdrTexture,
        blend: this.getBlendState(),
      },
    ];
  }

  private createSingleChannelTarget(): GPUColorTargetState[] {
    return [{ format: QualitySettings.getInstance().getSettings().aoTexture }];
  }

  private createScreenTarget(): GPUColorTargetState[] {
    return [
      {
        format: Render.getInstance().getFormat(),
        blend: PipelineFactory.getOpaqueBlending(),
      },
    ];
  }

  // ============================================================================
  // BLEND STATE CONFIGURATION METHODS
  // ============================================================================

  private getBlendState(): GPUBlendState {
    switch (this.blendMode) {
      case BlendModes.ADDITIVE_BY_SRC_ALPHA:
        return PipelineFactory.getAdditiveBlending();
      case BlendModes.ADDITIVE:
        return PipelineFactory.getPureAdditiveBlending();
      case BlendModes.COMBINATIVE_GBUFFER:
        return PipelineFactory.getAlphaBlending();
      case BlendModes.COMBINATIVE:
        return PipelineFactory.getAlphaBlending();
      case BlendModes.VOLUMETRIC:
        return PipelineFactory.getVolumetricBlending();
      default:
        return PipelineFactory.getOpaqueBlending();
    }
  }

  // ============================================================================
  // DEPTH CONFIGURATION METHODS
  // ============================================================================

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
      case DepthModes.INVERSE_TEST_NO_WRITE: {
        return {
          depthWriteEnabled: false,
          depthCompare: 'greater',
          format: 'depth32float',
        };
      }
      case DepthModes.DEFAULT: {
        return {
          format: 'depth32float',
          depthWriteEnabled: true,
          depthCompare: 'less',
          depthBias: 0, // Sin bias para rendering normal
          depthBiasSlopeScale: 0,
          depthBiasClamp: 0,
        };
      }
      case DepthModes.SHADOWS: {
        return {
          format: 'depth32float',
          depthWriteEnabled: true,
          depthCompare: 'less',
          // Moderate bias for standard back-face culling
          depthBias: 0.0, // Constant offset to prevent acne on flat surfaces
          depthBiasSlopeScale: 2.0, // Increased for steep angles (perpendicular surfaces)
          depthBiasClamp: 0.005, // Maximum bias limit to prevent peter panning
        };
      }
      case DepthModes.ALWAYS: {
        return {
          format: 'depth32float',
          depthWriteEnabled: true,
          depthCompare: 'always',
        };
      }
      case DepthModes.LESS_EQUAL_NO_WRITE: {
        return {
          format: 'depth32float',
          depthWriteEnabled: false,
          depthCompare: 'less-equal',
        };
      }
      case DepthModes.TEST_EQUAL_NO_WRITE: {
        return {
          format: 'depth32float',
          depthWriteEnabled: false,
          depthCompare: 'equal',
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
    if (!this.pipelineLayouts || idx < 0 || idx >= this.pipelineLayouts.length) {
      return undefined;
    }
    return this.pipelineLayouts[idx];
  }
}
