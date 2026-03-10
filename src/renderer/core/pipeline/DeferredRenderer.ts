import { AmbientOcclusionComponent } from '../../../components/render/AmbientOcclusionComponent';
import { ContactShadowsComponent } from '../../../components/render/ContactShadowsComponent';
import { FroxelVolumetricScattering } from '../../shading/FroxelVolumetricScattering';
import { Entity } from '../../../core/ecs/Entity';
import { QualitySettings } from '../../../core/engine/QualitySettings';
import { RenderCategory } from '../../../types/RenderCategory.enum';
import { Mesh } from '../../resources/Mesh';
import { RenderTarget } from '../../resources/RenderTarget';
import { Technique } from '../../resources/Technique';
import { Texture } from '../../resources/Texture';
import { AmbientLight } from '../../shading/AmbientLight';
import { Skybox } from '../../shading/Skybox';
import { BindGroupFactory } from '../factories/BindGroupFactory';
import { GBufferPass } from '../passes/GBufferPass';
import { DepthPrepass } from '../passes/DepthPrepass';
import { RenderPassManager } from '../passes/RenderPassManager';
import { Render } from './Render';
import { DirectionalLightComponent } from '../../../components/render/DirectionalLightComponent';
import { PointLightComponent } from '../../../components/render/PointLightComponent';
import { Engine } from '../../../core/engine/Engine';
import { SpotLightComponent } from '../../../components/render/SpotLightComponent';
import { ScreenSpaceReflections } from '../../shading/ScreenSpaceReflections';
import { ScreenSpaceGlobalIllumination } from '../../shading/ScreenSpaceGlobalIllumination';
import { SamplerLibrary } from '../utils/SamplerLibrary';
import { PipelineBindGroupLayouts } from '../../../types/PipelineBindGroupLayouts.enum';
import { HZBBuilder } from '../culling/HZBBuilder';

export class DeferredRenderer {
  private isLoaded = false;
  private skybox!: Skybox;
  private ambientLight!: AmbientLight;
  private ssr!: ScreenSpaceReflections;
  private froxelVolumetrics!: FroxelVolumetricScattering;
  private ssgi!: ScreenSpaceGlobalIllumination;
  private depthPrepass!: DepthPrepass;
  private gBufferPass!: GBufferPass;
  private hzbBuilder!: HZBBuilder;
  private renderPassManager!: RenderPassManager;
  private rtAccLight!: RenderTarget;
  private rtOITAccumulation!: RenderTarget;
  private rtOITRevealage!: RenderTarget;
  private oitComposeTechnique!: Technique;
  private oitComposeMesh!: Mesh;
  private oitComposeBindGroup!: GPUBindGroup;
  private oitGlassEnvBindGroup: GPUBindGroup | null = null;
  private aoResult!: GPUTextureView;

  private rtCopyAlbedos!: RenderTarget;
  private rtCopyNormals!: RenderTarget;

  private gBufferBindGroup!: GPUBindGroup;
  private gBufferComputeBindGroup!: GPUBindGroup; // COMPUTE-visibility version for AO/SSGI compute passes
  private gBufferLayout!: GPUBindGroupLayout;
  private whiteTexture!: Texture;

  private pointLightTechnique!: Technique;
  private pointLightWithShadowsTechnique!: Technique;
  private spotLightTechnique!: Technique;
  private spotLightWithShadowsTechnique!: Technique;
  private unitSphere!: Mesh;
  private unitFrustum!: Mesh;

  constructor() {}

