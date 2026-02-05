// src/components/ui/widgets/TextWidget.ts
import { Widget } from '../Widget';
import type { WidgetParams, TextParams } from '../../../types/WidgetTypes';
import { createDefaultTextParams } from '../../../types/WidgetTypes';

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
    }
  }

  protected override render(): void {
    // Text rendering will be handled by UIRenderUtils in FASE 7
    // Bitmap font layout: 8x8 grid (ASCII standard)
    // Each character: uvX = (charCode % 16) / 16, uvY = (charCode / 16) / 16
    // UIRenderUtils.renderText(this.getAbsolute(), this.textParams);
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
