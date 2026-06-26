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

  // Diffuse uniform: 5 scalars (+ padding to 8) = 32 bytes.
  // Layout: [0] globalBoost  [1] diffuseBoost  [2] isBaking
  //         [3] probeBlendWeight  [4] hasProbeA  [5..7] padding
  private ambientDiffuseUniformArray = new Float32Array(8);
  private ambientSpecularUniformArray = new Float32Array(12);

  // SH L2 irradiance: probeA(9×vec4) + probeB(9×vec4) = 72 floats / 288 bytes.
  // Each vec4 = (R, G, B, 0_padding). Layout: coefA[0..8] then coefB[0..8].
  private shUniformBuffer!: GPUBuffer;
  private shUniformArray = new Float32Array(72);

  // PCC specular uniform: 7 × vec4 = 28 floats / 112 bytes.
  // Layout: probeAPos(xyz,hasA) + probeAMin(xyz,_) + probeAMax(xyz,_)
  //       + probeBPos(xyz,hasB) + probeBMin(xyz,_) + probeBMax(xyz,_)
  //       + blendWeight(_,_,_,_)
  private pccSpecularUniformBuffer!: GPUBuffer;
  private pccSpecularUniformArray = new Float32Array(28);

  /** Cached probe env views for specular bind-group invalidation. */
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
    try {
      this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
      this.ambientDiffuseTechnique = await Technique.getAsync('lighting/ambient.tech');

      this.ambientDiffuseUniformBuffer = GPUUtils.createBuffer(
        'ambient diffuse uniform buffer',
        32, // 8 floats: globalBoost, diffuseBoost, isBaking, blendWeight, hasProbeA + 3 pad
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );

      this.shUniformBuffer = GPUUtils.createBuffer(
        'ambient SH uniform buffer',
        288, // 72 floats: probeA(9×vec4) + probeB(9×vec4)
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
    } catch (e) {
      console.error('[AmbientLight] load() FAILED:', e);
    }
  }

  public renderDiffuse(
    rtAccLight: GPUTextureView,
    gBufferBindGroup: GPUBindGroup,
    aoResult: GPUTextureView,
  ): void {
    // SH data is in a uniform buffer written every frame — bind group is stable per aoResult.
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
    if (!this.pccSpecularUniformBuffer || !this.ambientSpecularUniformBuffer) return;
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

  private createAmbientDiffuseBindGroup(aoResult: GPUTextureView): GPUBindGroup {
    return BindGroupFactory.createBindGroup(
      'ambient_bindgroup',
      this.ambientDiffuseTechnique.getPipeline().getBindGroupLayout(2),
      [
        { binding: 0, resource: aoResult },
        { binding: 1, resource: SamplerLibrary.simpleSampler! },
        { binding: 2, resource: { buffer: this.ambientDiffuseUniformBuffer } },
        { binding: 3, resource: this.brdfLUT.getTextureView()! },
        { binding: 4, resource: { buffer: this.shUniformBuffer } },
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
    if (!this.pccSpecularUniformBuffer || !this.ambientDiffuseUniformBuffer || !this.ambientSpecularUniformBuffer || !this.shUniformBuffer) return;

    const ambientData = Engine.getEnvironmentManager().getAmbientLightData();
    const blend = ProbeManager.getInstance().getBlendedProbes();
    // hasProbeA is 1 only when SH coefficients are actually loaded — otherwise fall back to
    // the global irradiance cubemap so there's no black frame during async JSON load.
    const shCoefA = blend.probeA?.getSHCoefficients() ?? null;
    const hasProbeA = shCoefA !== null ? 1.0 : 0.0;

    this.ambientDiffuseUniformArray[0] = ambientData.globalFactor;
    this.ambientDiffuseUniformArray[1] = ambientData.diffuseFactor;
    this.ambientDiffuseUniformArray[2] = AmbientLight._bakingMode ? 1.0 : 0.0;
    this.ambientDiffuseUniformArray[3] = blend.probeB !== null ? blend.blendWeight : 0.0;
    this.ambientDiffuseUniformArray[4] = hasProbeA;
    // [5..7] = padding
    GPUUtils.writeBuffer(this.ambientDiffuseUniformBuffer, 0, this.ambientDiffuseUniformArray);

    this.ambientSpecularUniformArray[0] = ambientData.globalFactor;
    this.ambientSpecularUniformArray[1] = 0.0;
    this.ambientSpecularUniformArray[2] = 0.0;
    this.ambientSpecularUniformArray[3] = 0.0;
    this.ambientSpecularUniformArray[4] = 0.0;
    this.ambientSpecularUniformArray[5] = 0.0;
    this.ambientSpecularUniformArray[6] = ambientData.reflectionFactor;
    this.ambientSpecularUniformArray[7] = ambientData.diffuseFactor;
    this.ambientSpecularUniformArray[8] = 0.0;
    this.ambientSpecularUniformArray[9] = 0.0;
    this.ambientSpecularUniformArray[10] = 0.0;
    this.ambientSpecularUniformArray[11] = 0.0;
    GPUUtils.writeBuffer(this.ambientSpecularUniformBuffer, 0, this.ambientSpecularUniformArray);

    this._writePCCSpecularUniforms();
    this._writeSHUniforms(blend);
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
   * Packs SH L2 coefficients for probe A and probe B into the SH uniform buffer.
   * Each coefficient is stored as vec4(R, G, B, 0). Layout: coefA[0..8] coefB[0..8].
   * When no probe is active, writes zeros so hasProbeA=0 causes the shader to fall back
   * to the global irradiance cubemap.
   */
  private _writeSHUniforms(blend: ReturnType<typeof ProbeManager.prototype.getBlendedProbes>): void {
    const shA = blend.probeA?.getSHCoefficients() ?? null;
    const shB = blend.probeB?.getSHCoefficients() ?? shA; // fall back to A when no B

    const writeSH = (coefs: Float32Array | null, base: number): void => {
      for (let k = 0; k < 9; k++) {
        const o = base + k * 4;
        this.shUniformArray[o]     = coefs ? coefs[k * 3]!     : 0;
        this.shUniformArray[o + 1] = coefs ? coefs[k * 3 + 1]! : 0;
        this.shUniformArray[o + 2] = coefs ? coefs[k * 3 + 2]! : 0;
        this.shUniformArray[o + 3] = 0; // padding
      }
    };

    writeSH(shA, 0);   // probeA at floats 0–35
    writeSH(shB, 36);  // probeB at floats 36–71
    GPUUtils.writeBuffer(this.shUniformBuffer, 0, this.shUniformArray);
  }

  public destroy(): void {
    this.ambientDiffuseBindGroupCache.clear();
    this.ambientSpecularBindGroup = null!;
    this.lastProbeEnvAView = null;
    this.lastProbeEnvBView = null;
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

}
