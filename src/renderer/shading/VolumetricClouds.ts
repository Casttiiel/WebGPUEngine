import { Engine } from '../../core/engine/Engine';
import { Render } from '../core/pipeline/Render';
import { Mesh } from '../resources/Mesh';
import { Technique } from '../resources/Technique';
import { GPUUtils } from '../core/utils/GPUUtils';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { GPUProfiler } from '../../core/debug/GPUProfiler';
import { Wind } from '../../core/engine/Wind';

/**
 * VolumetricClouds — ray-marched cloud layer rendered as a post-skybox pass.
 *
 * Two-pass approach for performance:
 *   Pass 1 (half-res): ray-march clouds into a private RGBA16F texture at 50 % resolution.
 *            No depth attachment — the cloud shader returns transparent on non-sky rays.
 *   Pass 2 (full-res composite): bilinearly upscale the half-res cloud texture onto rtAccLight.
 *            Uses depth-equal test so the composite only runs on sky pixels (depth == 1.0),
 *            preventing clouds from bleeding over foreground geometry.
 *
 * Net effect: 4× fewer cloud fragments → ~4× GPU speedup from resolution reduction alone.
 */
export class VolumetricClouds {
  private technique!: Technique;
  private compositeTechnique!: Technique;
  private quad!: Mesh;
  private uniformBuffer!: GPUBuffer;
  private bindGroup!: GPUBindGroup;
  private compositeSampler!: GPUSampler;

  // Half-res render target (recreated on resize)
  private cloudHalfResTexture: GPUTexture | null = null;
  private cloudHalfResView: GPUTextureView | null = null;
  private compositeBindGroup: GPUBindGroup | null = null;
  private lastHalfW = 0;
  private lastHalfH = 0;

  // ── Parameters (tweakable via renderInMenu) ──────────────────────────────────
  public cloudBase: number = 500; // world-Y of cloud bottom (metres)
  public cloudTop: number = 1300; // world-Y of cloud top  (800 m slab)
  public coverage: number = 0.55; // [0 = sparse … 1 = overcast]
  public density: number = 1.2; // density multiplier
  public absorption: number = 0.04; // light absorption per unit density
  public scatterStrength: number = 4.0; // overall brightness scale
  public cloudFrequency: number = 0.00022; // noise spatial frequency (lower = bigger clouds)
  // Quality / style
  public stepCount: number = 64; // primary ray-march steps (perf vs quality)
  public lightSteps: number = 5; // shadow ray steps per sample
  public warpStrength: number = 0.35; // domain-warp intensity (0 = no warp)
  public worleyWeight: number = 0.35; // Worley contribution in base shape (0 = pure value noise)
  public fadeRadius: number = 25000; // horizontal radius beyond which clouds fade out (metres)
  public resolutionDivisor: number = 4; // render clouds at 1/N screen resolution (1=full, 2=half, 4=quarter…)

  // Wind state (accumulated per frame)
  private windOffset: number = 0;
  private lastTime: number = 0;

  private static readonly UNIFORM_SIZE = 112; // 28 × f32  (must be multiple of 16)