  public create(width: number, height: number) {
    if (!this.isLoaded) return;
    this.dispose();
    this.gBufferLayout = BindGroupFactory.getGBufferLayout();

    // Create depth prepass first (generates depth + linear depth)
    this.depthPrepass.resize();

    // Rebuild the HZB pyramid for the new depth texture (if already initialized).
    // Must come after depthPrepass.resize() so the depth texture is the new one.
    if (this.hzbBuilder?.isInitialized()) {
      this.hzbBuilder.createResources(this.depthPrepass.getDepthTexture());
    }

    // Create G-Buffer pass with specified dimensions by resizing
    this.gBufferPass.resize();

    // Invalidate any volumetric bind groups that reference the old GBuffer textures
    if (this.froxelVolumetrics) {
      this.froxelVolumetrics.resize();
    }

    // Initialize render pass manager
    if (!this.renderPassManager) {
      this.renderPassManager = new RenderPassManager();
    }

    // Create accumulation light render target
    if (!this.rtAccLight) {
      this.rtAccLight = new RenderTarget();
    }
    this.rtAccLight.createRT(
      'acc_light.dds',
      width,
      height,
      QualitySettings.getInstance().getSettings().hdrTexture,
      GPUTextureUsage.COPY_SRC,
    );

    // Create OIT render targets
    if (!this.rtOITAccumulation) this.rtOITAccumulation = new RenderTarget();
    this.rtOITAccumulation.createRT('oit_accumulation', width, height, 'rgba16float');
    if (!this.rtOITRevealage) this.rtOITRevealage = new RenderTarget();
    this.rtOITRevealage.createRT('oit_revealage', width, height, 'rgba8unorm');

    if (!this.rtCopyAlbedos) {
      this.rtCopyAlbedos = new RenderTarget();
    }
    this.rtCopyAlbedos.createRT(
      'gbuffer_copy_albedos',
      width,
      height,
      QualitySettings.getInstance().getSettings().albedoTexture,
      GPUTextureUsage.COPY_DST,
    );
    if (!this.rtCopyNormals) {
      this.rtCopyNormals = new RenderTarget();
    }
    this.rtCopyNormals.createRT(
      'gbuffer_copy_normals',
      width,
      height,
      QualitySettings.getInstance().getSettings().normalTexture,
      GPUTextureUsage.COPY_DST,
    );

    // Initialize render passes with GBufferPass render targets
    const gBufferRenderTargets = this.gBufferPass.getRenderTargets();
    const prepassDepthView = this.depthPrepass.getDepthTextureView();

    // Initialize depth prepass
    this.renderPassManager.initializeDepthPrepass(prepassDepthView);

    const copyPartialGBufferBindGroup = BindGroupFactory.createBindGroup(
      `gBuffer_copy_bind_group`,
      this.gBufferLayout,
      [
        {
          binding: 0,
          resource: this.rtCopyAlbedos.getView()!,
        },
        {
          binding: 1,
          resource: this.rtCopyNormals.getView()!,
        },
        {
          binding: 2,
          resource: gBufferRenderTargets.linearDepth.getView()!, // From G-Buffer
        },
        {
          binding: 3,
          resource: SamplerLibrary.nonFilteringSampler!,
        },
      ],
    );

    // Initialize deferred passes - all use prepass depth for depth testing
    this.renderPassManager.initializeDeferredPasses(
      gBufferRenderTargets.albedos,
      gBufferRenderTargets.normals,
      gBufferRenderTargets.linearDepth,
      prepassDepthView,
      this.rtAccLight,
      copyPartialGBufferBindGroup,
    );

    // Initialize OIT passes (gather into accum+revealage, depth read-only from prepass)
    this.renderPassManager.initializeOITPasses(
      this.rtOITAccumulation,
      this.rtOITRevealage,
      prepassDepthView,
    );

    // Create bind group with G-Buffer targets and linear depth from G-Buffer
    this.gBufferBindGroup = BindGroupFactory.createBindGroup(
      `gbuffer_bindgroup`,
      this.gBufferLayout,
      [
        {
          binding: 0,
          resource: gBufferRenderTargets.albedos.getView()!,
        },
        {
          binding: 1,
          resource: gBufferRenderTargets.normals.getView()!,
        },
        {
          binding: 2,
          resource: gBufferRenderTargets.linearDepth.getView()!, // From G-Buffer
        },
        {
          binding: 3,
          resource: SamplerLibrary.nonFilteringSampler!,
        },
      ],
    );

    // Compute-visibility G-Buffer bind group — same textures, COMPUTE visibility for AO/SSGI dispatches.
    this.gBufferComputeBindGroup = BindGroupFactory.createBindGroup(
      `gbuffer_compute_bindgroup`,
      BindGroupFactory.getGBufferComputeLayout(),
      [
        { binding: 0, resource: gBufferRenderTargets.albedos.getView()! },
        { binding: 1, resource: gBufferRenderTargets.normals.getView()! },
        { binding: 2, resource: gBufferRenderTargets.linearDepth.getView()! },
        { binding: 3, resource: SamplerLibrary.nonFilteringSampler! },
      ],
    );

    // Initialize lighting passes after gBufferBindGroup is created
    // Use depth from prepass for all lighting effects
    this.renderPassManager.initializeLightingPasses(
      this.rtAccLight,
      prepassDepthView,
      this.pointLightTechnique,
      this.pointLightWithShadowsTechnique,
      this.spotLightTechnique,
      this.spotLightWithShadowsTechnique,
      this.unitSphere,
      this.unitFrustum,
      this.gBufferBindGroup,
    );

    this.ssr.dispose();
    this.ssgi?.resize();

    // Create OIT compose bind group (accumulation + revealage → resolve over accLight)
    const oitLayout = BindGroupFactory.getLayoutFromEnum(
      PipelineBindGroupLayouts.OIT_COMPOSE_TEXTURES,
    );
    this.oitComposeBindGroup = BindGroupFactory.createBindGroup('oit_compose_bg', oitLayout, [
      { binding: 0, resource: this.rtOITAccumulation.getView() },
      { binding: 1, resource: this.rtOITRevealage.getView() },
      { binding: 2, resource: SamplerLibrary.simpleSampler! },
    ]);
  }

