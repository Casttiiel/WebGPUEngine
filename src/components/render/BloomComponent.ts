import { QualitySettings } from '../../core/engine/QualitySettings';
import { Render } from '../../renderer/core/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { BlurComponent } from './BlurComponent';

export class BloomComponent extends BlurComponent {
  private technique!: Technique;
  // TODO: Uncomment when implementing full bloom combination
  // private combineTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private bindGroup!: GPUBindGroup | null;
  // private combineBindGroup!: GPUBindGroup | null;
  private result!: RenderTarget;
  private finalResult!: RenderTarget;
  private renderPassManager!: RenderPassManager;

  // Bloom parameters
  private bloomIntensity: number = 1.0;
  private bloomThreshold: number = 1.0;
  private bloomKnee: number = 0.5;
  private bloomRadius: number = 1.0;
  private uniformBuffer!: GPUBuffer;

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }

  public override async load(): Promise<void> {
    // Load parent blur component first
    await super.load();

    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
    this.technique = await Technique.get('bloom_filter.tech');
    // TODO: Load combine technique when shader system supports it
    // this.combineTechnique = await Technique.get('bloom_combine.tech');

    const qualitySettings = QualitySettings.getInstance();
    const bloomFormat = qualitySettings.getPostProcessingFormats().bloomTexture;

    this.result = new RenderTarget();
    this.result.createRT('bloom_filter_result.dds', Render.width, Render.height, bloomFormat);

    this.finalResult = new RenderTarget();
    this.finalResult.createRT('bloom_final_result.dds', Render.width, Render.height, bloomFormat);

    // Create uniform buffer for bloom parameters
    this.uniformBuffer = GPUUtils.createBuffer(
      'bloom_params_buffer',
      16, // 4 floats * 4 bytes
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.updateBloomParams();
  }

  public override resize(): void {
    // Call parent resize
    super.resize();

    const qualitySettings = QualitySettings.getInstance();
    const bloomFormat = qualitySettings.getPostProcessingFormats().bloomTexture;

    this.result.createRT('bloom_filter_result.dds', Render.width, Render.height, bloomFormat);
    this.finalResult.createRT('bloom_final_result.dds', Render.width, Render.height, bloomFormat);
    this.bindGroup = null;
    // this.combineBindGroup = null; // TODO: Uncomment when implementing combination
  }

  private updateBloomParams(): void {
    const params = new Float32Array([
      this.bloomIntensity,
      this.bloomThreshold,
      this.bloomKnee,
      this.bloomRadius,
    ]);
    GPUUtils.writeBuffer(this.uniformBuffer, 0, params);
  }

  public generateHighlights(
    gBufferBindGroup: GPUBindGroup,
    texture: GPUTextureView,
  ): GPUTextureView {
    this.setBindGroup(texture);

    // Use RenderPassManager to execute bloom filter pass dynamically
    this.renderPassManager.executeBloomFilteringPass(
      this.fullscreenQuadMesh,
      this.technique,
      gBufferBindGroup,
      this.bindGroup!,
      this.result,
    );

    const highlightsResult = this.result.getView();

    // Apply multiscaling blur to the highlights
    const blurredHighlights = this.applyMultiscaleBlur(highlightsResult);

    return blurredHighlights;
  }

  public addBloom(_originalTexture: GPUTextureView, bloomTexture: GPUTextureView): GPUTextureView {
    // For now, just return the bloom texture (highlights with blur applied)
    // TODO: Implement proper combination when shader system supports multiple bind groups
    return bloomTexture;
  }

  private setBindGroup(texture: GPUTextureView): void {
    if (this.bindGroup) return;

    const sampler = GPUUtils.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    this.bindGroup = BindGroupFactory.createBindGroup(
      `bloom_bindgroup`,
      this.technique.getPipeline().getBindGroupLayout(2),
      [
        {
          binding: 0,
          resource: texture,
        },
        {
          binding: 1,
          resource: sampler,
        },
      ],
    );
  }

  // TODO: Uncomment when implementing full bloom combination
  /*
  private setCombineBindGroup(originalTexture: GPUTextureView, _bloomTexture: GPUTextureView): void {
    if (this.combineBindGroup) return;

    const sampler = GPUUtils.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    // Create bind groups for original texture (we'll create others when needed)
    this.combineBindGroup = BindGroupFactory.createBindGroup(
      `bloom_original_bindgroup`,
      this.combineTechnique.getPipeline().getBindGroupLayout(1),
      [
        { binding: 0, resource: originalTexture },
        { binding: 1, resource: sampler },
      ],
    );

    // TODO: Store bloom and params bind groups when render pass system supports multiple bind groups
  }
  */

  // Getters for bloom parameters (for UI/debug)
  public getBloomIntensity(): number {
    return this.bloomIntensity;
  }
  public setBloomIntensity(value: number): void {
    this.bloomIntensity = value;
    this.updateBloomParams();
  }

  public getBloomThreshold(): number {
    return this.bloomThreshold;
  }
  public setBloomThreshold(value: number): void {
    this.bloomThreshold = value;
    this.updateBloomParams();
  }

  // Additional bloom parameter controls
  public getBloomRadius(): number {
    return this.bloomRadius;
  }
  public setBloomRadius(value: number): void {
    this.bloomRadius = Math.max(0.1, Math.min(5.0, value));
    this.updateBloomParams();
  }

  public getBloomKnee(): number {
    return this.bloomKnee;
  }
  public setBloomKnee(value: number): void {
    this.bloomKnee = Math.max(0.0, Math.min(1.0, value));
    this.updateBloomParams();
  }

  // Inherit blur parameter controls from parent
  public override setMaxBlurSteps(steps: number): void {
    super.setMaxBlurSteps(steps);
  }

  public override setBlurStrength(strength: number): void {
    super.setBlurStrength(strength);
  }

  public override setBlendIntensity(intensity: number): void {
    super.setBlendIntensity(intensity);
  }

  public override update(_dt: number): void {
    // Update bloom parameters if needed
  }

  public override debugInMenu(): void {
    // Implement debug menu for bloom parameters
  }

  public override renderDebug(): void {
    // Implement debug rendering if needed
  }

  public override dispose(): void {
    super.dispose();

    if (this.result) {
      this.result.destroy();
    }
    if (this.finalResult) {
      this.finalResult.destroy();
    }
    if (this.uniformBuffer) {
      this.uniformBuffer.destroy();
    }
  }
}
