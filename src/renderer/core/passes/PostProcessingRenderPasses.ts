import { BaseRenderPass, RenderPassConfig } from './BaseRenderPass';
import { Engine } from '../../../core/engine/Engine';
import { Mesh } from '../../resources/Mesh';
import { Technique } from '../../resources/Technique';

/**
 * Base class for post-processing render passes
 */
export abstract class PostProcessingRenderPass extends BaseRenderPass {
  protected mesh: Mesh;
  protected technique: Technique;

  constructor(config: RenderPassConfig, mesh: Mesh, technique: Technique) {
    super(config);
    this.mesh = mesh;
    this.technique = technique;
  }

  protected render(pass: GPURenderPassEncoder): void {
    // 1. Activate pipeline
    this.technique.activatePipeline(pass);

    // 2. Activate mesh data
    this.mesh.activate(pass);

    // 3. Set bind groups
    this.setBindGroups(pass);

    // 4. Draw the mesh
    this.mesh.renderGroup(pass);
  }

  /**
   * Abstract method for setting bind groups - each post-processing pass has different requirements
   */
  protected abstract setBindGroups(pass: GPURenderPassEncoder): void;
}

/**
 * Tone mapping post-processing render pass
 */
export class ToneMappingRenderPass extends PostProcessingRenderPass {
  private bindGroup: GPUBindGroup;
  private exposureBindGroup: GPUBindGroup | null = null;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    bindGroup: GPUBindGroup,
    exposureBindGroup?: GPUBindGroup,
  ) {
    super(config, mesh, technique);
    this.bindGroup = bindGroup;
    this.exposureBindGroup = exposureBindGroup ?? null;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(0, this.bindGroup);
    if (this.exposureBindGroup) {
      pass.setBindGroup(1, this.exposureBindGroup);
    }
  }

  /**
   * Update the bind group for tone mapping
   */
  public updateBindGroup(bindGroup: GPUBindGroup): void {
    this.bindGroup = bindGroup;
  }
}

export class SpeedLinesVFXRenderPass extends PostProcessingRenderPass {
  private textureBindGroup: GPUBindGroup;
  private bufferBindGroup: GPUBindGroup;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    textureBindGroup: GPUBindGroup,
    bufferBindGroup: GPUBindGroup,
  ) {
    super(config, mesh, technique);
    this.textureBindGroup = textureBindGroup;
    this.bufferBindGroup = bufferBindGroup;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(0, this.textureBindGroup);
    pass.setBindGroup(1, this.bufferBindGroup);
  }
}

/**
 * Bloom Filtering post-processing render pass
 * This pass requires two bind groups: global camera uniforms and texture
 */
export class BloomFilteringRenderPass extends PostProcessingRenderPass {
  private gBufferBindGroup: GPUBindGroup;
  private textureBindGroup: GPUBindGroup;
  private paramsBindGroup: GPUBindGroup | null;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    gBufferBindGroup: GPUBindGroup,
    textureBindGroup: GPUBindGroup,
    paramsBindGroup?: GPUBindGroup,
  ) {
    super(config, mesh, technique);
    this.textureBindGroup = textureBindGroup;
    this.gBufferBindGroup = gBufferBindGroup;
    this.paramsBindGroup = paramsBindGroup || null;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    // Bloom filtering needs global bind group at 0, gBuffer at 1, texture at 2, and params at 3
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, this.gBufferBindGroup);
    pass.setBindGroup(2, this.textureBindGroup);

    // Set bloom parameters bind group if available
    if (this.paramsBindGroup) {
      pass.setBindGroup(3, this.paramsBindGroup);
    }
  }

  /**
   * Update the texture bind group for antialiasing
   */
  public updateTextureBindGroup(bindGroup: GPUBindGroup): void {
    this.textureBindGroup = bindGroup;
  }
}

/**
 * Anti-aliasing (FXAA) post-processing render pass
 * This pass requires two bind groups: global camera uniforms and texture
 */
export class AntialiasingRenderPass extends PostProcessingRenderPass {
  private textureBindGroup: GPUBindGroup;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    textureBindGroup: GPUBindGroup,
  ) {
    super(config, mesh, technique);
    this.textureBindGroup = textureBindGroup;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    // Antialiasing needs global bind group at 0 and texture at 1
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, this.textureBindGroup);
  }

  /**
   * Update the texture bind group for antialiasing
   */
  public updateTextureBindGroup(bindGroup: GPUBindGroup): void {
    this.textureBindGroup = bindGroup;
  }
}

