import { Logger } from '../../core/debug/Logger';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Render } from '../core/pipeline/Render';
import { RenderTarget } from '../resources/RenderTarget';
import { GPUUtils } from '../core/utils/GPUUtils';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { PipelineFactory, ComputePipelineConfig } from '../core/factories/PipelineFactory';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { Mesh } from '../resources/Mesh';
import { Technique } from '../resources/Technique';
import { Engine } from '../../core/engine/Engine';
import { RenderPassManager } from '../core/passes/RenderPassManager';
import { GPUProfiler } from '../../core/debug/GPUProfiler';
import { CameraComponent } from '../../components/render/CameraComponent';

// RCParams uniform buffer layout (matches WGSL struct — 12 × f32 = 48 bytes)
// struct RCParams {
//   cascadeIndex: f32, cascadeCount: f32, baseRange: f32, intervalStart: f32,
//   intervalEnd: f32, raysPerProbe: f32, maxSteps: f32, temporalBlend: f32,
//   cascadeRes: vec2<f32>, screenSize: vec2<f32>
// }
const RC_PARAMS_SIZE = 48;

// Per-cascade constants: [raysPerProbe, maxSteps, intervalMultStart, intervalMultEnd]
const CASCADE_CONFIG = [
  { raysPerProbe: 4, maxSteps: 32, intervalMultStart: 0, intervalMultEnd: 1 }, // [0, R]
  { raysPerProbe: 16, maxSteps: 24, intervalMultStart: 1, intervalMultEnd: 4 }, // [R, 4R]
  { raysPerProbe: 64, maxSteps: 16, intervalMultStart: 4, intervalMultEnd: 16 }, // [4R, 16R]
  { raysPerProbe: 256, maxSteps: 16, intervalMultStart: 16, intervalMultEnd: 64 }, // [16R, 64R]
] as const;

// Temporal blend factors per cascade (0 = no accumulation, used for c0/c1)
const TEMPORAL_BLEND = [0, 0, 0.9, 0.95] as const;

export class RadianceCascades {
  private isLoaded = false;
  private bindGroupsDirty = true;

  // ─── Render targets ────────────────────────────────────────────────────────
  // cascadeRT[i]: trace output. Cascade 0 = finest (W/4), each next halves.
  private cascadeRT: RenderTarget[] = [];
  // mergeRT[i]: merge output at cascade i's resolution (i from 0..N-2).
  private mergeRT: RenderTarget[] = [];
  // historyRT: ping-pong buffers for cascades N-2 and N-1 (temporal accumulation).
  private historyRT: [RenderTarget, RenderTarget] | null = null;
  // giResultRT: full-res GI contribution written by the apply pass.
  private giResultRT: RenderTarget | null = null;

  // ─── GPU resources ─────────────────────────────────────────────────────────
  private rcParamsBuffer!: GPUBuffer;
  private tracePipeline!: GPUComputePipeline;
  private mergePipeline!: GPUComputePipeline;
  private applyPipeline!: GPUComputePipeline;

  // ─── Bind groups ───────────────────────────────────────────────────────────
  // Camera compute bind group (lazily created/cached per frame)
  private cameraComputeBindGroup: GPUBindGroup | null = null;
  private lastCameraBuffer: GPUBuffer | null = null;
  // Per-cascade trace bind groups (groups 2 and 3)
  private traceGroup2: GPUBindGroup[] = []; // one per cascade
  private traceGroup3: GPUBindGroup[] = []; // one per cascade (storage output)
  // Per-merge-step bind groups (groups 1 and 2)
  private mergeGroup1: GPUBindGroup[] = []; // one per merge step
  private mergeGroup2: GPUBindGroup[] = []; // one per merge step (storage output)
  // Apply pass bind groups (groups 2 and 3)
  private applyGroup2!: GPUBindGroup;
  private applyGroup3!: GPUBindGroup;
  // Composite pass bind group (group 1 = giResult SingleTexture)
  private compositeBindGroup!: GPUBindGroup;
  // Composite pass RC params bind group (group 2 = rcParamsBuffer, giIntensity slot)
  private compositeRCParamsBindGroup!: GPUBindGroup;

  // ─── Composite render resources ────────────────────────────────────────────
  private fullscreenQuadMesh!: Mesh;
  private compositeTechnique!: Technique;

