import { Component } from '../../core/ecs/Component';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import {
  PipelineFactory,
  ComputePipelineConfig,
} from '../../renderer/core/factories/PipelineFactory';
import { Render } from '../../renderer/core/pipeline/Render';
import { Texture } from '../../renderer/resources/Texture';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { Engine } from '../../core/engine/Engine';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { CameraComponent } from './CameraComponent';
import { GPUProfiler } from '../../core/debug/GPUProfiler';

// ─── Layout constant (must match WGSL SSAOParams struct: 10 × f32 padded to 48 bytes) ──────
const SSAO_PARAMS_SIZE = 48;

export class AmbientOcclusionComponent extends Component {
  private device: GPUDevice;
  private loaded = false;

  // Render targets — all need STORAGE_BINDING (compute write) + TEXTURE_BINDING (read input)
  private rawAOTarget!: RenderTarget;
  private intermediateAOTarget!: RenderTarget; // horizontal bilateral pass output
  private finalAOResult!: RenderTarget;
  private aoWidth = 0;
  private aoHeight = 0;

  // SSAO params uniform buffer + noise
  private ssaoParamsBuffer!: GPUBuffer;
  private noiseTexture!: Texture;
  private ssaoUniformData: Float32Array;

  // User-tunable settings
  private isEnabled: boolean;
  private sampleCount: number;
  private sliceCount: number;
  private radius: number;
  private strength: number;
  private angleOffset = 0.1;
  private spacialOffset = 1.0;
  private falloff = 1.0;
  private thicknessMix = 0.2;
  private maxStride = 8.0;
  private limit = 100.0;

  // ── Compute pipelines ────────────────────────────────────────────────────────
  private gtaoPipeline!: GPUComputePipeline;
  private bilateralHPipeline!: GPUComputePipeline; // horizontal pass (cs_h, 16×8)
  private bilateralVPipeline!: GPUComputePipeline; // vertical   pass (cs_v,  8×16)
  private bilateralVPSXPipeline!: GPUComputePipeline; // vertical PSX   pass (cs_v_psx, 8×16)

  // ── Bind group layouts (custom to this component) ────────────────────────────
  /** Group 2 of GTAO pass: UBO + hbaoSampler + noiseTexture + noiseSampler */
  private gtaoParamsLayout!: GPUBindGroupLayout;
  /** Group 3 of both passes: write-only rgba16float storage texture (filterable + storage-capable) */
  private storageWriteR32Layout!: GPUBindGroupLayout;

  // ── Bind groups ──────────────────────────────────────────────────────────────
  private cameraComputeBindGroup: GPUBindGroup | null = null;
  private lastCameraBuffer: GPUBuffer | null = null;

  /** GTAO group 2 — stable after load */
  private gtaoParamsBindGroup: GPUBindGroup | null = null;
  /** GTAO group 3 — storage write into rawAOTarget. Rebuilt on resize. */
  private gtaoOutputBindGroup: GPUBindGroup | null = null;
  /** Bilateral-H group 2 — rawAOTarget as read texture. Rebuilt on resize. */
  private bilateralHInputBindGroup: GPUBindGroup | null = null;
  /** Bilateral-H group 3 — storage write into intermediateAOTarget. Rebuilt on resize. */
  private bilateralHOutputBindGroup: GPUBindGroup | null = null;
  /** Bilateral-V group 2 — intermediateAOTarget as read texture. Rebuilt on resize. */
  private bilateralVInputBindGroup: GPUBindGroup | null = null;
  /** Bilateral-V group 3 — storage write into finalAOResult. Rebuilt on resize. */
  private bilateralVOutputBindGroup: GPUBindGroup | null = null;

  constructor() {
    super();
    this.device = GPUUtils.getDevice();
    const qs = QualitySettings.getInstance().getSettings();
    this.isEnabled = qs.enableAO;
    this.sampleCount = qs.aoSampleCount;
    this.sliceCount = qs.aoSliceCount;
    this.radius = qs.aoRadius;
    this.strength = qs.aoStrength;
    this.ssaoUniformData = new Float32Array(12);
  }

  // ─── Component lifecycle ──────────────────────────────────────────────────────