/**
 * Ambient occlusion (SSAO) post-processing render pass
 * This pass requires two bind groups: global camera uniforms and G-Buffer
 */
export class AmbientOcclusionRenderPass extends PostProcessingRenderPass {
  private gBufferBindGroup: GPUBindGroup;
  private ssaoParamsBindGroup?: GPUBindGroup | undefined;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    gBufferBindGroup: GPUBindGroup,
    ssaoParamsBindGroup?: GPUBindGroup,
  ) {
    super(config, mesh, technique);
    this.gBufferBindGroup = gBufferBindGroup;
    this.ssaoParamsBindGroup = ssaoParamsBindGroup;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    // AO needs global bind group at 0, G-Buffer at 1, and optionally SSAO params at 2
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, this.gBufferBindGroup);
    if (this.ssaoParamsBindGroup) {
      pass.setBindGroup(2, this.ssaoParamsBindGroup);
    }
  }

  /**
   * Update the G-Buffer bind group for ambient occlusion
   */
  public updateGBufferBindGroup(bindGroup: GPUBindGroup): void {
    this.gBufferBindGroup = bindGroup;
  }

  /**
   * Update the SSAO parameters bind group
   */
  public updateSSAOParamsBindGroup(bindGroup: GPUBindGroup): void {
    this.ssaoParamsBindGroup = bindGroup;
  }
}

/**
 * AO Bilateral Filter post-processing render pass
 * This pass takes the raw AO texture and applies bilateral filtering using G-Buffer data
 */
export class AOBilateralFilterRenderPass extends PostProcessingRenderPass {
  private gBufferBindGroup: GPUBindGroup;
  private aoBindGroup: GPUBindGroup;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    gBufferBindGroup: GPUBindGroup,
    aoBindGroup: GPUBindGroup,
  ) {
    super(config, mesh, technique);
    this.gBufferBindGroup = gBufferBindGroup;
    this.aoBindGroup = aoBindGroup;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    // AO bilateral filter needs global camera uniforms at group 0, G-Buffer at group 1, and AO texture at group 2
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, this.gBufferBindGroup);
    pass.setBindGroup(2, this.aoBindGroup);
  }

  /**
   * Update the G-Buffer bind group
   */
  public updateGBufferBindGroup(bindGroup: GPUBindGroup): void {
    this.gBufferBindGroup = bindGroup;
  }

  /**
   * Update the AO texture bind group
   */
  public updateAOBindGroup(bindGroup: GPUBindGroup): void {
    this.aoBindGroup = bindGroup;
  }
}

export class BloomCombineRenderPass extends PostProcessingRenderPass {
  private bloomCombineParamsBindGroup: GPUBindGroup;
  private bloomTexturesBindGroup: GPUBindGroup;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    bloomCombineParamsBindGroup: GPUBindGroup,
    bloomTexturesBindGroup: GPUBindGroup,
  ) {
    super(config, mesh, technique);
    this.bloomCombineParamsBindGroup = bloomCombineParamsBindGroup;
    this.bloomTexturesBindGroup = bloomTexturesBindGroup;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    // Set all bind groups needed for the bloom combine shader
    pass.setBindGroup(0, this.bloomCombineParamsBindGroup);
    pass.setBindGroup(1, this.bloomTexturesBindGroup);
  }
}

export class DOFRenderPass extends PostProcessingRenderPass {
  private paramsBindGroup: GPUBindGroup;
  private gBufferBindGroup: GPUBindGroup | null;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    paramsBindGroup: GPUBindGroup,
    gBufferBindGroup: GPUBindGroup | null = null,
  ) {
    super(config, mesh, technique);
    this.paramsBindGroup = paramsBindGroup;
    this.gBufferBindGroup = gBufferBindGroup;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    // Set all bind groups needed for the DOF shader
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, this.gBufferBindGroup);
    pass.setBindGroup(2, this.paramsBindGroup);
  }
}

/**
 * Motion Blur post-processing render pass
 */
export class MotionBlurRenderPass extends PostProcessingRenderPass {
  private paramsBindGroup: GPUBindGroup;
  private gBufferBindGroup: GPUBindGroup | null;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    paramsBindGroup: GPUBindGroup,
    gBufferBindGroup: GPUBindGroup,
  ) {
    super(config, mesh, technique);
    this.paramsBindGroup = paramsBindGroup;
    this.gBufferBindGroup = gBufferBindGroup;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, this.gBufferBindGroup);
    pass.setBindGroup(2, this.paramsBindGroup);
  }
}

