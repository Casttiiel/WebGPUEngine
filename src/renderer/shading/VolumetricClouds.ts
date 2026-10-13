import { Engine } from '../../core/engine/Engine';
import { Render } from '../core/pipeline/Render';
import { Mesh } from '../resources/Mesh';
import { Technique } from '../resources/Technique';
import { GPUUtils } from '../core/utils/GPUUtils';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { GPUProfiler } from '../../core/debug/GPUProfiler';
import { Wind } from '../../core/engine/Wind';
import { CameraComponent } from '../../components/render/CameraComponent';
import { ResourceManager } from '../../core/engine/ResourceManager';

/**
 * VolumetricClouds — ray-marched cloud layer with temporal accumulation.
 *
 * Noise: all procedural noise is baked once at load by a compute shader into
 * tileable textures (128³ shape, 32³ detail, 512² weather) sampled with 'repeat'.
 * The clouds move because the ray-march offsets the sample coordinates by the
 * accumulated wind — the textures themselves never change.
 *
 * Three-pass approach:
 *   Pass 1 (1/N res): ray-march clouds into cloudCurrentTex.  The ray of each
 *           low-res texel is jittered per frame (Halton) so that, over N² frames,
 *           every full-res sub-pixel gets ray-marched.
 *   Pass 2 (full res): temporal resolve — un-jitter currentTex, reproject
 *           previous-frame world positions via prevViewProj, clamp history to the
 *           neighbourhood, blend (weighted by distance to this frame's sample) and
 *           write to cloudHistoryTex[current].
 *   Pass 3 (full res): composite — copy cloudHistoryTex[current] onto rtAccLight
 *           using depth-equal so only sky pixels are touched.
 *
 * Result: close to full-resolution detail on stable regions while spending only
 * 1/N² fragment work per frame.
 */
export class VolumetricClouds {
  private technique!: Technique;
  private compositeTechnique!: Technique;
  private temporalTechnique!: Technique;
  private quad!: Mesh;

  // ── Cloud ray-march uniforms (group 1 of the ray-march pass) ─────────────
  private uniformBuffer!: GPUBuffer;
  private bindGroup!: GPUBindGroup;

  // ── Temporal resolve uniforms ─────────────────────────────────────────────
  private temporalUniformBuffer!: GPUBuffer;

  // ── Samplers ──────────────────────────────────────────────────────────────
  private cloudSampler!: GPUSampler;
  private noiseSampler!: GPUSampler;

  // ── Baked noise (generated once in load()) ────────────────────────────────
  private shapeNoiseTex!: GPUTexture; // 128³ rgba8: perlin fBm + 3 worley fBm
  private detailNoiseTex!: GPUTexture; // 32³ rgba8: 3 worley fBm (edge erosion)
  private weatherTex!: GPUTexture; // 512² rgba8: regional coverage + column top height
  private static readonly SHAPE_SIZE = 128;
  private static readonly DETAIL_SIZE = 32;
  private static readonly WEATHER_SIZE = 512;

  // ── Low-res ray-march output (recreated on resize or divisor change) ──────
  private cloudCurrentTex: GPUTexture | null = null;
  private cloudCurrentView: GPUTextureView | null = null;
  private lastHalfW = 0;
  private lastHalfH = 0;

  // ── Full-res temporal history ping-pong ───────────────────────────────────
  // Frame N reads historyTex[N%2], writes historyTex[(N+1)%2].
  private historyTex: [GPUTexture | null, GPUTexture | null] = [null, null];
  private historyView: [GPUTextureView | null, GPUTextureView | null] = [null, null];
  private lastFullW = 0;
  private lastFullH = 0;

  // Bind groups rebuilt when textures change
  private temporalBindGroup: [GPUBindGroup | null, GPUBindGroup | null] = [null, null];
  private compositeBindGroup: [GPUBindGroup | null, GPUBindGroup | null] = [null, null];

  // ── Per-frame state ───────────────────────────────────────────────────────
  private frameIndex: number = 0;
  private prevViewProj: Float32Array = new Float32Array(16);

