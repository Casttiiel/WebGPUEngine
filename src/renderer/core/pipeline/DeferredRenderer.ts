import { AmbientOcclusionComponent } from '../../../components/render/AmbientOcclusionComponent';
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
import { ProceduralSkyCubemap } from '../../shading/ProceduralSkyCubemap';
import { BindGroupFactory } from '../factories/BindGroupFactory';
import { GBufferPass } from '../passes/GBufferPass';
import { DepthPrepass } from '../passes/DepthPrepass';
import { RenderPassManager } from '../passes/RenderPassManager';
import { Render } from './Render';
import { DirectionalLightComponent } from '../../../components/render/DirectionalLightComponent';
import { AreaLightComponent } from '../../../components/render/AreaLightComponent';
import { PointLightComponent } from '../../../components/render/PointLightComponent';
import { Engine } from '../../../core/engine/Engine';
import { SpotLightComponent } from '../../../components/render/SpotLightComponent';
import { ScreenSpaceReflections } from '../../shading/ScreenSpaceReflections';
import { ScreenSpaceGlobalIllumination } from '../../shading/ScreenSpaceGlobalIllumination';
import { SamplerLibrary } from '../utils/SamplerLibrary';
import { PipelineBindGroupLayouts } from '../../../types/PipelineBindGroupLayouts.enum';
import { HZBBuilder } from '../culling/HZBBuilder';
import { RenderManagerV2 } from '../managers/RenderManagerV2';
import { TiledLightManager } from '../managers/TiledLightManager';

export class DeferredRenderer {
  private isLoaded = false;
  private skybox!: Skybox;
  private proceduralSkyCubemap: ProceduralSkyCubemap | null = null;
  private ambientLight!: AmbientLight;
  private ssr!: ScreenSpaceReflections;

  /**
   * Optional stable color source for SSR hit sampling.
   * When TAA is active, set to TAAComponent.getHistoryView() before render() —
   * the history is the previous frame's resolved (non-jittered) result which
   * gives SSR stable hit colors.  Null falls back to the current accLight.
   */
  private ssrColorSource: GPUTextureView | null = null;

  public setSSRColorSource(view: GPUTextureView | null): void {
    this.ssrColorSource = view;
  }
  private froxelVolumetrics!: FroxelVolumetricScattering;
  private ssgi!: ScreenSpaceGlobalIllumination;
  private depthPrepass!: DepthPrepass;
  private gBufferPass!: GBufferPass;
  private hzbBuilder!: HZBBuilder;
  private renderPassManager!: RenderPassManager;

  // Depth prepass techniques (override applied per-frame before GBuffer)
  private depthPrepassTechnique!: Technique;
  private depthPrepassInstancedTechnique!: Technique;
  private depthPrepassMaskTechnique!: Technique;
  private depthPrepassMaskInstancedTechnique!: Technique;
  private depthPrepassDitherTechnique!: Technique;
  private depthPrepassDitherInstancedTechnique!: Technique;
  private rtAccLight!: RenderTarget;
  private rtOITAccumulation!: RenderTarget;
  private rtOITRevealage!: RenderTarget;
  private rtGlassRefraction!: RenderTarget;
  private oitComposeTechnique!: Technique;
  private oitComposeMesh!: Mesh;
  private oitComposeBindGroup!: GPUBindGroup;
  private oitGlassEnvBindGroup: GPUBindGroup | null = null;
  private aoResult!: GPUTextureView;
  // Cached extended G-Buffer+AO bind group for lighting shaders. Rebuilt when aoResult changes.
  private gBufferWithAOBindGroup: GPUBindGroup | null = null;
  private lastAOViewForGBuffer: GPUTextureView | null = null;

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

  private tiledLightManager!: TiledLightManager;
  private tiledLightTechnique!: Technique;
  private tiledLightMesh!: Mesh;

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
    // Snapshot of accLight right before the glass pass — used for screen-space refraction
    if (!this.rtGlassRefraction) this.rtGlassRefraction = new RenderTarget();
    this.rtGlassRefraction.createRT(
      'glass_refraction',
      width,
      height,
      QualitySettings.getInstance().getSettings().hdrTexture,
      GPUTextureUsage.COPY_DST,
    );

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