/**
 * Contact shadows post-processing render pass.
 * group 0 = camera, group 1 = GBuffer, group 2 = params (accLight tex + sampler + uniform)
 */
export class ContactShadowsRenderPass extends PostProcessingRenderPass {
  private gBufferBindGroup: GPUBindGroup;
  private paramsBindGroup: GPUBindGroup;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    gBufferBindGroup: GPUBindGroup,
    paramsBindGroup: GPUBindGroup,
  ) {
    super(config, mesh, technique);
    this.gBufferBindGroup = gBufferBindGroup;
    this.paramsBindGroup = paramsBindGroup;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, this.gBufferBindGroup);
    pass.setBindGroup(2, this.paramsBindGroup);
  }
}

/**
 * Volumetric god rays render pass (Step 1 replacement).
 * Per-pixel view-ray march through CSM shadow maps — works from any camera angle.
 * group(0) = CameraUniforms (auto), group(1) = GBufferUniforms (linearDepth),
 * group(2) = GodRaysVolumetricCSM (shadow maps), group(3) = VolumetricGodRaysParams.
 */
export class GodRaysVolumetricRenderPass extends PostProcessingRenderPass {
  private gBufferBindGroup: GPUBindGroup;
  private csmBindGroup: GPUBindGroup;
  private paramsBindGroup: GPUBindGroup;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    gBufferBindGroup: GPUBindGroup,
    csmBindGroup: GPUBindGroup,
    paramsBindGroup: GPUBindGroup,
  ) {
    super(config, mesh, technique);
    this.gBufferBindGroup = gBufferBindGroup;
    this.csmBindGroup = csmBindGroup;
    this.paramsBindGroup = paramsBindGroup;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, this.gBufferBindGroup);
    pass.setBindGroup(2, this.csmBindGroup);
    pass.setBindGroup(3, this.paramsBindGroup);
  }
}

/**
 * God rays occlusion mask render pass (Step 1).
 * Renders a quarter-resolution bright-pixel mask from the HDR scene.
 * group(0) = CameraUniforms (auto), group(1) = GBuffer, group(2) = HDR input, group(3) = GodRaysParams.
 */
export class GodRaysOcclusionRenderPass extends PostProcessingRenderPass {
  private gBufferBindGroup: GPUBindGroup;
  private inputBindGroup: GPUBindGroup;
  private paramsBindGroup: GPUBindGroup;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    gBufferBindGroup: GPUBindGroup,
    inputBindGroup: GPUBindGroup,
    paramsBindGroup: GPUBindGroup,
  ) {
    super(config, mesh, technique);
    this.gBufferBindGroup = gBufferBindGroup;
    this.inputBindGroup = inputBindGroup;
    this.paramsBindGroup = paramsBindGroup;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, this.gBufferBindGroup);
    pass.setBindGroup(2, this.inputBindGroup);
    pass.setBindGroup(3, this.paramsBindGroup);
  }
}

/**
 * God rays radial blur render pass (Step 2).
 * Marches 64 samples from each pixel toward the sun, accumulating the
 * occlusion mask with exponential decay to produce light shafts.
 * group(0) = CameraUniforms (auto), group(1) = occlusion mask, group(2) = GodRaysParams.
 */
export class GodRaysRadialRenderPass extends PostProcessingRenderPass {
  private inputBindGroup: GPUBindGroup;
  private paramsBindGroup: GPUBindGroup;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    inputBindGroup: GPUBindGroup,
    paramsBindGroup: GPUBindGroup,
  ) {
    super(config, mesh, technique);
    this.inputBindGroup = inputBindGroup;
    this.paramsBindGroup = paramsBindGroup;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, this.inputBindGroup);
    pass.setBindGroup(2, this.paramsBindGroup);
  }
}

/**
 * God rays Kawase blur render pass (Step 3).
 * One ping-pong pass of the 4-tap diagonal Kawase kernel.
 * Run 5× with pre-written offset buffers: k ∈ {0, 1, 2, 2, 3}.
 * group(0) = CameraUniforms (auto), group(1) = ping-pong input, group(2) = KawaseParams.
 */
export class GodRaysKawaseRenderPass extends PostProcessingRenderPass {
  private inputBindGroup: GPUBindGroup;
  private paramsBindGroup: GPUBindGroup;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    inputBindGroup: GPUBindGroup,
    paramsBindGroup: GPUBindGroup,
  ) {
    super(config, mesh, technique);
    this.inputBindGroup = inputBindGroup;
    this.paramsBindGroup = paramsBindGroup;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, this.inputBindGroup);
    pass.setBindGroup(2, this.paramsBindGroup);
  }
}

