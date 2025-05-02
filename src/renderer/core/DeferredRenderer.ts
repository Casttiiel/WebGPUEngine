import { Camera } from "../../core/math/Camera";
import { RenderCategory } from "../../types/RenderCategory.enum";
import { RenderManager } from "./RenderManager";
import { RenderToTexture } from "./RenderToTexture";

export class DeferredRenderer {
  private width!: number;
  private height!: number;
  private rtAlbedos!: RenderToTexture;
  private rtNormals!: RenderToTexture;
  private rtDepth!: RenderToTexture;
  private rtAccLight!: RenderToTexture;
  private rtSelfIllum!: RenderToTexture;

  constructor() { }

  public create(width: number, height: number) {
    this.width = width;
    this.height = height;

    this.destroy();

    if (!this.rtAlbedos) {
      this.rtAlbedos = new RenderToTexture();
      this.rtNormals = new RenderToTexture();
      this.rtDepth = new RenderToTexture();
      this.rtAccLight = new RenderToTexture();
      this.rtSelfIllum = new RenderToTexture();
    }

    this.rtAlbedos.createRT("g_albedos.dds", width, height, "rgba16unorm");
    this.rtNormals.createRT("g_normals.dds", width, height, "rgba16unorm");
    this.rtDepth.createRT("g_depths.dds", width, height, "r32float");
    this.rtAccLight.createRT("acc_light.dds", width, height, "rgba16float", "unknown", true);
    this.rtSelfIllum.createRT("g_self_illum.dds", width, height, "rgba8unorm");
  }

  private destroy() {
    if (this.rtAlbedos) {
      this.rtAlbedos.destroy();
      this.rtNormals.destroy();
      this.rtDepth.destroy();
      this.rtAccLight.destroy();
      this.rtSelfIllum.destroy();
    }
  }

  public render(
    camera: Camera
  ) {
    this.renderGBuffer();
    //TODO RENDER GBUFFERDECALS
    //TODO RENDER AO
    //TODO RENDER ACC LIGHTS
    //TODO RENDER CATEGORY TRANSPARENTS
    //TODO RESOLVE
  }

  public renderGBuffer() {
    //CLEAR TEXTURE COLORS
    RenderManager.getInstance().render(RenderCategory.SOLIDS);
  }

}