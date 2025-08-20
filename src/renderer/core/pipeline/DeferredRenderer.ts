import { AmbientOcclusionComponent } from '../../../components/render/AmbientOcclusionComponent';
import { ScreenSpaceReflections } from '../ScreenSpaceReflections';
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
import { RenderPassManager } from '../passes/RenderPassManager';
import { DepthResolver } from '../processing/DepthResolver';
import { Render } from './Render';
import { DirectionalLight } from '../../shading/DirectionalLight';
import { Engine } from '../../../core/engine/Engine';
import { SpotLightComponent } from '../../../components/render/SpotLightComponent';

export class DeferredRenderer {
  private isLoaded = false;
  private skybox!: Skybox;
  private ambientLight!: AmbientLight;
  public directionalLight!: DirectionalLight;
  private depthResolver!: DepthResolver;
  private gBufferPass!: GBufferPass;
  private renderPassManager!: RenderPassManager;
  private ssr!: ScreenSpaceReflections;
  private ssrComposeTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private rtAccLight!: RenderTarget;
  private rtFinalComposite!: RenderTarget;
  private rtAO!: RenderTarget;
  private rtAOBinding!: RenderTarget; // Copy target for binding
  private rtCopyAlbedos!: RenderTarget;
  private rtCopyNormals!: RenderTarget;
  private rtCopySelfIllum!: RenderTarget;

  private gBufferBindGroup!: GPUBindGroup;
  private gBufferLayout!: GPUBindGroupLayout;
  private whiteTexture!: Texture;

  private pointLightTechnique!: Technique;
  private spotLightTechnique!: Technique;
  private unitSphere!: Mesh;
  private unitFrustum!: Mesh;

  constructor() {}