  public async load(): Promise<void> {
    this.skybox = new Skybox();
    await this.skybox.load();

    this.ambientLight = new AmbientLight();
    await this.ambientLight.load();

    this.ssr = new ScreenSpaceReflections();
    await this.ssr.load();

    this.ssgi = new ScreenSpaceGlobalIllumination();
    await this.ssgi.load();

    this.froxelVolumetrics = new FroxelVolumetricScattering();
    await this.froxelVolumetrics.load();

    this.depthPrepass = new DepthPrepass();
    this.depthPrepass.load();

    this.gBufferPass = new GBufferPass();
    this.gBufferPass.load();

    // HZB Builder — async pipeline setup, resources created on first create()
    this.hzbBuilder = new HZBBuilder();
    await this.hzbBuilder.initialize();

    this.pointLightTechnique = await Technique.getAsync('lighting/point_light.tech');
    this.pointLightWithShadowsTechnique = await Technique.getAsync(
      'lighting/point_light_shadows.tech',
    );
    this.spotLightTechnique = await Technique.getAsync('lighting/spot_light.tech');
    this.spotLightWithShadowsTechnique = await Technique.getAsync(
      'lighting/spot_light_shadows.tech',
    );
    this.unitSphere = await Mesh.getAsync('unit_sphere.obj');
    this.unitFrustum = await Mesh.getAsync('unit_frustum.obj');

    // OIT compose resources
    this.oitComposeTechnique = await Technique.getAsync('utility/oit_compose.tech');
    this.oitComposeMesh = await Mesh.getAsync('fullscreenquad.obj');

    this.whiteTexture = await Texture.getAsync('white.png');

    this.isLoaded = true;
  }

  public generateShadowMaps(): void {
    for (const comp of Engine.getEntities()
      .getObjectManagerByName('directional_light')
      ?.getList() ?? []) {
      const directionalLightComponent = comp as DirectionalLightComponent;
      directionalLightComponent.generateShadowMap();
    }

    for (const comp of Engine.getEntities().getObjectManagerByName('spot_light')?.getList() ?? []) {
      const spotLightComponent = comp as SpotLightComponent;
      if (spotLightComponent.hasShadows() && spotLightComponent.isVisible())
        spotLightComponent.generateShadowMap();
    }

    for (const comp of Engine.getEntities().getObjectManagerByName('point_light')?.getList() ??
      []) {
      const pointLightComponent = comp as PointLightComponent;
      if (pointLightComponent.hasShadows() && pointLightComponent.isVisible())
        pointLightComponent.generateShadowMap();
    }
  }

