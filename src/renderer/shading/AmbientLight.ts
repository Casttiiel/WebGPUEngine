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
  private ambientDiffuseBindGroup!: GPUBindGroup;
  private ambientDiffuseUniformBuffer!: GPUBuffer;

  private ambientSpecularTechnique!: Technique;
  private ambientSpecularBindGroup!: GPUBindGroup;
  private ambientSpecularUniformBuffer!: GPUBuffer;

  private ambientDiffuseUniformArray = new Float32Array(4);
  private ambientSpecularUniformArray = new Float32Array(12);

  /** Cached views for bind-group invalidation on resize or SSGI toggle. */
  private lastAoView: GPUTextureView | null = null;

  /** Cached probe views for bind-group invalidation when the player moves between probes. */
  private lastProbeAView: GPUTextureView | null = null;
  private lastProbeBView: GPUTextureView | null = null;

  private brdfLUT!: Texture;

  constructor() {}

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.ambientDiffuseTechnique = await Technique.getAsync('lighting/ambient.tech');

    this.ambientDiffuseUniformBuffer = GPUUtils.createBuffer(
      'ambient diffuse uniform buffer',
      16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.ambientSpecularTechnique = await Technique.getAsync('lighting/ambient_specular.tech');

    this.brdfLUT = await Texture.getAsync('brdfLUT.png');

    this.ambientSpecularUniformBuffer = GPUUtils.createBuffer(
      'ambient specular uniform buffer',
      48,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
  }

  public renderDiffuse(
    rtAccLight: GPUTextureView,
    gBufferBindGroup: GPUBindGroup,
    aoResult: GPUTextureView,
  ): void {
    const probeViews = this._getProbeViews();
    const probeAChanged = probeViews.viewA !== this.lastProbeAView;
    const probeBChanged = probeViews.viewB !== this.lastProbeBView;

    if (
      !this.ambientDiffuseBindGroup ||
      this.lastAoView !== aoResult ||
      probeAChanged ||
      probeBChanged
    ) {
      this.createAmbientDiffuseBindGroup(aoResult, probeViews.viewA, probeViews.viewB);
      this.lastAoView = aoResult;
      this.lastProbeAView = probeViews.viewA;
      this.lastProbeBView = probeViews.viewB;
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
    pass.setBindGroup(2, this.ambientDiffuseBindGroup);

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
    if (!this.ambientSpecularBindGroup) {
      this.createAmbientSpecularBindGroup(ssr, ao);
    }
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

  private createAmbientDiffuseBindGroup(
    aoResult: GPUTextureView,
    irradianceViewA: GPUTextureView,
    irradianceViewB: GPUTextureView,
  ): void {
    this.ambientDiffuseBindGroup = BindGroupFactory.createBindGroup(
      'ambient_bindgroup',
      this.ambientDiffuseTechnique.getPipeline().getBindGroupLayout(2),
      [
        {
          binding: 0,
          resource: aoResult,
        },
        {
          binding: 1,
          resource: SamplerLibrary.simpleSampler!,
        },
        {
          binding: 2,
          resource: { buffer: this.ambientDiffuseUniformBuffer },
        },
        {
          binding: 3,
          resource: irradianceViewA,
        },
        {
          binding: 4,
          resource: Engine.getEnvironmentManager()
            .getAmbientLightData()
            .irradianceCubemap.getSampler()!,
        },
        {
          binding: 5,
          resource: this.brdfLUT.getTextureView()!,
        },
        {
          binding: 6,
          resource: irradianceViewB,
        },
      ],
    );
  }

  private createAmbientSpecularBindGroup(ssr: GPUTextureView, ao: GPUTextureView) {
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
      ],
    );
  }

  public update(_dt: number): void {
    const ambientData = Engine.getEnvironmentManager().getAmbientLightData();
    this.ambientDiffuseUniformArray[0] = ambientData.globalFactor;
    this.ambientDiffuseUniformArray[1] = ambientData.diffuseFactor;
    this.ambientDiffuseUniformArray[2] = 0.0;
    // [3] = probeBlendWeight — updated by _getProbeViews() side-effect via renderDiffuse
    const blend = ProbeManager.getInstance().getBlendedProbes();
    this.ambientDiffuseUniformArray[3] = blend.probeB !== null ? blend.blendWeight : 0.0;
    GPUUtils.writeBuffer(this.ambientDiffuseUniformBuffer, 0, this.ambientDiffuseUniformArray);

    this.ambientSpecularUniformArray[0] = ambientData.globalFactor;
    this.ambientSpecularUniformArray[1] = 0.0;
    this.ambientSpecularUniformArray[2] = 0.0;
    this.ambientSpecularUniformArray[3] = 0.0;
    this.ambientSpecularUniformArray[4] = 0.0;
    this.ambientSpecularUniformArray[5] = 0.0;
    this.ambientSpecularUniformArray[6] = ambientData.reflectionFactor;
    this.ambientSpecularUniformArray[7] = ambientData.diffuseFactor;
    // indices 8–11 are metallicMin, roughnessMax, _pad0, _pad1 — unused in this pass, keep as 0
    this.ambientSpecularUniformArray[8] = 0.0;
    this.ambientSpecularUniformArray[9] = 0.0;
    this.ambientSpecularUniformArray[10] = 0.0;
    this.ambientSpecularUniformArray[11] = 0.0;
    GPUUtils.writeBuffer(this.ambientSpecularUniformBuffer, 0, this.ambientSpecularUniformArray);
  }

  public destroy(): void {
    this.ambientDiffuseBindGroup = null!;
    this.ambientSpecularBindGroup = null!;
    this.lastAoView = null;
    this.lastProbeAView = null;
    this.lastProbeBView = null;
  }

  /**
   * Returns the irradiance cubemap views to bind for the two dominant probes.
   * Falls back to the global/environment irradiance when no probe covers the player.
   */
  private _getProbeViews(): { viewA: GPUTextureView; viewB: GPUTextureView } {
    const globalView = Engine.getEnvironmentManager()
      .getAmbientLightData()
      .irradianceCubemap.getTextureView()!;

    const blend = ProbeManager.getInstance().getBlendedProbes();
    const viewA = blend.probeA?.getIrradianceView() ?? globalView;
    const viewB = blend.probeB?.getIrradianceView() ?? viewA;
    return { viewA, viewB };
  }
}