  public async load(): Promise<void> {
    this.noiseTexture = await Texture.getAsync('noiseRGB.jpg');

    const qs = QualitySettings.getInstance().getSettings();
    // r16float is not a valid WebGPU storage texture format.
    // rgba16float is both a valid write-only storage format AND filterable (Float sample type).
    const aoStorageFormat: GPUTextureFormat = 'rgba16float';
    const aoScale = qs.aoScale;
    this.aoWidth = Math.floor(Render.width * aoScale);
    this.aoHeight = Math.floor(Render.height * aoScale);

    // RENDER_ATTACHMENT: needed for the "disabled AO" clear render pass
    // TEXTURE_BINDING:   bilateral filter reads rawAOTarget as sampled texture
    // STORAGE_BINDING:   compute shaders write to all targets
    const extraUsage = GPUTextureUsage.STORAGE_BINDING;

    this.rawAOTarget = new RenderTarget();
    this.rawAOTarget.createRT(
      'raw_ao_result.dds',
      this.aoWidth,
      this.aoHeight,
      aoStorageFormat,
      extraUsage,
    );

    this.intermediateAOTarget = new RenderTarget();
    this.intermediateAOTarget.createRT(
      'intermediate_ao_result.dds',
      this.aoWidth,
      this.aoHeight,
      aoStorageFormat,
      extraUsage,
    );

    this.finalAOResult = new RenderTarget();
    this.finalAOResult.createRT(
      'final_ao_result.dds',
      this.aoWidth,
      this.aoHeight,
      aoStorageFormat,
      extraUsage,
    );

    this.createSSAOParamsBuffer();
    this.createLayouts();
    await this.createPipelines();
    this.createParamsBindGroup();

    this.loaded = true;
  }

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.RESIZE, 'ambient_occlusion', (comp) => {
      const c = comp as AmbientOcclusionComponent;
      if (c.hasLoaded()) c.resize();
    });
  }

  public resize(): void {
    const qs = QualitySettings.getInstance().getSettings();
    const aoStorageFormat: GPUTextureFormat = 'rgba16float';
    const aoScale = qs.aoScale;
    this.aoWidth = Math.floor(Render.width * aoScale);
    this.aoHeight = Math.floor(Render.height * aoScale);

    const extraUsage = GPUTextureUsage.STORAGE_BINDING;

    if (this.rawAOTarget) this.rawAOTarget.destroy();
    if (this.intermediateAOTarget) this.intermediateAOTarget.destroy();
    if (this.finalAOResult) this.finalAOResult.destroy();

    this.rawAOTarget.createRT(
      'raw_ao_result.dds',
      this.aoWidth,
      this.aoHeight,
      aoStorageFormat,
      extraUsage,
    );
    this.intermediateAOTarget.createRT(
      'intermediate_ao_result.dds',
      this.aoWidth,
      this.aoHeight,
      aoStorageFormat,
      extraUsage,
    );
    this.finalAOResult.createRT(
      'final_ao_result.dds',
      this.aoWidth,
      this.aoHeight,
      aoStorageFormat,
      extraUsage,
    );

    // Texture-view bind groups reference stale GPU textures — must regenerate lazily
    this.gtaoOutputBindGroup = null;
    this.bilateralHInputBindGroup = null;
    this.bilateralHOutputBindGroup = null;
    this.bilateralVInputBindGroup = null;
    this.bilateralVOutputBindGroup = null;
  }

  // ─── Setup helpers ────────────────────────────────────────────────────────────

  private createSSAOParamsBuffer(): void {
    this.ssaoParamsBuffer = GPUUtils.createBuffer(
      'SSAO Parameters Buffer',
      SSAO_PARAMS_SIZE,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
  }

  private createLayouts(): void {
    // GTAO group 2: SSAOParams UBO + hbaoSampler + noiseTexture + noiseSampler
    this.gtaoParamsLayout = BindGroupFactory.getLayout('ao_gtao_params_compute', [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
    ]);

    // Both passes group 3: write-only rgba16float storage texture
    // rgba16float is both a valid write-only storage format AND filterable (Float sample type),
    // unlike r32float which is storage-capable but UnfilterableFloat.
    this.storageWriteR32Layout = BindGroupFactory.getLayout('ao_storage_write_rgba16f', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
      },
    ]);
  }

  private async createPipelines(): Promise<void> {
    const cameraLayout = BindGroupFactory.getCameraComputeLayout();
    const gbufferLayout = BindGroupFactory.getGBufferComputeLayout();

    // ── GTAO ──────────────────────────────────────────────────────────────────
    const gtaoCode = await ResourceManager.loadShader('post-processing/gtao.cs');
    const gtaoModule = this.device.createShaderModule({ label: 'gtao_cs', code: gtaoCode });
    const gtaoConfig: ComputePipelineConfig = {
      label: 'GTAO Compute Pipeline',
      layout: PipelineFactory.createPipelineLayout('ao_gtao_pipeline_layout', [
        cameraLayout,
        gbufferLayout,
        this.gtaoParamsLayout,
        this.storageWriteR32Layout,
      ]),
      compute: { module: gtaoModule, entryPoint: 'cs' },
    };
    this.gtaoPipeline = PipelineFactory.createComputePipeline(gtaoConfig);

    // ── Bilateral filter (separable: horizontal + vertical) ──────────────────
    const bilateralCode = await ResourceManager.loadShader(
      'post-processing/ao_bilateral_filter.cs',
    );
    const bilateralModule = this.device.createShaderModule({
      label: 'ao_bilateral_cs',
      code: bilateralCode,
    });
    const bilateralLayout = PipelineFactory.createPipelineLayout('ao_bilateral_pipeline_layout', [
      cameraLayout,
      gbufferLayout,
      BindGroupFactory.getSingleTextureComputeLayout(),
      this.storageWriteR32Layout,
    ]);

    const bilateralHConfig: ComputePipelineConfig = {
      label: 'AO Bilateral Filter Horizontal',
      layout: bilateralLayout,
      compute: { module: bilateralModule, entryPoint: 'cs_h' },
    };
    this.bilateralHPipeline = PipelineFactory.createComputePipeline(bilateralHConfig);

    const bilateralVConfig: ComputePipelineConfig = {
      label: 'AO Bilateral Filter Vertical',
      layout: bilateralLayout,
      compute: { module: bilateralModule, entryPoint: 'cs_v' },
    };
    this.bilateralVPipeline = PipelineFactory.createComputePipeline(bilateralVConfig);

    const bilateralVPSXConfig: ComputePipelineConfig = {
      label: 'AO Bilateral Filter Vertical PSX',
      layout: bilateralLayout,
      compute: { module: bilateralModule, entryPoint: 'cs_v_psx' },
    };
    this.bilateralVPSXPipeline = PipelineFactory.createComputePipeline(bilateralVPSXConfig);
  }

  private createParamsBindGroup(): void {
    this.gtaoParamsBindGroup = BindGroupFactory.createBindGroup(
      'ao_gtao_params_bindgroup',
      this.gtaoParamsLayout,
      [
        { binding: 0, resource: { buffer: this.ssaoParamsBuffer } },
        { binding: 1, resource: SamplerLibrary.ambientOcclusionSampler },
        { binding: 2, resource: this.noiseTexture.getTextureView()! },
        { binding: 3, resource: SamplerLibrary.ambientOcclusionSampler },
      ],
    );
  }

  // ─── Per-frame bind group helpers (lazy / cached) ─────────────────────────────

  private getCameraComputeBindGroup(): GPUBindGroup | null {
    const cameraEntity = Engine.getEntities().getEntityByName('MainCamera');
    const cameraComp = cameraEntity?.getComponent('camera') as CameraComponent | undefined;
    const cameraBuffer = cameraComp?.getCamera().getUniformBuffer();
    if (!cameraBuffer) return null;

    if (!this.cameraComputeBindGroup || cameraBuffer !== this.lastCameraBuffer) {
      this.lastCameraBuffer = cameraBuffer;
      this.cameraComputeBindGroup = BindGroupFactory.createBindGroup(
        'ao_camera_compute_bindgroup',
        BindGroupFactory.getCameraComputeLayout(),
        [{ binding: 0, resource: { buffer: cameraBuffer } }],
      );
    }
    return this.cameraComputeBindGroup;
  }

  private getGTAOOutputBindGroup(): GPUBindGroup {
    if (!this.gtaoOutputBindGroup) {
      this.gtaoOutputBindGroup = BindGroupFactory.createBindGroup(
        'ao_gtao_output_bindgroup',
        this.storageWriteR32Layout,
        [{ binding: 0, resource: this.rawAOTarget.getStorageView() }],
      );
    }
    return this.gtaoOutputBindGroup;
  }

  private getBilateralHInputBindGroup(): GPUBindGroup {
    if (!this.bilateralHInputBindGroup) {
      this.bilateralHInputBindGroup = BindGroupFactory.createBindGroup(
        'ao_bilateral_h_input_bindgroup',
        BindGroupFactory.getSingleTextureComputeLayout(),
        [
          { binding: 0, resource: this.rawAOTarget.getView() },
          { binding: 1, resource: SamplerLibrary.simpleSampler },
        ],
      );
    }
    return this.bilateralHInputBindGroup;
  }

  private getBilateralHOutputBindGroup(): GPUBindGroup {
    if (!this.bilateralHOutputBindGroup) {
      this.bilateralHOutputBindGroup = BindGroupFactory.createBindGroup(
        'ao_bilateral_h_output_bindgroup',
        this.storageWriteR32Layout,
        [{ binding: 0, resource: this.intermediateAOTarget.getStorageView() }],
      );
    }
    return this.bilateralHOutputBindGroup;
  }

  private getBilateralVInputBindGroup(): GPUBindGroup {
    if (!this.bilateralVInputBindGroup) {
      this.bilateralVInputBindGroup = BindGroupFactory.createBindGroup(
        'ao_bilateral_v_input_bindgroup',
        BindGroupFactory.getSingleTextureComputeLayout(),
        [
          { binding: 0, resource: this.intermediateAOTarget.getView() },
          { binding: 1, resource: SamplerLibrary.simpleSampler },
        ],
      );
    }
    return this.bilateralVInputBindGroup;
  }

  private getBilateralVOutputBindGroup(): GPUBindGroup {
    if (!this.bilateralVOutputBindGroup) {
      this.bilateralVOutputBindGroup = BindGroupFactory.createBindGroup(
        'ao_bilateral_v_output_bindgroup',
        this.storageWriteR32Layout,
        [{ binding: 0, resource: this.finalAOResult.getStorageView() }],
      );
    }
    return this.bilateralVOutputBindGroup;
  }

  // ─── Main compute entry point ─────────────────────────────────────────────────

  /**
   * Executes two compute passes: GTAO → bilateral filter.
   * @param gBufferComputeBindGroup G-Buffer bind group with COMPUTE visibility.
   */
  public compute(gBufferComputeBindGroup: GPUBindGroup): GPUTextureView {
    if (!this.isEnabled) {
      return this.renderDisabledAO();
    }

    const cameraBindGroup = this.getCameraComputeBindGroup();
    if (!cameraBindGroup) {
      return this.renderDisabledAO();
    }

    this.updateUniforms();

    const encoder = Render.getInstance().getCommandEncoder();

    // Horizontal bilateral: workgroup 16×8 → dispatch ceil(W/16) × ceil(H/8)
    const wHX = Math.ceil(this.aoWidth / 16);
    const wHY = Math.ceil(this.aoHeight / 8);
    // Vertical bilateral: workgroup 8×16 → dispatch ceil(W/8) × ceil(H/16)
    const wVX = Math.ceil(this.aoWidth / 8);
    const wVY = Math.ceil(this.aoHeight / 16);
    // GTAO: workgroup 8×8
    const wX = Math.ceil(this.aoWidth / 8);
    const wY = Math.ceil(this.aoHeight / 8);

    // ── Pass 1: GTAO ─────────────────────────────────────────────────────────
    const gtaoTs = GPUProfiler.getInstance().getTimestampWrites('GTAO Compute');
    const gtaoPass = encoder.beginComputePass({
      label: 'GTAO Compute',
      ...(gtaoTs ? { timestampWrites: gtaoTs } : {}),
    });
    gtaoPass.setPipeline(this.gtaoPipeline);
    gtaoPass.setBindGroup(0, cameraBindGroup);
    gtaoPass.setBindGroup(1, gBufferComputeBindGroup);
    gtaoPass.setBindGroup(2, this.gtaoParamsBindGroup!);
    gtaoPass.setBindGroup(3, this.getGTAOOutputBindGroup());
    gtaoPass.dispatchWorkgroups(wX, wY, 1);
    gtaoPass.end();

    // ── Pass 2: Bilateral filter — horizontal (cs_h) ─────────────────────────
    const bilHTs = GPUProfiler.getInstance().getTimestampWrites('AO Bilateral Horizontal');
    const bilHPass = encoder.beginComputePass({
      label: 'AO Bilateral Filter Horizontal',
      ...(bilHTs ? { timestampWrites: bilHTs } : {}),
    });
    bilHPass.setPipeline(this.bilateralHPipeline);
    bilHPass.setBindGroup(0, cameraBindGroup);
    bilHPass.setBindGroup(1, gBufferComputeBindGroup);
    bilHPass.setBindGroup(2, this.getBilateralHInputBindGroup());
    bilHPass.setBindGroup(3, this.getBilateralHOutputBindGroup());
    bilHPass.dispatchWorkgroups(wHX, wHY, 1);
    bilHPass.end();

    // ── Pass 3: Bilateral filter — vertical (cs_v / cs_v_psx) ─────────────────
    const isPSX = QualitySettings.getInstance().getSettings().ditheringMode === 'psx';
    const bilVTs = GPUProfiler.getInstance().getTimestampWrites('AO Bilateral Vertical');
    const bilVPass = encoder.beginComputePass({
      label: 'AO Bilateral Filter Vertical',
      ...(bilVTs ? { timestampWrites: bilVTs } : {}),
    });
    bilVPass.setPipeline(isPSX ? this.bilateralVPSXPipeline : this.bilateralVPipeline);
    bilVPass.setBindGroup(0, cameraBindGroup);
    bilVPass.setBindGroup(1, gBufferComputeBindGroup);
    bilVPass.setBindGroup(2, this.getBilateralVInputBindGroup());
    bilVPass.setBindGroup(3, this.getBilateralVOutputBindGroup());
    bilVPass.dispatchWorkgroups(wVX, wVY, 1);
    bilVPass.end();

    return this.finalAOResult.getView();
  }

  // ── Disabled path: render pass that clears to white (no occlusion) ───────────
  private renderDisabledAO(): GPUTextureView {
    const commandEncoder = Render.getInstance().getCommandEncoder();
    const renderPass = commandEncoder.beginRenderPass({
      label: 'Clear AO Target',
      colorAttachments: [
        {
          view: this.rawAOTarget.getView(),
          clearValue: { r: 0.5, g: 0.5, b: 1.0, a: 1.0 }, // oct01(0,0,1) = neutral bent normal, AO=1
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    renderPass.end();
    return this.rawAOTarget.getView();
  }

  // ── Uniform update ────────────────────────────────────────────────────────────

  private updateUniforms(): void {
    let o = 0;
    this.ssaoUniformData[o++] = this.sampleCount;
    this.ssaoUniformData[o++] = this.sliceCount;
    this.ssaoUniformData[o++] = this.radius;
    this.ssaoUniformData[o++] = this.strength;
    this.ssaoUniformData[o++] = this.angleOffset;
    this.ssaoUniformData[o++] = this.spacialOffset;
    this.ssaoUniformData[o++] = this.falloff;
    this.ssaoUniformData[o++] = this.thicknessMix;
    this.ssaoUniformData[o++] = this.maxStride;
    this.ssaoUniformData[o++] = this.limit;

    this.device.queue.writeBuffer(this.ssaoParamsBuffer, 0, this.ssaoUniformData.buffer);
  }

  // ── Debug UI ──────────────────────────────────────────────────────────────────

  public override renderInMenu(): void {
    const gui = Engine.getGUI();
    if (!gui.getIsVisible()) return;

    if (!gui.beginWindow('Ambient Occlusion', true)) return;

    const guiManager = gui as any;
    const folder = guiManager.folders?.get('Ambient Occlusion');

    if (!folder) {
      gui.endWindow();
      return;
    }

    folder.add(this, 'isEnabled').name('Enable AO').listen();
    folder.add(this, 'sampleCount', 4.0, 8.0).name('Sample Count').listen();
    folder.add(this, 'sliceCount', 3.0, 6.0).name('Slice Count').listen();
    folder.add(this, 'radius', 0.1, 2.0).name('Radius').listen();
    folder.add(this, 'strength', 0.0, 2.0).name('Strength').listen();
    folder.add(this, 'angleOffset', 0.0, 3.0).name('Angle Offset').listen();
    folder.add(this, 'spacialOffset', 0.0, 3.0).name('Spacial Offset').listen();
    folder.add(this, 'falloff', 0.0, 15.0).name('Falloff').listen();
    folder.add(this, 'thicknessMix', 0.001, 1.0).name('Thickness Mix').listen();
    folder.add(this, 'maxStride', 1.0, 32.0).name('Max Stride').listen();
    folder.add(this, 'limit', 0.0, 100.0).name('Limit').listen();

    gui.endWindow();
  }

  public update(_dt: number): void {}

  public renderDebug(): void {}

  public hasLoaded(): boolean {
    return this.loaded;
  }
}
