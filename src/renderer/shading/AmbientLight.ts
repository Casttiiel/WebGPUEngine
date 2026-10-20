import { Engine } from '../../core/engine/Engine';
import { Render } from '../core/pipeline/Render';
import { Mesh } from '../resources/Mesh';
import { Technique } from '../resources/Technique';
import { GPUUtils } from '../core/utils/GPUUtils';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { Texture } from '../resources/Texture';
import { GPUProfiler } from '../../core/debug/GPUProfiler';
import { ProbeManager } from '../core/managers/ProbeManager';

export class AmbientLight {
  private fullscreenQuadMesh!: Mesh;

  private ambientDiffuseTechnique!: Technique;
  /** Cached per-aoResult — allows main scene (real AO) and water (white) to coexist without thrashing. */
  private ambientDiffuseBindGroupCache = new Map<GPUTextureView, GPUBindGroup>();
  private ambientDiffuseUniformBuffer!: GPUBuffer;

  private ambientSpecularTechnique!: Technique;
  private ambientSpecularBindGroup!: GPUBindGroup;
  private ambientSpecularUniformBuffer!: GPUBuffer;

  // Diffuse uniform: [0] globalBoost  [1] diffuseBoost  [2..7] padding.
  // Irradiance comes per pixel from ProbeManager's ProbeSet (common/probes.wgsl).
  private ambientDiffuseUniformArray = new Float32Array(8);
  private ambientSpecularUniformArray = new Float32Array(12);
  /** When true, ambient_specular.fs takes the specular radiance from SSR instead of the IBL. */
  private ssrActive = false;

  /** Specular bind groups keyed by SSR view; cleared when the probe resources change. */
  private specularBindGroupCache = new Map<GPUTextureView, GPUBindGroup>();
  private lastProbeEnv: GPUTextureView | null = null;
  private lastProbeBuffer: GPUBuffer | null = null;

  /** No-op kept for the bake code: the bake now hides probes through ProbeManager. */
  public static setBakingMode(_enabled: boolean): void {}

  private brdfLUT!: Texture;

  constructor() {}

  public async load(): Promise<void> {
    try {
      this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
      this.ambientDiffuseTechnique = await Technique.getAsync('lighting/ambient.tech');

      this.ambientDiffuseUniformBuffer = GPUUtils.createBuffer(
        'ambient diffuse uniform buffer',
        32,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );

      this.ambientSpecularTechnique = await Technique.getAsync('lighting/ambient_specular.tech');
      this.brdfLUT = await Texture.getAsync('brdfLUT.png');

      this.ambientSpecularUniformBuffer = GPUUtils.createBuffer(
        'ambient specular uniform buffer',
        48,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );
    } catch (e) {
      console.error('[AmbientLight] load() FAILED:', e);
    }
  }

  public renderDiffuse(
    rtAccLight: GPUTextureView,
    gBufferBindGroup: GPUBindGroup,
    aoResult: GPUTextureView,
  ): void {
    // The probe buffer is rewritten in place every frame — bind group is stable per aoResult.
    let diffuseBG = this.ambientDiffuseBindGroupCache.get(aoResult);
    if (!diffuseBG) {
      diffuseBG = this.createAmbientDiffuseBindGroup(aoResult);
      this.ambientDiffuseBindGroupCache.set(aoResult, diffuseBG);
    }
    const render = Render.getInstance();

    // Use GPUUtils for consistent render pass descriptor creation
    const colorAttachment = GPUUtils.createColorAttachment(rtAccLight, 'clear', 'store');

    const ambDiffDesc = GPUUtils.createRenderPassDescriptor('ambient light render pass', [
      colorAttachment,
    ]);
    const ambDiffTs = GPUProfiler.getInstance().getTimestampWrites('Ambient Diffuse');
    if (ambDiffTs) ambDiffDesc.timestampWrites = ambDiffTs;
    const pass = render.getCommandEncoder().beginRenderPass(ambDiffDesc);

    // Configure viewport and scissor using GPUUtils
    GPUUtils.configureViewportAndScissor(pass);

    // 1. Activate pipeline
    this.ambientDiffuseTechnique.activatePipeline(pass);

    // 2. Activate mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Set bind groups
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, gBufferBindGroup);
    pass.setBindGroup(2, diffuseBG);

    // 4. Draw the mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }

  public renderSpecular(
    accLights: GPUTextureView,
    ssr: GPUTextureView,
    ao: GPUTextureView,
    gBufferBindGroup: GPUBindGroup,
  ): void {
    if (!this.ambientSpecularUniformBuffer) return;
    const probes = ProbeManager.getInstance();
    const probeEnv = probes.getEnvArrayView();
    const probeBuffer = probes.getProbeSetBuffer();
    if (probeEnv !== this.lastProbeEnv || probeBuffer !== this.lastProbeBuffer) {
      this.specularBindGroupCache.clear();
      this.lastProbeEnv = probeEnv;
      this.lastProbeBuffer = probeBuffer;
    }
    // SSR ping-pongs its output between two textures: keep one bind group per SSR view.
    let specularBG = this.specularBindGroupCache.get(ssr);
    if (!specularBG) {
      this.createAmbientSpecularBindGroup(ssr, ao, probeEnv, probeBuffer);
      specularBG = this.ambientSpecularBindGroup;
      this.specularBindGroupCache.set(ssr, specularBG);
    }
    this.ambientSpecularBindGroup = specularBG;
    const render = Render.getInstance();

    const colorAttachment = GPUUtils.createColorAttachment(accLights, 'load', 'store');

    const ambSpecDesc = GPUUtils.createRenderPassDescriptor('ambient specular render pass', [
      colorAttachment,
    ]);
    const ambSpecTs = GPUProfiler.getInstance().getTimestampWrites('Ambient Specular');
    if (ambSpecTs) ambSpecDesc.timestampWrites = ambSpecTs;
    const pass = render.getCommandEncoder().beginRenderPass(ambSpecDesc);

    // Configure viewport and scissor using GPUUtils
    GPUUtils.configureViewportAndScissor(pass, Render.width, Render.height);

    // 1. Activate pipeline
    this.ambientSpecularTechnique.activatePipeline(pass);

    // 2. Activate mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Set bind groups
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, gBufferBindGroup);
    pass.setBindGroup(2, this.ambientSpecularBindGroup);