/**
 * God rays composite render pass (Step 4).
 * Additively blends the blurred light-shaft buffer onto the full-resolution
 * HDR frame in-place (loadOp: 'load' + ONE+ONE pipeline blend).
 * group(0) = CameraUniforms (auto), group(1) = Kawase output, group(2) = composite params.
 */
export class GodRaysCompositeRenderPass extends PostProcessingRenderPass {
  private inputBindGroup: GPUBindGroup;
  private paramsBindGroup: GPUBindGroup;
  private exposureBindGroup: GPUBindGroup;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    inputBindGroup: GPUBindGroup,
    paramsBindGroup: GPUBindGroup,
    exposureBindGroup: GPUBindGroup,
  ) {
    super(config, mesh, technique);
    this.inputBindGroup = inputBindGroup;
    this.paramsBindGroup = paramsBindGroup;
    this.exposureBindGroup = exposureBindGroup;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, this.inputBindGroup);
    pass.setBindGroup(2, this.paramsBindGroup);
    pass.setBindGroup(3, this.exposureBindGroup);
  }
}

/**
 * Height Fog post-processing render pass
 */
export class HeightFogRenderPass extends PostProcessingRenderPass {
  private paramsBindGroup: GPUBindGroup;
  private gBufferBindGroup: GPUBindGroup;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    paramsBindGroup: GPUBindGroup,
    gBufferBindGroup: GPUBindGroup,
  ) {
    super(config, mesh, technique);
    this.paramsBindGroup = paramsBindGroup;
    this.gBufferBindGroup = gBufferBindGroup;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, this.gBufferBindGroup);
    pass.setBindGroup(2, this.paramsBindGroup);
  }
}

/**
 * Lens flare occlusion mask render pass (Step 1).
 * Renders a quarter-resolution sky-visibility mask near the sun disc.
 * group(0) = CameraUniforms (auto), group(1) = GBuffer, group(2) = LensFlareParams.
 */
export class LensFlareOcclusionRenderPass extends PostProcessingRenderPass {
  private gBufferBindGroup: GPUBindGroup;
  private paramsBindGroup: GPUBindGroup;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    gBufferBindGroup: GPUBindGroup,
    paramsBindGroup: GPUBindGroup,
  ) {
    super(config, mesh, technique);
    this.gBufferBindGroup = gBufferBindGroup;
    this.paramsBindGroup = paramsBindGroup;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, this.gBufferBindGroup);
    pass.setBindGroup(2, this.paramsBindGroup);
  }
}

/**
 * Lens flare composite render pass (Step 2).
 * Additively blends all flare elements (glow, ghosts, ring, streak) onto the
 * full-resolution HDR frame using the occlusion mask for visibility gating.
 * group(0) = CameraUniforms (auto), group(1) = occlusion mask, group(2) = LensFlareParams.
 */
export class LensFlareCompositeRenderPass extends PostProcessingRenderPass {
  private occlusionBindGroup: GPUBindGroup;
  private paramsBindGroup: GPUBindGroup;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    occlusionBindGroup: GPUBindGroup,
    paramsBindGroup: GPUBindGroup,
  ) {
    super(config, mesh, technique);
    this.occlusionBindGroup = occlusionBindGroup;
    this.paramsBindGroup = paramsBindGroup;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, this.occlusionBindGroup);
    pass.setBindGroup(2, this.paramsBindGroup);
  }
}

/**
 * Radiance Cascades composite render pass.
 * Additively blends the GI contribution (pre-computed by rc_apply.cs) onto rtAccLight.
 * group(0) = CameraUniforms, group(1) = giResult + sampler (SingleTexture).
 */
export class RCCompositeRenderPass extends PostProcessingRenderPass {
  private giBindGroup: GPUBindGroup;
  private rcParamsBindGroup: GPUBindGroup;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    giBindGroup: GPUBindGroup,
    rcParamsBindGroup: GPUBindGroup,
  ) {
    super(config, mesh, technique);
    this.giBindGroup = giBindGroup;
    this.rcParamsBindGroup = rcParamsBindGroup;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, this.giBindGroup);
    pass.setBindGroup(2, this.rcParamsBindGroup);
  }

  public updateGIBindGroup(bindGroup: GPUBindGroup): void {
    this.giBindGroup = bindGroup;
  }
}
