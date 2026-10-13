import { mat4 } from 'gl-matrix';
import { Logger } from '../../core/debug/Logger';
import { Engine } from '../../core/engine/Engine';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { PipelineFactory, ComputePipelineConfig } from '../core/factories/PipelineFactory';
import { Render } from '../core/pipeline/Render';
import { GPUUtils } from '../core/utils/GPUUtils';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { RenderTarget } from '../resources/RenderTarget';
import { Texture } from '../resources/Texture';
import { GPUProfiler } from '../../core/debug/GPUProfiler';
import type { AmbientLight } from './AmbientLight';

// Must match SSRTraceParams in ssr_common.wgsl: 4 × mat4 + 28 × f32
const TRACE_PARAMS_FLOATS = 4 * 16 + 32;
// Same max prefiltered mip as ambient_specular.fs
const ENV_MAX_MIP = 7;

/**
 * Stochastic screen-space reflections, ported from three.js webgpu_postprocessing_ssr_denoise
 * (SSRNode stochastic + TemporalReprojectNode + RecurrentDenoiseNode).
 *
 * Pipeline (all compute, SSR resolution = render resolution × ssrScale):
 *   1. ssr.cs          — one GGX ray per pixel → raw radiance + ray length,
 *                        multi-bounce from last frame's denoised result
 *   2. ssr_temporal.cs — surface + hit-point reprojection of the history, variance clipping
 *   3. ssr_denoise.cs  — REBLUR-style spatial filter + Karis temporal blend
 *   4. copies          — denoised result / depth / normals become next frame's history
 *
 * Misses and screen-edge fades resolve to the same prefiltered environment as the IBL
 * (global env + PCC probes), so ambient_specular.fs uses the SSR result as the full
 * specular radiance whenever SSR is enabled.
 */
export class ScreenSpaceReflections {
  private isInitialized = false;
  private _editorFolder: any = null;

  // ── Pipelines / layouts ────────────────────────────────────────────────────
  private tracePipeline: GPUComputePipeline | null = null;
  private temporalPipeline: GPUComputePipeline | null = null;
  private denoisePipeline: GPUComputePipeline | null = null;
  private traceInputLayout!: GPUBindGroupLayout;
  private temporalInputLayout!: GPUBindGroupLayout;
  private denoiseInputLayout!: GPUBindGroupLayout;
  private outputLayout!: GPUBindGroupLayout;

  // ── Render targets (SSR resolution) ────────────────────────────────────────
  /** Raw stochastic trace: rgb = radiance, a = ray length */
  private ssrRaw!: RenderTarget;
  /** Reprojected + clipped history: rgb = radiance, a = 1 / frames */
  private ssrReprojected!: RenderTarget;
  /** Denoised result: rgb = radiance, a = 1 / frames. Read by ambient_specular. */
  /**
   * Ping-pong pair for the denoised result: frame N writes ssrTargets[parity] (read by
   * ambient_specular) and reads ssrTargets[1 - parity] as history (temporal + multi-bounce).
   * Swapping replaces a full-target copy per frame.
   */
  private ssrTargets: [RenderTarget, RenderTarget] = [new RenderTarget(), new RenderTarget()];
  private parity = 0;
  // Previous frame's G-buffer (render resolution), for history confidence
  private prevLinearDepth!: RenderTarget;
  private prevNormals!: RenderTarget;
  private width = 0;
  private height = 0;

  // ── Bind groups (lazily rebuilt) ───────────────────────────────────────────
  private cameraComputeBindGroup: GPUBindGroup | null = null;
  private lastCameraBuffer: GPUBuffer | null = null;
  // Bind groups that reference the ping-pong pair are cached per parity
  private traceInputBindGroups: [GPUBindGroup | null, GPUBindGroup | null] = [null, null];
  private traceInputKeys: [GPUTextureView[], GPUTextureView[]] = [[], []];
  private temporalInputBindGroups: [GPUBindGroup | null, GPUBindGroup | null] = [null, null];
  private denoiseInputBindGroup: GPUBindGroup | null = null;
  private rawOutputBindGroup: GPUBindGroup | null = null;
  private reprojectedOutputBindGroup: GPUBindGroup | null = null;
  private accumOutputBindGroups: [GPUBindGroup | null, GPUBindGroup | null] = [null, null];

