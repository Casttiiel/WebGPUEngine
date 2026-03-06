// src/components/ui/widgets/ImageWidget.ts
import { Widget } from '../Widget';
import { vec2, vec4 } from 'gl-matrix';
import type { WidgetParams, ImageParams } from '../../../types/WidgetTypes';
import { createDefaultImageParams } from '../../../types/WidgetTypes';
import { UIRenderUtils } from '../../../renderer/core/UIRenderUtils';
import { Texture } from '../../../renderer/resources/Texture';

/**
 * ImageWidget - Renders textures/sprites with full control over UV, color, and blending.
 * Replicates C++ CImage widget.
 */
export class ImageWidget extends Widget {
  protected imageParams: ImageParams;
  private cachedTexture: Texture | null = null;
  private cachedTexturePath: string | null = null;

  constructor(
    name: string,
    alias: string,
    params: WidgetParams,
    imageParams?: Partial<ImageParams>,
  ) {
    super(name, alias, params);

    // Initialize image parameters with defaults
    this.imageParams = createDefaultImageParams();

    // Override with provided parameters
    if (imageParams) {
      if (imageParams.texture !== undefined) this.imageParams.texture = imageParams.texture;
      if (imageParams.size) this.imageParams.size = imageParams.size;
      if (imageParams.additive !== undefined) this.imageParams.additive = imageParams.additive;
      if (imageParams.color) this.imageParams.color = imageParams.color;
      if (imageParams.minUV) this.imageParams.minUV = imageParams.minUV;
      if (imageParams.maxUV) this.imageParams.maxUV = imageParams.maxUV;
    }
  }

  private _dbgLogged = false;
  protected override render(renderPass: GPURenderPassEncoder): void {
    // Skip if no texture is set
    if (!this.imageParams.texture) return;

    // Check if texture needs to be loaded/reloaded
    if (this.cachedTexturePath !== this.imageParams.texture) {
      this.cachedTexturePath = this.imageParams.texture;
      this.cachedTexture = null;

      // Load texture asynchronously only when texture path changes
      Texture.getAsync(this.imageParams.texture)
        .then((texture) => {
          this.cachedTexture = texture;
        })
        .catch((error) => {
          console.error(`❌ Failed to load texture: ${this.imageParams.texture}`, error);
        });
    }

    // Only render if texture is loaded
    if (!this.cachedTexture) {
      if (!this._dbgLogged)
        console.log(`[UI] "${this.name}" texture not yet loaded: ${this.imageParams.texture}`);
      return;
    }

    // Convert color to tint vec4
    const color = this.imageParams.color;
    const tint = vec4.fromValues(color.r, color.g, color.b, color.a);

    // Convert UV to vec2
    const minUV = vec2.fromValues(this.imageParams.minUV.x, this.imageParams.minUV.y);
    const maxUV = vec2.fromValues(this.imageParams.maxUV.x, this.imageParams.maxUV.y);

    if (!this._dbgLogged) {
      const abs = this.getAbsolute();
      console.log(
        `[UI] "${this.name}" → tex:${this.imageParams.texture} color:[${color.r.toFixed(2)},${color.g.toFixed(2)},${color.b.toFixed(2)},${color.a.toFixed(2)}] matrix:[${Array.from(
          abs as Float32Array,
        )
          .slice(0, 4)
          .map((v: number) => v.toFixed(1))
          .join(',')}...]`,
      );
      this._dbgLogged = true;
    }

    UIRenderUtils.renderBitmap(
      renderPass,
      this.cachedTexture,
      this.getAbsolute(),
      tint,
      minUV,
      maxUV,
      this.imageParams.additive,
    );
  }

  // ============================================================================
  // IMAGE PARAMETERS GETTERS/SETTERS
  // ============================================================================

  public getImageParams(): ImageParams {
    return this.imageParams;
  }

  public setTexture(texturePath: string): void {
    this.imageParams.texture = texturePath;
  }

  public getTexture(): string | null {
    return this.imageParams.texture;
  }

  public override setSize(x: number, y: number): void {
    super.setSize(x, y);
    this.imageParams.size = { x, y };
  }

  public setColor(r: number, g: number, b: number, a: number): void {
    this.imageParams.color = { r, g, b, a };
  }

  public getColor(): { r: number; g: number; b: number; a: number } {
    return this.imageParams.color;
  }

  public setAdditive(additive: boolean): void {
    this.imageParams.additive = additive;
  }

  public isAdditive(): boolean {
    return this.imageParams.additive;
  }

  public setUV(minU: number, minV: number, maxU: number, maxV: number): void {
    this.imageParams.minUV = { x: minU, y: minV };
    this.imageParams.maxUV = { x: maxU, y: maxV };
  }

  public setMinUV(u: number, v: number): void {
    this.imageParams.minUV = { x: u, y: v };
  }

  public setMaxUV(u: number, v: number): void {
    this.imageParams.maxUV = { x: u, y: v };
  }

  public getMinUV(): { x: number; y: number } {
    return this.imageParams.minUV;
  }

  public getMaxUV(): { x: number; y: number } {
    return this.imageParams.maxUV;
  }
}
