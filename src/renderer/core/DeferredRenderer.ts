import { RenderCategory } from '../../types/RenderCategory.enum';
import { AmbientLight } from '../shading/AmbientLight';
import { Skybox } from '../shading/Skybox';
import { Render } from './Render';
import { RenderManagerV2 as RenderManager } from './managers/RenderManagerV2';
import { RenderToTexture } from './RenderToTexture';
import { DepthResolver } from './DepthResolver';
import { Entity } from '@/core/ecs/Entity';
import { AmbientOcclusionComponent } from '@/components/render/AmbientOcclusionComponent';
import { Technique } from '../resources/Technique';
import { Mesh } from '../resources/Mesh';
import { Engine } from '../../core/engine/Engine';
import { PointLightComponent } from '../../components/render/PointLightComponent';
import { TransformComponent } from '../../components/core/TransformComponent';
import { BindGroupFactory } from './factories/BindGroupFactory';
import { Texture } from '../resources/Texture';
import { SpotLightComponent } from '../../components/render/SpotLightComponent';
import { GBufferPass } from './passes/GBufferPass';
import { RenderPassManager } from './passes/RenderPassManager';
import { GPUUtils } from './utils/GPUUtils';

export class DeferredRenderer {
  private isLoaded = false;
  private skybox!: Skybox;
  private ambientLight!: AmbientLight;
  private depthResolver!: DepthResolver;
  private gBufferPass!: GBufferPass;
  private renderPassManager!: RenderPassManager;
  private rtAccLight!: RenderToTexture;

  private gBufferBindGroup!: GPUBindGroup;
  private gbufferLayout: GPUBindGroupLayout;
  private whiteTexture!: Texture;
  // Mantener track del estado actual del AO
  private currentAOState: {
    hasAO: boolean;
    textureView: GPUTextureView;
  } | null = null;

  private pointLightTechnique!: Technique;
  private spotLightTechnique!: Technique;
  private unitSphere!: Mesh;
  private unitFrustum!: Mesh;