  // ── Parameters (tweakable via renderInMenu) ───────────────────────────────
  public cloudBase: number = 500; // world-Y of cloud bottom (metres)
  public cloudTop: number = 1300; // world-Y of cloud top   (670 m slab)
  public coverage: number = 0.58; // [0 = sparse … 1 = overcast]
  public density: number = 1.2;
  public absorption: number = 0.03;
  public scatterStrength: number = 30.0;
  public cloudFrequency: number = 0.001;
  // Quality / style
  public stepCount: number = 64;
  public lightSteps: number = 5;
  public warpStrength: number = 0.35;
  public worleyWeight: number = 0.35;
  public detailStrength: number = 0.6;
  public detailFrequency: number = 16;
  public fadeRadius: number = 11000;
  public resolutionDivisor: number = 4;
  // Temporal
  public blendFactor: number = 0.07;

  // Sub-pixel jitter of the current frame (low-res pixels, [-0.5, 0.5])
  private jitterX: number = 0;
  private jitterY: number = 0;

  // Reused upload scratch (no per-frame allocations)
  private readonly cloudData = new Float32Array(VolumetricClouds.UNIFORM_SIZE / 4);
  private readonly temporalData = new Float32Array(VolumetricClouds.TEMPORAL_SIZE / 4);

  // Wind state
  private windOffset: number = 0;
  private lastTime: number = 0;

  private static readonly UNIFORM_SIZE = 128; // cloud ray-march uniforms: 32 × f32
  private static readonly TEMPORAL_SIZE = 80; // temporal uniforms: mat4(64) + 4×f32(16)

