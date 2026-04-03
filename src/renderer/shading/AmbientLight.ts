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

  // Diffuse uniform: 4 scalars + 6 × vec4 for PCC probe A/B data = 28 floats / 112 bytes.
  // Layout: [0..3] = globalBoost,diffuseBoost,isBaking,blendWeight
  //         [4..15] = probeAPos(xyz,w) + probeAMin(xyz,_) + probeAMax(xyz,_)
  //         [16..27] = probeBPos(xyz,w) + probeBMin(xyz,_) + probeBMax(xyz,_)
  private ambientDiffuseUniformArray = new Float32Array(28);
  private ambientSpecularUniformArray = new Float32Array(12);

  // PCC specular uniform: 7 × vec4 = 28 floats / 112 bytes.
  // Layout: probeAPos(xyz,hasA) + probeAMin(xyz,_) + probeAMax(xyz,_)
  //       + probeBPos(xyz,hasB) + probeBMin(xyz,_) + probeBMax(xyz,_)
  //       + blendWeight(_,_,_,_)
  private pccSpecularUniformBuffer!: GPUBuffer;
  private pccSpecularUniformArray = new Float32Array(28);

  /** Cached views for bind-group invalidation on resize or SSGI toggle. */
  private lastAoView: GPUTextureView | null = null;

  /** Cached probe views for bind-group invalidation when the player moves between probes. */
  private lastProbeAView: GPUTextureView | null = null;
  private lastProbeBView: GPUTextureView | null = null;
  private lastProbeEnvAView: GPUTextureView | null = null;
  private lastProbeEnvBView: GPUTextureView | null = null;

  /** When true, the ambient diffuse shader uses white irradiance instead of sampled cubemaps. */
  private static _bakingMode: boolean = false;

  public static setBakingMode(enabled: boolean): void {
    AmbientLight._bakingMode = enabled;
  }

  private brdfLUT!: Texture;

  constructor() {}

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.ambientDiffuseTechnique = await Technique.getAsync('lighting/ambient.tech');

    this.ambientDiffuseUniformBuffer = GPUUtils.createBuffer(
      'ambient diffuse uniform buffer',
      112, // 28 floats: 4 scalars + 6 vec4s for PCC probe A/B
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.ambientSpecularTechnique = await Technique.getAsync('lighting/ambient_specular.tech');

    this.brdfLUT = await Texture.getAsync('brdfLUT.png');

    this.ambientSpecularUniformBuffer = GPUUtils.createBuffer(
      'ambient specular uniform buffer',
      48,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.pccSpecularUniformBuffer = GPUUtils.createBuffer(
      'ambient specular PCC uniform buffer',
      112, // 28 floats: probeA(pos/min/max) + probeB(pos/min/max) + blendWeight
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
    const envViews = this._getProbeEnvViews();
    if (
      !this.ambientSpecularBindGroup ||
      envViews.envA !== this.lastProbeEnvAView ||
      envViews.envB !== this.lastProbeEnvBView
    ) {
      this.createAmbientSpecularBindGroup(ssr, ao, envViews.envA, envViews.envB);
      this.lastProbeEnvAView = envViews.envA;
      this.lastProbeEnvBView = envViews.envB;
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

  private createAmbientSpecularBindGroup(
    ssr: GPUTextureView,
    ao: GPUTextureView,
    probeEnvAView: GPUTextureView,
    probeEnvBView: GPUTextureView,
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
          resource: { buffer: this.pccSpecularUniformBuffer },
        },
        {
          binding: 9,
          resource: probeEnvAView,
        },
        {
          binding: 10,
          resource: probeEnvBView,
        },
      ],
    );
  }

  public update(_dt: number): void {
    // Guard: load() is async and may not have finished yet (e.g. after resetAmbientLightResources)
    if (
      !this.pccSpecularUniformBuffer ||
      !this.ambientDiffuseUniformBuffer ||
      !this.ambientSpecularUniformBuffer
    )
      return;

    const ambientData = Engine.getEnvironmentManager().getAmbientLightData();
    this.ambientDiffuseUniformArray[0] = ambientData.globalFactor;
    this.ambientDiffuseUniformArray[1] = ambientData.diffuseFactor;
    this.ambientDiffuseUniformArray[2] = AmbientLight._bakingMode ? 1.0 : 0.0; // isBaking flag
    // [3] = probeBlendWeight — updated by _getProbeViews() side-effect via renderDiffuse
    const blend = ProbeManager.getInstance().getBlendedProbes();
    this.ambientDiffuseUniformArray[3] = blend.probeB !== null ? blend.blendWeight : 0.0;
    // Buffer is written by _writePCCDiffuseUniforms() below (avoids a redundant write)

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

    // ── PCC specular data ─────────────────────────────────────────────────────
    this._writePCCSpecularUniforms();

    // ── PCC diffuse data (packed into ambient diffuse uniform) ────────────────
    this._writePCCDiffuseUniforms();
  }

  /**
   * Writes probe A and B AABB data + blendWeight into the PCC specular uniform buffer.
   * hasProbeA/B (w component) = 1.0 when active; 0.0 = raw reflection direction.
   */
  private _writePCCSpecularUniforms(): void {
    const blend = ProbeManager.getInstance().getBlendedProbes();

    const writeProbeSpec = (probe: typeof blend.probeA, offset: number): void => {
      if (probe) {
        const pos = probe.getPosition();
        const ext = probe.getExtents();
        this.pccSpecularUniformArray[offset + 0] = pos[0];
        this.pccSpecularUniformArray[offset + 1] = pos[1];
        this.pccSpecularUniformArray[offset + 2] = pos[2];
        this.pccSpecularUniformArray[offset + 3] = probe.getProbeTypeFlag(); // 1=outdoor, 2=indoor+PCC
        this.pccSpecularUniformArray[offset + 4] = pos[0] - ext[0];
        this.pccSpecularUniformArray[offset + 5] = pos[1] - ext[1];
        this.pccSpecularUniformArray[offset + 6] = pos[2] - ext[2];
        this.pccSpecularUniformArray[offset + 7] = 0.0;
        this.pccSpecularUniformArray[offset + 8] = pos[0] + ext[0];
        this.pccSpecularUniformArray[offset + 9] = pos[1] + ext[1];
        this.pccSpecularUniformArray[offset + 10] = pos[2] + ext[2];
        this.pccSpecularUniformArray[offset + 11] = 0.0;
      } else {
        this.pccSpecularUniformArray[offset + 3] = 0.0; // clear hasProbe
      }
    };

    writeProbeSpec(blend.probeA, 0); // probeAPos at index 0
    writeProbeSpec(blend.probeB, 12); // probeBPos at index 12
    // blendWeight at index 24
    this.pccSpecularUniformArray[24] = blend.probeB !== null ? blend.blendWeight : 0.0;
    GPUUtils.writeBuffer(this.pccSpecularUniformBuffer, 0, this.pccSpecularUniformArray);
  }

  /**
   * Writes probe A and B AABB data into the ambient diffuse uniform buffer
   * at the PCC region (offsets 4–27 of the Float32Array).
   */
  private _writePCCDiffuseUniforms(): void {
    const blend = ProbeManager.getInstance().getBlendedProbes();

    const writeProbe = (probe: typeof blend.probeA, offset: number): void => {
      if (probe) {
        const pos = probe.getPosition();
        const ext = probe.getExtents();
        this.ambientDiffuseUniformArray[offset + 0] = pos[0];
        this.ambientDiffuseUniformArray[offset + 1] = pos[1];
        this.ambientDiffuseUniformArray[offset + 2] = pos[2];
        this.ambientDiffuseUniformArray[offset + 3] = probe.getProbeTypeFlag(); // 1=outdoor, 2=indoor+PCC
        this.ambientDiffuseUniformArray[offset + 4] = pos[0] - ext[0];
        this.ambientDiffuseUniformArray[offset + 5] = pos[1] - ext[1];
        this.ambientDiffuseUniformArray[offset + 6] = pos[2] - ext[2];
        this.ambientDiffuseUniformArray[offset + 7] = 0.0;
        this.ambientDiffuseUniformArray[offset + 8] = pos[0] + ext[0];
        this.ambientDiffuseUniformArray[offset + 9] = pos[1] + ext[1];
        this.ambientDiffuseUniformArray[offset + 10] = pos[2] + ext[2];
        this.ambientDiffuseUniformArray[offset + 11] = 0.0;
      } else {
        this.ambientDiffuseUniformArray[offset + 3] = 0.0; // clear hasProbe
      }
    };

    writeProbe(blend.probeA, 4); // probeAPos at index 4
    writeProbe(blend.probeB, 16); // probeBPos at index 16
    GPUUtils.writeBuffer(this.ambientDiffuseUniformBuffer, 0, this.ambientDiffuseUniformArray);
  }

  public destroy(): void {
    this.ambientDiffuseBindGroup = null!;
    this.ambientSpecularBindGroup = null!;
    this.lastAoView = null;
    this.lastProbeAView = null;
    this.lastProbeBView = null;
    this.lastProbeEnvAView = null;
    this.lastProbeEnvBView = null;
    this.pccSpecularUniformBuffer?.destroy();
    this.pccSpecularUniformBuffer = null!;
  }

  /**
   * Returns env cubemap views for the two dominant probes.
   * Falls back to the global SSR env cubemap when no probe covers the player.
   */
  private _getProbeEnvViews(): { envA: GPUTextureView; envB: GPUTextureView } {
    const globalEnvView = Engine.getEnvironmentManager()
      .getSSREnvironmentTexture()
      .getTextureView()!;
    const blend = ProbeManager.getInstance().getBlendedProbes();
    const envA = blend.probeA?.getEnvView() ?? globalEnvView;
    const envB = blend.probeB?.getEnvView() ?? envA;
    return { envA, envB };
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