  public create(width: number, height: number) {
    if (!this.isLoaded) return;
    this.dispose();

    this.gBufferLayout = BindGroupFactory.getGBufferLayout();

    // Create G-Buffer pass with specified dimensions by resizing
    this.gBufferPass.resize();

    // Initialize render pass manager
    if (!this.renderPassManager) {
      this.renderPassManager = new RenderPassManager();
    }

    // Create accumulation light render target
    const qualitySettings = QualitySettings.getInstance();
    const postProcessingFormats = qualitySettings.getPostProcessingFormats();
    const msaaLevel = QualitySettings.getInstance().getSettings().msaaLevel;
    const enableMSAA = msaaLevel > 1;

    if (!this.rtAccLight) {
      this.rtAccLight = new RenderTarget();
    }
    this.rtAccLight.createRT(
      'acc_light.dds',
      width,
      height,
      postProcessingFormats.toneMappingTexture,
    );

    if (!this.rtFinalComposite) {
      this.rtFinalComposite = new RenderTarget();
    }
    this.rtFinalComposite.createRT(
      'final_composite.dds',
      width,
      height,
      postProcessingFormats.toneMappingTexture,
    );

    if (!this.rtAO) {
      this.rtAO = new RenderTarget();
    }
    this.rtAO.createRT(
      'ambient_occlusion_result.dds',
      width,
      height,
      postProcessingFormats.aoTexture,
      false,
      GPUTextureUsage.COPY_SRC,
    ); // Add COPY_SRC

    if (!this.rtAOBinding) {
      this.rtAOBinding = new RenderTarget();
    }
    this.rtAOBinding.createRT(
      'ambient_occlusion_binding.dds',
      width,
      height,
      postProcessingFormats.aoTexture,
      false,
      GPUTextureUsage.COPY_DST,
    ); // Add COPY_DST

    if (!this.rtCopyAlbedos) {
      this.rtCopyAlbedos = new RenderTarget();
    }
    this.rtCopyAlbedos.createRT(
      'gbuffer_copy_albedos',
      width,
      height,
      QualitySettings.getInstance().getSettings().albedoTexture,
      enableMSAA,
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
      enableMSAA,
      GPUTextureUsage.COPY_DST,
    );

    if (!this.rtCopySelfIllum) {
      this.rtCopySelfIllum = new RenderTarget();
    }
    this.rtCopySelfIllum.createRT(
      'gbuffer_copy_selfillum',
      width,
      height,
      QualitySettings.getInstance().getSettings().selfIllumTexture,
      enableMSAA,
      GPUTextureUsage.COPY_DST,
    );

    // Initialize render passes with GBufferPass render targets
    const gBufferRenderTargets = this.gBufferPass.getRenderTargets();
    const gBufferDepthTextures = this.gBufferPass.getDepthTextures();

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
          resource: gBufferRenderTargets.linearDepth.getView()!,
        },
        {
          binding: 3,
          resource: this.rtCopySelfIllum.getView()!,
        },
        {
          binding: 4,
          resource: this.whiteTexture.getTextureView()!,
        },
        {
          binding: 5,
          resource: this.whiteTexture.getSampler()!,
        },
      ],
    );

    this.renderPassManager.initializeDeferredPasses(
      gBufferRenderTargets.albedos,
      gBufferRenderTargets.normals,
      gBufferRenderTargets.selfIllum,
      gBufferRenderTargets.linearDepth,
      this.rtAccLight,
      gBufferDepthTextures.msaaDepthView,
      gBufferDepthTextures.singleDepthView,
      copyPartialGBufferBindGroup,
    );

    // Create bind group with AO texture (now MSAA compatible)
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
          resource: gBufferRenderTargets.linearDepth.getView()!,
        },
        {
          binding: 3,
          resource: gBufferRenderTargets.selfIllum.getView()!,
        },
        {
          binding: 4,
          resource: this.rtAOBinding.getView()!, // Use binding texture instead
        },
        {
          binding: 5,
          resource: this.whiteTexture.getSampler()!,
        },
      ],
    );

    // Initialize lighting passes after gBufferBindGroup is created
    this.renderPassManager.initializeLightingPasses(
      this.rtAccLight,
      gBufferDepthTextures.singleDepthView,
      this.pointLightTechnique,
      this.spotLightTechnique,
      this.unitSphere,
      this.unitFrustum,
      this.gBufferBindGroup,
    );
  }

  public async load(): Promise<void> {
    this.skybox = new Skybox();
    await this.skybox.load();

    this.ambientLight = new AmbientLight();
    await this.ambientLight.load();

    this.directionalLight = new DirectionalLight();
    await this.directionalLight.load();

    this.depthResolver = new DepthResolver();
    await this.depthResolver.load();

    this.ssr = new ScreenSpaceReflections();
    await this.ssr.load();

    this.ssrComposeTechnique = await Technique.get('ssr_compose.tech');
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');

    this.gBufferPass = new GBufferPass();
    this.gBufferPass.load();

    this.pointLightTechnique = await Technique.get('point_light.tech');
    this.spotLightTechnique = await Technique.get('spot_light.tech');
    this.unitSphere = await Mesh.get('unit_sphere.obj');
    this.unitFrustum = await Mesh.get('unit_frustum.obj');

    this.whiteTexture = await Texture.get('white.png');

    this.isLoaded = true;
  }

  public generateShadowMaps(): void {
    this.directionalLight.renderShadowMap();

    for (const comp of Engine.getEntities().getObjectManagerByName('spot_light')?.getList() ?? []) {
      const spotLightComponent = comp as SpotLightComponent;
      if (spotLightComponent.hasShadows()) spotLightComponent.generateShadowMap();
    }
  }

  public render(camera: Entity): GPUTextureView {
    // Execute G-Buffer pass using new render pass system
    this.renderPassManager.executePass('gbuffer', RenderCategory.SOLIDS);

    // Execute Decal pass
    this.copyGBufferTexturesToBindGroup();
    this.renderPassManager.executePass('decals', RenderCategory.DECALS);

    // Resolve MSAA depth to single-sample depth for skybox (only if MSAA is enabled)
    const gBufferDepthTextures = this.gBufferPass.getDepthTextures();
    const msaaLevel = QualitySettings.getInstance().getSettings().msaaLevel;

    if (msaaLevel > 1) {
      this.depthResolver.resolve(gBufferDepthTextures.msaaDepth, gBufferDepthTextures.singleDepth);
    }

    this.renderAO(camera, this.rtAO);

    this.renderAccLight();

    this.renderPassManager.executePass('transparent', RenderCategory.TRANSPARENT);

    //const finalResult = this.renderSSR();

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

    // Copiar selfIllum
    encoder.copyTextureToTexture(
      { texture: gBufferRenderTargets.selfIllum.getTexture() },
      { texture: this.rtCopySelfIllum.getTexture() },
      {
        width: this.rtCopySelfIllum.getWidth(),
        height: this.rtCopySelfIllum.getHeight(),
        depthOrArrayLayers: 1,
      },
    );
  }

  private renderAO(camera: Entity, ao: RenderTarget): void {
    const ambientOcclusionComponent = camera.getComponent(
      'ambient_occlusion',
    ) as AmbientOcclusionComponent;
    ambientOcclusionComponent.compute(this.gBufferBindGroup, ao);
    this.copyAOTextureToBinding();
  }

  private renderSSR(): GPUTextureView {
    // Create a special bind group for SSR that has the lit scene in binding 0
    const ssrGBufferBindGroup = this.createSSRGBufferBindGroup();
    const ssrResult = this.ssr.apply(this.rtAccLight.getView(), ssrGBufferBindGroup);

    // Compose SSR result with the scene using additive blending
    this.composeSSRWithScene(ssrResult);

    return this.rtFinalComposite.getView();
  }

  private composeSSRWithScene(ssrTexture: GPUTextureView): void {
    const commandEncoder = Render.getInstance().getCommandEncoder();

    // Create render pass that composes SSR with the lit scene
    const renderPassDescriptor: GPURenderPassDescriptor = {
      label: 'SSR Composition Pass',
      colorAttachments: [
        {
          view: this.rtFinalComposite.getRenderView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    };

    const renderPass = commandEncoder.beginRenderPass(renderPassDescriptor);

    // Set pipeline for composition
    this.ssrComposeTechnique.activatePipeline(renderPass);

    // Create bind groups for scene and SSR textures
    const sceneBindGroup = BindGroupFactory.createBindGroup(
      'ssr_scene_bindgroup',
      this.ssrComposeTechnique.getPipeline().getBindGroupLayout(0)!,
      [
        {
          binding: 0,
          resource: this.rtAccLight.getView()!,
        },
        {
          binding: 1,
          resource: this.whiteTexture.getSampler()!,
        },
      ],
    );

    const ssrBindGroup = BindGroupFactory.createBindGroup(
      'ssr_reflection_bindgroup',
      this.ssrComposeTechnique.getPipeline().getBindGroupLayout(1)!,
      [
        {
          binding: 0,
          resource: ssrTexture,
        },
        {
          binding: 1,
          resource: this.whiteTexture.getSampler()!,
        },
      ],
    );

    // Bind resources and render fullscreen quad
    renderPass.setBindGroup(0, sceneBindGroup);
    renderPass.setBindGroup(1, ssrBindGroup);

    this.fullscreenQuadMesh.activate(renderPass);
    this.fullscreenQuadMesh.renderGroup(renderPass);

    renderPass.end();
  }

  private createSSRGBufferBindGroup(): GPUBindGroup {
    const gBufferRenderTargets = this.gBufferPass.getRenderTargets();

    // Create bind group with lit scene in binding 0 (where albedo usually is)
    return BindGroupFactory.createBindGroup('ssr_gbuffer_bindgroup', this.gBufferLayout, [
      {
        binding: 0,
        resource: this.rtAccLight.getView()!, // Lit scene instead of albedo
      },
      {
        binding: 1,
        resource: gBufferRenderTargets.normals.getView()!,
      },
      {
        binding: 2,
        resource: gBufferRenderTargets.linearDepth.getView()!,
      },
      {
        binding: 3,
        resource: gBufferRenderTargets.selfIllum.getView()!,
      },
      {
        binding: 4,
        resource: this.rtAOBinding.getView()!,
      },
      {
        binding: 5,
        resource: this.whiteTexture.getSampler()!,
      },
    ]);
  }

  private renderAccLight(): void {
    this.ambientLight.render(this.rtAccLight.getView(), this.gBufferBindGroup);

    // Use new render pass system for lights
    this.directionalLight.render(this.rtAccLight.getView(), this.gBufferBindGroup);
    this.renderPassManager.executePass('pointLights');
    this.renderPassManager.executePass('spotLights');

    const gBufferDepthTextures = this.gBufferPass.getDepthTextures();
    this.skybox.render(this.rtAccLight.getView(), gBufferDepthTextures.singleDepthView);
  }

  private copyAOTextureToBinding(): void {
    // Copy AO result to binding texture using GPU
    const encoder = Render.getInstance().getCommandEncoder();

    encoder.copyTextureToTexture(
      { texture: this.rtAO.getTexture() },
      { texture: this.rtAOBinding.getTexture() },
      {
        width: this.rtAO.getWidth(),
        height: this.rtAO.getHeight(),
        depthOrArrayLayers: 1,
      },
    );
  }

  public update(_dt: number): void {}

  private dispose(): void {
    if (this.gBufferPass) {
      this.gBufferPass.dispose();
    }
    if (this.rtAccLight) {
      this.rtAccLight.destroy();
    }
    if (this.rtFinalComposite) {
      this.rtFinalComposite.destroy();
    }
    if (this.rtAO) {
      this.rtAO.destroy();
    }

    if (this.rtAOBinding) {
      this.rtAOBinding.destroy();
    }
  }

  public destroy(): void {
    console.log('Cleaning up DeferredRenderer...');
    this.dispose();

    if (this.renderPassManager) {
      this.renderPassManager.clear();
    }

    // Clean up depth resolver
    if (this.depthResolver) {
      this.depthResolver.destroy();
    }

    this.gBufferBindGroup = null as any;
    this.gBufferLayout = null as any;
    this.isLoaded = false;
  }

  public getDepthStencilView(): GPUTextureView | null {
    const gBufferDepthTextures = this.gBufferPass.getDepthTextures();
    return gBufferDepthTextures.singleDepthView;
  }

  public getGBufferBindGroup(): GPUBindGroup {
    return this.gBufferBindGroup;
  }
}
