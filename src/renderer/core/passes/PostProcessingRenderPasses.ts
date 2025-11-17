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

  constructor(config: RenderPassConfig, mesh: Mesh, technique: Technique, bindGroup: GPUBindGroup) {
    super(config, mesh, technique);
    this.bindGroup = bindGroup;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(0, this.bindGroup);
  }

  /**
   * Update the bind group for tone mapping
   */
  public updateBindGroup(bindGroup: GPUBindGroup): void {
    this.bindGroup = bindGroup;
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