  public async load(): Promise<void> {
    this.quad = await Mesh.getAsync('fullscreenquad.obj');
    this.technique = await Technique.getAsync('lighting/volumetric_clouds.tech');
    this.compositeTechnique = await Technique.getAsync('lighting/volumetric_clouds_composite.tech');
    this.temporalTechnique = await Technique.getAsync('lighting/volumetric_clouds_temporal.tech');

    this.uniformBuffer = GPUUtils.createBuffer(
      'volumetric_clouds_uniforms',
      VolumetricClouds.UNIFORM_SIZE,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.temporalUniformBuffer = GPUUtils.createBuffer(
      'volumetric_clouds_temporal_uniforms',
      VolumetricClouds.TEMPORAL_SIZE,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.cloudSampler = GPUUtils.getDevice().createSampler({
      label: 'cloud_sampler',
      magFilter: 'linear',
      minFilter: 'linear',
    });

    this.noiseSampler = GPUUtils.getDevice().createSampler({
      label: 'cloud_noise_sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
    });

    await this.bakeNoise();

    this.bindGroup = BindGroupFactory.createBindGroup(
      'volumetric_clouds_bindgroup',
      this.technique.getPipeline().getBindGroupLayout(1)!,
      [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.shapeNoiseTex.createView({ dimension: '3d' }) },
        { binding: 2, resource: this.detailNoiseTex.createView({ dimension: '3d' }) },
        { binding: 3, resource: this.weatherTex.createView() },
        { binding: 4, resource: this.noiseSampler },
      ],
    );
  }

  /** Bakes the tileable cloud noise textures with a one-off compute dispatch. */
  private async bakeNoise(): Promise<void> {
    const device = GPUUtils.getDevice();
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    const S = VolumetricClouds.SHAPE_SIZE;
    const D = VolumetricClouds.DETAIL_SIZE;
    const W = VolumetricClouds.WEATHER_SIZE;

    this.shapeNoiseTex = device.createTexture({
      label: 'cloud_shape_noise',
      size: [S, S, S],
      dimension: '3d',
      format: 'rgba8unorm',
      usage,
    });
    this.detailNoiseTex = device.createTexture({
      label: 'cloud_detail_noise',
      size: [D, D, D],
      dimension: '3d',
      format: 'rgba8unorm',
      usage,
    });
    this.weatherTex = device.createTexture({
      label: 'cloud_weather',
      size: [W, W],
      format: 'rgba8unorm',
      usage,
    });

    const code = await ResourceManager.loadShader('lighting/volumetric_clouds_noise.compute.wgsl');
    const module = device.createShaderModule({ label: 'cloud_noise_bake', code });
    const storage3d: GPUStorageTextureBindingLayout = {
      access: 'write-only',
      format: 'rgba8unorm',
      viewDimension: '3d',
    };
    const layout = device.createBindGroupLayout({
      label: 'cloud_noise_bake_layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: storage3d },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: storage3d },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
        },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({
      label: 'cloud_noise_bake_pipeline_layout',
      bindGroupLayouts: [layout],
    });
    const makePipeline = (entryPoint: string): GPUComputePipeline =>
      device.createComputePipeline({
        label: `cloud_noise_${entryPoint}`,
        layout: pipelineLayout,
        compute: { module, entryPoint },
      });
    const bindGroup = device.createBindGroup({
      label: 'cloud_noise_bake_bg',
      layout,
      entries: [
        { binding: 0, resource: this.shapeNoiseTex.createView({ dimension: '3d' }) },
        { binding: 1, resource: this.detailNoiseTex.createView({ dimension: '3d' }) },
        { binding: 2, resource: this.weatherTex.createView() },
      ],
    });

    const encoder = device.createCommandEncoder({ label: 'cloud_noise_bake' });
    const pass = encoder.beginComputePass({ label: 'cloud noise bake' });
    pass.setBindGroup(0, bindGroup);
    pass.setPipeline(makePipeline('bakeShape'));
    pass.dispatchWorkgroups(S / 4, S / 4, S / 4);
    pass.setPipeline(makePipeline('bakeDetail'));
    pass.dispatchWorkgroups(D / 4, D / 4, D / 4);
    pass.setPipeline(makePipeline('bakeWeather'));
    pass.dispatchWorkgroups(W / 8, W / 8, 1);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  /** Halton low-discrepancy sequence, base b, 1-based index. */
  private static halton(index: number, base: number): number {
    let f = 1;
    let r = 0;
    let i = index;
    while (i > 0) {
      f /= base;
      r += f * (i % base);
      i = Math.floor(i / base);
    }
    return r;
  }

  /** environment.json "clouds.volumetric" overrides are applied once, on the first render. */
  private settingsApplied = false;

  private applyEnvironmentSettings(): void {
    const s = Engine.getEnvironmentManager().getVolumetricCloudSettings();
    if (s.base !== undefined) this.cloudBase = s.base;
    if (s.top !== undefined) this.cloudTop = s.top;
    if (s.coverage !== undefined) this.coverage = s.coverage;
    if (s.density !== undefined) this.density = s.density;
    if (s.absorption !== undefined) this.absorption = s.absorption;
    if (s.scatterStrength !== undefined) this.scatterStrength = s.scatterStrength;
    if (s.frequency !== undefined) this.cloudFrequency = s.frequency;
    if (s.stepCount !== undefined) this.stepCount = s.stepCount;
    if (s.lightSteps !== undefined) this.lightSteps = s.lightSteps;
    if (s.fadeRadius !== undefined) this.fadeRadius = s.fadeRadius;
    if (s.resolutionDivisor !== undefined) this.resolutionDivisor = s.resolutionDivisor;
    this.settingsApplied = true;
  }

  public render(rtAccLight: GPUTextureView, depthStencilView: GPUTextureView): void {
    // Only when environment.json selects volumetric clouds (switchable at runtime)
    if (Engine.getEnvironmentManager().getCloudsType() !== 'volumetric') return;
    if (!this.settingsApplied) this.applyEnvironmentSettings();

    const div = Math.max(1, Math.round(this.resolutionDivisor));
    const halfW = Math.max(1, Math.floor(Render.width / div));
    const halfH = Math.max(1, Math.floor(Render.height / div));
    const fullW = Render.width;
    const fullH = Render.height;

    // Jitter cycle long enough to visit every full-res sub-pixel of a low-res texel.
    const cycle = Math.min(64, Math.max(4, div * div));
    const hIdx = (this.frameIndex % cycle) + 1;
    this.jitterX = div > 1 ? VolumetricClouds.halton(hIdx, 2) - 0.5 : 0;
    this.jitterY = div > 1 ? VolumetricClouds.halton(hIdx, 3) - 0.5 : 0;

    this.uploadCloudUniforms(halfW, halfH);

    // ── Recreate low-res current texture when size changes ───────────────────
    if (halfW !== this.lastHalfW || halfH !== this.lastHalfH || !this.cloudCurrentTex) {
      this.cloudCurrentTex?.destroy();
      this.cloudCurrentTex = GPUUtils.getDevice().createTexture({
        label: 'cloud_current',
        size: [halfW, halfH],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.cloudCurrentView = this.cloudCurrentTex.createView({ label: 'cloud_current_view' });
      this.lastHalfW = halfW;
      this.lastHalfH = halfH;
      // Temporal bind groups depend on cloudCurrentTex — invalidate them.
      this.temporalBindGroup = [null, null];
      this.compositeBindGroup = [null, null];
    }

    // ── Recreate full-res history textures when screen size changes ──────────
    if (
      fullW !== this.lastFullW ||
      fullH !== this.lastFullH ||
      !this.historyTex[0] ||
      !this.historyTex[1]
    ) {
      this.historyTex[0]?.destroy();
      this.historyTex[1]?.destroy();
      for (let i = 0; i < 2; i++) {
        this.historyTex[i] = GPUUtils.getDevice().createTexture({
          label: `cloud_history_${i}`,
          size: [fullW, fullH],
          format: 'rgba16float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.historyView[i] = this.historyTex[i]!.createView({ label: `cloud_history_view_${i}` });
      }
      this.lastFullW = fullW;
      this.lastFullH = fullH;
      this.temporalBindGroup = [null, null];
      this.compositeBindGroup = [null, null];
      this.frameIndex = 0; // reset history on resize
    }

    const prevIdx = this.frameIndex % 2;
    const currIdx = (this.frameIndex + 1) % 2;

    // ── Build bind groups (once per texture set) ─────────────────────────────
    if (!this.temporalBindGroup[0] || !this.temporalBindGroup[1]) {
      const temporalLayout = this.temporalTechnique.getBindGroupLayout(1)!;
      for (let i = 0; i < 2; i++) {
        const prevI = i;
        this.temporalBindGroup[i] = BindGroupFactory.createBindGroup(
          `cloud_temporal_bg_${i}`,
          temporalLayout,
          [
            { binding: 0, resource: this.cloudCurrentView! },
            { binding: 1, resource: this.historyView[prevI]! },
            { binding: 2, resource: this.cloudSampler },
            { binding: 3, resource: { buffer: this.temporalUniformBuffer } },
          ],
        );
      }
    }

    if (!this.compositeBindGroup[0] || !this.compositeBindGroup[1]) {
      const compositeLayout = this.compositeTechnique.getPipeline().getBindGroupLayout(1)!;
      for (let i = 0; i < 2; i++) {
        this.compositeBindGroup[i] = BindGroupFactory.createBindGroup(
          `cloud_composite_bg_${i}`,
          compositeLayout,
          [
            { binding: 0, resource: this.historyView[i]! },
            { binding: 1, resource: this.cloudSampler },
          ],
        );
      }
    }

    this.uploadTemporalUniforms();

    const render = Render.getInstance();

    // ── Pass 1: ray-march clouds at 1/N resolution ────────────────────────────
    const cloudColorAtt: GPURenderPassColorAttachment = {
      view: this.cloudCurrentView!,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    };
    const cloudDesc: GPURenderPassDescriptor = {
      label: 'volumetric clouds ray-march',
      colorAttachments: [cloudColorAtt],
    };
    const ts = GPUProfiler.getInstance().getTimestampWrites('VolumetricClouds');
    if (ts) cloudDesc.timestampWrites = ts;

    const cloudPass = render.getCommandEncoder().beginRenderPass(cloudDesc);
    GPUUtils.configureViewportAndScissor(cloudPass, halfW, halfH);
    this.technique.activatePipeline(cloudPass);
    this.quad.activate(cloudPass);
    cloudPass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    cloudPass.setBindGroup(1, this.bindGroup);
    this.quad.renderGroup(cloudPass);
    cloudPass.end();

    // ── Pass 2: temporal resolve — reads currentTex + prevHistory, writes currHistory
    const temporalColorAtt: GPURenderPassColorAttachment = {
      view: this.historyView[currIdx]!,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    };
    const temporalDesc: GPURenderPassDescriptor = {
      label: 'volumetric clouds temporal resolve',
      colorAttachments: [temporalColorAtt],
    };

    const temporalTs = GPUProfiler.getInstance().getTimestampWrites('VolumetricClouds Temporal');
    if (temporalTs) temporalDesc.timestampWrites = temporalTs;
    const temporalPass = render.getCommandEncoder().beginRenderPass(temporalDesc);
    GPUUtils.configureViewportAndScissor(temporalPass, fullW, fullH);
    this.temporalTechnique.activatePipeline(temporalPass);
    this.quad.activate(temporalPass);
    temporalPass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    temporalPass.setBindGroup(1, this.temporalBindGroup[prevIdx]!);
    this.quad.renderGroup(temporalPass);
    temporalPass.end();

    // ── Pass 3: composite — copy currHistory onto rtAccLight (sky pixels only) ──
    const compositeColorAtt = GPUUtils.createColorAttachment(rtAccLight, 'load', 'store');
    const compositeDepthAtt = GPUUtils.createDepthStencilAttachment(
      depthStencilView,
      'load',
      'store',
    );
    const compositeDesc = GPUUtils.createRenderPassDescriptor(
      'cloud composite pass',
      [compositeColorAtt],
      compositeDepthAtt,
    );

    const compositeTs = GPUProfiler.getInstance().getTimestampWrites('VolumetricClouds Composite');
    if (compositeTs) compositeDesc.timestampWrites = compositeTs;
    const compositePass = render.getCommandEncoder().beginRenderPass(compositeDesc);
    GPUUtils.configureViewportAndScissor(compositePass);
    this.compositeTechnique.activatePipeline(compositePass);
    this.quad.activate(compositePass);
    compositePass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    compositePass.setBindGroup(1, this.compositeBindGroup[currIdx]!);
    this.quad.renderGroup(compositePass);
    compositePass.end();

    // Store current VP for next frame's reprojection, then advance frame counter.
    this.storePrevViewProj();
    this.frameIndex++;
  }

  // ── Uniform uploads ────────────────────────────────────────────────────────

  private uploadCloudUniforms(lowResW: number, lowResH: number): void {
    const env = Engine.getEnvironmentManager();
    const sunDir = env.getSunDirection();
    const sunH = sunDir[1];
    const sunHAbove = Math.max(0, sunH);
    const nightFactor = Math.max(0, Math.min(1, (0.1 - sunH) / 0.3));

    const dayIntensity = (1.0 + sunHAbove) * (1.0 - nightFactor);
    const sunR = dayIntensity;
    const sunG = (0.5 + sunHAbove * 0.5) * dayIntensity;
    const sunB = (0.3 + sunHAbove * 0.68) * dayIntensity;

    const moonI = nightFactor * 0.05;
    const moonR = 0.75 * moonI;
    const moonG = 0.82 * moonI;
    const moonB = 0.9 * moonI;

    const ambScale = 1.0 - nightFactor * 0.88;
    const ambR = (0.15 + sunHAbove * 0.25) * ambScale;
    const ambG = (0.2 + sunHAbove * 0.3) * ambScale;
    const ambB = (0.35 + sunHAbove * 0.4) * ambScale;

    const CLOUD_WIND_SCALE = 200.0;
    const now = performance.now() * 0.001;
    if (this.lastTime > 0) {
      this.windOffset += Wind.speed * CLOUD_WIND_SCALE * (now - this.lastTime);
    }
    this.lastTime = now;

    const d = this.cloudData;
    d[0] = sunDir[0];
    d[1] = sunDir[1];
    d[2] = sunDir[2];
    d[3] = this.cloudBase;
    d[4] = sunR + moonR;
    d[5] = sunG + moonG;
    d[6] = sunB + moonB;
    d[7] = this.cloudTop;
    d[8] = Wind.getDirX();
    d[9] = 0;
    d[10] = Wind.getDirZ();
    d[11] = this.windOffset;
    d[12] = this.coverage;
    d[13] = this.density;
    d[14] = this.absorption;
    d[15] = this.scatterStrength;
    d[16] = ambR;
    d[17] = ambG;
    d[18] = ambB;
    d[19] = this.cloudFrequency;
    d[20] = this.stepCount;
    d[21] = this.lightSteps;
    d[22] = this.warpStrength;
    d[23] = this.worleyWeight;
    d[24] = this.fadeRadius;
    d[25] = this.frameIndex % 4096;
    d[26] = this.jitterX;
    d[27] = this.jitterY;
    d[28] = lowResW;
    d[29] = lowResH;
    d[30] = this.detailStrength;
    d[31] = this.detailFrequency;

    GPUUtils.getDevice().queue.writeBuffer(this.uniformBuffer, 0, d);
  }

  private uploadTemporalUniforms(): void {
    const d = this.temporalData; // 80 bytes

    // prevViewProj: 16 floats at offset 0
    d.set(this.prevViewProj, 0);

    // blendFactor and cloudMid at offsets 16 and 17
    d[16] = this.blendFactor;
    d[17] = (this.cloudBase + this.cloudTop) * 0.5;
    d[18] = this.jitterX;
    d[19] = this.jitterY;

    GPUUtils.getDevice().queue.writeBuffer(this.temporalUniformBuffer, 0, d);
  }

  private storePrevViewProj(): void {
    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    if (!mainCamera) return;
    const camComp = mainCamera.getComponent('camera') as CameraComponent | null;
    if (!camComp) return;
    const vp = camComp.getCamera().getViewProjection();
    this.prevViewProj.set(vp as Float32Array);
  }

  // ── Menu ───────────────────────────────────────────────────────────────────

  public renderInMenu(folder: any): void {
    const f = folder.addFolder('Volumetric Clouds');
    f.close();
    f.add(this, 'cloudBase', 0, 5000, 10).name('Base (m)');
    f.add(this, 'cloudTop', 100, 8000, 10).name('Top (m)');
    f.add(this, 'coverage', 0, 1, 0.01).name('Coverage');
    f.add(this, 'cloudFrequency', 0.00001, 0.001, 0.00001).name('Frequency');
    f.add(this, 'warpStrength', 0, 1, 0.01).name('Warp strength');
    f.add(this, 'worleyWeight', 0, 1, 0.01).name('Worley weight');
    f.add(this, 'detailStrength', 0, 1, 0.01).name('Detail erosion');
    f.add(this, 'detailFrequency', 2, 40, 1).name('Detail frequency');
    f.add(this, 'density', 0.1, 5, 0.1).name('Density');
    f.add(this, 'absorption', 0.01, 1, 0.01).name('Absorption');
    f.add(this, 'scatterStrength', 0.1, 50, 0.1).name('Scatter');
    f.add(this, 'stepCount', 16, 128, 1).name('Steps (quality)');
    f.add(this, 'lightSteps', 2, 12, 1).name('Light steps');
    f.add(this, 'fadeRadius', 1000, 80000, 500).name('Fade radius (m)');
    f.add(this, 'resolutionDivisor', 1, 8, 1).name('Resolution (1/N)');
    f.add(this, 'blendFactor', 0.02, 0.3, 0.01).name('Temporal blend');
  }

  public dispose(): void {
    this.uniformBuffer?.destroy();
    this.temporalUniformBuffer?.destroy();
    this.cloudCurrentTex?.destroy();
    this.historyTex[0]?.destroy();
    this.historyTex[1]?.destroy();
    this.shapeNoiseTex?.destroy();
    this.detailNoiseTex?.destroy();
    this.weatherTex?.destroy();
  }
}
