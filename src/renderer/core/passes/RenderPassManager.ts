import { BaseRenderPass } from './BaseRenderPass';
import { GBufferRenderPass, DecalRenderPass, TransparentRenderPass } from './DeferredRenderPasses';
import {
  PointLightRenderPass,
  SpotLightRenderPass,
  SpotLightWithShadowsRenderPass,
} from './LightingRenderPasses';
import {
  ToneMappingRenderPass,
  AntialiasingRenderPass,
  AmbientOcclusionRenderPass,
  AOBilateralFilterRenderPass,
  BloomFilteringRenderPass,
  MotionBlurRenderPass,
} from './PostProcessingRenderPasses';
import { RenderPassFactory } from './RenderPassFactory';
import { RenderTarget } from '../../resources/RenderTarget';
import { RenderCategory } from '../../../types/RenderCategory.enum';
import { Render } from '../pipeline/Render';
import { RenderKey } from '../managers/RenderKeyManager';
import { Mesh } from '../../resources/Mesh';
import { Technique } from '../../resources/Technique';
import { QualitySettings } from '../../../core/engine/QualitySettings';

export class RenderPassManager {
  private renderPasses: Map<string, BaseRenderPass> = new Map();

  public initializeDeferredPasses(
    albedos: RenderTarget,
    normals: RenderTarget,
    linearDepth: RenderTarget,
    accLight: RenderTarget,
    msaaDepthView: GPUTextureView,
    singleDepthView: GPUTextureView,
    copyPartialGBufferBindGroup: GPUBindGroup,
  ): void {
    // Create G-Buffer pass
    const gBufferConfig = RenderPassFactory.createGBufferPassConfig(
      albedos,
      normals,
      linearDepth,
      msaaDepthView,
    );
    const gBufferPass = new GBufferRenderPass(gBufferConfig);
    this.renderPasses.set('gbuffer', gBufferPass);

    // Create Decal pass
    const decalConfig = RenderPassFactory.createDecalPassConfig(albedos, normals, msaaDepthView);
    const decalPass = new DecalRenderPass(decalConfig);
    decalPass.setCustomBindGroup(copyPartialGBufferBindGroup);
    this.renderPasses.set('decals', decalPass);

    // Create Transparent pass
    const transparentConfig = RenderPassFactory.createTransparentPassConfig(
      accLight,
      singleDepthView,
    );
    const transparentPass = new TransparentRenderPass(transparentConfig);
    this.renderPasses.set('transparent', transparentPass);
  }

  public executePass(passName: string, category?: RenderCategory, renderKeys?: RenderKey[]): void {
    const pass = this.renderPasses.get(passName);
    if (!pass) {
      throw new Error(`Render pass '${passName}' not found`);
    }

    const encoder = Render.getInstance().getCommandEncoder();
    pass.execute(encoder, category, renderKeys);
  }

  public clear(): void {
    this.renderPasses.clear();
  }

  public initializeLightingPasses(
    accLight: RenderTarget,
    singleDepthView: GPUTextureView,
    pointLightTechnique: Technique,
    spotLightTechnique: Technique,
    spotLightWithShadowsTechnique: Technique,
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

    // Create Spot Light with shadows pass
    const spotLightWithShadowsPass = new SpotLightWithShadowsRenderPass(
      spotLightConfig,
      spotLightWithShadowsTechnique,
      unitFrustum,
      gBufferBindGroup,
    );
    this.renderPasses.set('spotLightsWithShadows', spotLightWithShadowsPass);
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
   * Create and execute a bloom filtering pass dynamically
   */
  public executeBloomFilteringPass(
    mesh: Mesh,
    technique: Technique,
    gBufferBindGroup: GPUBindGroup,
    inputTextureBindGroup: GPUBindGroup,
    result: RenderTarget,
    paramsBindGroup?: GPUBindGroup,
  ): void {
    const passConfig = RenderPassFactory.createPostProcessPassConfig(result);
    const pass = new BloomFilteringRenderPass(
      passConfig,
      mesh,
      technique,
      gBufferBindGroup,
      inputTextureBindGroup,
      paramsBindGroup,
    );
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
    const aoScale = QualitySettings.getInstance().getSettings().aoScale;
    const passConfig = RenderPassFactory.createPostProcessPassConfig(result, {
      width: Render.width * aoScale,
      height: Render.height * aoScale,
    });
    const pass = new AmbientOcclusionRenderPass(
      passConfig,
      mesh,
      technique,
      gBufferBindGroup,
      ssaoParamsBindGroup,
    );
    this.executeDynamicPass(pass);
  }

  /**
   * Create and execute an AO bilateral filter pass dynamically
   */
  public executeAOBilateralFilterPass(
    mesh: Mesh,
    technique: Technique,
    gBufferBindGroup: GPUBindGroup,
    aoBindGroup: GPUBindGroup,
    result: RenderTarget,
  ): void {
    const aoScale = QualitySettings.getInstance().getSettings().aoScale;
    const passConfig = RenderPassFactory.createPostProcessPassConfig(result, {
      width: Render.width * aoScale,
      height: Render.height * aoScale,
    });
    const pass = new AOBilateralFilterRenderPass(
      passConfig,
      mesh,
      technique,
      gBufferBindGroup,
      aoBindGroup,
    );
    this.executeDynamicPass(pass);
  }

  public executeSSGIBilateralFilterPass(
    mesh: Mesh,
    technique: Technique,
    gBufferBindGroup: GPUBindGroup,
    aoBindGroup: GPUBindGroup,
    result: RenderTarget,
  ): void {
    const scale = QualitySettings.getInstance().getSettings().ssgiScale;
    const passConfig = RenderPassFactory.createPostProcessPassConfig(result, {
      width: Render.width * scale,
      height: Render.height * scale,
    });
    const pass = new AOBilateralFilterRenderPass(
      passConfig,
      mesh,
      technique,
      gBufferBindGroup,
      aoBindGroup,
    );
    this.executeDynamicPass(pass);
  }

  /**
   * Create and execute a motion blur pass dynamically
   */
  public executeMotionBlurPass(
    mesh: Mesh,
    technique: Technique,
    paramsBindGroup: GPUBindGroup,
    texturesBindGroup: GPUBindGroup,
    result: RenderTarget,
  ): void {
    const passConfig = RenderPassFactory.createPostProcessPassConfig(result);
    const pass = new MotionBlurRenderPass(
      passConfig,
      mesh,
      technique,
      paramsBindGroup,
      texturesBindGroup,
    );
    this.executeDynamicPass(pass);
  }
}