  /**
   * Renderiza la escena completa con el pipeline de deferred rendering
   * @param camera - Entidad con CameraComponent
   * @param skipPostProcessing - Si true, devuelve después de iluminación (sin SSR, volumetrics)
   * @returns Vista de textura con el resultado final
   */
  public render(camera: Entity, skipPostProcessing: boolean = false): GPUTextureView {
    // 1. G-Buffer pass - uses depth from prepass
    this.renderPassManager.executePass('gbuffer', RenderCategory.SOLIDS);

    // 2. Build the HZB pyramid from this frame's depth buffer.
    //    The pyramid will be consumed NEXT frame by HZBCullingPass (after frustum culling)
    //    to perform occlusion culling at zero CPU readback cost.
    if (this.hzbBuilder?.isInitialized()) {
      const encoder = Render.getInstance().getCommandEncoder();
      this.hzbBuilder.build(encoder, this.depthPrepass.getDepthTexture());
    }
    this.copyGBufferTexturesToBindGroup();
    this.renderPassManager.executePass('decals', RenderCategory.DECALS);

    // 3. Render ambient occlusion and lighting
    this.aoResult = this.renderAO(camera);
    this.renderAccLight();

    this.renderPassManager.executePass('transparent', RenderCategory.TRANSPARENT);

    this.ensureOITGlassEnvBindGroup();
    this.renderPassManager.executePass('oit_gather', RenderCategory.GLASS);
    this.renderPassManager.executeOITComposePass(
      this.oitComposeMesh,
      this.oitComposeTechnique,
      this.oitComposeBindGroup,
      this.rtAccLight,
    );

    // Si es para reflection probes, devolver aquí (sin SSR ni volumetrics)
    if (skipPostProcessing) {
      return this.rtAccLight.getView();
    }

    // Post-procesado (solo para renderizado normal)
    // Use gBufferComputeBindGroup — SSR now runs as a compute pass and requires COMPUTE visibility
    const ssr = this.ssr.generateSSR(
      this.rtAccLight.getView(),
      this.aoResult,
      this.gBufferComputeBindGroup,
    );
    this.ambientLight.renderSpecular(
      this.rtAccLight.getView(),
      ssr,
      this.aoResult,
      this.gBufferBindGroup,
    );

    if (this.froxelVolumetrics.isVolumetricEnabled()) {
      const gBufferRenderTargets = this.gBufferPass.getRenderTargets();
      this.froxelVolumetrics.updateFroxelData(gBufferRenderTargets.linearDepth);
      this.froxelVolumetrics.renderVolumetrics(this.rtAccLight.getView(), this.gBufferBindGroup);
    }

    return this.rtAccLight.getView();
  }

  private copyGBufferTexturesToBindGroup(): void {
    const gBufferRenderTargets = this.gBufferPass.getRenderTargets();
    const encoder = Render.getInstance().getCommandEncoder();

    // Copiar albedo
    encoder.copyTextureToTexture(
      { texture: gBufferRenderTargets.albedos.getTexture() },
      { texture: this.rtCopyAlbedos.getTexture() },
      {
        width: this.rtCopyAlbedos.getWidth(),
        height: this.rtCopyAlbedos.getHeight(),
        depthOrArrayLayers: 1,
      },
    );

    // Copiar normal
    encoder.copyTextureToTexture(
      { texture: gBufferRenderTargets.normals.getTexture() },
      { texture: this.rtCopyNormals.getTexture() },
      {
        width: this.rtCopyNormals.getWidth(),
        height: this.rtCopyNormals.getHeight(),
        depthOrArrayLayers: 1,
      },
    );
  }

  private renderAO(camera: Entity): GPUTextureView {
    const ambientOcclusionComponent = camera?.getComponent(
      'ambient_occlusion',
    ) as AmbientOcclusionComponent;
    if (!ambientOcclusionComponent || !ambientOcclusionComponent.hasLoaded()) {
      return this.whiteTexture.getTextureView()!;
    }
    return ambientOcclusionComponent.compute(this.gBufferComputeBindGroup);
  }

  private renderAccLight(): void {
    this.ambientLight.renderDiffuse(
      this.rtAccLight.getView(),
      this.gBufferBindGroup,
      this.aoResult,
    );

    // Directional lights receive the shadow factor and apply it to their own contribution only
    for (const comp of Engine.getEntities()
      .getObjectManagerByName('directional_light')
      ?.getList() ?? []) {
      const directionalLightComponent = comp as DirectionalLightComponent;
      directionalLightComponent.render(
        this.rtAccLight.getView(),
        this.gBufferBindGroup,
        this.whiteTexture.getTextureView()!,
      );
    }
    this.renderPassManager.executePass('pointLights');
    this.renderPassManager.executePass('pointLightsWithShadows');
    this.renderPassManager.executePass('spotLights');
    this.renderPassManager.executePass('spotLightsWithShadows');

    const prepassDepthView = this.depthPrepass.getDepthTextureView();
    this.skybox.render(this.rtAccLight.getView(), prepassDepthView);
  }