  // ─── History management ────────────────────────────────────────────────────
  private historyInvalid = true;
  // Track last rtAccLight view to detect resize (triggers bind group rebuild)
  private lastAccLightView: GPUTextureView | null = null;

  // ─── Debug / tweakable params ──────────────────────────────────────────────
  private debugParams = {
    baseRange: 0.5,       // world-space base interval length
    giIntensity: 0.15,    // multiplier applied to the composite pass output
    temporalStrength: 0.9, // blend factor for the 2nd-coarsest cascade (N-2)
  };
  private _editorFolder: any = null;

  constructor() {
    MsgDispatcher.register(MsgType.RESIZE, 'radiance_cascades', () => {
      this.invalidateHistory();
      this.bindGroupsDirty = true;
    });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  public async load(): Promise<void> {
    const device = GPUUtils.getDevice();

    this.rcParamsBuffer = device.createBuffer({
      label: 'RCParams',
      size: RC_PARAMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.createRenderTargets();
    await this.createPipelines();

    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.compositeTechnique = await Technique.getAsync('post-processing/rc_composite.tech');

    this.isLoaded = true;
    Logger.info('RENDER', 'Radiance Cascades ready');
  }

  public resize(): void {
    if (!this.isLoaded) return;
    this.createRenderTargets();
    this.bindGroupsDirty = true;
    this.historyInvalid = true;
  }

  public dispose(): void {
    MsgDispatcher.register(MsgType.RESIZE, 'radiance_cascades', () => {});
    this.destroyRenderTargets();
    this.rcParamsBuffer?.destroy();
    this.isLoaded = false;
  }

  // ─── Per-frame entry point ─────────────────────────────────────────────────

  public render(
    gBufferComputeBindGroup: GPUBindGroup,
    rtAccLight: RenderTarget,
    renderPassManager: RenderPassManager,
  ): void {
    if (!this.isLoaded) return;

    // Rebuild bind groups on first frame, after resize, or when rtAccLight changes.
    const accLightView = rtAccLight.getView();
    if (this.bindGroupsDirty || accLightView !== this.lastAccLightView) {
      this.lastAccLightView = accLightView;
      this.rebuildBindGroups(rtAccLight);
      this.bindGroupsDirty = false;
    }

    const cameraGroup = this.getCameraComputeBindGroup();
    if (!cameraGroup) return; // no camera yet

    const qs = QualitySettings.getInstance().getSettings();
    const cascadeCount = qs.rcCascadeCount;
    const baseRange = this.debugParams.baseRange;
    const encoder = Render.getInstance().getCommandEncoder();

    // ── Fase 2: trace each cascade ────────────────────────────────────────
    for (let i = 0; i < cascadeCount; i++) {
      const cfg = CASCADE_CONFIG[i];
      const rt = this.cascadeRT[i];
      const wX = Math.ceil(rt.getWidth() / 8);
      const wY = Math.ceil(rt.getHeight() / 8);

      let blend = 0;
      if (!this.historyInvalid) {
        if (i === cascadeCount - 1) blend = Math.min(this.debugParams.temporalStrength + 0.05, 0.99);
        else if (i === cascadeCount - 2) blend = this.debugParams.temporalStrength;
      }
      this.uploadRCParams(
        i,
        cascadeCount,
        baseRange,
        cfg.maxSteps,
        cfg.raysPerProbe,
        cfg.intervalMultStart,
        cfg.intervalMultEnd,
        blend,
        rt.getWidth(),
        rt.getHeight(),
      );

      const ts = GPUProfiler.getInstance().getTimestampWrites(`RC Trace ${i}`);
      const pass = encoder.beginComputePass({
        label: `RC Trace ${i}`,
        ...(ts ? { timestampWrites: ts } : {}),
      });
      pass.setPipeline(this.tracePipeline);
      pass.setBindGroup(0, cameraGroup);
      pass.setBindGroup(1, gBufferComputeBindGroup);
      pass.setBindGroup(2, this.traceGroup2[i]);
      pass.setBindGroup(3, this.traceGroup3[i]);
      pass.dispatchWorkgroups(wX, wY, 1);
      pass.end();
    }

    // Copy history for cascades N-2 and N-1 (before merge reads from cascadeRT)
    this.copyHistory(encoder, cascadeCount);

    // ── Fase 3: merge cascades (coarsest → finest) ────────────────────────
    // Merge step i: cascade[i] + cascade[i+1 or mergeRT[i+1]] → mergeRT[i]
    for (let i = cascadeCount - 2; i >= 0; i--) {
      const rt = this.mergeRT[i]; // output resolution = cascadeRT[i] resolution
      const wX = Math.ceil(rt.getWidth() / 8);
      const wY = Math.ceil(rt.getHeight() / 8);

      // Upload RCParams: only cascadeRes and screenSize matter for merge shader
      this.uploadRCParams(
        i,
        cascadeCount,
        baseRange,
        CASCADE_CONFIG[i].maxSteps,
        CASCADE_CONFIG[i].raysPerProbe,
        CASCADE_CONFIG[i].intervalMultStart,
        CASCADE_CONFIG[i].intervalMultEnd,
        0, // temporalBlend unused in merge
        rt.getWidth(),
        rt.getHeight(),
      );

      const ts = GPUProfiler.getInstance().getTimestampWrites(`RC Merge ${i}`);
      const pass = encoder.beginComputePass({
        label: `RC Merge ${i}`,
        ...(ts ? { timestampWrites: ts } : {}),
      });
      pass.setPipeline(this.mergePipeline);
      pass.setBindGroup(0, cameraGroup);
      pass.setBindGroup(1, this.mergeGroup1[i]);
      pass.setBindGroup(2, this.mergeGroup2[i]);
      pass.dispatchWorkgroups(wX, wY, 1);
      pass.end();
    }

    // ── Fase 4a: apply — bilateral upsample to giResultRT ─────────────────
    {
      const gi = this.giResultRT!;
      const wX = Math.ceil(gi.getWidth() / 8);
      const wY = Math.ceil(gi.getHeight() / 8);

      // cascadeRes = cascade 0 resolution; screenSize = full res
      const c0 = this.mergeRT[0];
      this.uploadRCParams(
        0,
        cascadeCount,
        baseRange,
        CASCADE_CONFIG[0].maxSteps,
        CASCADE_CONFIG[0].raysPerProbe,
        CASCADE_CONFIG[0].intervalMultStart,
        CASCADE_CONFIG[0].intervalMultEnd,
        0,
        c0.getWidth(),
        c0.getHeight(),
        Render.width,
        Render.height,
      );

      const ts = GPUProfiler.getInstance().getTimestampWrites('RC Apply');
      const pass = encoder.beginComputePass({
        label: 'RC Apply',
        ...(ts ? { timestampWrites: ts } : {}),
      });
      pass.setPipeline(this.applyPipeline);
      pass.setBindGroup(0, cameraGroup);
      pass.setBindGroup(1, gBufferComputeBindGroup);
      pass.setBindGroup(2, this.applyGroup2);
      pass.setBindGroup(3, this.applyGroup3);
      pass.dispatchWorkgroups(wX, wY, 1);
      pass.end();
    }

    // ── Fase 4b: composite — additive render blend onto rtAccLight ─────────
    // Update GI intensity in the composite technique uniform (piggybacks on
    // unused rcParams fields — simpler than a separate uniform buffer).
    this.uploadRCParams(
      0, cascadeCount, baseRange,
      CASCADE_CONFIG[0].maxSteps, CASCADE_CONFIG[0].raysPerProbe,
      CASCADE_CONFIG[0].intervalMultStart, CASCADE_CONFIG[0].intervalMultEnd,
      this.debugParams.giIntensity, // temporalBlend slot reused as intensity in composite FS
      this.mergeRT[0].getWidth(), this.mergeRT[0].getHeight(),
      Render.width, Render.height,
    );
    renderPassManager.executeRCCompositePass(
      this.fullscreenQuadMesh,
      this.compositeTechnique,
      rtAccLight.getRenderView(),
      this.compositeBindGroup,
      this.compositeRCParamsBindGroup,
    );

    // Reset history-invalid after first frame (temporalBlend was forced to 0)
    this.historyInvalid = false;
  }

  // ─── History management ────────────────────────────────────────────────────

  public invalidateHistory(): void {
    this.historyInvalid = true;
  }

  // ─── Debug UI ──────────────────────────────────────────────────────────────

  public renderInMenu(folder?: any): void {
    if (!folder) return;
    if (this._editorFolder) return;
    this._editorFolder = folder.addFolder('Radiance Cascades');
    this._editorFolder.close();

    const qs = QualitySettings.getInstance().getSettings();
    const p = this.debugParams;

    // Read-only info
    this._editorFolder.add({ cascades: qs.rcCascadeCount }, 'cascades').name('Cascade Count').disable();

    this._editorFolder.add(p, 'baseRange', 0.05, 3.0).name('Base Range').listen();
    this._editorFolder.add(p, 'giIntensity', 0.0, 4.0).name('GI Intensity').listen();
    this._editorFolder.add(p, 'temporalStrength', 0.0, 0.98).name('Temporal Blend').listen();

    const actions = {
      invalidateHistory: () => this.invalidateHistory(),
    };
    this._editorFolder.add(actions, 'invalidateHistory').name('Reset History');
  }

  // ─── Accessors ─────────────────────────────────────────────────────────────

  public getCascadeRT(index: number): RenderTarget | undefined {
    return this.cascadeRT[index];
  }

  public getCascadeCount(): number {
    return QualitySettings.getInstance().getSettings().rcCascadeCount;
  }

  // ─── Internal: pipeline creation ──────────────────────────────────────────

  private async createPipelines(): Promise<void> {
    const device = GPUUtils.getDevice();

    const cameraLayout = BindGroupFactory.getCameraComputeLayout();
    const gbufferLayout = BindGroupFactory.getGBufferComputeLayout();
    const storageLayout = BindGroupFactory.getSSROutputLayout(); // write-only rgba16float

    // ── Trace pipeline ────────────────────────────────────────────────────
    const traceLayout2 = BindGroupFactory.getRCTraceGroup2Layout();
    const traceCode = await ResourceManager.loadShader('rc/rc_trace.cs');
    this.tracePipeline = PipelineFactory.createComputePipeline({
      label: 'RC Trace Pipeline',
      layout: PipelineFactory.createPipelineLayout('rc_trace_pipeline_layout', [
        cameraLayout,
        gbufferLayout,
        traceLayout2,
        storageLayout,
      ]),
      compute: {
        module: device.createShaderModule({ label: 'rc_trace_cs', code: traceCode }),
        entryPoint: 'cs',
      },
    } as ComputePipelineConfig);

    // ── Merge pipeline ────────────────────────────────────────────────────
    const mergeLayout1 = BindGroupFactory.getRCMergeGroup1Layout();
    const mergeCode = await ResourceManager.loadShader('rc/rc_merge.cs');
    this.mergePipeline = PipelineFactory.createComputePipeline({
      label: 'RC Merge Pipeline',
      layout: PipelineFactory.createPipelineLayout('rc_merge_pipeline_layout', [
        cameraLayout,
        mergeLayout1,
        storageLayout,
      ]),
      compute: {
        module: device.createShaderModule({ label: 'rc_merge_cs', code: mergeCode }),
        entryPoint: 'cs',
      },
    } as ComputePipelineConfig);

    // ── Apply pipeline ────────────────────────────────────────────────────
    const applyLayout2 = BindGroupFactory.getRCApplyGroup2Layout();
    const applyCode = await ResourceManager.loadShader('rc/rc_apply.cs');
    this.applyPipeline = PipelineFactory.createComputePipeline({
      label: 'RC Apply Pipeline',
      layout: PipelineFactory.createPipelineLayout('rc_apply_pipeline_layout', [
        cameraLayout,
        gbufferLayout,
        applyLayout2,
        storageLayout,
      ]),
      compute: {
        module: device.createShaderModule({ label: 'rc_apply_cs', code: applyCode }),
        entryPoint: 'cs',
      },
    } as ComputePipelineConfig);
  }

  // ─── Internal: render targets ──────────────────────────────────────────────

  private createRenderTargets(): void {
    this.destroyRenderTargets();

    const qs = QualitySettings.getInstance().getSettings();
    const cascadeCount = qs.rcCascadeCount;

    const storageCopyUsage =
      GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    const storageUsage = GPUTextureUsage.STORAGE_BINDING;
    const fmt: GPUTextureFormat = 'rgba16float';

    // Cascade 0 starts at W/4; each subsequent cascade halves again.
    for (let i = 0; i < cascadeCount; i++) {
      const divisor = 4 * Math.pow(2, i);
      const w = Math.max(1, Math.floor(Render.width / divisor));
      const h = Math.max(1, Math.floor(Render.height / divisor));
      const rt = new RenderTarget();
      rt.createRT(`rc_cascade_${i}`, w, h, fmt, storageCopyUsage);
      this.cascadeRT.push(rt);
    }

    // mergeRT[i] = same resolution as cascadeRT[i], for i = 0..N-2
    for (let i = 0; i < cascadeCount - 1; i++) {
      const c = this.cascadeRT[i];
      const rt = new RenderTarget();
      rt.createRT(`rc_merge_${i}`, c.getWidth(), c.getHeight(), fmt, storageCopyUsage);
      this.mergeRT.push(rt);
    }

    // History for the two coarsest cascades (indices N-2 and N-1)
    const c2 = this.cascadeRT[cascadeCount - 2];
    const c3 = this.cascadeRT[cascadeCount - 1];
    const h0 = new RenderTarget();
    h0.createRT('rc_history_c2', c2.getWidth(), c2.getHeight(), fmt, storageCopyUsage);
    const h1 = new RenderTarget();
    h1.createRT('rc_history_c3', c3.getWidth(), c3.getHeight(), fmt, storageCopyUsage);
    this.historyRT = [h0, h1];

    // Full-res GI result (written by apply pass, read by composite FS)
    this.giResultRT = new RenderTarget();
    this.giResultRT.createRT('rc_gi_result', Render.width, Render.height, fmt, storageUsage);
  }

  private destroyRenderTargets(): void {
    for (const rt of this.cascadeRT) rt.destroy();
    this.cascadeRT = [];
    for (const rt of this.mergeRT) rt.destroy();
    this.mergeRT = [];
    if (this.historyRT) {
      this.historyRT[0].destroy();
      this.historyRT[1].destroy();
      this.historyRT = null;
    }
    this.giResultRT?.destroy();
    this.giResultRT = null;
  }

  // ─── Internal: bind group management ──────────────────────────────────────

  private rebuildBindGroups(rtAccLight: RenderTarget): void {
    const cascadeCount = QualitySettings.getInstance().getSettings().rcCascadeCount;
    const irradianceCubemap =
      Engine.getEnvironmentManager().getAmbientLightData().irradianceCubemap;

    this.traceGroup2 = [];
    this.traceGroup3 = [];

    for (let i = 0; i < cascadeCount; i++) {
      // History binding: cascades 0 and 1 use a dummy (temporalBlend=0, never sampled);
      // cascade N-2 uses historyRT[0], cascade N-1 uses historyRT[1].
      let historyView: GPUTextureView;
      if (i === cascadeCount - 2) {
        historyView = this.historyRT![0].getView();
      } else if (i === cascadeCount - 1) {
        historyView = this.historyRT![1].getView();
      } else {
        historyView = this.historyRT![0].getView(); // dummy — never read when temporalBlend=0
      }

      this.traceGroup2.push(
        BindGroupFactory.createBindGroup(
          `rc_trace_g2_${i}`,
          BindGroupFactory.getRCTraceGroup2Layout(),
          [
            { binding: 0, resource: { buffer: this.rcParamsBuffer } },
            { binding: 1, resource: rtAccLight.getView() },
            { binding: 2, resource: irradianceCubemap.getTextureView()! },
            { binding: 3, resource: irradianceCubemap.getSampler()! },
            { binding: 4, resource: historyView },
          ],
        ),
      );

      this.traceGroup3.push(
        BindGroupFactory.createBindGroup(
          `rc_trace_g3_${i}`,
          BindGroupFactory.getSSROutputLayout(),
          [{ binding: 0, resource: this.cascadeRT[i].getStorageView() }],
        ),
      );
    }

    // Merge bind groups: step i merges cascade[i] with cascade[i+1] or mergeRT[i+1]
    this.mergeGroup1 = [];
    this.mergeGroup2 = [];

    for (let i = 0; i < cascadeCount - 1; i++) {
      const cFineView = this.cascadeRT[i].getView();
      const cCoarseView =
        i === cascadeCount - 2
          ? this.cascadeRT[i + 1].getView() // coarsest: read traced result
          : this.mergeRT[i + 1].getView(); // others: read already-merged result

      this.mergeGroup1.push(
        BindGroupFactory.createBindGroup(
          `rc_merge_g1_${i}`,
          BindGroupFactory.getRCMergeGroup1Layout(),
          [
            { binding: 0, resource: { buffer: this.rcParamsBuffer } },
            { binding: 1, resource: cFineView },
            { binding: 2, resource: cCoarseView },
            { binding: 3, resource: SamplerLibrary.simpleSampler },
          ],
        ),
      );

      this.mergeGroup2.push(
        BindGroupFactory.createBindGroup(
          `rc_merge_g2_${i}`,
          BindGroupFactory.getSSROutputLayout(),
          [{ binding: 0, resource: this.mergeRT[i].getStorageView() }],
        ),
      );
    }

    // Apply bind groups
    this.applyGroup2 = BindGroupFactory.createBindGroup(
      'rc_apply_g2',
      BindGroupFactory.getRCApplyGroup2Layout(),
      [
        { binding: 0, resource: { buffer: this.rcParamsBuffer } },
        { binding: 1, resource: this.mergeRT[0].getView() },
        { binding: 2, resource: SamplerLibrary.simpleSampler },
      ],
    );

    this.applyGroup3 = BindGroupFactory.createBindGroup(
      'rc_apply_g3',
      BindGroupFactory.getSSROutputLayout(),
      [{ binding: 0, resource: this.giResultRT!.getStorageView() }],
    );

    // Composite bind group (SingleTexture layout: giResult + sampler)
    this.compositeBindGroup = BindGroupFactory.createBindGroup(
      'rc_composite_bg',
      BindGroupFactory.getSingleTextureLayout(),
      [
        { binding: 0, resource: this.giResultRT!.getView() },
        { binding: 1, resource: SamplerLibrary.simpleSampler },
      ],
    );

    // Composite RC params bind group (group 2: rcParamsBuffer, giIntensity slot)
    this.compositeRCParamsBindGroup = BindGroupFactory.createBindGroup(
      'rc_composite_params_bg',
      BindGroupFactory.getBufferUniformLayout(),
      [{ binding: 0, resource: { buffer: this.rcParamsBuffer } }],
    );
  }

  // ─── Internal: camera compute bind group ──────────────────────────────────

  private getCameraComputeBindGroup(): GPUBindGroup | null {
    const cameraEntity = Engine.getEntities().getEntityByName('MainCamera');
    const cameraComp = cameraEntity?.getComponent('camera') as CameraComponent | undefined;
    const cameraBuffer = cameraComp?.getCamera().getUniformBuffer();
    if (!cameraBuffer) return null;

    if (!this.cameraComputeBindGroup || cameraBuffer !== this.lastCameraBuffer) {
      this.lastCameraBuffer = cameraBuffer;
      this.cameraComputeBindGroup = BindGroupFactory.createBindGroup(
        'rc_camera_compute_bindgroup',
        BindGroupFactory.getCameraComputeLayout(),
        [{ binding: 0, resource: { buffer: cameraBuffer } }],
      );
    }
    return this.cameraComputeBindGroup;
  }

  // ─── Internal: RCParams upload ────────────────────────────────────────────

  private uploadRCParams(
    cascadeIndex: number,
    cascadeCount: number,
    baseRange: number,
    maxSteps: number,
    raysPerProbe: number,
    intervalMultStart: number,
    intervalMultEnd: number,
    temporalBlend: number,
    cascadeResW: number,
    cascadeResH: number,
    screenW = Render.width,
    screenH = Render.height,
  ): void {
    const data = new Float32Array(RC_PARAMS_SIZE / 4);
    data[0] = cascadeIndex;
    data[1] = cascadeCount;
    data[2] = baseRange;
    data[3] = baseRange * intervalMultStart;
    data[4] = baseRange * intervalMultEnd;
    data[5] = raysPerProbe;
    data[6] = maxSteps;
    data[7] = temporalBlend;
    data[8] = cascadeResW;
    data[9] = cascadeResH;
    data[10] = screenW;
    data[11] = screenH;
    GPUUtils.getDevice().queue.writeBuffer(this.rcParamsBuffer, 0, data);
  }

  // ─── Internal: history copy ────────────────────────────────────────────────

  private copyHistory(encoder: GPUCommandEncoder, cascadeCount: number): void {
    if (!this.historyRT) return;

    const src2 = this.cascadeRT[cascadeCount - 2];
    const src3 = this.cascadeRT[cascadeCount - 1];

    encoder.copyTextureToTexture(
      { texture: src2.getTexture() },
      { texture: this.historyRT[0].getTexture() },
      { width: src2.getWidth(), height: src2.getHeight(), depthOrArrayLayers: 1 },
    );
    encoder.copyTextureToTexture(
      { texture: src3.getTexture() },
      { texture: this.historyRT[1].getTexture() },
      { width: src3.getWidth(), height: src3.getHeight(), depthOrArrayLayers: 1 },
    );
  }
}
