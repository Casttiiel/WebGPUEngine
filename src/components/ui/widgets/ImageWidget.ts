// src/components/ui/widgets/ImageWidget.ts
import { Widget } from '../Widget';
import { vec2 } from 'gl-matrix';
import type { WidgetParams, ImageParams } from '../../../types/WidgetTypes';
import { createDefaultImageParams } from '../../../types/WidgetTypes';

/**
 * ImageWidget - Renders textures/sprites with full control over UV, color, and blending.
 * Replicates C++ CImage widget.
 */
export class ImageWidget extends Widget {
  protected imageParams: ImageParams;

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

  protected override render(): void {
    // Rendering will be handled by UIRenderUtils in FASE 7
    // For now, this is a placeholder
    // UIRenderUtils.renderImage(this.getAbsolute(), this.imageParams);
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

  public setSize(x: number, y: number): void {
    this.imageParams.size = { x, y };
  }

  public override getSize(): vec2 {
    return vec2.fromValues(this.imageParams.size.x, this.imageParams.size.y);
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
