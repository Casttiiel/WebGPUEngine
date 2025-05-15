import { Camera } from "../../core/math/Camera";
import { RenderCategory } from "../../types/RenderCategory.enum";
import { Render } from "./render";
import { RenderManager } from "./RenderManager";
import { RenderToTexture } from "./RenderToTexture";

export class DeferredRenderer {
  private width!: number;
  private height!: number;
  public rtAlbedos!: RenderToTexture;
  private rtNormals!: RenderToTexture;
  private rtLinearDepth!: RenderToTexture;
  private rtAccLight!: RenderToTexture;
  private rtSelfIllum!: RenderToTexture;
  private depthStencil!: GPUTexture;

  constructor() { }

  public create(width: number, height: number) {
    this.width = width;
    this.height = height;

    this.destroy();

    if (!this.rtAlbedos) {
      this.rtAlbedos = new RenderToTexture();
      this.rtNormals = new RenderToTexture();
      this.rtLinearDepth = new RenderToTexture();
      this.rtAccLight = new RenderToTexture();
      this.rtSelfIllum = new RenderToTexture();
    }

    this.rtAlbedos.createRT("g_albedos.dds", width, height, 'rgba16float');
    this.rtNormals.createRT("g_normals.dds", width, height, 'rgba16float');
    this.rtSelfIllum.createRT("g_self_illum.dds", width, height, "rgba16float");
    this.rtLinearDepth.createRT("g_depths.dds", width, height, 'r16float');
    this.rtAccLight.createRT("acc_light.dds", width, height, 'rgba16float');


    this.depthStencil = Render.getInstance().getDevice().createTexture({
      size: {
        width: Render.width,
        height: Render.height
      },
      format: 'depth32float-stencil8',
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
  }

  public render(camera: Camera): GPUTextureView {
    this.renderGBuffer();
    //TODO RENDER GBUFFERDECALS
    //TODO RENDER AO
    //TODO RENDER ACC LIGHTS
    this.renderTransparents();
    
    return this.rtAlbedos.getView();
  }

  public renderGBuffer(): void{
    const render = Render.getInstance();
    const pass = render.getCommandEncoder().beginRenderPass(this.getGBufferRenderPassDescriptor());

    // Configurar el viewport y scissor para asegurar que todo el canvas sea utilizable
    pass.setViewport(
      0, 0,                          // Offset X,Y
      render.getCanvas().width,             // Width
      render.getCanvas().height,            // Height
      0.0, 1.0                       // Min/max depth
    );

    pass.setScissorRect(
      0, 0,                          // Offset X,Y
      render.getCanvas().width,             // Width
      render.getCanvas().height             // Height
    );

    RenderManager.getInstance().render(RenderCategory.SOLIDS, pass);

    pass.end();
  }

  private renderTransparents(): void {
    const render = Render.getInstance();
    const pass = render.getCommandEncoder().beginRenderPass({
      label: 'Transparents Render pass',
      colorAttachments: [{
        view: this.rtAlbedos.getView(),
        loadOp: 'load',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthStencil.createView(),
        depthLoadOp: 'load',
        depthStoreOp: 'discard',
        stencilLoadOp: 'load',
        stencilStoreOp: 'discard'
      },
    });

    // Configurar el viewport y scissor para asegurar que todo el canvas sea utilizable
    pass.setViewport(
      0, 0,                          // Offset X,Y
      render.getCanvas().width,             // Width
      render.getCanvas().height,            // Height
      0.0, 1.0                       // Min/max depth
    );

    pass.setScissorRect(
      0, 0,                          // Offset X,Y
      render.getCanvas().width,             // Width
      render.getCanvas().height             // Height
    );

    RenderManager.getInstance().render(RenderCategory.TRANSPARENT, pass);

    pass.end();
  }

  private getGBufferRenderPassDescriptor(): GPURenderPassDescriptor {
    return {
      label: 'GBuffer Render pass',
      colorAttachments: [{
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
      }],
      depthStencilAttachment: {
        view: this.depthStencil.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        stencilClearValue: 0,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'store'
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
    }
  }
}