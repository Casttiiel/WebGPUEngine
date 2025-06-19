import { Camera } from '../../core/math/Camera';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { AmbientLight } from '../shading/AmbientLight';
import { Skybox } from '../shading/Skybox';
import { Render } from './Render';
import { RenderManager } from './RenderManager';
import { RenderToTexture } from './RenderToTexture';

export class DeferredRenderer {
  private isLoaded = false;

  private skybox!: Skybox;
  private ambientLight!: AmbientLight;
  private rtAlbedos!: RenderToTexture;
  private rtNormals!: RenderToTexture;
  private rtLinearDepth!: RenderToTexture;
  private rtAccLight!: RenderToTexture;
  private rtSelfIllum!: RenderToTexture;
  private depthStencil!: GPUTexture;
  private depthStencilView!: GPUTextureView | null;

  // MSAA depth buffer for G-Buffer pass
  private msaaDepthStencil!: GPUTexture;
  private msaaDepthStencilView!: GPUTextureView | null;

  constructor() {}

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

    const device = Render.getInstance().getDevice();

    // Create single-sample depth buffer (for non-MSAA passes and skybox)
    this.depthStencil = device.createTexture({
      label: 'deferred depth stencil texture label',
      size: {
        width: width,
        height: height,
      },
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
      sampleCount: 1,
    });

    this.depthStencilView = this.depthStencil.createView();

    // Create MSAA depth buffer for G-Buffer pass
    this.msaaDepthStencil = device.createTexture({
      label: 'deferred msaa depth stencil texture label',
      size: {
        width: width,
        height: height,
      },
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
      sampleCount: 4,
    });

    this.msaaDepthStencilView = this.msaaDepthStencil.createView();

    this.ambientLight.create(
      this.rtAlbedos.getView(),
      this.rtNormals.getView(),
      this.rtLinearDepth.getView(),
      this.rtSelfIllum.getView(),
    );
  }

  public async load(): Promise<void> {
    this.skybox = new Skybox();
    await this.skybox.load();

    this.ambientLight = new AmbientLight();
    await this.ambientLight.load();
    this.isLoaded = true;
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
    this.ambientLight.render(this.rtAccLight.getView());
    //TODO POINT LIGHTS
    //TODO DIRECTIONAL LIGHTS NO SHADOWS
    //TODO DIRECTIONAL LIGHTS WITH SHADOWS
    //TODO FAKE VOLUMETRIC LIGHTS
    this.skybox.render(this.rtAccLight.getView(), this.depthStencilView!);
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
    // Helper function to create color attachment with optional resolve target
    const createColorAttachment = (rt: RenderToTexture): GPURenderPassColorAttachment => {
      const attachment: GPURenderPassColorAttachment = {
        view: rt.getRenderView(), // MSAA view if enabled, otherwise single-sample
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      };

      // Add resolve target only if MSAA is enabled
      const resolveTarget = rt.getResolveTarget();
      if (resolveTarget) {
        attachment.resolveTarget = resolveTarget;
      }

      return attachment;
    };

    return {
      label: 'GBuffer Render pass',
      colorAttachments: [
        createColorAttachment(this.rtAlbedos),
        createColorAttachment(this.rtNormals),
        createColorAttachment(this.rtSelfIllum),
        createColorAttachment(this.rtLinearDepth),
      ],
      depthStencilAttachment: {
        view: this.msaaDepthStencilView!, // Use MSAA depth buffer for G-Buffer pass
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    };
  }

  public update(dt: number): void {
    this.ambientLight.update(dt);
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

      // Clean up MSAA depth buffer
      if (this.msaaDepthStencil) {
        this.msaaDepthStencil.destroy();
        this.msaaDepthStencilView = null;
      }
    }
  }

  public getDepthStencilView(): GPUTextureView | null {
    return this.depthStencilView;
  }
}
