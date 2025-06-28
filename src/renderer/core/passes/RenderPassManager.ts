import { BaseRenderPass } from './BaseRenderPass';
import { GBufferRenderPass, DecalRenderPass, TransparentRenderPass } from './DeferredRenderPasses';
import { PointLightRenderPass, SpotLightRenderPass } from './LightingRenderPasses';
import {
  ToneMappingRenderPass,
  AntialiasingRenderPass,
  AmbientOcclusionRenderPass,
  AOBilateralFilterRenderPass,
} from './PostProcessingRenderPasses';
import { RenderPassFactory } from './RenderPassFactory';
import { RenderTarget } from '../../resources/RenderTarget';
import { RenderCategory } from '../../../types/RenderCategory.enum';
import { Render } from '../Render';
import { RenderKey } from '../managers/RenderKeyManager';
import { Mesh } from '../../resources/Mesh';
import { Technique } from '../../resources/Technique';

/**
 * Manager for coordinating multiple render passes in the deferred rendering pipeline
 */
export class RenderPassManager {
  private renderPasses: Map<string, BaseRenderPass> = new Map();

  /**
   * Initialize all render passes for deferred rendering
   */
  public initializeDeferredPasses(
    albedos: RenderTarget,
    normals: RenderTarget,
    selfIllum: RenderTarget,
    linearDepth: RenderTarget,
    accLight: RenderTarget,
    msaaDepthView: GPUTextureView,
    singleDepthView: GPUTextureView,
  ): void {
    // Create G-Buffer pass
    const gBufferConfig = RenderPassFactory.createGBufferPassConfig(
      albedos,
      normals,
      selfIllum,
      linearDepth,
      msaaDepthView,
    );
    const gBufferPass = new GBufferRenderPass(gBufferConfig);
    this.renderPasses.set('gbuffer', gBufferPass);

    // Create Decal pass
    const decalConfig = RenderPassFactory.createDecalPassConfig(albedos, selfIllum, msaaDepthView);
    const decalPass = new DecalRenderPass(decalConfig);
    this.renderPasses.set('decals', decalPass);

    // Create Transparent pass
    const transparentConfig = RenderPassFactory.createTransparentPassConfig(
      accLight,
      singleDepthView,
    );
    const transparentPass = new TransparentRenderPass(transparentConfig);
    this.renderPasses.set('transparent', transparentPass);
  }

  /**
   * Execute a specific render pass
   */
  public executePass(passName: string, category?: RenderCategory, renderKeys?: RenderKey[]): void {
    const pass = this.renderPasses.get(passName);
    if (!pass) {
      throw new Error(`Render pass '${passName}' not found`);
    }

    const encoder = Render.getInstance().getCommandEncoder();
    pass.execute(encoder, category, renderKeys);
  }

  /**
   * Execute the complete deferred rendering pipeline
   */
  public executeDeferredPipeline(): void {
    // Execute G-Buffer pass
    this.executePass('gbuffer', RenderCategory.SOLIDS);

    // Execute Decal pass
    this.executePass('decals', RenderCategory.DECALS);

    // Transparent pass would be executed after lighting passes
    // this.executePass('transparent', RenderCategory.TRANSPARENT);
  }

  /**
   * Get a render pass by name
   */
  public getPass(passName: string): BaseRenderPass | undefined {
    return this.renderPasses.get(passName);
  }

  /**
   * Add a custom render pass
   */
  public addPass(name: string, pass: BaseRenderPass): void {
    this.renderPasses.set(name, pass);
  }

  /**
   * Remove a render pass
   */
  public removePass(name: string): boolean {
    return this.renderPasses.delete(name);
  }

  /**
   * Clear all render passes
   */
  public clear(): void {
    this.renderPasses.clear();
  }

  /**
   * Initialize lighting passes for deferred rendering
   */
  public initializeLightingPasses(
    accLight: RenderTarget,
    singleDepthView: GPUTextureView,
    pointLightTechnique: Technique,
    spotLightTechnique: Technique,
    unitSphere: Mesh,
    unitFrustum: Mesh,
    gBufferBindGroup: GPUBindGroup,
  ): void {
    // Create Point Light pass
    const pointLightConfig = RenderPassFactory.createPointLightPassConfig(
      accLight,
      singleDepthView,
    );
    const pointLightPass = new PointLightRenderPass(
      pointLightConfig,
      pointLightTechnique,
      unitSphere,
      gBufferBindGroup,
    );
    this.renderPasses.set('pointLights', pointLightPass);

    // Create Spot Light pass
    const spotLightConfig = RenderPassFactory.createSpotLightPassConfig(accLight, singleDepthView);
    const spotLightPass = new SpotLightRenderPass(
      spotLightConfig,
      spotLightTechnique,
      unitFrustum,
      gBufferBindGroup,
    );
    this.renderPasses.set('spotLights', spotLightPass);
  }

  /**
   * Execute a dynamic render pass directly without registration
   */
  public executeDynamicPass(
    pass: BaseRenderPass,
    category?: RenderCategory,
    renderKeys?: RenderKey[],
  ): void {
    const encoder = Render.getInstance().getCommandEncoder();
    pass.execute(encoder, category, renderKeys);
  }

  /**
   * Create and execute a tone mapping pass dynamically
   */
  public executeToneMappingPass(
    mesh: Mesh,
    technique: Technique,
    bindGroup: GPUBindGroup,
    result: RenderTarget,
  ): void {
    const passConfig = RenderPassFactory.createPostProcessPassConfig(result);
    const pass = new ToneMappingRenderPass(passConfig, mesh, technique, bindGroup);
    this.executeDynamicPass(pass);
  }

  /**
   * Create and execute an antialiasing pass dynamically
   */
  public executeAntialiasingPass(
    mesh: Mesh,
    technique: Technique,
    bindGroup: GPUBindGroup,
    result: RenderTarget,
  ): void {
    const passConfig = RenderPassFactory.createPostProcessPassConfig(result);
    const pass = new AntialiasingRenderPass(passConfig, mesh, technique, bindGroup);
    this.executeDynamicPass(pass);
  }

  /**
   * Create and execute an ambient occlusion pass dynamically
   */
  public executeAmbientOcclusionPass(
    mesh: Mesh,
    technique: Technique,
    gBufferBindGroup: GPUBindGroup,
    ssaoParamsBindGroup: GPUBindGroup | undefined,
    result: RenderTarget,
  ): void {
    const passConfig = RenderPassFactory.createPostProcessPassConfig(result);
    const pass = new AmbientOcclusionRenderPass(
      passConfig,
      mesh,
      technique,
      gBufferBindGroup,
      ssaoParamsBindGroup,
    );
    this.executeDynamicPass(pass);
  } /**
   * Create and execute an AO bilateral filter pass dynamically
   */
  public executeAOBilateralFilterPass(
    mesh: Mesh,
    technique: Technique,
    gBufferBindGroup: GPUBindGroup,
    aoBindGroup: GPUBindGroup,
    result: RenderTarget,
  ): void {
    const passConfig = RenderPassFactory.createPostProcessPassConfig(result);
    const pass = new AOBilateralFilterRenderPass(
      passConfig,
      mesh,
      technique,
      gBufferBindGroup,
      aoBindGroup,
    );
    this.executeDynamicPass(pass);
  }
}
