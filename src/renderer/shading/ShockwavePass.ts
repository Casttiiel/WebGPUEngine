import { Engine } from '../../core/engine/Engine';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { PipelineFactory, ComputePipelineConfig } from '../core/factories/PipelineFactory';
import { Render } from '../core/pipeline/Render';
import { GPUUtils } from '../core/utils/GPUUtils';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { RenderTarget } from '../resources/RenderTarget';

export interface ShockwaveConfig {
  /** Expansion speed in m/s. Default 15. */
  speed?: number;
  /** Maximum radius before the wave auto-expires. Default 25. */
  maxRadius?: number;
  /** Ring width in world units. Default 2.5. */
  thickness?: number;
  /** UV warp amplitude. Default 0.04. */
  intensity?: number;
  /** Depth-attenuation: exp(-linearDepth * falloff). Default 0.6. */
  falloff?: number;
}

interface ActiveWave {
  origin:    [number, number, number];
  radius:    number;
  speed:     number;
  maxRadius: number;
  thickness: number;
  intensity: number;
  falloff:   number;
}

const MAX_WAVES = 8;

// GPU UBO layout (bytes):
//   0-15 : count (u32) + 3 × u32 padding
//   16.. : 8 × ShockwaveSource (32 bytes each)
// ShockwaveSource:
//   +0  origin.xyz  (vec3<f32>, 12 bytes; struct align=16 → radius at +12)
//   +12 radius      f32
//   +16 thickness   f32
//   +20 intensity   f32
//   +24 falloff     f32
//   +28 _pad        f32
//   = 32 bytes per wave
const UBO_BYTES = 16 + MAX_WAVES * 32;

export class ShockwavePass {
  private pipeline:  GPUComputePipeline | null = null;
  private outputRT:  RenderTarget | null = null;

  // bind groups — lazily created / invalidated
  private inputBG:   GPUBindGroup | null = null;
  private outputBG:  GPUBindGroup | null = null;
  private wavesBG:   GPUBindGroup | null = null;
  private cameraBG:  GPUBindGroup | null = null;
  private lastAccLightView:  GPUTextureView | null = null;
  private lastDepthView:     GPUTextureView | null = null;
  private lastCameraBuffer:  GPUBuffer | null = null;

  // wave UBO
  private readonly wavesUBO:  GPUBuffer;
  private readonly uboBuffer: ArrayBuffer;
  private readonly uboFloat:  Float32Array;
  private readonly uboUint:   Uint32Array;

  private waves:   ActiveWave[] = [];
  private _loaded: boolean = false;

  constructor() {
    this.uboBuffer = new ArrayBuffer(UBO_BYTES);
    this.uboFloat  = new Float32Array(this.uboBuffer);
    this.uboUint   = new Uint32Array(this.uboBuffer);
    this.wavesUBO  = GPUUtils.createBuffer(
      'shockwave_waves_ubo', UBO_BYTES,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  public async load(): Promise<void> {
    const device     = GPUUtils.getDevice();
    const shaderCode = await ResourceManager.loadShader('post-processing/shockwave_pp.cs');
    const module     = device.createShaderModule({ label: 'shockwave_pp_cs', code: shaderCode });

    const config: ComputePipelineConfig = {
      label: 'Shockwave Compute Pipeline',
      layout: PipelineFactory.createPipelineLayout('shockwave_pp_layout', [
        BindGroupFactory.getCameraComputeLayout(),
        BindGroupFactory.getShockwaveInputLayout(),
        BindGroupFactory.getShockwaveOutputLayout(),
        BindGroupFactory.getShockwaveWavesLayout(),
      ]),
      compute: { module, entryPoint: 'cs' },
    };

    this.pipeline = PipelineFactory.createComputePipeline(config);

    this.createOutputRT(Render.width, Render.height);
    this._loaded = true;
  }

  public hasLoaded(): boolean { return this._loaded; }
  public hasActiveWaves(): boolean { return this.waves.length > 0; }

  public addWave(
    origin: [number, number, number],
    config: ShockwaveConfig = {},
  ): void {
    if (this.waves.length >= MAX_WAVES) return;
    this.waves.push({
      origin,
      radius:    0,
      speed:     config.speed     ?? 15,
      maxRadius: config.maxRadius ?? 25,
      thickness: config.thickness ?? 2.5,
      intensity: config.intensity ?? 0.04,
      falloff:   config.falloff   ?? 0.6,
    });
  }

  public update(dt: number): void {
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i]!;
      w.radius += w.speed * dt;
      if (w.radius >= w.maxRadius) this.waves.splice(i, 1);
    }
  }

