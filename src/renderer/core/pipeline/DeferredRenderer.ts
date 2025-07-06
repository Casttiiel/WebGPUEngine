import { AmbientOcclusionComponent } from '../../../components/render/AmbientOcclusionComponent';
import { Entity } from '../../../core/ecs/Entity';
import { QualitySettings } from '../../../core/engine/QualitySettings';
import { RenderCategory } from '../../../types/RenderCategory.enum';
import { RenderManagerV2 as RenderManager } from '../managers/RenderManagerV2';
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

export class DeferredRenderer {
  private isLoaded = false;
  private skybox!: Skybox;
  private ambientLight!: AmbientLight;
  private depthResolver!: DepthResolver;
  private gBufferPass!: GBufferPass;
  private renderPassManager!: RenderPassManager;
  private rtAccLight!: RenderTarget;
  private rtAO!: RenderTarget;
  private rtAOBinding!: RenderTarget; // Copy target for binding

  private gBufferBindGroup!: GPUBindGroup;
  private gBufferLayout: GPUBindGroupLayout;
  private whiteTexture!: Texture;

  private pointLightTechnique!: Technique;
  private spotLightTechnique!: Technique;
  private unitSphere!: Mesh;
  private unitFrustum!: Mesh;

  constructor() {
    this.gBufferLayout = BindGroupFactory.getGBufferLayout();
  }

  public create(width: number, height: number) {
    if (!this.isLoaded) return;
    this.destroy();

    // Create G-Buffer pass with specified dimensions by resizing
    this.gBufferPass.resize();

    // Initialize render pass manager
    if (!this.renderPassManager) {
      this.renderPassManager = new RenderPassManager();
    }

    // Create accumulation light render target
    const qualitySettings = QualitySettings.getInstance();
    const postProcessingFormats = qualitySettings.getPostProcessingFormats();

    if (!this.rtAccLight) {
      this.rtAccLight = new RenderTarget();
    }
    this.rtAccLight.createRT(
      'acc_light.dds',
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

    // Initialize render passes with GBufferPass render targets
    const gBufferRenderTargets = this.gBufferPass.getRenderTargets();
    const gBufferDepthTextures = this.gBufferPass.getDepthTextures();
    this.renderPassManager.initializeDeferredPasses(
      gBufferRenderTargets.albedos,
      gBufferRenderTargets.normals,
      gBufferRenderTargets.selfIllum,
      gBufferRenderTargets.linearDepth,
      this.rtAccLight,
      gBufferDepthTextures.msaaDepthView,
      gBufferDepthTextures.singleDepthView,
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

    this.depthResolver = new DepthResolver();
    await this.depthResolver.load();

    this.gBufferPass = new GBufferPass();
    await this.gBufferPass.load();

    this.pointLightTechnique = await Technique.get('point_light.tech');
    this.spotLightTechnique = await Technique.get('spot_light.tech');
    this.unitSphere = await Mesh.get('unit_sphere.obj');
    this.unitFrustum = await Mesh.get('unit_frustum.obj');

    this.whiteTexture = await Texture.get('white.png');

    this.isLoaded = true;
  }

  public async render(camera: Entity): Promise<GPUTextureView> {
    // Pre-render GPU culling - do this BEFORE starting render passes
    await RenderManager.getInstance().performPreRenderCulling();

    // Execute G-Buffer pass using new render pass system
    this.renderPassManager.executePass('gbuffer', RenderCategory.SOLIDS);

    // Execute Decal pass
    this.renderPassManager.executePass('decals', RenderCategory.DECALS);

    // Resolve MSAA depth to single-sample depth for skybox (only if MSAA is enabled)
    const gBufferDepthTextures = this.gBufferPass.getDepthTextures();
    const qualitySettings = QualitySettings.getInstance();
    const msaaLevel = qualitySettings.getMSAALevel();

    if (msaaLevel > 1) {
      this.depthResolver.resolve(gBufferDepthTextures.msaaDepth, gBufferDepthTextures.singleDepth);
    } // Execute AO pass first
    this.renderAO(camera, this.rtAO);

    // Copy AO result to binding texture to avoid usage conflicts
    this.copyAOTextureToBinding();

    // Render accumulated light with AO texture
    this.renderAccLight();

    // Execute transparent pass
    this.renderPassManager.executePass('transparent', RenderCategory.TRANSPARENT);

    const view = this.rtAccLight.getView();
    if (!view) {
      throw new Error('Failed to get albedo render target view');
    }
    return view;
  }

  private renderAO(camera: Entity, ao: RenderTarget): void {
    const ambientOcclusionComponent = camera.getComponent(
      'ambient_occlusion',
    ) as AmbientOcclusionComponent;
    ambientOcclusionComponent.compute(this.gBufferBindGroup, ao);
  }

  private renderAccLight(): void {
    this.ambientLight.render(this.rtAccLight.getView(), this.gBufferBindGroup);

    // Use new render pass system for lights
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

  private destroy(): void {
    if (this.gBufferPass) {
      this.gBufferPass.dispose();
    }
    if (this.rtAccLight) {
      this.rtAccLight.destroy();
    }

    if (this.rtAO) {
      this.rtAO.destroy();
    }

    if (this.rtAOBinding) {
      this.rtAOBinding.destroy();
    }

    if (this.renderPassManager) {
      this.renderPassManager.clear();
    }

    // Clean up depth resolver
    if (this.depthResolver) {
      this.depthResolver.destroy();
    }
  }

  public getDepthStencilView(): GPUTextureView | null {
    const gBufferDepthTextures = this.gBufferPass.getDepthTextures();
    return gBufferDepthTextures.singleDepthView;
  }

  public getGBufferBindGroup(): GPUBindGroup {
    return this.gBufferBindGroup;
  }

  /**
   * Public cleanup method for external use
   */
  public cleanup(): void {
    console.log('Cleaning up DeferredRenderer...');
    this.destroy();
    this.isLoaded = false;
  }
}
