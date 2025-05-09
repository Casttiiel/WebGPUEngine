import { Render } from "./render";

export class RenderToTexture {
  private name: string = "";
  private xRes: number = 0;
  private yRes: number = 0;
  private texture!: GPUTexture;

  public createRT(name: string, width: number, height: number, format: GPUTextureFormat): void {
    this.destroy();

    this.name = name;
    this.xRes = width;
    this.yRes = height;

    this.texture = Render.getInstance().getDevice().createTexture({
      size: [width, height],
      format: format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    })
  }

  public createView(): GPUTextureView {
    return this.texture.createView();
  }

  public getWidth(): number {
    return this.xRes;
  }

  public getHeight(): number {
    return this.yRes;
  }

  public destroy(): void { }
}