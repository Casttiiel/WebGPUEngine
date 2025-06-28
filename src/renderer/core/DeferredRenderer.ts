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
import { GPUUtils } from './utils/GPUUtils';
import { Mesh } from '../resources/Mesh';
import { Engine } from '../../core/engine/Engine';
import { PointLightComponent } from '../../components/render/PointLightComponent';
import { TransformComponent } from '../../components/core/TransformComponent';
import { BindGroupFactory } from './factories/BindGroupFactory';
import { Texture } from '../resources/Texture';
import { SpotLightComponent } from '../../components/render/SpotLightComponent';

export class DeferredRenderer {
  private isLoaded = false;
  private skybox!: Skybox;
  private ambientLight!: AmbientLight;
  private depthResolver!: DepthResolver;
  private rtAlbedos!: RenderToTexture;
  private rtNormals!: RenderToTexture;
  private rtLinearDepth!: RenderToTexture;
  private rtAccLight!: RenderToTexture;
  private rtSelfIllum!: RenderToTexture;

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

  private depthStencil!: GPUTexture;
  private depthStencilView!: GPUTextureView;

  // MSAA depth buffer for G-Buffer pass
  private msaaDepthStencil!: GPUTexture;
  private msaaDepthStencilView!: GPUTextureView | null;

  constructor() {
    this.gbufferLayout = BindGroupFactory.getGBufferLayout();
  }

  public create(width: number, height: number) {
    if (!this.isLoaded) return;
    this.destroy();

    if (!this.rtAlbedos) {
      this.rtAlbedos = new RenderToTexture();
      this.rtNormals = new RenderToTexture();
      this.rtLinearDepth = new RenderToTexture();
      this.rtAccLight = new RenderToTexture();
      this.rtSelfIllum = new RenderToTexture();
    }

    this.rtAlbedos.createRT('g_albedos.dds', width, height, 'rgba16float', true);
    this.rtNormals.createRT('g_normals.dds', width, height, 'rgba16float', true);
    this.rtSelfIllum.createRT('g_self_illum.dds', width, height, 'rgba16float', true);
    this.rtLinearDepth.createRT('g_depths.dds', width, height, 'r16float', true);
    this.rtAccLight.createRT('acc_light.dds', width, height, 'rgba16float');

    // Create single-sample depth buffer (for non-MSAA passes and skybox)
    this.depthStencil = GPUUtils.createTexture(
      'deferred depth stencil texture label',
      width,
      height,
      'depth32float',
      GPUTextureUsage.RENDER_ATTACHMENT,
      1
    );

    this.depthStencilView = this.depthStencil.createView(); // Create MSAA depth buffer for G-Buffer pass
    this.msaaDepthStencil = GPUUtils.createTexture(
      'deferred msaa depth stencil texture label',
      width,
      height,
      'depth32float',
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      4
    );

    this.msaaDepthStencilView = this.msaaDepthStencil.createView();    // Si no hay AO, usar la textura blanca (que representa sin oclusión)
    const aoView = this.whiteTexture.getTextureView();

    this.gBufferBindGroup = BindGroupFactory.createBindGroup(
      `ambient_bindgroup`,
      this.gbufferLayout,
      [
        {
          binding: 0,
          resource: this.rtAlbedos.getView(),
        },
        {
          binding: 1,
          resource: this.rtNormals.getView(),
        },
        {
          binding: 2,
          resource: this.rtLinearDepth.getView(),
        },
        {
          binding: 3,
          resource: this.rtSelfIllum.getView(),
        },
        {
          binding: 4,
          resource: aoView,
        },
        {
          binding: 5,
          resource: this.whiteTexture.getSampler(),
        },
      ]
    );

    // Guardar estado inicial del AO
    this.currentAOState = {
      hasAO: false,
      textureView: aoView,
    };
  }

  public async load(): Promise<void> {
    this.skybox = new Skybox();
    await this.skybox.load();

    this.ambientLight = new AmbientLight();
    await this.ambientLight.load();

    this.depthResolver = new DepthResolver();
    await this.depthResolver.load();

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
    this.renderGBuffer();
    this.renderGBufferDecals();
    // Resolve MSAA depth to single-sample depth for skybox
    this.depthResolver.resolve(this.msaaDepthStencil, this.depthStencil);
    const aoResult = this.renderAO(camera);
    this.renderAccLight(aoResult);
    this.renderTransparents();

    const view = this.rtAccLight.getView();
    if (!view) {
      throw new Error('Failed to get albedo render target view');
    }
    return view;
  }

  private renderGBuffer(): void {
    const render = Render.getInstance();
    const pass = render.getCommandEncoder().beginRenderPass(this.getGBufferRenderPassDescriptor());

    // Configurar el viewport y scissor para asegurar que todo el canvas sea utilizable
    pass.setViewport(
      0,
      0, // Offset X,Y
      Render.width, // Width
      Render.height, // Height
      0.0,
      1.0, // Min/max depth
    );

    pass.setScissorRect(
      0,
      0, // Offset X,Y
      Render.width, // Width
      Render.height, // Height
    );

    // Now use synchronous render with pre-culled objects
    RenderManager.getInstance().render(RenderCategory.SOLIDS, pass);

    pass.end();
  }

