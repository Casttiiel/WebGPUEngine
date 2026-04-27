import { QualitySettings } from '../../core/engine/QualitySettings';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { BloomCombineRenderPass } from '../../renderer/core/passes/PostProcessingRenderPasses';
import { RenderPassFactory } from '../../renderer/core/passes/RenderPassFactory';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { Render } from '../../renderer/core/pipeline/Render';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Texture } from '../../renderer/resources/Texture';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { BlurKawaseComponent } from './BlurKawaseComponent';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';

export class BloomComponent extends BlurKawaseComponent {
  private whiteTexture!: Texture;
  private technique!: Technique;
  private combineTechnique!: Technique;
  private result!: RenderTarget;
  private renderPassManager!: RenderPassManager;

  // Bloom filter parameters (controlables desde Tweakpane)
  private thresholdMin: number = 12.0; // Más alto para evitar specular común
  private thresholdMax: number = 0.7; // Threshold más alto para HDR
  private emissiveFactor: number = 2.0;

  // Additional bind groups for bloom combine operation
  private inputTextureBindGroup!: GPUBindGroup | null;

  private bloomCombineParamsBuffer!: GPUBuffer; // Buffer específico para parámetros del combine
  private bloomCombineParamsBindGroup!: GPUBindGroup | null;
  private bloomFiltersParamsBuffer!: GPUBuffer; // Buffer específico para parámetros del filter
  private bloomFilterParamsBindGroup!: GPUBindGroup | null;

  private bloomTexturesBindGroup!: GPUBindGroup | null;

