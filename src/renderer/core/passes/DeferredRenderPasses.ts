import { BaseRenderPass, RenderPassConfig } from './BaseRenderPass';
import { RenderCategory } from '../../../types/RenderCategory.enum';
import { RenderManagerV2 as RenderManager } from '../managers/RenderManagerV2';
import { Render } from '../pipeline/Render';
import { GPUUtils } from '../utils/GPUUtils';
import { RenderKey } from '../managers/RenderKeyManager';
import { Mesh } from '../../resources/Mesh';
import { Technique } from '../../resources/Technique';

/**
 * Depth prepass render pass
 * Generates depth and linear depth textures before G-Buffer rendering
 */
export class DepthPrepassRenderPass extends BaseRenderPass {
  constructor(config: RenderPassConfig) {
    super(config);
  }

  protected render(pass: GPURenderPassEncoder, category?: RenderCategory): void {
    // Configure viewport for the pass
    const viewport = this.config.viewport;
    if (viewport) {
      GPUUtils.configureViewportAndScissor(pass, viewport.width, viewport.height);
    } else {
      GPUUtils.configureViewportAndScissor(pass, Render.width, Render.height);
    }

    // Render solid geometry to depth prepass
    const renderCategory = RenderCategory.SOLIDS;
    RenderManager.getInstance().render(renderCategory, pass);
  }
}

/**
 * G-Buffer render pass for deferred rendering using BaseRenderPass
 */
export class GBufferRenderPass extends BaseRenderPass {
  constructor(config: RenderPassConfig) {
    super(config);
  }

  /**
   * Renders geometry to G-Buffer targets
   */
  protected render(pass: GPURenderPassEncoder, category?: RenderCategory): void {
    // Configure viewport for the pass
    const viewport = this.config.viewport;
    if (viewport) {
      GPUUtils.configureViewportAndScissor(pass, viewport.width, viewport.height);
    } else {
      GPUUtils.configureViewportAndScissor(pass, Render.width, Render.height);
    }

    // Render solid geometry to G-Buffer
    const renderCategory = category || RenderCategory.SOLIDS;
    RenderManager.getInstance().render(renderCategory, pass);
  }
}

/**
 * Decals render pass for G-Buffer
 */
export class DecalRenderPass extends BaseRenderPass {
  private customBindGroup: GPUBindGroup | null = null;

  constructor(config: RenderPassConfig) {
    super(config);
  }

  public setCustomBindGroup(bindGroup: GPUBindGroup): void {
    this.customBindGroup = bindGroup;
  }

  protected render(
    pass: GPURenderPassEncoder,
    _category?: RenderCategory,
    _renderKeys?: RenderKey[],
  ): void {
    // Configure viewport for decals
    const viewport = this.config.viewport;
    if (viewport) {
      GPUUtils.configureViewportAndScissor(pass, viewport.width, viewport.height);
    } else {
      GPUUtils.configureViewportAndScissor(pass, Render.width, Render.height);
    }

    // Set the custom bind group if provided
    if (this.customBindGroup) {
      pass.setBindGroup(3, this.customBindGroup);
    }

    // Render decals on top of G-Buffer
    RenderManager.getInstance().render(RenderCategory.DECALS, pass);
  }
}

/**
 * Transparent objects render pass
 */
export class TransparentRenderPass extends BaseRenderPass {
  constructor(config: RenderPassConfig) {
    super(config);
  }

  protected render(
    pass: GPURenderPassEncoder,
    _category?: RenderCategory,
    _renderKeys?: RenderKey[],
  ): void {
    // Configure viewport for transparent objects
    const viewport = this.config.viewport;
    if (viewport) {
      GPUUtils.configureViewportAndScissor(pass, viewport.width, viewport.height);
    } else {
      GPUUtils.configureViewportAndScissor(pass, Render.width, Render.height);
    }

    // Render transparent objects
    RenderManager.getInstance().render(RenderCategory.TRANSPARENT, pass);
  }
}

/**
 * Weighted Blended OIT gather pass — renders RenderCategory.GLASS into
 * two render targets: accumulation (RGBA16F) and revealage (RGBA8Unorm).
 * Depth is read-only (test but no write) so the prepass depth is preserved.
 * Group 3 is set to the prefiltered environment cubemap for IBL reflections.
 */
export class GlassOITGatherRenderPass extends BaseRenderPass {
  private envBindGroup: GPUBindGroup | null = null;

  constructor(config: RenderPassConfig) {
    super(config);
  }

  public setEnvBindGroup(bindGroup: GPUBindGroup): void {
    this.envBindGroup = bindGroup;
  }

  protected render(
    pass: GPURenderPassEncoder,
    _category?: RenderCategory,
    _renderKeys?: RenderKey[],
  ): void {
    const viewport = this.config.viewport;
    if (viewport) {
      GPUUtils.configureViewportAndScissor(pass, viewport.width, viewport.height);
    } else {
      GPUUtils.configureViewportAndScissor(pass, Render.width, Render.height);
    }

    if (this.envBindGroup) {
      pass.setBindGroup(3, this.envBindGroup);
    }

    RenderManager.getInstance().render(RenderCategory.GLASS, pass);
  }
}

/**
 * Water composite render pass — fullscreen quad executed after the water GBuffer pass.
 * Blends the lit water surface with the pre-water scene colour using depth-based
 * absorption (Beer–Lambert) and Schlick Fresnel.
 *
 * Requires two bind groups set per frame:
 *   group(0) = CameraUniforms
 *   group(1) = WaterCompositeUniforms (scene snapshot + water GBuffer + env cubemap)
 */
export class WaterCompositeRenderPass extends BaseRenderPass {
  private mesh: Mesh;
  private technique: Technique;
  private cameraBindGroup: GPUBindGroup | null = null;
  private waterBindGroup: GPUBindGroup | null = null;

  constructor(config: RenderPassConfig, mesh: Mesh, technique: Technique) {
    super(config);
    this.mesh = mesh;
    this.technique = technique;
  }

  public updateBindGroups(cameraBindGroup: GPUBindGroup, waterBindGroup: GPUBindGroup): void {
    this.cameraBindGroup = cameraBindGroup;
    this.waterBindGroup = waterBindGroup;
  }

  protected render(pass: GPURenderPassEncoder): void {
    if (!this.cameraBindGroup || !this.waterBindGroup) return;
    this.technique.activatePipeline(pass);
    this.mesh.activate(pass);
    pass.setBindGroup(0, this.cameraBindGroup);
    pass.setBindGroup(1, this.waterBindGroup);
    this.mesh.renderGroup(pass);
  }
}