    // 4. Draw the mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }

  private createAmbientDiffuseBindGroup(aoResult: GPUTextureView): GPUBindGroup {
    return BindGroupFactory.createBindGroup(
      'ambient_bindgroup',
      this.ambientDiffuseTechnique.getPipeline().getBindGroupLayout(2),
      [
        { binding: 0, resource: aoResult },
        { binding: 1, resource: SamplerLibrary.simpleSampler! },
        { binding: 2, resource: { buffer: this.ambientDiffuseUniformBuffer } },
        { binding: 3, resource: this.brdfLUT.getTextureView()! },
        { binding: 4, resource: { buffer: ProbeManager.getInstance().getProbeSetBuffer() } },
      ],
    );
  }

  private createAmbientSpecularBindGroup(
    ssr: GPUTextureView,
    ao: GPUTextureView,
    probeEnv: GPUTextureView,
    probeBuffer: GPUBuffer,
  ) {
    this.ambientSpecularBindGroup = BindGroupFactory.createBindGroup(
      'ambient_specular_bindgroup',
      this.ambientSpecularTechnique.getPipeline().getBindGroupLayout(2),
      [
        {
          binding: 0,
          resource: ssr,
        },
        {
          binding: 1,
          resource: SamplerLibrary.simpleSampler!,
        },
        {
          binding: 2,
          resource: ao,
        },
        {
          binding: 3,
          resource: this.brdfLUT.getTextureView()!,
        },
        {
          binding: 4,
          resource: SamplerLibrary.simpleSampler!,
        },
        {
          binding: 5,
          resource: Engine.getEnvironmentManager().getSSREnvironmentTexture().getTextureView()!,
        },
        {
          binding: 6,
          resource: Engine.getEnvironmentManager().getSSREnvironmentTexture().getSampler()!,
        },
        {
          binding: 7,
          resource: { buffer: this.ambientSpecularUniformBuffer },
        },
        {
          binding: 8,
          resource: { buffer: probeBuffer },
        },
        {
          binding: 9,
          resource: probeEnv,
        },
      ],
    );
  }

  public update(_dt: number): void {
    if (!this.ambientDiffuseUniformBuffer || !this.ambientSpecularUniformBuffer) return;

    const ambientData = Engine.getEnvironmentManager().getAmbientLightData();
    // Probes near the rendering camera (the probe's own camera while baking).
    const camera = Engine.getRender().getMainCamera();
    ProbeManager.getInstance().update(camera.getPosition(), camera.getViewProjection());

    this.ambientDiffuseUniformArray[0] = ambientData.globalFactor;
    this.ambientDiffuseUniformArray[1] = ambientData.diffuseFactor;
    GPUUtils.writeBuffer(this.ambientDiffuseUniformBuffer, 0, this.ambientDiffuseUniformArray);

    this.ambientSpecularUniformArray[0] = ambientData.globalFactor;
    this.ambientSpecularUniformArray[1] = ambientData.environmentIntensity;
    this.ambientSpecularUniformArray[2] = 0.0;
    this.ambientSpecularUniformArray[3] = 0.0;
    this.ambientSpecularUniformArray[4] = 0.0;
    this.ambientSpecularUniformArray[5] = this.ssrActive ? 1.0 : 0.0; // SSRUniforms.enabled
    this.ambientSpecularUniformArray[6] = ambientData.reflectionFactor;
    this.ambientSpecularUniformArray[7] = ambientData.diffuseFactor;
    this.ambientSpecularUniformArray[8] = 0.0;
    this.ambientSpecularUniformArray[9] = 0.0;
    this.ambientSpecularUniformArray[10] = 0.0;
    this.ambientSpecularUniformArray[11] = 0.0;
    GPUUtils.writeBuffer(this.ambientSpecularUniformBuffer, 0, this.ambientSpecularUniformArray);
  }

  public destroy(): void {
    this.ambientDiffuseBindGroupCache.clear();
    this.ambientSpecularBindGroup = null!;
    this.specularBindGroupCache.clear();
    this.lastProbeEnv = null;
    this.lastProbeBuffer = null;
  }

  /**
   * Tells ambient_specular.fs whether this frame's SSR result replaces the IBL radiance.
   * Uploaded immediately so it applies to the frame being recorded.
   */
  public setSSRActive(active: boolean): void {
    if (active === this.ssrActive || !this.ambientSpecularUniformBuffer) {
      this.ssrActive = active;
      return;
    }
    this.ssrActive = active;
    this.ambientSpecularUniformArray[5] = active ? 1.0 : 0.0;
    GPUUtils.writeBuffer(this.ambientSpecularUniformBuffer, 0, this.ambientSpecularUniformArray);
  }
}
