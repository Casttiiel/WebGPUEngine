export class RenderToTexture {
  private xRes: number = 0;
  private yRes: number = 0;

  public createRT(name: string, width: number, height: number, colorFormat: string, depthFormat = "", usesDepthOfBackbuffer = false): void {
    this.destroy();

    this.xRes = width;
    this.yRes = height;
  }

  public getWidth(): number {
    return this.xRes;
  }

  public getHeight(): number {
    return this.yRes;
  }

  public destroy(): void { }
}