  // ── Buffers ─────────────────────────────────────────────────────────────────
  private traceParamsBuffer!: GPUBuffer;
  private traceParamsData = new Float32Array(TRACE_PARAMS_FLOATS);
  private brdfLUT!: Texture;

  // ── Temporal state ──────────────────────────────────────────────────────────
  private noiseIndex = 0;
  private historyValid = false;
  private prevView = mat4.create();
  private prevProjection = mat4.create();
  private prevInvProjection = mat4.create();
  private prevInvView = mat4.create();

  // ── Tunables (three.js example defaults; distances rescaled from its 0.1-scale
  //    dungeon to this engine's metre-scale scenes) ─────────────────────────────
  private params = {
    enabled: true,
    // SSR
    quality: 0.5,
    mirrorBias: 0.5,
    maxDistance: 10,
    intensity: 1,
    thickness: 0.15,
    maxLuminance: 35,
    stepExponent: 3,
    screenEdgeFade: 0.2,
    // Temporal reprojection
    maxFrames: 16,
    clampIntensity: 0.25,
    flickerSuppression: 1,
    hitPointReprojection: true,
    multiBounce: true,
    // Recurrent denoise
    denoiseEnabled: true,
    lumaPhi: 0.75,
    depthPhi: 20,
    normalPhi: 0.3,
    roughnessPhi: 100,
    denoiseRadius: 1.5,
    alphaPhi: 5,
    strength: 0.725,
    adapt: 0.5,
    smoothDisocclusions: true,
    adaptiveTrust: 1,
  };

  constructor() {}

  public async load(): Promise<void> {
    try {
      this.brdfLUT = await Texture.getAsync('brdfLUT.png');

      this.traceParamsBuffer = GPUUtils.createBuffer(
        'ssr trace params',
        TRACE_PARAMS_FLOATS * 4,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );

      this.createRenderTargets();
      this.createLayouts();
      await this.createPipelines();

      this.isInitialized = true;
      Logger.info('RENDER', 'SSR ready');
    } catch (error) {
      console.warn('Failed to load SSR, disabling feature:', error);
      this.isInitialized = false;
    }
  }

  // ─── Setup ──────────────────────────────────────────────────────────────────

  private createRenderTargets(): void {
    const qs = QualitySettings.getInstance().getSettings();
    this.width = Math.max(1, Math.floor(Render.width * qs.ssrScale));
    this.height = Math.max(1, Math.floor(Render.height * qs.ssrScale));
    const fmt: GPUTextureFormat = 'rgba16float';

    this.ssrRaw ??= new RenderTarget();
    this.ssrReprojected ??= new RenderTarget();
    this.prevLinearDepth ??= new RenderTarget();
    this.prevNormals ??= new RenderTarget();

    const storage = GPUTextureUsage.STORAGE_BINDING;
    this.ssrRaw.createRT('ssr_raw', this.width, this.height, fmt, storage);
    this.ssrReprojected.createRT('ssr_reprojected', this.width, this.height, fmt, storage);
    this.ssrTargets.forEach((rt, i) => rt.createRT(`ssr_accum_${i}`, this.width, this.height, fmt, storage));
    this.prevLinearDepth.createRT(
      'ssr_prev_linear_depth',
      Render.width,
      Render.height,
      qs.linearDepthTexture,
      GPUTextureUsage.COPY_DST,
    );
    this.prevNormals.createRT(
      'ssr_prev_normals',
      Render.width,
      Render.height,
      qs.normalTexture,
      GPUTextureUsage.COPY_DST,
    );

    this.traceInputBindGroups = [null, null];
    this.traceInputKeys = [[], []];
    this.temporalInputBindGroups = [null, null];
    this.denoiseInputBindGroup = null;
    this.rawOutputBindGroup = null;
    this.reprojectedOutputBindGroup = null;
    this.accumOutputBindGroups = [null, null];
    this.historyValid = false;
  }

