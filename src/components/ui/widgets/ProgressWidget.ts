// src/components/ui/widgets/ProgressWidget.ts
import { ImageWidget } from './ImageWidget';
import type { WidgetParams, ProgressParams, ImageParams } from '../../../types/WidgetTypes';
import { createDefaultProgressParams } from '../../../types/WidgetTypes';

/**
 * ProgressWidget - Progress bar with ratio-based filling.
 * Replicates C++ CProgress and CBar (they are identical).
 *
 * ⚠️ Note: BarWidget is redundant - this unified widget handles both horizontal and vertical bars.
 */
export class ProgressWidget extends ImageWidget {
  private progressParams: ProgressParams;
  private direction: 'horizontal' | 'vertical' = 'horizontal';
  private backgroundImage?: ImageParams; // Optional background

  constructor(
    name: string,
    alias: string,
    params: WidgetParams,
    imageParams?: Partial<ImageParams>,
    progressParams?: Partial<ProgressParams>,
  ) {
    super(name, alias, params, imageParams);

    this.progressParams = createDefaultProgressParams();

    if (progressParams) {
      if (progressParams.ratio !== undefined) {
        this.progressParams.ratio = Math.max(0, Math.min(1, progressParams.ratio));
      }
    }
  }

  protected override render(): void {
    // Rendering will be handled by UIRenderUtils in FASE 7
    // Render background if exists
    if (this.backgroundImage) {
      // UIRenderUtils.renderImage(this.getAbsolute(), this.backgroundImage);
    }

    // Render fill with clipping/scaling based on ratio
    // Horizontal: scale.x *= ratio, adjust position
    // Vertical: scale.y *= ratio, adjust position
    // UIRenderUtils.renderProgressBar(this.getAbsolute(), this.imageParams, this.progressParams.ratio, this.direction);
  }

  // ============================================================================
  // PROGRESS PARAMETERS
  // ============================================================================

  public setRatio(ratio: number): void {
    this.progressParams.ratio = Math.max(0, Math.min(1, ratio));
  }

  public getRatio(): number {
    return this.progressParams.ratio;
  }

  public setDirection(direction: 'horizontal' | 'vertical'): void {
    this.direction = direction;
  }

  public getDirection(): 'horizontal' | 'vertical' {
    return this.direction;
  }

  public setBackgroundImage(imageParams: ImageParams): void {
    this.backgroundImage = imageParams;
  }

  public getBackgroundImage(): ImageParams | undefined {
    return this.backgroundImage;
  }

  /**
   * Convenience method to set value with min/max bounds.
   */
  public setValue(value: number, min: number, max: number): void {
    const ratio = (value - min) / (max - min);
    this.setRatio(ratio);
  }
}
