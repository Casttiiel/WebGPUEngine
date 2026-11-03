import { ResourceManager } from '../../core/engine/ResourceManager';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { PipelineFactory } from '../core/factories/PipelineFactory';
import { GPUUtils } from '../core/utils/GPUUtils';

/** À-trous tap spacing of each denoise iteration (texels). */
const DENOISE_STEPS = [1, 2];

/**
 * Per-pixel final gather (docs/realtime-gi-plan.md, phase 4): one short cosine ray per texel of
 * the GI resolve, radiance from the radiance cache or, past its range, the probes
 * (gi/gi_gather.cs); then an edge-aware à-trous denoise (gi/gi_gather_denoise.cs). The result
 * replaces the probe lookup in gi_resolve.cs, which accumulates it over time.
 * Textures match the resolve size: A holds the raw gather and, after the two iterations
 * (A → B → A), the denoised result the resolve reads.
 */
export class GIFinalGather {
  private outLayout: GPUBindGroupLayout;
  private denoiseLayout: GPUBindGroupLayout;
  private gatherPipeline: GPUComputePipeline | null = null;
  private denoisePipeline: GPUComputePipeline | null = null;
  private stepBuffers: GPUBuffer[];

  private textures: GPUTexture[] = [];
  private views: GPUTextureView[] = [];
  /**
   * Edge-stopping guide per texel (xyz = source pixel's normal, w = its linear depth), written by
   * the gather so the denoise taps read one compact texel instead of two scattered G-buffer
   * loads + an octahedral decode each (same values: the G-buffer is r16float / rgba16float).
   */
  private guide: GPUTexture | null = null;
  private outBindGroup: GPUBindGroup | null = null;
  private denoiseBindGroups: GPUBindGroup[] = [];

  constructor() {
    const C = GPUShaderStage.COMPUTE;
    this.outLayout = BindGroupFactory.getLayout('gi_gather_out_layout', [
      {
        binding: 0,
        visibility: C,
        storageTexture: { access: 'write-only', format: 'rgba16float' },
      },
      { binding: 1, visibility: C, storageTexture: { access: 'write-only', format: 'rgba32float' } },
    ]);
    this.denoiseLayout = BindGroupFactory.getLayout('gi_gather_denoise_layout', [
      { binding: 0, visibility: C, texture: { sampleType: 'unfilterable-float' } },
      {
        binding: 1,
        visibility: C,
        storageTexture: { access: 'write-only', format: 'rgba16float' },
      },
      { binding: 2, visibility: C, buffer: { type: 'uniform' } },
      { binding: 3, visibility: C, texture: { sampleType: 'unfilterable-float' } },
    ]);
    this.stepBuffers = DENOISE_STEPS.map((step) =>
      GPUUtils.createBuffer(
        'gi_gather_step',
        16,
        GPUBufferUsage.UNIFORM,
        new Uint32Array([step, 0, 0, 0]),
      ),
    );
  }

  public async load(
    frameLayout: GPUBindGroupLayout,
    sceneLayout: GPUBindGroupLayout,
  ): Promise<void> {
    const device = GPUUtils.getDevice();
    const gbuffer = BindGroupFactory.getGBufferComputeLayout();
    const [gatherCode, denoiseCode] = await Promise.all([
      ResourceManager.loadShader('gi/gi_gather.cs'),
      ResourceManager.loadShader('gi/gi_gather_denoise.cs'),
    ]);
    [this.gatherPipeline, this.denoisePipeline] = await Promise.all([
      device.createComputePipelineAsync({
        label: 'gi_gather',
        layout: PipelineFactory.createPipelineLayout('gi_gather_pl', [
          frameLayout,
          sceneLayout,
          gbuffer,
          this.outLayout,
        ]),
        compute: {
          module: device.createShaderModule({ label: 'gi_gather', code: gatherCode }),
          entryPoint: 'cs',
        },
      }),
      device.createComputePipelineAsync({
        label: 'gi_gather_denoise',
        layout: PipelineFactory.createPipelineLayout('gi_gather_denoise_pl', [
          gbuffer,
          this.denoiseLayout,
        ]),
        compute: {
          module: device.createShaderModule({ label: 'gi_gather_denoise', code: denoiseCode }),
          entryPoint: 'cs',
        },
      }),
    ]);
  }

  /** The denoised gather (what gi_resolve.cs reads), sized to the resolve. */
  public getResultView(width: number, height: number): GPUTextureView {
    const current = this.textures[0];
    if (!current || current.width !== width || current.height !== height)
      this.createTextures(width, height);
    return this.views[0]!;
  }

  private createTextures(width: number, height: number): void {
    this.destroyTextures();
    const device = GPUUtils.getDevice();
    for (let i = 0; i < 2; i++) {
      const texture = device.createTexture({
        label: `gi_gather_${i}`,
        size: { width, height },
        format: 'rgba16float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.textures.push(texture);
      this.views.push(texture.createView());
    }
    this.guide = device.createTexture({
      label: 'gi_gather_guide',
      size: { width, height },
      format: 'rgba32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    const guideView = this.guide.createView();
    this.outBindGroup = BindGroupFactory.createBindGroup('gi_gather_out_bg', this.outLayout, [
      { binding: 0, resource: this.views[0]! },
      { binding: 1, resource: guideView },
    ]);
    // Iteration i reads views[i % 2] and writes the other one.
    this.denoiseBindGroups = DENOISE_STEPS.map((_, i) =>
      BindGroupFactory.createBindGroup(`gi_gather_denoise_bg_${i}`, this.denoiseLayout, [
        { binding: 0, resource: this.views[i % 2]! },
        { binding: 1, resource: this.views[(i + 1) % 2]! },
        { binding: 2, resource: { buffer: this.stepBuffers[i]! } },
        { binding: 3, resource: guideView },
      ]),
    );
  }

  /** Gather + denoise into the result view (getResultView must have sized the textures). */
  public dispatch(
    frameBindGroup: GPUBindGroup,
    sceneBindGroup: GPUBindGroup,
    gBufferComputeBindGroup: GPUBindGroup,
    run: (label: string, fn: (pass: GPUComputePassEncoder) => void) => void,
  ): void {
    if (!this.gatherPipeline || !this.denoisePipeline || !this.outBindGroup) return;
    const width = this.textures[0]!.width;
    const height = this.textures[0]!.height;
    const groups = [Math.ceil(width / 8), Math.ceil(height / 8)] as const;
    run('GI Gather', (pass) => {
      pass.setPipeline(this.gatherPipeline!);
      pass.setBindGroup(0, frameBindGroup);
      pass.setBindGroup(1, sceneBindGroup);
      pass.setBindGroup(2, gBufferComputeBindGroup);
      pass.setBindGroup(3, this.outBindGroup!);
      pass.dispatchWorkgroups(...groups);
    });
    run('GI Gather Denoise', (pass) => {
      pass.setPipeline(this.denoisePipeline!);
      pass.setBindGroup(0, gBufferComputeBindGroup);
      for (const bindGroup of this.denoiseBindGroups) {
        pass.setBindGroup(1, bindGroup);
        pass.dispatchWorkgroups(...groups);
      }
    });
  }

  private destroyTextures(): void {
    this.textures.forEach((t) => t.destroy());
    this.textures = [];
    this.guide?.destroy();
    this.guide = null;
    this.views = [];
    this.outBindGroup = null;
    this.denoiseBindGroups = [];
  }

  public destroy(): void {
    this.destroyTextures();
    this.stepBuffers.forEach((b) => b.destroy());
  }
}