  private createLayouts(): void {
    const C = GPUShaderStage.COMPUTE;
    this.traceInputLayout = BindGroupFactory.getLayout('ssr_trace_inputs', [
      { binding: 0, visibility: C, texture: { sampleType: 'float' } }, // accLight
      { binding: 1, visibility: C, buffer: { type: 'uniform' } }, // SSRTraceParams
      { binding: 2, visibility: C, texture: { sampleType: 'float', viewDimension: 'cube' } },
      { binding: 3, visibility: C, texture: { sampleType: 'float', viewDimension: 'cube' } },
      { binding: 4, visibility: C, texture: { sampleType: 'float', viewDimension: 'cube' } },
      { binding: 5, visibility: C, sampler: { type: 'filtering' } },
      { binding: 6, visibility: C, buffer: { type: 'uniform' } }, // PCC data
      { binding: 7, visibility: C, texture: { sampleType: 'float' } }, // history (multi-bounce)
      { binding: 8, visibility: C, texture: { sampleType: 'float' } }, // BRDF LUT
      { binding: 9, visibility: C, sampler: { type: 'filtering' } },
    ]);
    this.temporalInputLayout = BindGroupFactory.getLayout('ssr_temporal_inputs', [
      { binding: 0, visibility: C, texture: { sampleType: 'float' } }, // ssrRaw
      { binding: 1, visibility: C, buffer: { type: 'uniform' } }, // SSRTraceParams
      { binding: 2, visibility: C, texture: { sampleType: 'float' } }, // history
      { binding: 3, visibility: C, texture: { sampleType: 'float' } }, // prev linear depth
      { binding: 4, visibility: C, texture: { sampleType: 'float' } }, // prev normals
    ]);
    this.denoiseInputLayout = BindGroupFactory.getLayout('ssr_denoise_inputs', [
      { binding: 0, visibility: C, texture: { sampleType: 'float' } }, // reprojected history
      { binding: 1, visibility: C, buffer: { type: 'uniform' } }, // SSRTraceParams
      { binding: 2, visibility: C, texture: { sampleType: 'float' } }, // ssrRaw
      { binding: 3, visibility: C, sampler: { type: 'filtering' } },
    ]);
    this.outputLayout = BindGroupFactory.getSSROutputLayout();
  }

  private async createPipelines(): Promise<void> {
    const device = GPUUtils.getDevice();
    const cameraLayout = BindGroupFactory.getCameraComputeLayout();
    const gbufferLayout = BindGroupFactory.getGBufferComputeLayout();

    const [traceCode, temporalCode, denoiseCode] = await Promise.all([
      ResourceManager.loadShader('post-processing/ssr.cs'),
      ResourceManager.loadShader('post-processing/ssr_temporal.cs'),
      ResourceManager.loadShader('post-processing/ssr_denoise.cs'),
    ]);

    const make = (label: string, code: string, inputs: GPUBindGroupLayout) => {
      const config: ComputePipelineConfig = {
        label,
        layout: PipelineFactory.createPipelineLayout(`${label}_layout`, [
          cameraLayout,
          gbufferLayout,
          inputs,
          this.outputLayout,
        ]),
        compute: { module: device.createShaderModule({ label, code }), entryPoint: 'cs' },
      };
      return PipelineFactory.createComputePipeline(config);
    };

    this.tracePipeline = make('ssr_trace', traceCode, this.traceInputLayout);
    this.temporalPipeline = make('ssr_temporal', temporalCode, this.temporalInputLayout);
    this.denoisePipeline = make('ssr_denoise', denoiseCode, this.denoiseInputLayout);
  }

  // ─── Per-frame ──────────────────────────────────────────────────────────────

