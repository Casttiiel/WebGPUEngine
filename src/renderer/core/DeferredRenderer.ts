import { Camera } from "../../core/math/Camera";
import { RenderCategory } from "../../types/RenderCategory.enum";
import { Mesh } from "../resources/Mesh";
import { Technique } from "../resources/Technique";
import { Render } from "./render";
import { RenderManager } from "./RenderManager";
import { RenderToTexture } from "./RenderToTexture";

export class DeferredRenderer {
  private fullscreenQuadMesh !: Mesh;

  private ambientTechnique !: Technique;
  
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

    if (!this.depthStencilView){
      this.depthStencilView = this.depthStencil.createView();
    }
  }

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get("fullscreenquad.obj");
    this.ambientTechnique = await Technique.get("ambient.tech");
  }

  public render(camera: Camera): GPUTextureView {
    this.renderGBuffer();
    //TODO RENDER GBUFFERDECALS
    //TODO RENDER AO
    this.renderAccLight();
    this.renderTransparents();

    return this.rtAlbedos.getView();
  }

  public renderGBuffer(): void {
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
    //this.renderAmbientPass();
    //TODO POINT LIGHTS
    //TODO DIRECTIONAL LIGHTS NO SHADOWS
    //TODO DIRECTIONAL LIGHTS WITH SHADOWS
    //TODO FAKE VOLUMETRIC LIGHTS
    //this.renderSkybox();
  }

  private renderAmbientPass(): void {
    const render = Render.getInstance();
    const pass = render.getCommandEncoder().beginRenderPass(
      {
        colorAttachments: [{
          view: this.rtAccLight.getView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      }
    );

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

    // 1. Activar el pipeline
    this.ambientTechnique.activatePipeline(pass);

    // 2. Activar mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Activar bind groups
    //pass.setBindGroup(0, this.bindGroup);

    // 4. Dibujar la mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
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