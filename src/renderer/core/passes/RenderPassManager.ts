import { BaseRenderPass } from './BaseRenderPass';
import {
  GBufferRenderPass,
  DecalRenderPass,
  TransparentRenderPass,
  DepthPrepassRenderPass,
  GlassOITGatherRenderPass,
  WaterCompositeRenderPass,
} from './DeferredRenderPasses';
import {
  PointLightWithShadowsRenderPass,
  SpotLightWithShadowsRenderPass,
  TiledLightingRenderPass,
} from './LightingRenderPasses';
import {
  ToneMappingRenderPass,
  AntialiasingRenderPass,
  AmbientOcclusionRenderPass,
  AOBilateralFilterRenderPass,
  BloomFilteringRenderPass,
  MotionBlurRenderPass,
  SpeedLinesVFXRenderPass,
  HeightFogRenderPass,
  ContactShadowsRenderPass,
  GodRaysOcclusionRenderPass,
  GodRaysRadialRenderPass,
  GodRaysKawaseRenderPass,
  GodRaysCompositeRenderPass,
  LensFlareOcclusionRenderPass,
  LensFlareCompositeRenderPass,
} from './PostProcessingRenderPasses';
import { FullScreenPass } from './BaseRenderPass';
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

  public initializeDepthPrepass(depthView: GPUTextureView): void {
    const depthPrepassConfig = RenderPassFactory.createDepthPrepassConfig(depthView);
    const depthPrepassPass = new DepthPrepassRenderPass(depthPrepassConfig);
    this.renderPasses.set('depth_prepass', depthPrepassPass);
  }

  public initializeDeferredPasses(
    albedos: RenderTarget,
    normals: RenderTarget,
    linearDepth: RenderTarget,
    prepassDepthView: GPUTextureView,
    accLight: RenderTarget,
    copyPartialGBufferBindGroup: GPUBindGroup,
  ): void {
    // Create G-Buffer pass - uses prepass depth for depth testing
    const gBufferConfig = RenderPassFactory.createGBufferPassConfig(
      albedos,
      normals,
      linearDepth,
      prepassDepthView,
    );
    const gBufferPass = new GBufferRenderPass(gBufferConfig);
    this.renderPasses.set('gbuffer', gBufferPass);

    // Create Decal pass - uses prepass depth
    const decalConfig = RenderPassFactory.createDecalPassConfig(albedos, normals, prepassDepthView);
    const decalPass = new DecalRenderPass(decalConfig);
    decalPass.setCustomBindGroup(copyPartialGBufferBindGroup);
    this.renderPasses.set('decals', decalPass);

    // Create Transparent pass - uses prepass depth
    const transparentConfig = RenderPassFactory.createTransparentPassConfig(
      accLight,
      prepassDepthView,
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

  /**
   * Registers the OIT gather pass using pre-created accumulation and revealage render targets.
   * Must be called after initializeDeferredPasses and before render().
   */
  public initializeOITPasses(
    accumulation: RenderTarget,
    revealage: RenderTarget,
    depthView: GPUTextureView,
  ): void {
    const config = RenderPassFactory.createOITGatherPassConfig(accumulation, revealage, depthView);
    const pass = new GlassOITGatherRenderPass(config);
    this.renderPasses.set('oit_gather', pass);
  }

  /**
   * Sets the environment cubemap bind group on the OIT gather pass (group 3).
   * Should be called once after initializeOITPasses and whenever the env texture changes.
   */
  public setOITGatherEnvBindGroup(bindGroup: GPUBindGroup): void {
    const pass = this.renderPasses.get('oit_gather') as GlassOITGatherRenderPass | undefined;
    pass?.setEnvBindGroup(bindGroup);
  }

  /**
   * Creates and executes the OIT compose pass dynamically each frame.
   * Blends the resolved accumulation/revealage into accLight using premultiplied alpha.
   */
  public executeOITComposePass(
    mesh: Mesh,
    technique: Technique,
    bindGroup: GPUBindGroup,
    accLight: RenderTarget,
  ): void {
    const passConfig = RenderPassFactory.createOITComposePassConfig(accLight);
    const pass = new FullScreenPass(passConfig, mesh, technique, bindGroup);
    this.executeDynamicPass(pass);
  }

  public clear(): void {
    this.renderPasses.clear();
  }

  public initializeLightingPasses(
    accLight: RenderTarget,
    singleDepthView: GPUTextureView,
    _pointLightTechnique: Technique,
    pointLightWithShadowsTechnique: Technique,
    _spotLightTechnique: Technique,
    spotLightWithShadowsTechnique: Technique,
    unitSphere: Mesh,
    unitFrustum: Mesh,
    gBufferBindGroup: GPUBindGroup,
  ): void {
    // Shadowless point/spot passes are replaced by the tiled lighting pass.
    // Only register shadow passes here.

    // Create Point Light with shadows pass
    const pointLightWithShadowsConfig = RenderPassFactory.createPointLightPassConfig(
      accLight,
      singleDepthView,
    );
    const pointLightWithShadowsPass = new PointLightWithShadowsRenderPass(
      pointLightWithShadowsConfig,
      pointLightWithShadowsTechnique,
      unitSphere,
      gBufferBindGroup,
    );
    pointLightWithShadowsPass.updateConfig({ label: 'Point Lights with Shadows' });
    this.renderPasses.set('pointLightsWithShadows', pointLightWithShadowsPass);

    // Create Spot Light with shadows pass
    const spotLightConfig = RenderPassFactory.createSpotLightPassConfig(accLight, singleDepthView);
    const spotLightWithShadowsPass = new SpotLightWithShadowsRenderPass(
      spotLightConfig,
      spotLightWithShadowsTechnique,
      unitFrustum,
      gBufferBindGroup,
    );
    spotLightWithShadowsPass.updateConfig({ label: 'Spot Lights with Shadows' });
    this.renderPasses.set('spotLightsWithShadows', spotLightWithShadowsPass);
  }

  /**
   * Propagates the extended G-Buffer+AO bind group to the shadow lighting render passes.
   * Call this once per frame in renderAccLight(), after computing the AO result.
   */
  public updateLightingPassesGBufferWithAO(gBufferWithAOBindGroup: GPUBindGroup): void {
    (
      this.renderPasses.get('pointLightsWithShadows') as PointLightWithShadowsRenderPass | undefined
    )?.updateGBufferWithAOBindGroup(gBufferWithAOBindGroup);
    (
      this.renderPasses.get('spotLightsWithShadows') as SpotLightWithShadowsRenderPass | undefined
    )?.updateGBufferWithAOBindGroup(gBufferWithAOBindGroup);
  }

  /**
   * Registers the tiled lighting full-screen pass.
   * Must be called once during create(), after initializeLightingPasses().
   */
  public initializeTiledLightingPass(
    accLight: RenderTarget,
    technique: Technique,
    fullscreenMesh: Mesh,
  ): void {
    const config = RenderPassFactory.createTiledLightingPassConfig(accLight);
    const pass = new TiledLightingRenderPass(config, technique, fullscreenMesh);
    this.renderPasses.set('tiledLighting', pass);
  }

  /**
   * Updates the tiled lighting pass's bind groups each frame (call in renderAccLight).
   */
  public updateTiledLightBindGroups(
    gBufferWithAOBindGroup: GPUBindGroup,
    tiledDataBindGroup: GPUBindGroup,
  ): void {
    const pass = this.renderPasses.get('tiledLighting') as TiledLightingRenderPass | undefined;
    pass?.updateGBufferWithAOBindGroup(gBufferWithAOBindGroup);
    pass?.updateTiledDataBindGroup(tiledDataBindGroup);
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
    exposureBindGroup?: GPUBindGroup,
  ): void {
    const passConfig = RenderPassFactory.createPostProcessPassConfig(
      result,
      undefined,
      'Tone Mapping',
    );
    const pass = new ToneMappingRenderPass(
      passConfig,
      mesh,
      technique,
      bindGroup,
      exposureBindGroup,
    );
    this.executeDynamicPass(pass);
  }

  public executeHeightFogPass(
    mesh: Mesh,
    technique: Technique,
    bindGroup: GPUBindGroup,
    gBufferBindGroup: GPUBindGroup,
    result: RenderTarget,
  ): void {
    const passConfig = RenderPassFactory.createPostProcessPassConfig(
      result,
      undefined,
      'Height Fog',
    );
    const pass = new HeightFogRenderPass(passConfig, mesh, technique, bindGroup, gBufferBindGroup);
    this.executeDynamicPass(pass);
  }

  /**
   * Create and execute a tone mapping pass dynamically
   */
  public executeSpeedLinesVFXPass(
    mesh: Mesh,
    technique: Technique,
    textureBindGroup: GPUBindGroup,
    bufferBindGroup: GPUBindGroup,
    result: GPUTextureView,
  ): void {
    const passConfig = RenderPassFactory.createPostProcessPassConfigBlended(
      result,
      undefined,
      'Speed Lines',
    );
    const pass = new SpeedLinesVFXRenderPass(
      passConfig,
      mesh,
      technique,
      textureBindGroup,
      bufferBindGroup,
    );
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
    label = 'Antialiasing',
  ): void {
    const passConfig = RenderPassFactory.createPostProcessPassConfig(
      result,
      Render.canvasSize,
      label,
    );
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
    label = 'Bloom',
  ): void {
    const passConfig = RenderPassFactory.createPostProcessPassConfig(result, undefined, label);
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
    const passConfig = RenderPassFactory.createPostProcessPassConfig(
      result,
      {
        width: Render.width * aoScale,
        height: Render.height * aoScale,
      },
      'AO Pass',
    );
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
    const passConfig = RenderPassFactory.createPostProcessPassConfig(
      result,
      {
        width: Render.width * aoScale,
        height: Render.height * aoScale,
      },
      'AO Bilateral Filter',
    );
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
    const passConfig = RenderPassFactory.createPostProcessPassConfig(
      result,
      {
        width: Render.width * scale,
        height: Render.height * scale,
      },
      'SSGI Bilateral Filter',
    );
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
    const passConfig = RenderPassFactory.createPostProcessPassConfig(
      result,
      undefined,
      'Motion Blur',
    );
    const pass = new MotionBlurRenderPass(
      passConfig,
      mesh,
      technique,
      paramsBindGroup,
      texturesBindGroup,
    );
    this.executeDynamicPass(pass);
  }

  /**
   * Create and execute a contact shadows pass dynamically
   */
  public executeContactShadowsPass(
    mesh: Mesh,
    technique: Technique,
    gBufferBindGroup: GPUBindGroup,
    paramsBindGroup: GPUBindGroup,
    result: RenderTarget,
  ): void {
    const passConfig = RenderPassFactory.createPostProcessPassConfig(
      result,
      {
        width: result.getWidth(),
        height: result.getHeight(),
      },
      'Contact Shadows',
    );
    const pass = new ContactShadowsRenderPass(
      passConfig,
      mesh,
      technique,
      gBufferBindGroup,
      paramsBindGroup,
    );
    this.executeDynamicPass(pass);
  }

  /**
   * Create and execute a god rays occlusion mask pass at a custom (typically
   * quarter) resolution.  group(1) = GBuffer, group(2) = HDR scene, group(3) = params.
   */
  public executeGodRaysOcclusionPass(
    mesh: Mesh,
    technique: Technique,
    gBufferBindGroup: GPUBindGroup,
    inputBindGroup: GPUBindGroup,
    paramsBindGroup: GPUBindGroup,
    result: RenderTarget,
  ): void {
    const passConfig = RenderPassFactory.createPostProcessPassConfig(
      result,
      { width: result.getWidth(), height: result.getHeight() },
      'God Rays Occlusion',
    );
    const pass = new GodRaysOcclusionRenderPass(
      passConfig,
      mesh,
      technique,
      gBufferBindGroup,
      inputBindGroup,
      paramsBindGroup,
    );
    this.executeDynamicPass(pass);
  }

  /**
   * Execute the god rays radial blur pass (Step 2).
   * Marches 64 samples from each pixel toward the sun NDC position,
   * accumulating the occlusion mask with exponential decay.
   * group(1) = occlusion mask, group(2) = GodRaysParams.
   */
  public executeGodRaysRadialPass(
    mesh: Mesh,
    technique: Technique,
    inputBindGroup: GPUBindGroup,
    paramsBindGroup: GPUBindGroup,
    result: RenderTarget,
  ): void {
    const passConfig = RenderPassFactory.createPostProcessPassConfig(
      result,
      { width: result.getWidth(), height: result.getHeight() },
      'God Rays Radial Blur',
    );
    const pass = new GodRaysRadialRenderPass(
      passConfig,
      mesh,
      technique,
      inputBindGroup,
      paramsBindGroup,
    );
    this.executeDynamicPass(pass);
  }

  /**
   * Execute one Kawase blur pass (Step 3).
   * Call 5× in ping-pong with pre-written offset bind groups (k = 0,1,2,2,3).
   * group(1) = ping-pong input, group(2) = KawaseParams (offset).
   */
  public executeGodRaysKawasePass(
    mesh: Mesh,
    technique: Technique,
    inputBindGroup: GPUBindGroup,
    paramsBindGroup: GPUBindGroup,
    result: RenderTarget,
    passLabel: string = 'God Rays Kawase',
  ): void {
    const passConfig = RenderPassFactory.createPostProcessPassConfig(
      result,
      { width: result.getWidth(), height: result.getHeight() },
      passLabel,
    );
    const pass = new GodRaysKawaseRenderPass(
      passConfig,
      mesh,
      technique,
      inputBindGroup,
      paramsBindGroup,
    );
    this.executeDynamicPass(pass);
  }

  /**
   * Execute the god rays composite pass (Step 4).
   * Renders additively onto the existing HDR view (loadOp: 'load' + ONE+ONE blend).
   * No new RT needed — the god rays contribution is blended directly in-place.
   * group(1) = Kawase output (quarter-res), group(2) = composite params.
   */
  public executeGodRaysCompositePass(
    mesh: Mesh,
    technique: Technique,
    hdrView: GPUTextureView,
    inputBindGroup: GPUBindGroup,
    paramsBindGroup: GPUBindGroup,
    exposureBindGroup: GPUBindGroup,
  ): void {
    const passConfig = RenderPassFactory.createPostProcessPassConfigBlended(
      hdrView,
      undefined,
      'God Rays Composite',
    );
    const pass = new GodRaysCompositeRenderPass(
      passConfig,
      mesh,
      technique,
      inputBindGroup,
      paramsBindGroup,
      exposureBindGroup,
    );
    this.executeDynamicPass(pass);
  }

  /**
   * Lens flare occlusion mask pass (Step 1).
   * Renders a quarter-resolution sky-visibility mask around the sun disc.
   * group(1) = GBuffer, group(2) = LensFlareParams.
   */
  public executeLensFlareOcclusionPass(
    mesh: Mesh,
    technique: Technique,
    gBufferBindGroup: GPUBindGroup,
    paramsBindGroup: GPUBindGroup,
    result: RenderTarget,
  ): void {
    const passConfig = RenderPassFactory.createPostProcessPassConfig(
      result,
      { width: result.getWidth(), height: result.getHeight() },
      'Lens Flare Occlusion',
    );
    const pass = new LensFlareOcclusionRenderPass(
      passConfig,
      mesh,
      technique,
      gBufferBindGroup,
      paramsBindGroup,
    );
    this.executeDynamicPass(pass);
  }

  /**
   * Lens flare composite pass (Step 2).
   * Additively blends flare elements (glow, ghosts, ring, streak) onto the HDR frame.
   * group(1) = occlusion mask, group(2) = LensFlareParams.
   */
  public executeLensFlareCompositePass(
    mesh: Mesh,
    technique: Technique,
    hdrView: GPUTextureView,
    occlusionBindGroup: GPUBindGroup,
    paramsBindGroup: GPUBindGroup,
  ): void {
    const passConfig = RenderPassFactory.createPostProcessPassConfigBlended(
      hdrView,
      undefined,
      'Lens Flare Composite',
    );
    const pass = new LensFlareCompositeRenderPass(
      passConfig,
      mesh,
      technique,
      occlusionBindGroup,
      paramsBindGroup,
    );
    this.executeDynamicPass(pass);
  }

  // ── Water passes ──────────────────────────────────────────────────────────

  /**
   * Registers the water GBuffer pass that writes water geometry into 3 dedicated
   * render targets (separate from the solid GBuffer).
   * Uses the same GBufferRenderPass class — the difference is the render targets
   * and the RenderCategory.WATER draw category.
   */
  public initializeWaterGBufferPass(
    waterAlbedo: RenderTarget,
    waterNormals: RenderTarget,
    waterDepth: RenderTarget,
    prepassDepthView: GPUTextureView,
  ): void {
    const config = RenderPassFactory.createWaterGBufferPassConfig(
      waterAlbedo,
      waterNormals,
      waterDepth,
      prepassDepthView,
    );
    this.renderPasses.set('waterGBuffer', new GBufferRenderPass(config));
  }

  /**
   * Registers the persistent water composite pass.
   * Call updateWaterCompositeBindGroups() each frame before executePass('waterComposite').
   */
  public initializeWaterCompositePass(
    accLight: RenderTarget,
    technique: Technique,
    fullscreenMesh: Mesh,
  ): void {
    const config = RenderPassFactory.createWaterCompositePassConfig(accLight);
    this.renderPasses.set(
      'waterComposite',
      new WaterCompositeRenderPass(config, fullscreenMesh, technique),
    );
  }

  /**
   * Updates both bind groups on the water composite pass.
   * Must be called each frame before executePass('waterComposite').
   */
  public updateWaterCompositeBindGroups(
    cameraBindGroup: GPUBindGroup,
    waterBindGroup: GPUBindGroup,
  ): void {
    const pass = this.renderPasses.get('waterComposite') as WaterCompositeRenderPass | undefined;
    pass?.updateBindGroups(cameraBindGroup, waterBindGroup);
  }
}