  public update(_dt: number): void {
    const mainCameraEntity = Engine.getEntities().getEntityByName('MainCamera');
    if (!mainCameraEntity) {
      return;
    }
    const ambientOcclusionComponent = mainCameraEntity.getComponent(
      'ambient_occlusion',
    ) as AmbientOcclusionComponent;
    if (ambientOcclusionComponent) {
      ambientOcclusionComponent.update(_dt);
    }

    this.ambientLight.update(_dt);
    this.ssr.update(_dt);
  }

  public renderInMenu(): void {
    this.froxelVolumetrics.renderInMenu();

    const mainCameraEntity = Engine.getEntities().getEntityByName('MainCamera');
    const ambientOcclusionComponent = mainCameraEntity?.getComponent(
      'ambient_occlusion',
    ) as AmbientOcclusionComponent;
    if (ambientOcclusionComponent) {
      ambientOcclusionComponent.renderInMenu();
    }
  }

  public resetSSRResources(): void {
    this.ssr.dispose();
    this.ssr = new ScreenSpaceReflections();
    this.ssr.load();
  }

  public resetAmbientLightResources(): void {
    this.ambientLight.destroy();
    this.ambientLight = new AmbientLight();
    this.ambientLight.load();
  }

  /**
   * Creates or rebuilds the OIT glass env bind group from the current environment cubemap.
   * Caches the result — only rebuilds if the cubemap texture view changed.
   */
  private ensureOITGlassEnvBindGroup(): void {
    const envTex = Engine.getEnvironmentManager().getSSREnvironmentTexture();
    if (!envTex) return;
    const brdfLUT = this.ssr.getBRDFLUT();
    if (!brdfLUT) return;
    if (!this.oitGlassEnvBindGroup) {
      const layout = BindGroupFactory.getOITGlassEnvLayout();
      this.oitGlassEnvBindGroup = BindGroupFactory.createBindGroup('oit_glass_env_bg', layout, [
        { binding: 0, resource: envTex.getTextureView()! },
        { binding: 1, resource: envTex.getSampler()! },
        { binding: 2, resource: brdfLUT.getTextureView()! },
      ]);
      this.renderPassManager.setOITGatherEnvBindGroup(this.oitGlassEnvBindGroup);
    }
  }

  private dispose(): void {
    if (this.gBufferPass) {
      this.gBufferPass.dispose();
    }
    if (this.rtAccLight) {
      this.rtAccLight.destroy();
    }
    if (this.rtOITAccumulation) {
      this.rtOITAccumulation.destroy();
    }
    if (this.rtOITRevealage) {
      this.rtOITRevealage.destroy();
    }
    this.oitGlassEnvBindGroup = null;

    if (this.ambientLight) {
      this.ambientLight.destroy();
    }

    this.aoResult = null as any;
  }

  public destroy(): void {
    console.log('Cleaning up DeferredRenderer...');
    this.dispose();

    if (this.renderPassManager) {
      this.renderPassManager.clear();
    }

    this.hzbBuilder?.dispose();

    this.ssgi?.dispose();
    this.gBufferBindGroup = null as any;
    this.gBufferLayout = null as any;
    this.aoResult = null as any;
    this.isLoaded = false;
  }

  public getDepthStencilView(): GPUTextureView | null {
    return this.depthPrepass.getDepthTextureView();
  }

  /** Returns the HZB pyramid builder for registration with RenderManagerV2. */
  public getHZBBuilder(): HZBBuilder {
    return this.hzbBuilder;
  }

  /** Returns the G-Buffer linear depth texture view (R = linear depth [0,1]). */
  public getLinearDepthView(): GPUTextureView {
    return this.gBufferPass.getRenderTargets().linearDepth.getView()!;
  }

  public getGBufferBindGroup(): GPUBindGroup {
    return this.gBufferBindGroup;
  }

  public getAccLightRenderTarget(): RenderTarget {
    return this.rtAccLight;
  }
}