  /** True when SSR runs this frame (ambient_specular then uses it instead of the IBL). */
  public isActive(): boolean {
    return (
      this.isInitialized &&
      this.params.enabled &&
      QualitySettings.getInstance().getSettings().ssrEnabled
    );
  }

  /**
   * Traces, reprojects and denoises SSR; returns the view read by ambient_specular.fs.
   * The returned view is stable between resizes (AmbientLight caches its bind group).
   */
  public generateSSR(
    accLights: GPUTextureView,
    gBufferComputeBindGroup: GPUBindGroup,
    gNormals: RenderTarget,
    gLinearDepth: RenderTarget,
    ambientLight: AmbientLight,
  ): GPUTextureView {
    if (
      !this.isActive() ||
      !this.tracePipeline ||
      !this.temporalPipeline ||
      !this.denoisePipeline
    ) {
      this.historyValid = false;
      return this.ssrTargets[this.parity]!.getView();
    }

    const camera = Engine.getRender().getMainCamera();
    const cameraBuffer = camera.getUniformBuffer();
    if (!cameraBuffer) return this.ssrTargets[this.parity]!.getView();
    const p = this.parity;
    const accum = this.ssrTargets[p]!;
    const history = this.ssrTargets[1 - p]!;
    if (!this.cameraComputeBindGroup || cameraBuffer !== this.lastCameraBuffer) {
      this.lastCameraBuffer = cameraBuffer;
      this.cameraComputeBindGroup = BindGroupFactory.createBindGroup(
        'ssr_camera_compute_bindgroup',
        BindGroupFactory.getCameraComputeLayout(),
        [{ binding: 0, resource: { buffer: cameraBuffer } }],
      );
    }

    this.writeTraceParams(camera.getNear());

    // Trace inputs depend on accLight and on which env/probe cubemaps are active
    const env = Engine.getEnvironmentManager().getSSREnvironmentTexture();
    const probes = ambientLight.getProbeEnvViews();
    const envView = env.getTextureView()!;
    const key = [accLights, envView, probes.envA, probes.envB];
    if (!this.traceInputBindGroups[p] || key.some((v, i) => v !== this.traceInputKeys[p]![i])) {
      this.traceInputKeys[p] = key;
      this.traceInputBindGroups[p] = BindGroupFactory.createBindGroup(
        `ssr_trace_inputs_bg_${p}`,
        this.traceInputLayout,
        [
          { binding: 0, resource: accLights },
          { binding: 1, resource: { buffer: this.traceParamsBuffer } },
          { binding: 2, resource: envView },
          { binding: 3, resource: probes.envA },
          { binding: 4, resource: probes.envB },
          { binding: 5, resource: env.getSampler()! },
          { binding: 6, resource: { buffer: ambientLight.getPCCSpecularBuffer() } },
          { binding: 7, resource: history.getView() },
          { binding: 8, resource: this.brdfLUT.getTextureView()! },
          { binding: 9, resource: SamplerLibrary.simpleSampler },
        ],
      );
    }
    this.temporalInputBindGroups[p] ??= BindGroupFactory.createBindGroup(
      `ssr_temporal_inputs_bg_${p}`,
      this.temporalInputLayout,
      [
        { binding: 0, resource: this.ssrRaw.getView() },
        { binding: 1, resource: { buffer: this.traceParamsBuffer } },
        { binding: 2, resource: history.getView() },
        { binding: 3, resource: this.prevLinearDepth.getView() },
        { binding: 4, resource: this.prevNormals.getView() },
      ],
    );
    this.denoiseInputBindGroup ??= BindGroupFactory.createBindGroup(
      'ssr_denoise_inputs_bg',
      this.denoiseInputLayout,
      [
        { binding: 0, resource: this.ssrReprojected.getView() },
        { binding: 1, resource: { buffer: this.traceParamsBuffer } },
        { binding: 2, resource: this.ssrRaw.getView() },
        { binding: 3, resource: SamplerLibrary.simpleSampler },
      ],
    );
    this.reprojectedOutputBindGroup ??= BindGroupFactory.createBindGroup(
      'ssr_reprojected_output_bg',
      this.outputLayout,
      [{ binding: 0, resource: this.ssrReprojected.getStorageView() }],
    );
    this.rawOutputBindGroup ??= BindGroupFactory.createBindGroup(
      'ssr_raw_output_bg',
      this.outputLayout,
      [{ binding: 0, resource: this.ssrRaw.getStorageView() }],
    );
    this.accumOutputBindGroups[p] ??= BindGroupFactory.createBindGroup(
      `ssr_accum_output_bg_${p}`,
      this.outputLayout,
      [{ binding: 0, resource: accum.getStorageView() }],
    );

    const encoder = Render.getInstance().getCommandEncoder();
    const wx = Math.ceil(this.width / 8);
    const wy = Math.ceil(this.height / 8);
    const profiler = GPUProfiler.getInstance();

    const dispatch = (
      label: string,
      pipeline: GPUComputePipeline,
      inputs: GPUBindGroup,
      output: GPUBindGroup,
    ) => {
      const ts = profiler.getTimestampWrites(label);
      const pass = encoder.beginComputePass({ label, ...(ts ? { timestampWrites: ts } : {}) });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.cameraComputeBindGroup!);
      pass.setBindGroup(1, gBufferComputeBindGroup);
      pass.setBindGroup(2, inputs);
      pass.setBindGroup(3, output);
      pass.dispatchWorkgroups(wx, wy, 1);
      pass.end();
    };