    // Initialize tiled lighting pass (shadowless point + spot lights)
    this.tiledLightManager.resize(width, height);
    this.renderPassManager.initializeTiledLightingPass(
      this.rtAccLight,
      this.tiledLightTechnique,
      this.tiledLightMesh,
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

    if (Engine.getEnvironmentManager().getSkyboxType() === 'procedural') {
      this.proceduralSkyCubemap = new ProceduralSkyCubemap();
      await this.proceduralSkyCubemap.load();
    }

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

    // Depth prepass techniques (VS-only for opaque, alpha-test FS for masked geometry)
    this.depthPrepassTechnique = await Technique.getAsync('utility/depth_prepass.tech');
    this.depthPrepassInstancedTechnique = await Technique.getAsync(
      'utility/depth_prepass_instanced.tech',
    );
    this.depthPrepassMaskTechnique = await Technique.getAsync('utility/depth_prepass_mask.tech');
    this.depthPrepassMaskInstancedTechnique = await Technique.getAsync(
      'utility/depth_prepass_mask_instanced.tech',
    );
    this.depthPrepassDitherTechnique = await Technique.getAsync(
      'utility/depth_prepass_dither.tech',
    );
    this.depthPrepassDitherInstancedTechnique = await Technique.getAsync(
      'utility/depth_prepass_dither_instanced.tech',
    );

    // HZB Builder — async pipeline setup, resources created on first create()
    this.hzbBuilder = new HZBBuilder();
    await this.hzbBuilder.initialize();

    this.pointLightTechnique = await Technique.getAsync('lighting/point_light.tech');
    const isPSX = QualitySettings.getInstance().getSettings().ditheringMode === 'psx';
    this.pointLightWithShadowsTechnique = await Technique.getAsync(
      isPSX ? 'lighting/point_light_shadows_psx.tech' : 'lighting/point_light_shadows.tech',
    );
    this.spotLightTechnique = await Technique.getAsync('lighting/spot_light.tech');
    this.spotLightWithShadowsTechnique = await Technique.getAsync(
      isPSX ? 'lighting/spot_light_shadows_psx.tech' : 'lighting/spot_light_shadows.tech',
    );
    this.unitSphere = await Mesh.getAsync('unit_sphere.obj');
    this.unitFrustum = await Mesh.getAsync('unit_frustum.obj');

    this.tiledLightTechnique = await Technique.getAsync('lighting/tiled_lighting.tech');
    this.tiledLightMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.tiledLightManager = new TiledLightManager();
    await this.tiledLightManager.load();

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
    // 0. Depth prepass — fills the shared depth buffer so the GBuffer can use
    //    hardware early-Z to eliminate overdraw.  Alpha-masked materials use a
    //    dedicated technique that discards transparent fragments so depth is only
    //    written for genuinely opaque pixels.
    const renderManager = RenderManagerV2.getInstance();
    const isDithered = QualitySettings.getInstance().getSettings().ditheringMode === 'psx';
    renderManager.setTechniqueOverride(
      this.depthPrepassTechnique,
      this.depthPrepassInstancedTechnique,
      isDithered ? this.depthPrepassDitherTechnique : this.depthPrepassMaskTechnique,
      isDithered
        ? this.depthPrepassDitherInstancedTechnique
        : this.depthPrepassMaskInstancedTechnique,
    );
    this.renderPassManager.executePass('depth_prepass', RenderCategory.SOLIDS);
    renderManager.clearTechniqueOverride();

    // 1. G-Buffer pass - loads depth from prepass (hardware early-Z active)
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

    // Snapshot accLight before glass so the glass shader can sample the undistorted scene
    // (screen-space refraction: offset UVs → shows displaced background through glass)
    const encoderForRefraction = Render.getInstance().getCommandEncoder();
    encoderForRefraction.copyTextureToTexture(
      { texture: this.rtAccLight.getTexture() },
      { texture: this.rtGlassRefraction.getTexture() },
      {
        width: this.rtGlassRefraction.getWidth(),
        height: this.rtGlassRefraction.getHeight(),
        depthOrArrayLayers: 1,
      },
    );

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
    const gBufferRTs = this.gBufferPass.getRenderTargets();
    const ssr = this.ssr.generateSSR(
      this.rtAccLight.getView(),
      this.aoResult,
      this.gBufferComputeBindGroup,
      gBufferRTs.normals.getView()!,
      gBufferRTs.linearDepth.getView()!,
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
    // Build (or reuse) the extended G-Buffer+AO bind group once per frame.
    if (!this.gBufferWithAOBindGroup || this.aoResult !== this.lastAOViewForGBuffer) {
      const rts = this.gBufferPass.getRenderTargets();
      this.gBufferWithAOBindGroup = BindGroupFactory.createBindGroup(
        'gbuffer_with_ao_bg',
        BindGroupFactory.getGBufferWithAOLayout(),
        [
          { binding: 0, resource: rts.albedos.getView()! },
          { binding: 1, resource: rts.normals.getView()! },
          { binding: 2, resource: rts.linearDepth.getView()! },
          { binding: 3, resource: SamplerLibrary.nonFilteringSampler! },
          { binding: 4, resource: this.aoResult },
          { binding: 5, resource: SamplerLibrary.simpleSampler! },
        ],
      );
      this.lastAOViewForGBuffer = this.aoResult;
    }

    this.ambientLight.renderDiffuse(
      this.rtAccLight.getView(),
      this.gBufferBindGroup,
      this.aoResult,
    );

    // Directional lights: pass the extended G-Buffer+AO bind group as their group 1
    for (const comp of Engine.getEntities()
      .getObjectManagerByName('directional_light')
      ?.getList() ?? []) {
      const directionalLightComponent = comp as DirectionalLightComponent;
      directionalLightComponent.render(
        this.rtAccLight.getView(),
        this.gBufferWithAOBindGroup!,
        this.whiteTexture.getTextureView()!,
      );
    }

    // Propagate extended G-Buffer+AO bind group to shadow lighting passes.
    this.renderPassManager.updateLightingPassesGBufferWithAO(this.gBufferWithAOBindGroup!);

    // Area lights (rectangular emitters, MRP technique)
    for (const comp of Engine.getEntities().getObjectManagerByName('area_light')?.getList() ?? []) {
      const areaLight = comp as AreaLightComponent;
      //if (!areaLight.isVisible()) continue;
      areaLight.render(this.rtAccLight.getView(), this.gBufferWithAOBindGroup!);
    }

    // Tiled lighting (shadowless point + spot lights)
    this.tiledLightManager.prepare();
    this.tiledLightManager.dispatchCulling(Render.getInstance().getCommandEncoder());
    this.renderPassManager.updateTiledLightBindGroups(
      this.gBufferWithAOBindGroup!,
      this.tiledLightManager.getRenderDataBindGroup(),
    );
    this.renderPassManager.executePass('tiledLighting');

    this.renderPassManager.executePass('pointLightsWithShadows');
    this.renderPassManager.executePass('spotLightsWithShadows');

    // Update the procedural sky cubemap before the main skybox draw so the
    // fog pass (post-processing) can sample it with correct frame-N sky colours.
    this.proceduralSkyCubemap?.render();

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
    this.ssr.renderInMenu();

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

  /**
   * Inform SSR whether TAA is currently active so it can adapt its step count.
   * Called every frame from ModuleRender before rendering.
   */
  public setSSRTemporalMode(active: boolean): void {
    this.ssr.setTemporalMode(active);
  }

  public resetAmbientLightResources(): void {
    this.ambientLight.destroy();
    this.ambientLight = new AmbientLight();
    this.ambientLight
      .load()
      .then(() => {
        console.log('[DeferredRenderer] new AmbientLight.load() completed OK');
      })
      .catch((e) => {
        console.error('[DeferredRenderer] new AmbientLight.load() FAILED:', e);
      });
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
        { binding: 3, resource: this.rtGlassRefraction.getView() },
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
    if (this.rtGlassRefraction) {
      this.rtGlassRefraction.destroy();
    }
    this.oitGlassEnvBindGroup = null;

    if (this.ambientLight) {
      this.ambientLight.destroy();
    }

    this.aoResult = null as any;
    this.gBufferWithAOBindGroup = null;
    this.lastAOViewForGBuffer = null;
  }

  public destroy(): void {
    console.log('Cleaning up DeferredRenderer...');
    this.dispose();

    if (this.renderPassManager) {
      this.renderPassManager.clear();
    }

    this.hzbBuilder?.dispose();

    this.ssgi?.dispose();
    this.proceduralSkyCubemap?.dispose();
    this.proceduralSkyCubemap = null;
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

  /** Returns the live procedural sky cubemap, or null when not in procedural mode. */
  public getProceduralSkyCubemap(): ProceduralSkyCubemap | null {
    return this.proceduralSkyCubemap;
  }
}
