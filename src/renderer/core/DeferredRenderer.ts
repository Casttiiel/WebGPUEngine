import { Camera } from "../../core/math/Camera";
import { RenderCategory } from "../../types/RenderCategory.enum";
import { Render } from "./render";
import { RenderManager } from "./RenderManager";
import { RenderToTexture } from "./RenderToTexture";

export class DeferredRenderer {
  private rtAlbedos!: RenderToTexture;
  private rtNormals!: RenderToTexture;
  private rtLinearDepth!: RenderToTexture;
  private rtAccLight!: RenderToTexture;
  private rtSelfIllum!: RenderToTexture;
  private depthStencil!: GPUTexture;
  private depthStencilView !: GPUTextureView | null;

  constructor() { }

  public create(width: number, height: number) {

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
      label: 'deferred depth stencil texture label',
      size: {
        width: width,
        height: height
      },
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });

    if(!this.depthStencilView)
      this.depthStencilView = this.depthStencil.createView();
  }

  public render(camera: Camera): GPUTextureView {
    this.renderGBuffer();
    //TODO RENDER GBUFFERDECALS
    //TODO RENDER AO
    this.renderAccLight();
    this.renderTransparents();
    
    return this.rtAlbedos.getView();
  }

  public renderGBuffer(): void{
    const render = Render.getInstance();
    const pass = render.getCommandEncoder().beginRenderPass(this.getGBufferRenderPassDescriptor());

    // Configurar el viewport y scissor para asegurar que todo el canvas sea utilizable
    pass.setViewport(
      0, 0,                          // Offset X,Y
      Render.width,             // Width
      Render.height,            // Height
      0.0, 1.0                       // Min/max depth
    );

    pass.setScissorRect(
      0, 0,                          // Offset X,Y
      Render.width,             // Width
      Render.height             // Height
    );

    RenderManager.getInstance().render(RenderCategory.SOLIDS, pass);

    pass.end();
  }

  public renderAccLight(): void {
    //TODO AMBIENT PASS
    //TODO POINT LIGHTS
    //TODO DIRECTIONAL LIGHTS NO SHADOWS
    //TODO DIRECTIONAL LIGHTS WITH SHADOWS
    //TODO FAKE VOLUMETRIC LIGHTS
    this.renderSkybox();
  }

  private renderSkybox(): void {
    
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
        view: this.depthStencilView,
        depthLoadOp: 'load',
        depthStoreOp: 'discard',
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
}