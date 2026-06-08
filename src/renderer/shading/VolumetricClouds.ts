import { Engine } from '../../core/engine/Engine';
import { Render } from '../core/pipeline/Render';
import { Mesh } from '../resources/Mesh';
import { Technique } from '../resources/Technique';
import { GPUUtils } from '../core/utils/GPUUtils';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { GPUProfiler } from '../../core/debug/GPUProfiler';
import { Wind } from '../../core/engine/Wind';

/**
 * VolumetricClouds — ray-marched cloud layer rendered as a post-skybox fullscreen pass.
 *
 * Renders into rtAccLight with alpha blending (blend: combinative) and depth-equal
 * test so clouds only appear on sky pixels (depth == 1.0), behind all geometry.
 *
 * Algorithm:
 *   - Flat slab cloud volume bounded by two horizontal planes (cloudBase / cloudTop)
 *   - Per-step: 3D procedural density (FBM + Worley), Beer-Lambert transmittance,
 *     6-step light march toward sun, Henyey-Greenstein dual-lobe phase, powder effect
 *   - 32 primary steps, early exit at transmittance < 0.01
 */
export class VolumetricClouds {
  private technique!: Technique;
  private quad!: Mesh;
  private uniformBuffer!: GPUBuffer;
  private bindGroup!: GPUBindGroup;

  // ── Parameters (tweakable via renderInMenu) ──────────────────────────────────
  public cloudBase: number = 800; // world-Y of cloud bottom (metres)
  public cloudTop: number = 2400; // world-Y of cloud top
  public coverage: number = 0.55; // [0 = sparse … 1 = overcast]
  public density: number = 4.0; // density multiplier
  public absorption: number = 0.12; // light absorption per unit density
  public scatterStrength: number = 1.5; // overall brightness scale
  public cloudFrequency: number = 0.00018; // noise spatial frequency (lower = bigger clouds)

  // Wind state (accumulated per frame)
  private windOffset: number = 0;
  private lastTime: number = 0;

  private static readonly UNIFORM_SIZE = 80; // 20 × f32

  public async load(): Promise<void> {
    this.quad = await Mesh.getAsync('fullscreenquad.obj');
    this.technique = await Technique.getAsync('lighting/volumetric_clouds.tech');

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
  }

  public render(rtAccLight: GPUTextureView, depthStencilView: GPUTextureView): void {
    this.uploadUniforms();

    const render = Render.getInstance();
    const colorAtt = GPUUtils.createColorAttachment(rtAccLight, 'load', 'store');
    const depthAtt = GPUUtils.createDepthStencilAttachment(depthStencilView, 'load', 'store');

    const desc = GPUUtils.createRenderPassDescriptor(
      'volumetric clouds pass',
      [colorAtt],
      depthAtt,
    );
    const ts = GPUProfiler.getInstance().getTimestampWrites('VolumetricClouds');
    if (ts) desc.timestampWrites = ts;

    const pass = render.getCommandEncoder().beginRenderPass(desc);
    GPUUtils.configureViewportAndScissor(pass);

    this.technique.activatePipeline(pass);
    this.quad.activate(pass);
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, this.bindGroup);
    this.quad.renderGroup(pass);
    pass.end();
  }

  private uploadUniforms(): void {
    const env = Engine.getEnvironmentManager();
    const sunDir = env.getSunDirection();
    const sunH = Math.max(0, sunDir[1]);

    // Sun color: warm orange at horizon → white at zenith
    const sunR = 1.0;
    const sunG = 0.5 + sunH * 0.5;
    const sunB = 0.3 + sunH * 0.68;
    const sunIntensity = 1.0 + sunH * 1.0;

    // Ambient sky color for cloud underside
    const ambR = 0.15 + sunH * 0.25;
    const ambG = 0.2 + sunH * 0.3;
    const ambB = 0.35 + sunH * 0.4;

    // Wind accumulation
    const now = performance.now() * 0.001;
    if (this.lastTime > 0) {
      this.windOffset += Wind.speed * (now - this.lastTime);
    }
    this.lastTime = now;

    // Struct layout — must match CloudUniforms in volumetric_clouds.fs exactly:
    //   [0..2]  sunDirection,  [3]     cloudBase
    //   [4..6]  sunColor,      [7]     cloudTop
    //   [8..10] windDirection, [11]    windOffset
    //   [12]    coverage,      [13]    density
    //   [14]    absorption,    [15]    scatterStrength
    //   [16..18] ambientColor, [19]    cloudFrequency
    const d = new Float32Array(20);
    d[0] = sunDir[0];
    d[1] = sunDir[1];
    d[2] = sunDir[2];
    d[3] = this.cloudBase;
    d[4] = sunR * sunIntensity;
    d[5] = sunG * sunIntensity;
    d[6] = sunB * sunIntensity;
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

    GPUUtils.getDevice().queue.writeBuffer(this.uniformBuffer, 0, d);
  }

  public renderInMenu(folder: any): void {
    const f = folder.addFolder('Volumetric Clouds');
    f.add(this, 'cloudBase', 0, 5000, 10).name('Base (m)');
    f.add(this, 'cloudTop', 100, 8000, 10).name('Top (m)');
    f.add(this, 'coverage', 0, 1, 0.01).name('Coverage');
    f.add(this, 'density', 0.1, 20, 0.1).name('Density');
    f.add(this, 'absorption', 0.01, 1, 0.01).name('Absorption');
    f.add(this, 'scatterStrength', 0.1, 5, 0.1).name('Scatter');
    f.add(this, 'cloudFrequency', 0.00001, 0.001, 0.00001).name('Frequency');
  }

  public dispose(): void {
    this.uniformBuffer?.destroy();
  }
}