  /** Returns the distorted accLight view. Falls back to `accLightView` when
   *  there are no active waves (zero cost). */
  public apply(
    accLightView:    GPUTextureView,
    gLinearDepthView: GPUTextureView,
  ): GPUTextureView {
    if (!this.pipeline || !this.outputRT) return accLightView;
    if (this.waves.length === 0)          return accLightView;

    this.uploadWaves();
    this.ensureBindGroups(accLightView, gLinearDepthView);

    const encoder = Render.getInstance().getCommandEncoder();
    const pass    = encoder.beginComputePass({ label: 'ShockwavePass' });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.cameraBG!);
    pass.setBindGroup(1, this.inputBG!);
    pass.setBindGroup(2, this.outputBG!);
    pass.setBindGroup(3, this.wavesBG!);
    pass.dispatchWorkgroups(
      Math.ceil(Render.width  / 8),
      Math.ceil(Render.height / 8),
    );
    pass.end();

    return this.outputRT.getView();
  }

  public resize(): void {
    this.createOutputRT(Render.width, Render.height);
    this.inputBG  = null;
    this.outputBG = null;
    this.cameraBG = null;
  }

  public dispose(): void {
    this.wavesUBO.destroy();
    this.waves = [];
    this._loaded = false;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private createOutputRT(w: number, h: number): void {
    this.outputRT = new RenderTarget();
    this.outputRT.createRT('shockwave_output', w, h, 'rgba16float', GPUTextureUsage.STORAGE_BINDING);
    this.outputBG = null;
  }

  private uploadWaves(): void {
    this.uboUint[0] = this.waves.length; // u32 count at byte offset 0
    // floats 1-3 = padding (already 0 from ArrayBuffer init)

    for (let i = 0; i < this.waves.length; i++) {
      const w    = this.waves[i]!;
      const base = 4 + i * 8; // float32 index: 4 header floats + 8 floats per wave
      this.uboFloat[base + 0] = w.origin[0];
      this.uboFloat[base + 1] = w.origin[1];
      this.uboFloat[base + 2] = w.origin[2];
      this.uboFloat[base + 3] = w.radius;
      this.uboFloat[base + 4] = w.thickness;
      this.uboFloat[base + 5] = w.intensity;
      this.uboFloat[base + 6] = w.falloff;
      this.uboFloat[base + 7] = 0; // _pad
    }

    GPUUtils.writeBuffer(this.wavesUBO, 0, this.uboBuffer);
  }

  private ensureBindGroups(
    accLightView:    GPUTextureView,
    gLinearDepthView: GPUTextureView,
  ): void {
    // Camera
    const camBuf = Engine.getRender().getMainCamera().getUniformBuffer();
    if (camBuf && (!this.cameraBG || camBuf !== this.lastCameraBuffer)) {
      this.lastCameraBuffer = camBuf;
      this.cameraBG = BindGroupFactory.createBindGroup(
        'shockwave_camera_bg',
        BindGroupFactory.getCameraComputeLayout(),
        [{ binding: 0, resource: { buffer: camBuf } }],
      );
    }

    // Input: accLight + sampler + gLinearDepth
    if (!this.inputBG
        || accLightView     !== this.lastAccLightView
        || gLinearDepthView !== this.lastDepthView) {
      this.lastAccLightView = accLightView;
      this.lastDepthView    = gLinearDepthView;
      this.inputBG = BindGroupFactory.createBindGroup(
        'shockwave_input_bg',
        BindGroupFactory.getShockwaveInputLayout(),
        [
          { binding: 0, resource: accLightView },
          { binding: 1, resource: SamplerLibrary.simpleSampler! },
          { binding: 2, resource: gLinearDepthView },
        ],
      );
    }

    // Output storage texture
    if (!this.outputBG) {
      this.outputBG = BindGroupFactory.createBindGroup(
        'shockwave_output_bg',
        BindGroupFactory.getShockwaveOutputLayout(),
        [{ binding: 0, resource: this.outputRT!.getStorageView() }],
      );
    }

    // Waves UBO
    if (!this.wavesBG) {
      this.wavesBG = BindGroupFactory.createBindGroup(
        'shockwave_waves_bg',
        BindGroupFactory.getShockwaveWavesLayout(),
        [{ binding: 0, resource: { buffer: this.wavesUBO } }],
      );
    }
  }
}