  private renderGBufferDecals(): void {
    const render = Render.getInstance();
    const pass = render
      .getCommandEncoder()
      .beginRenderPass(this.getGBufferDecalsRenderPassDescriptor());

    // Configurar el viewport y scissor para asegurar que todo el canvas sea utilizable
    pass.setViewport(
      0,
      0, // Offset X,Y
      Render.width, // Width
      Render.height, // Height
      0.0,
      1.0, // Min/max depth
    );

    pass.setScissorRect(
      0,
      0, // Offset X,Y
      Render.width, // Width
      Render.height, // Height
    );

    RenderManager.getInstance().render(RenderCategory.DECALS, pass);

    pass.end();
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
    this.skybox.render(this.rtAccLight.getView(), this.depthStencilView!);
  }

  private renderPointLights(): void {
    const render = Render.getInstance();
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
        view: this.depthStencilView!, // Use single-sample depth for poitng light pass
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
    });

    // Configurar el viewport y scissor para asegurar que todo el canvas sea utilizable
    pass.setViewport(
      0,
      0, // Offset X,Y
      render.getCanvas().width, // Width
      render.getCanvas().height, // Height
      0.0,
      1.0, // Min/max depth
    );

    pass.setScissorRect(
      0,
      0, // Offset X,Y
      render.getCanvas().width, // Width
      render.getCanvas().height, // Height
    );

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
        view: this.depthStencilView!, // Use single-sample depth for poitng light pass
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
    });

    // Configurar el viewport y scissor para asegurar que todo el canvas sea utilizable
    pass.setViewport(
      0,
      0, // Offset X,Y
      render.getCanvas().width, // Width
      render.getCanvas().height, // Height
      0.0,
      1.0, // Min/max depth
    );

    pass.setScissorRect(
      0,
      0, // Offset X,Y
      render.getCanvas().width, // Width
      render.getCanvas().height, // Height
    );

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

  private renderTransparents(): void {
    const render = Render.getInstance();

    const pass = render.getCommandEncoder().beginRenderPass({
      label: 'Transparents Render pass',
      colorAttachments: [
        {
          view: this.rtAccLight.getView(),
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depthStencilView!, // Use single-sample depth for transparent pass
        depthLoadOp: 'load',
        depthStoreOp: 'discard',
      },
    });

    // Configurar el viewport y scissor para asegurar que todo el canvas sea utilizable
    pass.setViewport(
      0,
      0, // Offset X,Y
      render.getCanvas().width, // Width
      render.getCanvas().height, // Height
      0.0,
      1.0, // Min/max depth
    );

    pass.setScissorRect(
      0,
      0, // Offset X,Y
      render.getCanvas().width, // Width
      render.getCanvas().height, // Height
    );

    RenderManager.getInstance().render(RenderCategory.TRANSPARENT, pass);

    pass.end();
  }

  private getGBufferRenderPassDescriptor(): GPURenderPassDescriptor {
    return {
      label: 'GBuffer Render pass',
      colorAttachments: [
        this.createColorAttachment(this.rtAlbedos),
        this.createColorAttachment(this.rtNormals),
        this.createColorAttachment(this.rtSelfIllum),
        this.createColorAttachment(this.rtLinearDepth),
      ],
      depthStencilAttachment: {
        view: this.msaaDepthStencilView!, // Use MSAA depth buffer for G-Buffer pass
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    };
  }

  private getGBufferDecalsRenderPassDescriptor(): GPURenderPassDescriptor {
    return {
      label: 'GBuffer Decals Render pass',
      colorAttachments: [
        this.createColorAttachment(this.rtAlbedos),
        this.createColorAttachment(this.rtSelfIllum),
      ],
      depthStencilAttachment: {
        view: this.msaaDepthStencilView!, // Use MSAA depth buffer for G-Buffer pass
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
    };
  }

  // Helper function to create color attachment with optional resolve target
  private createColorAttachment = (rt: RenderToTexture): GPURenderPassColorAttachment => {
    const attachment: GPURenderPassColorAttachment = {
      view: rt.getRenderView(), // MSAA view if enabled, otherwise single-sample
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: 'load',
      storeOp: 'store',
    };

    // Add resolve target only if MSAA is enabled
    const resolveTarget = rt.getResolveTarget();
    if (resolveTarget) {
      attachment.resolveTarget = resolveTarget;
    }

    return attachment;
  };

  public update(dt: number): void { }

  private destroy(): void {
    if (this.rtAlbedos) {
      this.rtAlbedos.destroy();
      this.rtNormals.destroy();
      this.rtLinearDepth.destroy();
      this.rtAccLight.destroy();
      this.rtSelfIllum.destroy();
      this.depthStencil.destroy();
      this.depthStencilView = null;

      // Clean up MSAA depth buffer
      if (this.msaaDepthStencil) {
        this.msaaDepthStencil.destroy();
        this.msaaDepthStencilView = null;
      }

      // Clean up depth resolver
      if (this.depthResolver) {
        this.depthResolver.destroy();
      }
    }
  }

  public getDepthStencilView(): GPUTextureView | null {
    return this.depthStencilView;
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
    this.gBufferBindGroup = BindGroupFactory.createBindGroup(
      `gbuffer bind group`,
      this.gbufferLayout,
      [
        {
          binding: 0,
          resource: this.rtAlbedos.getView(),
        },
        {
          binding: 1,
          resource: this.rtNormals.getView(),
        },
        {
          binding: 2,
          resource: this.rtLinearDepth.getView(),
        },
        {
          binding: 3,
          resource: this.rtSelfIllum.getView(),
        },
        {
          binding: 4,
          resource: rtAmbientOcclusion,
        },
        {
          binding: 5,
          resource: this.whiteTexture.getSampler(),
        },
      ]
    );
  }
}
