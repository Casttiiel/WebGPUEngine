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
import { BindGroupFactory } from '../factories/BindGroupFactory';
import { GBufferPass } from '../passes/GBufferPass';
import { DepthPrepass } from '../passes/DepthPrepass';
import { RenderPassManager } from '../passes/RenderPassManager';
import { RenderManagerV2 as RenderManager } from '../managers/RenderManagerV2';
import { Render } from './Render';
import { DirectionalLightComponent } from '../../../components/render/DirectionalLightComponent';
import { Engine } from '../../../core/engine/Engine';
import { SpotLightComponent } from '../../../components/render/SpotLightComponent';
import { ScreenSpaceReflections } from '../../shading/ScreenSpaceReflections';

export class DeferredRenderer {
  private isLoaded = false;
  private skybox!: Skybox;
  private ambientLight!: AmbientLight;
  private ssr!: ScreenSpaceReflections;
  private froxelVolumetrics!: FroxelVolumetricScattering;
  private depthPrepass!: DepthPrepass;
  private depthPrepassTechnique!: Technique;
  private depthPrepassInstancedTechnique!: Technique;
  private gBufferPass!: GBufferPass;
  private renderPassManager!: RenderPassManager;
  private rtAccLight!: RenderTarget;
  private aoResult!: GPUTextureView;

  private rtCopyAlbedos!: RenderTarget;
  private rtCopyNormals!: RenderTarget;

  private gBufferBindGroup!: GPUBindGroup;
  private gBufferLayout!: GPUBindGroupLayout;
  private whiteTexture!: Texture;

  private pointLightTechnique!: Technique;
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

    // Create G-Buffer pass with specified dimensions by resizing
    this.gBufferPass.resize();

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
          resource: this.whiteTexture.getSampler()!,
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
          resource: this.whiteTexture.getSampler()!,
        },
      ],
    );

    // Initialize lighting passes after gBufferBindGroup is created
    // Use depth from prepass for all lighting effects
    this.renderPassManager.initializeLightingPasses(
      this.rtAccLight,
      prepassDepthView,
      this.pointLightTechnique,
      this.spotLightTechnique,
      this.spotLightWithShadowsTechnique,
      this.unitSphere,
      this.unitFrustum,
      this.gBufferBindGroup,
    );

    this.ssr.dispose();
  }

  public async load(): Promise<void> {
    this.skybox = new Skybox();
    await this.skybox.load();

    this.ambientLight = new AmbientLight();
    await this.ambientLight.load();

    this.ssr = new ScreenSpaceReflections();
    await this.ssr.load();

    this.froxelVolumetrics = new FroxelVolumetricScattering();
    await this.froxelVolumetrics.load();

    this.depthPrepass = new DepthPrepass();
    this.depthPrepass.load();

    this.depthPrepassTechnique = await Technique.getAsync('depth_prepass.tech');
    this.depthPrepassInstancedTechnique = await Technique.getAsync('depth_prepass_instanced.tech');

    this.gBufferPass = new GBufferPass();
    this.gBufferPass.load();

    this.pointLightTechnique = await Technique.getAsync('point_light.tech');
    this.spotLightTechnique = await Technique.getAsync('spot_light.tech');
    this.spotLightWithShadowsTechnique = await Technique.getAsync('spot_light_shadows.tech');
    this.unitSphere = await Mesh.getAsync('unit_sphere.obj');
    this.unitFrustum = await Mesh.getAsync('unit_frustum.obj');

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
      if (spotLightComponent.hasShadows()) spotLightComponent.generateShadowMap();
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
    this.copyGBufferTexturesToBindGroup();
    this.renderPassManager.executePass('decals', RenderCategory.DECALS);

    // 3. Render ambient occlusion and lighting
    this.aoResult = this.renderAO(camera);
    this.renderAccLight();

    this.renderPassManager.executePass('transparent', RenderCategory.TRANSPARENT);

    // Si es para reflection probes, devolver aquí (sin SSR ni volumetrics)
    if (skipPostProcessing) {
      const view = this.rtAccLight.getView();
      if (!view) {
        throw new Error('Failed to get final render target view');
      }
      return view;
    }

    // Post-procesado (solo para renderizado normal)
    const ssr = this.ssr.generateSSR(
      this.rtAccLight.getView(),
      this.aoResult,
      this.gBufferBindGroup,
    );
    this.ambientLight.renderSpecular(
      this.rtAccLight.getView(),
      ssr,
      this.aoResult,
      this.gBufferBindGroup,
    );

    if (this.froxelVolumetrics.isVolumetricEnabled()) {
      this.froxelVolumetrics.updateFroxelData();
      this.froxelVolumetrics.renderVolumetrics(this.rtAccLight.getView(), this.gBufferBindGroup);
    }

    const view = this.rtAccLight.getView();
    if (!view) {
      throw new Error('Failed to get final render target view');
    }
    return view;
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
    const ambientOcclusionComponent = camera.getComponent(
      'ambient_occlusion',
    ) as AmbientOcclusionComponent;
    if (!ambientOcclusionComponent || !ambientOcclusionComponent.hasLoaded()) {
      return this.whiteTexture.getTextureView()!;
    }
    return ambientOcclusionComponent.compute(this.gBufferBindGroup);
  }

  private renderAccLight(): void {
    this.ambientLight.renderDiffuse(
      this.rtAccLight.getView(),
      this.gBufferBindGroup,
      this.aoResult,
    );

    // Use new render pass system for lights
    for (const comp of Engine.getEntities()
      .getObjectManagerByName('directional_light')
      ?.getList() ?? []) {
      const directionalLightComponent = comp as DirectionalLightComponent;
      directionalLightComponent.render(this.rtAccLight.getView(), this.gBufferBindGroup);
    }
    this.renderPassManager.executePass('pointLights');
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

  private dispose(): void {
    if (this.gBufferPass) {
      this.gBufferPass.dispose();
    }
    if (this.rtAccLight) {
      this.rtAccLight.destroy();
    }

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

    this.gBufferBindGroup = null as any;
    this.gBufferLayout = null as any;
    this.aoResult = null as any;
    this.isLoaded = false;
  }

  public getDepthStencilView(): GPUTextureView | null {
    return this.depthPrepass.getDepthTextureView();
  }

  public getGBufferBindGroup(): GPUBindGroup {
    return this.gBufferBindGroup;
  }

  public getAccLightRenderTarget(): RenderTarget {
    return this.rtAccLight;
  }
}