  private inputTextureCache: Map<GPUTextureView, GPUBindGroup> = new Map();

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }

  public override async load(): Promise<void> {
    // Load parent blur component first
    await super.load();

    this.whiteTexture = await Texture.getAsync('white.png');
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.technique = await Technique.getAsync('post-processing/bloom_filter.tech');
    this.combineTechnique = await Technique.getAsync('post-processing/bloom_combine_simple.tech');

    const qualitySettings = QualitySettings.getInstance();
    const bloomFormat = qualitySettings.getSettings().bloomTexture;

    this.result = new RenderTarget();
    this.result.createRT('bloom_filter_result.dds', Render.width, Render.height, bloomFormat);

    // Create uniform buffer specifically for bloom filter parameters
    this.bloomFiltersParamsBuffer = GPUUtils.createBuffer(
      'bloom_filter_params_buffer',
      16, // 4 floats * 4 bytes (threshold_min, threshold_max, emissive_factor, padding)
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Create uniform buffer specifically for bloom combine parameters
    this.bloomCombineParamsBuffer = GPUUtils.createBuffer(
      'bloom_combine_params_buffer',
      16, // 4 floats * 4 bytes (threshold_min, threshold_max, emissive_factor, padding)
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.updateBloomFilterParams();
    this.updateBloomCombineParams();
  }

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.RESIZE, 'bloom', (comp) => {
      const c = comp as BloomComponent;
      if (c.hasLoaded()) c.resize();
    });
  }

  public override resize(): void {
    super.resize();

    const qualitySettings = QualitySettings.getInstance();
    const bloomFormat = qualitySettings.getSettings().bloomTexture;

    this.result.createRT('bloom_filter_result.dds', Render.width, Render.height, bloomFormat);

    // ✅ Clear caches on resize (textures recreated)
    this.inputTextureCache.clear();
    this.inputTextureBindGroup = null;
    this.bloomCombineParamsBindGroup = null;
    this.bloomTexturesBindGroup = null;
  }

  private updateBloomFilterParams(): void {
    // Update bloom filter parameters buffer
    const paramsData = new Float32Array([
      this.thresholdMin,
      this.thresholdMax,
      this.emissiveFactor,
      0.0, // padding
    ]);

    GPUUtils.writeBuffer(this.bloomFiltersParamsBuffer, 0, paramsData);
  }

  private updateBloomCombineParams(): void {
    // Update bloom combine parameters buffer
    const paramsData = new Float32Array([1.0]);

    GPUUtils.writeBuffer(this.bloomCombineParamsBuffer, 0, paramsData);
  }

  public generateHighlights(
    gBufferBindGroup: GPUBindGroup,
    inputTexture: GPUTextureView,
  ): GPUTextureView {
    this.setInputTextureBindGroup(inputTexture);
    this.createBloomFilterParamsBindGroup();

    // Use RenderPassManager to execute bloom filter pass with parameters
    this.renderPassManager.executeBloomFilteringPass(
      this.fullscreenQuadMesh,
      this.technique,
      gBufferBindGroup,
      this.inputTextureBindGroup!,
      this.result,
      this.bloomFilterParamsBindGroup!,
    );

    const highlightsResult = this.result.getView();
    return this.applyBlur(highlightsResult);
  }

  public apply(inputTexture: GPUTextureView, gBufferBindGroup: GPUBindGroup): GPUTextureView {
    // Generate bloom highlights from input texture using G-Buffer data
    const bloomTexture = this.generateHighlights(gBufferBindGroup, inputTexture);

    // Add bloom to original texture
    this.addBloom(inputTexture, bloomTexture);

    // Return the original texture (bloom is applied directly to it)
    return inputTexture;
  }

  public hasLoaded(): boolean {
    return (
      this.technique !== undefined &&
      this.combineTechnique !== undefined &&
      this.whiteTexture !== undefined &&
      this.fullscreenQuadMesh !== undefined &&
      this.result !== undefined
    );
  }

  public addBloom(originalTexture: GPUTextureView, bloomTexture: GPUTextureView): void {
    // Create bind groups for the combine operation
    this.setupCombineBindGroups(bloomTexture);

    // Use the RenderPassFactory to create a post-process pass config
    const passConfig = RenderPassFactory.createBloomCombinePassConfig(originalTexture);

    // Create a bloom combine render pass
    const pass = new BloomCombineRenderPass(
      passConfig,
      this.fullscreenQuadMesh,
      this.combineTechnique,
      this.bloomCombineParamsBindGroup!,
      this.bloomTexturesBindGroup!,
    );

    // Execute the custom pass directly using RenderPassManager
    this.renderPassManager.executeDynamicPass(pass);
  }

  private createBloomFilterParamsBindGroup(): void {
    if (this.bloomFilterParamsBindGroup) return;

    this.bloomFilterParamsBindGroup = BindGroupFactory.createBindGroup(
      'bloom_filter_params_bindgroup',
      BindGroupFactory.getBufferUniformLayout(),
      [
        {
          binding: 0,
          resource: {
            buffer: this.bloomFiltersParamsBuffer,
          },
        },
      ],
    );
  }

  private setupCombineBindGroups(bloomTexture: GPUTextureView): void {
    // ✅ Skip if already created
    if (this.bloomCombineParamsBindGroup && this.bloomTexturesBindGroup) return;

    this.bloomCombineParamsBindGroup = BindGroupFactory.createBindGroup(
      `bloom_combine_params_bindgroup`,
      this.combineTechnique.getPipeline().getBindGroupLayout(0),
      [
        {
          binding: 0,
          resource: {
            buffer: this.bloomCombineParamsBuffer,
          },
        },
      ],
    );

    const bindGroupData = [
      {
        binding: 0,
        resource: bloomTexture,
      },
      { binding: 1, resource: SamplerLibrary.bloom },
    ];

    this.bloomTexturesBindGroup = BindGroupFactory.createBindGroup(
      `bloom_textures_bindgroup`,
      this.combineTechnique.getPipeline().getBindGroupLayout(1),
      bindGroupData,
    );
  }

  /**
   * ✅ Get or create cached input texture bind group
   */
  private setInputTextureBindGroup(texture: GPUTextureView): void {
    // Check cache first
    let cached = this.inputTextureCache.get(texture);
    if (!cached) {
      cached = BindGroupFactory.createBindGroup(
        `bloom_input_texture_cached`,
        this.technique.getPipeline().getBindGroupLayout(2),
        [
          {
            binding: 0,
            resource: texture,
          },
          {
            binding: 1,
            resource: SamplerLibrary.simpleSampler,
          },
        ],
      );
      this.inputTextureCache.set(texture, cached);
    }
    this.inputTextureBindGroup = cached;
  }

  public override update(_dt: number): void {
    // Update bloom parameters if needed
  }

  public debugInMenu(): void {
    // Implement debug menu for bloom parameters
  }

  public override renderInMenu(): void {
    // Implement render menu for bloom parameters
  }

  public override renderDebug(): void {
    // Implement debug rendering if needed
  }

  public override dispose(): void {
    super.dispose();

    if (this.result) {
      this.result.destroy();
    }
  }
}