    dispatch('SSR Trace', this.tracePipeline, this.traceInputBindGroups[p]!, this.rawOutputBindGroup);
    dispatch(
      'SSR Temporal',
      this.temporalPipeline,
      this.temporalInputBindGroups[p]!,
      this.reprojectedOutputBindGroup,
    );
    dispatch(
      'SSR Denoise',
      this.denoisePipeline,
      this.denoiseInputBindGroup,
      this.accumOutputBindGroups[p]!,
    );

    // ── History for the next frame ─────────────────────────────────────────────
    // The denoised result becomes the history by swapping parity (no copy); depth and
    // normals still need a copy since the G-buffer is overwritten next frame.
    const copy = (src: RenderTarget, dst: RenderTarget) =>
      encoder.copyTextureToTexture(
        { texture: src.getTexture() },
        { texture: dst.getTexture() },
        { width: dst.getWidth(), height: dst.getHeight(), depthOrArrayLayers: 1 },
      );
    copy(gLinearDepth, this.prevLinearDepth);
    copy(gNormals, this.prevNormals);

    mat4.copy(this.prevView, camera.getView());
    mat4.copy(this.prevProjection, camera.getProjection());
    mat4.copy(this.prevInvProjection, camera.getInvProjectionMatrix());
    mat4.invert(this.prevInvView, this.prevView);
    this.historyValid = true;
    this.noiseIndex = (this.noiseIndex + 1) % 0x7fffffff;
    this.parity = 1 - p;