  public async load(): Promise<void> {
    this.quad = await Mesh.getAsync('fullscreenquad.obj');
    this.technique = await Technique.getAsync('lighting/volumetric_clouds.tech');
    this.compositeTechnique = await Technique.getAsync('lighting/volumetric_clouds_composite.tech');

    this.uniformBuffer = GPUUtils.createBuffer(
      'volumetric_clouds_uniforms',
      VolumetricClouds.UNIFORM_SIZE,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.bindGroup = BindGroupFactory.createBindGroup(
      'volumetric_clouds_bindgroup',
      this.technique.getPipeline().getBindGroupLayout(1)!,
      [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    );

    this.compositeSampler = GPUUtils.getDevice().createSampler({
      label: 'cloud_composite_sampler',
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }

  public render(rtAccLight: GPUTextureView, depthStencilView: GPUTextureView): void {
    this.uploadUniforms();

    const div = Math.max(1, Math.round(this.resolutionDivisor));
    const halfW = Math.max(1, Math.floor(Render.width / div));
    const halfH = Math.max(1, Math.floor(Render.height / div));

    // Recreate texture whenever the render resolution or divisor changes
    if (halfW !== this.lastHalfW || halfH !== this.lastHalfH || !this.cloudHalfResTexture) {
      this.cloudHalfResTexture?.destroy();
      this.cloudHalfResTexture = GPUUtils.getDevice().createTexture({
        label: 'cloud_lowres',
        size: [halfW, halfH],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.cloudHalfResView = this.cloudHalfResTexture.createView({ label: 'cloud_halfres_view' });
      this.lastHalfW = halfW;
      this.lastHalfH = halfH;
      this.compositeBindGroup = null; // force rebuild below
    }

    if (!this.compositeBindGroup) {
      this.compositeBindGroup = BindGroupFactory.createBindGroup(
        'cloud_composite_bindgroup',
        this.compositeTechnique.getPipeline().getBindGroupLayout(1)!,
        [
          { binding: 0, resource: this.cloudHalfResView! },
          { binding: 1, resource: this.compositeSampler },
        ],
      );
    }

    const render = Render.getInstance();

    // ── Pass 1: ray-march clouds at half resolution (no depth attachment) ─────
    const cloudColorAtt: GPURenderPassColorAttachment = {
      view: this.cloudHalfResView!,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    };
    const cloudDesc: GPURenderPassDescriptor = {
      label: 'volumetric clouds half-res',
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

    // ── Pass 2: composite half-res cloud texture onto rtAccLight ──────────────
    // depth-equal test (z: test_equal in tech) ensures only sky pixels are touched
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

    const compositePass = render.getCommandEncoder().beginRenderPass(compositeDesc);
    GPUUtils.configureViewportAndScissor(compositePass);
    this.compositeTechnique.activatePipeline(compositePass);
    this.quad.activate(compositePass);
    compositePass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    compositePass.setBindGroup(1, this.compositeBindGroup);
    this.quad.renderGroup(compositePass);
    compositePass.end();
  }

  private uploadUniforms(): void {
    const env = Engine.getEnvironmentManager();
    const sunDir = env.getSunDirection();
    const sunH = sunDir[1]; // real value, may be negative at night
    const sunHAbove = Math.max(0, sunH); // used only for above-horizon color gradient

    // night_factor: mirrors skybox_scattering.fs smoothstep(0.1, -0.2, sun_height)
    // 0 = full day, 1 = full night
    const nightFactor = Math.max(0, Math.min(1, (0.1 - sunH) / 0.3));

    // Sunlight: warm orange at horizon → warm white at zenith, fades to zero at night
    const dayIntensity = (1.0 + sunHAbove) * (1.0 - nightFactor);
    const sunR = dayIntensity;
    const sunG = (0.5 + sunHAbove * 0.5) * dayIntensity;
    const sunB = (0.3 + sunHAbove * 0.68) * dayIntensity;

    // Moonlight: cool dim blue only at night (matches skybox moon color)
    const moonI = nightFactor * 0.05;
    const moonR = 0.75 * moonI;
    const moonG = 0.82 * moonI;
    const moonB = 0.9 * moonI;

    // Ambient sky color for cloud underside, weakens at night
    const ambScale = 1.0 - nightFactor * 0.88;
    const ambR = (0.15 + sunHAbove * 0.25) * ambScale;
    const ambG = (0.2 + sunHAbove * 0.3) * ambScale;
    const ambB = (0.35 + sunHAbove * 0.4) * ambScale;

    // Wind accumulation.
    // Wind.speed está calibrado en unidades UV/s para el skybox 2D.
    // Para nubes 3D en espacio mundo (cloudFrequency ≈ 0.00022), necesitamos metros/s reales.
    // El factor 200 convierte: Wind.speed=0.08 → ~16 m/s, Wind.speed=0.5 → ~100 m/s.
    const CLOUD_WIND_SCALE = 200.0;
    const now = performance.now() * 0.001;
    if (this.lastTime > 0) {
      this.windOffset += Wind.speed * CLOUD_WIND_SCALE * (now - this.lastTime);
    }
    this.lastTime = now;

    // Struct layout — must match CloudUniforms in volumetric_clouds.fs exactly:
    //   [0..2]  sunDirection,  [3]     cloudBase
    //   [4..6]  sunColor,      [7]     cloudTop
    //   [8..10] windDirection, [11]    windOffset
    //   [12]    coverage,      [13]    density
    //   [14]    absorption,    [15]    scatterStrength
    //   [16..18] ambientColor, [19]    cloudFrequency
    //   [20]    stepCount,     [21]    lightSteps
    //   [22]    warpStrength,  [23]    worleyWeight
    //   [24]    fadeRadius,    [25..27] (padding)
    const d = new Float32Array(28);
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
    // d[25..27] padding = 0 (Float32Array default)

    GPUUtils.getDevice().queue.writeBuffer(this.uniformBuffer, 0, d);
  }

  public renderInMenu(folder: any): void {
    const f = folder.addFolder('Volumetric Clouds');
    // Shape
    f.add(this, 'cloudBase', 0, 5000, 10).name('Base (m)');
    f.add(this, 'cloudTop', 100, 8000, 10).name('Top (m)');
    f.add(this, 'coverage', 0, 1, 0.01).name('Coverage');
    f.add(this, 'cloudFrequency', 0.00001, 0.001, 0.00001).name('Frequency');
    f.add(this, 'warpStrength', 0, 1, 0.01).name('Warp strength');
    f.add(this, 'worleyWeight', 0, 1, 0.01).name('Worley weight');
    // Lighting
    f.add(this, 'density', 0.1, 5, 0.1).name('Density');
    f.add(this, 'absorption', 0.01, 1, 0.01).name('Absorption');
    f.add(this, 'scatterStrength', 0.1, 50, 0.1).name('Scatter');
    // Performance
    f.add(this, 'stepCount', 16, 128, 1).name('Steps (quality)');
    f.add(this, 'lightSteps', 2, 12, 1).name('Light steps');
    // Render distance
    f.add(this, 'fadeRadius', 1000, 80000, 500).name('Fade radius (m)');
    // Resolution
    f.add(this, 'resolutionDivisor', 1, 8, 1).name('Resolution (1/N)');
  }

  public dispose(): void {
    this.uniformBuffer?.destroy();
    this.cloudHalfResTexture?.destroy();
  }
}
