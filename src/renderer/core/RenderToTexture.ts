import { Render } from "./render";

export class RenderToTexture {
  private name: string = "";
  private xRes: number = 0;
  private yRes: number = 0;
  private texture!: GPUTexture;
  private textureView !: GPUTextureView | null;

  public createRT(name: string, width: number, height: number, format: GPUTextureFormat): void {
    this.destroy();

    this.name = name;
    this.xRes = width;
    this.yRes = height;    this.texture = Render.getInstance().getDevice().createTexture({
      label: `${this.name}_texture`,
      size: [width, height],
      format: format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    })
  }

  public getView(): GPUTextureView {
    if (this.textureView) return this.textureView;    this.textureView = this.texture.createView({
      label: `${this.name}_textureView`
    });
    return this.textureView;
  }

  public getWidth(): number {
    return this.xRes;
  }

  public getHeight(): number {
    return this.yRes;
  }

  public destroy(): void {
    if(this.texture){
      this.texture.destroy();
    }
    this.textureView = null;
  }
}