    return accum.getView();
  }

  private writeTraceParams(cameraNear: number): void {
    const d = this.traceParamsData;
    const p = this.params;
    d.set(this.prevView, 0);
    d.set(this.prevProjection, 16);
    d.set(this.prevInvProjection, 32);
    d.set(this.prevInvView, 48);
    let o = 64;
    d[o++] = p.quality;
    d[o++] = p.mirrorBias;
    d[o++] = p.maxDistance;
    d[o++] = p.thickness;
    d[o++] = p.intensity;
    d[o++] = p.maxLuminance;
    d[o++] = p.screenEdgeFade;
    d[o++] = p.stepExponent;
    d[o++] = this.noiseIndex;
    d[o++] = cameraNear;
    d[o++] = ENV_MAX_MIP;
    d[o++] = p.maxFrames;
    d[o++] = p.clampIntensity;
    d[o++] = p.flickerSuppression;
    d[o++] = p.hitPointReprojection ? 1 : 0;
    d[o++] = this.historyValid ? 1 : 0;
    d[o++] = p.lumaPhi;
    d[o++] = p.depthPhi;
    d[o++] = p.normalPhi;
    d[o++] = p.roughnessPhi;
    d[o++] = p.denoiseEnabled ? p.denoiseRadius : 0; // radius 0 = temporal only
    d[o++] = p.alphaPhi;
    d[o++] = p.strength;
    d[o++] = p.adapt;
    d[o++] = p.smoothDisocclusions ? 1 : 0;
    d[o++] = p.adaptiveTrust;
    d[o++] = p.multiBounce ? 1 : 0;
    const ambientData = Engine.getEnvironmentManager().getAmbientLightData();
    d[o++] = ambientData.reflectionFactor;
    d[o++] = ambientData.environmentIntensity;
    GPUUtils.writeBuffer(this.traceParamsBuffer, 0, d);
  }

  public getBRDFLUT(): Texture {
    return this.brdfLUT;
  }

  // ─── Editor ─────────────────────────────────────────────────────────────────

  public renderInMenu(folder?: any): void {
    if (!folder) return;
    if (this._editorFolder) return;
    this._editorFolder = folder.addFolder('SSR');
    this._editorFolder.close();

    const p = this.params;
    const f = this._editorFolder;
    f.add(p, 'enabled').name('Enabled').listen();
    f.add(p, 'quality', 0, 1).name('Quality').listen();
    f.add(p, 'mirrorBias', 0, 1).name('Mirror Bias').listen();
    f.add(p, 'maxDistance', 0.05, 50).name('Max Distance').listen();
    f.add(p, 'thickness', 0.001, 1).name('Thickness').listen();
    f.add(p, 'intensity', 0, 2).name('Intensity').listen();
    f.add(p, 'maxLuminance', 1, 100).name('Max Luminance').listen();
    f.add(p, 'stepExponent', 1, 5, 1).name('Step Exponent').listen();
    f.add(p, 'screenEdgeFade', 0, 0.5).name('Screen Edge Fade').listen();
    f.add(p, 'maxFrames', 1, 64, 1).name('Temporal Max Frames').listen();
    f.add(p, 'clampIntensity', 0, 1).name('Temporal Clamp').listen();
    f.add(p, 'flickerSuppression', 0, 2).name('Flicker Suppression').listen();
    f.add(p, 'hitPointReprojection').name('Hit-Point Reprojection').listen();
    f.add(p, 'multiBounce').name('Multi-Bounce').listen();
    f.add(p, 'denoiseEnabled').name('Denoise').listen();
    f.add(p, 'denoiseRadius', 0, 5).name('Denoise Radius').listen();
    f.add(p, 'lumaPhi', 0, 5).name('Denoise Luma Phi').listen();
    f.add(p, 'depthPhi', 0, 50).name('Denoise Depth Phi').listen();
    f.add(p, 'normalPhi', 0, 1).name('Denoise Normal Phi').listen();
    f.add(p, 'roughnessPhi', 0, 200).name('Denoise Roughness Phi').listen();
    f.add(p, 'alphaPhi', 0, 20).name('Denoise Hit Dist Phi').listen();
    f.add(p, 'strength', 0, 1).name('Denoise Strength').listen();
    f.add(p, 'adapt', 0, 1).name('Denoise Adapt').listen();
    f.add(p, 'smoothDisocclusions').name('Smooth Disocclusions').listen();
    f.add(p, 'adaptiveTrust', 0, 1).name('Adaptive Trust').listen();
  }

  /** Called on resize: recreates the targets and restarts the temporal history. */
  public dispose(): void {
    this.cameraComputeBindGroup = null;
    this.lastCameraBuffer = null;
    if (this.ssrRaw) {
      this.ssrRaw.destroy();
      this.ssrReprojected.destroy();
      this.ssrTargets.forEach((rt) => rt.destroy());
      this.prevLinearDepth.destroy();
      this.prevNormals.destroy();
    }
    this.createRenderTargets();
  }
}
