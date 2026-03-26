import { Component } from '../../core/ecs/Component';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';

// Uniform buffer layout (16 bytes):
//   offset  0: levels         (f32) — quantization levels per channel, default 5 → 5³=125 colors
//   offset  4: ditherStrength (f32) — 0=hard bands, 1=full Bayer dither
//   offset  8: enabled        (f32) — 0=pass-through, 1=active
//   offset 12: _pad           (f32)

export class PaletteQuantizeComponent extends Component {
  private loaded = false;
  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private result!: RenderTarget;
  private renderPassManager!: RenderPassManager;

  private uniformBuffer!: GPUBuffer;
  private paramsArray = new Float32Array(4);

  // Tweakable parameters
  public levels: number = 5; // 5³ = 125 ≈ 128 colors
  public ditherStrength: number = 1; // full Bayer dithering
  public override enabled: boolean = true;

  // Cache bind group per input texture view to avoid recreation every frame.
  // The uniform buffer reference is stable — only its contents change.
  private bindGroupCache: Map<GPUTextureView, GPUBindGroup> = new Map();

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.technique = await Technique.getAsync('post-processing/palette_quantize.tech');

    const format = QualitySettings.getInstance().getSettings().aliasingTexture as GPUTextureFormat;
    this.result = new RenderTarget();
    this.result.createRT('palette_quantize_result.dds', Render.width, Render.height, format);

    this.uniformBuffer = GPUUtils.createBuffer(
      'palette_quantize_uniform_buffer',
      16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.loaded = true;
  }

  public resize(): void {
    const format = QualitySettings.getInstance().getSettings().aliasingTexture as GPUTextureFormat;
    this.result.createRT('palette_quantize_result.dds', Render.width, Render.height, format);
    this.bindGroupCache.clear();
  }

  public apply(texture: GPUTextureView): GPUTextureView {
    this.updateUniformBuffer();

    const bindGroup = this.getOrCreateBindGroup(texture);
    this.renderPassManager.executeAntialiasingPass(
      this.fullscreenQuadMesh,
      this.technique,
      bindGroup,
      this.result,
      'Palette Quantize',
    );

    return this.result.getView();
  }

  private updateUniformBuffer(): void {
    this.paramsArray[0] = this.levels;
    this.paramsArray[1] = this.ditherStrength;
    this.paramsArray[2] = this.enabled ? 1.0 : 0.0;
    this.paramsArray[3] = 0.0;
    GPUUtils.writeBuffer(this.uniformBuffer, 0, this.paramsArray);
  }

  private getOrCreateBindGroup(texture: GPUTextureView): GPUBindGroup {
    let bg = this.bindGroupCache.get(texture);
    if (!bg) {
      bg = BindGroupFactory.createBindGroup(
        'palette_quantize_bindgroup',
        this.technique.getPipeline().getBindGroupLayout(1),
        [
          { binding: 0, resource: texture },
          { binding: 1, resource: SamplerLibrary.simpleSampler! },
          { binding: 2, resource: { buffer: this.uniformBuffer } },
        ],
      );
      this.bindGroupCache.set(texture, bg);
    }
    return bg;
  }

  public hasLoaded(): boolean {
    return this.loaded;
  }

  public override update(_dt: number): void {}
  public override renderDebug(): void {}

  public override dispose(): void {
    this.uniformBuffer?.destroy();
  }
}