  constructor() {
    this.gbufferLayout = BindGroupFactory.getGBufferLayout();
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
    if (!this.rtAccLight) {
      this.rtAccLight = new RenderToTexture();
    }
    this.rtAccLight.createRT('acc_light.dds', width, height, 'rgba16float');

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

    // Si no hay AO, usar la textura blanca (que representa sin oclusión)
    const aoView = this.whiteTexture.getTextureView();

    this.gBufferBindGroup = BindGroupFactory.createBindGroup(
      `ambient_bindgroup`,
      this.gbufferLayout,
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
          resource: aoView!,
        },
        {
          binding: 5,
          resource: this.whiteTexture.getSampler()!,
        },
      ],
    );

    // Guardar estado inicial del AO
    this.currentAOState = {
      hasAO: false,
      textureView: aoView!,
    };
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

    // Resolve MSAA depth to single-sample depth for skybox
    const gBufferDepthTextures = this.gBufferPass.getDepthTextures();
    this.depthResolver.resolve(gBufferDepthTextures.msaaDepth, gBufferDepthTextures.singleDepth);

    const aoResult = this.renderAO(camera);
    this.renderAccLight(aoResult);

    // Execute transparent pass
    this.renderPassManager.executePass('transparent', RenderCategory.TRANSPARENT);

    const view = this.rtAccLight.getView();
    if (!view) {
      throw new Error('Failed to get albedo render target view');
    }
    return view;
  }

  private renderAO(camera: Entity): GPUTextureView | undefined {
    const ambientOcclusionComponent = camera.getComponent(
      'ambient_occlusion',
    ) as AmbientOcclusionComponent;
    if (!ambientOcclusionComponent) {
      return undefined;
    }
    return ambientOcclusionComponent.compute(this.gBufferBindGroup);
  }
  private renderAccLight(aoTextureView: GPUTextureView | undefined): void {
    this.updateAOTexture(aoTextureView || null);
    this.ambientLight.render(this.rtAccLight.getView(), this.gBufferBindGroup);
    this.renderPointLights();
    this.renderSpotLightsNoShadows();

    const gBufferDepthTextures = this.gBufferPass.getDepthTextures();
    this.skybox.render(this.rtAccLight.getView(), gBufferDepthTextures.singleDepthView);
  }

  private renderPointLights(): void {
    const render = Render.getInstance();
    const gBufferDepthTextures = this.gBufferPass.getDepthTextures();

    const pass = render.getCommandEncoder().beginRenderPass({
      label: 'Point Lights Render pass',
      colorAttachments: [
        {
          view: this.rtAccLight.getView(),
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: gBufferDepthTextures.singleDepthView, // Use single-sample depth for point light pass
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
    });

    // Configurar el viewport y scissor para asegurar que todo el canvas sea utilizable
    GPUUtils.configureViewportAndScissor(pass, render.getCanvas().width, render.getCanvas().height);

    // 1. Activar el pipeline
    this.pointLightTechnique.activatePipeline(pass);

    // 2. Activar mesh data
    this.unitSphere.activate(pass);

    // 3. Activar bind groups
    pass.setBindGroup(0, Engine.getRender().getGlobalBindGroup()); // Camera uniforms
    pass.setBindGroup(1, this.gBufferBindGroup); // GBuffer textures

    for (const comp of Engine.getEntities().getObjectManagerByName('point_light')?.getList() ??
      []) {
      const pointLightComponent = comp as PointLightComponent;
      const entity = pointLightComponent.getOwner();
      const transform = entity.getComponent('transform') as TransformComponent;
      pass.setBindGroup(2, transform.getModelBindGroup());
      pointLightComponent.setBindGroup(pass);

      // 4. Dibujar la mesh
      this.unitSphere.renderGroup(pass);
    }

    pass.end();
  }

  private renderSpotLightsNoShadows(): void {
    const render = Render.getInstance();
    const gBufferDepthTextures = this.gBufferPass.getDepthTextures();

    const pass = render.getCommandEncoder().beginRenderPass({
      label: 'Spot Lights Render pass',
      colorAttachments: [
        {
          view: this.rtAccLight.getView(),
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: gBufferDepthTextures.singleDepthView, // Use single-sample depth for spot light pass
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
    });

    // Configurar el viewport y scissor para asegurar que todo el canvas sea utilizable
    GPUUtils.configureViewportAndScissor(pass, render.getCanvas().width, render.getCanvas().height);

    // 1. Activar el pipeline
    this.spotLightTechnique.activatePipeline(pass);

    // 2. Activar mesh data
    this.unitFrustum.activate(pass);

    // 3. Activar bind groups
    pass.setBindGroup(0, Engine.getRender().getGlobalBindGroup()); // Camera uniforms
    pass.setBindGroup(1, this.gBufferBindGroup); // GBuffer textures

    for (const comp of Engine.getEntities().getObjectManagerByName('spot_light')?.getList() ?? []) {
      const spotLightComponent = comp as SpotLightComponent;
      spotLightComponent.setBindGroup(pass);

      // 4. Dibujar la mesh
      this.unitFrustum.renderGroup(pass);
    }

    pass.end();
  }
  public update(_dt: number): void { }
  private destroy(): void {
    if (this.gBufferPass) {
      this.gBufferPass.dispose();
    }

    if (this.rtAccLight) {
      this.rtAccLight.destroy();
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

  private updateAOTexture(rtAmbientOcclusion: GPUTextureView | null): void {
    // Determinar el nuevo estado del AO
    const hasNewAO = rtAmbientOcclusion !== null;
    const aoTextureView = hasNewAO ? rtAmbientOcclusion : this.whiteTexture.getTextureView();

    if (!aoTextureView) {
      throw new Error('AO texture view is undefined in AmbientLight.updateAOTexture');
    }

    // Verificar si hubo un cambio real en el estado del AO
    if (
      this.currentAOState &&
      this.currentAOState.hasAO === hasNewAO &&
      this.currentAOState.textureView === aoTextureView
    ) {
      return; // No hay cambio, mantener el bind group actual
    }

    // Actualizar el estado del AO
    this.currentAOState = {
      hasAO: hasNewAO,
      textureView: aoTextureView,
    };

    // Recrear el bind group solo si hubo un cambio
    const gBufferRenderTargets = this.gBufferPass.getRenderTargets();
    this.gBufferBindGroup = BindGroupFactory.createBindGroup(
      `gbuffer bind group`,
      this.gbufferLayout,
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
          resource: rtAmbientOcclusion!,
        },
        {
          binding: 5,
          resource: this.whiteTexture.getSampler()!,
        },
      ]
    );
  }
}
