// src/components/ui/widgets/TextWidget.ts
import { Widget } from '../Widget';
import type { WidgetParams, TextParams } from '../../../types/WidgetTypes';
import { createDefaultTextParams } from '../../../types/WidgetTypes';
import { vec2, vec4 } from 'gl-matrix';
import { Texture } from '../../../renderer/resources/Texture';
import { UIRenderUtils } from '../../../renderer/core/UIRenderUtils';

const DEFAULT_FONT = 'ui/fonts/font.png';

/**
 * TextWidget - Renders text using bitmap fonts.
 * Replicates C++ CText widget with character-by-character rendering from 8x8 grid.
 */
export class TextWidget extends Widget {
  protected textParams: TextParams;

  constructor(name: string, alias: string, params: WidgetParams, textParams?: Partial<TextParams>) {
    super(name, alias, params);

    this.textParams = createDefaultTextParams();

    if (textParams) {
      if (textParams.text !== undefined) this.textParams.text = textParams.text;
      if (textParams.texture !== undefined) this.textParams.texture = textParams.texture;
      if (textParams.size) this.textParams.size = textParams.size;
      if (textParams.color) this.textParams.color = textParams.color;
      if (textParams.align) this.textParams.align = textParams.align;
    }
  }

  private cachedFont: Texture | null = null;
  private cachedFontPath: string | null = null;

  protected override render(renderPass: GPURenderPassEncoder): void {
    const text = this.textParams.text;
    if (!text) return;

    const fontPath = this.textParams.texture ?? DEFAULT_FONT;
    if (this.cachedFontPath !== fontPath) {
      this.cachedFontPath = fontPath;
      this.cachedFont = null;
      Texture.getAsync(fontPath)
        .then((texture) => {
          if (this.cachedFontPath === fontPath) this.cachedFont = texture;
        })
        .catch((error) => console.error(`Failed to load font texture: ${fontPath}`, error));
    }
    if (!this.cachedFont) return;

    // Mismo factor de escala que usa Widget para su tamaño (px de referencia → px físicos).
    const gs = this.scaleWithScreen ? UIRenderUtils.getGlobalScale() : window.devicePixelRatio || 1;
    const charW = this.textParams.size.x * gs;
    const charH = this.textParams.size.y * gs;
    let x = this.originX;
    if (this.textParams.align === 'center') {
      x += (this.getWidth() * gs - UIRenderUtils.measureText(text, charW)) / 2;
    }
    const y = this.originY + Math.max(0, (this.getHeight() * gs - charH) / 2);
    const c = this.textParams.color ?? { r: 1, g: 1, b: 1, a: 1 };
    UIRenderUtils.renderText(
      renderPass,
      text,
      this.cachedFont,
      vec2.fromValues(x, y),
      vec2.fromValues(charW, charH),
      vec4.fromValues(c.r, c.g, c.b, c.a),
    );
  }

  public setColor(r: number, g: number, b: number, a: number): void {
    this.textParams.color = { r, g, b, a };
  }

  // ============================================================================
  // TEXT PARAMETERS GETTERS/SETTERS
  // ============================================================================

  public getTextParams(): TextParams {
    return this.textParams;
  }

  public setText(text: string): void {
    this.textParams.text = text;
  }

  public getText(): string {
    return this.textParams.text;
  }

  public setFontTexture(texturePath: string): void {
    this.textParams.texture = texturePath;
  }

  public getFontTexture(): string | null {
    return this.textParams.texture;
  }

  public setTextSize(x: number, y: number): void {
    this.textParams.size = { x, y };
  }

  public getTextSize(): { x: number; y: number } {
    return this.textParams.size;
  }
}
