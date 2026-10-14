// src/components/ui/widgets/TextWidget.ts
import { Widget } from '../Widget';
import type { WidgetParams, TextParams } from '../../../types/WidgetTypes';
import { createDefaultTextParams } from '../../../types/WidgetTypes';
import { vec2, vec4 } from 'gl-matrix';
import { Texture } from '../../../renderer/resources/Texture';
import { UIRenderUtils } from '../../../renderer/core/UIRenderUtils';

/** Fuente por defecto: atlas Latin-1 con métricas (scripts/generate-ui-font.mjs). */
const DEFAULT_FONT = 'ui/fonts/ui_font.png';

// Shared per-draw scratch: renderText copies both into uniforms before returning.
const originScratch = vec2.create();
const tintScratch = vec4.create();

/**
 * TextWidget - Una línea de texto con fuente bitmap (atlas + métricas proporcionales).
 * textParams.size.y = altura de línea en px de referencia; align: left | center.
 */
export class TextWidget extends Widget {
  protected textParams: TextParams;
  private ownsColor = false;

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
    const metrics = UIRenderUtils.getFontMetrics(fontPath);
    if (!this.cachedFont || metrics === undefined) return;

    // Mismo factor de escala que usa Widget para su tamaño (px de referencia → px físicos).
    // size.y = altura de línea; size.x solo se usa con el atlas antiguo (monoespaciado).
    const gs = this.scaleWithScreen ? UIRenderUtils.getGlobalScale() : window.devicePixelRatio || 1;
    const lineH = this.textParams.size.y * gs;
    let x = this.originX;
    if (this.textParams.align === 'center') {
      x += (this.getWidth() * gs - UIRenderUtils.measureText(text, lineH, metrics)) / 2;
    }
    const y = this.originY + Math.max(0, (this.getHeight() * gs - lineH) / 2);
    const c = this.textParams.color;
    if (c) vec4.set(tintScratch, c.r, c.g, c.b, c.a);
    else vec4.set(tintScratch, 1, 1, 1, 1);
    UIRenderUtils.renderText(
      renderPass,
      text,
      this.cachedFont,
      vec2.set(originScratch, x, y),
      lineH,
      tintScratch,
      metrics,
    );
  }

  public setColor(r: number, g: number, b: number, a: number): void {
    // Same as ImageWidget.setColor: reuse our own object (called every frame by the HUD).
    const c = this.textParams.color;
    if (!this.ownsColor || !c) {
      this.textParams.color = { r, g, b, a };
      this.ownsColor = true;
      return;
    }
    c.r = r;
    c.g = g;
    c.b = b;
    c.a = a;
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
