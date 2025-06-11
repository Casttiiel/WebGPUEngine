import { Engine } from '../../core/engine/Engine';
import { Camera } from '../../core/math/Camera';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { Cubemap } from '../resources/Cubemap';
import { Mesh } from '../resources/Mesh';
import { Technique } from '../resources/Technique';
import { Render } from './render';
import { RenderManager } from './RenderManager';
import { RenderToTexture } from './RenderToTexture';

export class DeferredRenderer {
  private fullscreenQuadMesh!: Mesh;

  private ambientTechnique!: Technique;
  private skyboxTechnique!: Technique;
  private skyboxBindGroup!: GPUBindGroup;
  private ambientBindGroup!: GPUBindGroup;
  private skyboxTexture!: Cubemap;

  private rtAlbedos!: RenderToTexture;
  private rtNormals!: RenderToTexture;
  private rtLinearDepth!: RenderToTexture;
  private rtAccLight!: RenderToTexture;
  private rtSelfIllum!: RenderToTexture;
  private depthStencil!: GPUTexture;
  private depthStencilView!: GPUTextureView | null;

  constructor() {}

  public create(width: number, height: number) {
    this.destroy();

    if (!this.rtAlbedos) {
      this.rtAlbedos = new RenderToTexture();
      this.rtNormals = new RenderToTexture();
      this.rtLinearDepth = new RenderToTexture();
      this.rtAccLight = new RenderToTexture();
      this.rtSelfIllum = new RenderToTexture();
    }

    this.rtAlbedos.createRT('g_albedos.dds', width, height, 'rgba16float');
    this.rtNormals.createRT('g_normals.dds', width, height, 'rgba16float');
    this.rtSelfIllum.createRT('g_self_illum.dds', width, height, 'rgba16float');
    this.rtLinearDepth.createRT('g_depths.dds', width, height, 'r16float');
    this.rtAccLight.createRT('acc_light.dds', width, height, 'rgba16float');

    this.depthStencil = Render.getInstance()
      .getDevice()
      .createTexture({
        label: 'deferred depth stencil texture label',
        size: {
          width: width,
          height: height,
        },
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });

    if (!this.depthStencilView) {
      this.depthStencilView = this.depthStencil.createView();
    }

    const sampler = this.skyboxTexture.getSampler();

    this.ambientBindGroup = Render.getInstance()
      .getDevice()
      .createBindGroup({
        label: `ambient_bindgroup`,
        layout: this.ambientTechnique.getPipeline().getBindGroupLayout(1),
        entries: [
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
            resource: this.rtSelfIllum.getView(),
          },
          {
            binding: 5,
            resource: sampler,
          },
        ],
      });
  }

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
    this.skyboxTechnique = await Technique.get('skybox.tech');

    this.skyboxTexture = await Cubemap.get('skybox.png', {
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const pipeline = this.skyboxTechnique.getPipeline();
    if (!pipeline) {
      throw new Error('Failed to get skybox pipeline');
    }

    const textureView = this.skyboxTexture.getTextureView();
    const sampler = this.skyboxTexture.getSampler();
    if (!textureView || !sampler) {
      throw new Error('Failed to get skybox texture view or sampler');
    }

    this.skyboxBindGroup = Render.getInstance()
      .getDevice()
      .createBindGroup({
        label: `skybox_bindgroup`,
        layout: pipeline.getBindGroupLayout(1),
        entries: [
          {
            binding: 0,
            resource: textureView,
          },
          {
            binding: 1,
            resource: sampler,
          },
        ],
      });

    this.ambientTechnique = await Technique.get('ambient.tech');
  }

  public render(_camera: Camera): GPUTextureView {
    this.renderGBuffer();
    this.renderAccLight();
    this.renderTransparents();

    const view = this.rtAccLight.getView();
    if (!view) {
      throw new Error('Failed to get albedo render target view');
    }
    return view;
  }

  public renderGBuffer(): void {
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

    RenderManager.getInstance().render(RenderCategory.SOLIDS, pass);

    pass.end();
  }

  public renderAccLight(): void {
    this.renderAmbientPass();
    //TODO POINT LIGHTS
    //TODO DIRECTIONAL LIGHTS NO SHADOWS
    //TODO DIRECTIONAL LIGHTS WITH SHADOWS
    //TODO FAKE VOLUMETRIC LIGHTS
    this.renderSkybox();
  }

  private renderAmbientPass(): void {
    const render = Render.getInstance();
    const pass = render.getCommandEncoder().beginRenderPass({
      colorAttachments: [
        {
          view: this.rtAccLight.getView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
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
    this.ambientTechnique.activatePipeline(pass);

    // 2. Activar mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Activar bind groups
    pass.setBindGroup(0, Engine.getRender().getGlobalBindGroup()); // Camera uniforms
    pass.setBindGroup(1, this.ambientBindGroup); // GBuffer textures

    // 4. Dibujar la mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }

  private renderSkybox(): void {
    const render = Render.getInstance();

    const pass = render.getCommandEncoder().beginRenderPass({
      colorAttachments: [
        {
          view: this.rtAccLight.getView(),
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depthStencilView,
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

    // 1. Activar el pipeline
    this.skyboxTechnique.activatePipeline(pass);

    // 2. Activar mesh data
    this.fullscreenQuadMesh.activate(pass); // 3. Activar bind groups
    pass.setBindGroup(0, Engine.getRender().getGlobalBindGroup());
    pass.setBindGroup(1, this.skyboxBindGroup);

    // 4. Dibujar la mesh
    this.fullscreenQuadMesh.renderGroup(pass);

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
        view: this.depthStencilView,
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
        {
          view: this.rtAlbedos.getView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
        {
          view: this.rtNormals.getView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
        {
          view: this.rtSelfIllum.getView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
        {
          view: this.rtLinearDepth.getView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depthStencilView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    };
  }

  private destroy() {
    if (this.rtAlbedos) {
      this.rtAlbedos.destroy();
      this.rtNormals.destroy();
      this.rtLinearDepth.destroy();
      this.rtAccLight.destroy();
      this.rtSelfIllum.destroy();
      this.depthStencil.destroy();
      this.depthStencilView = null;
    }
  }

  public getDepthStencilView(): GPUTextureView | null {
    return this.depthStencilView;
  }
}
