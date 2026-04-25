import { Engine } from '../../../core/engine/Engine';
import { ImageWidget } from '../../ui/widgets/ImageWidget';
import { ThrowSystem } from './ThrowSystem';
import { createDefaultWidgetParams, createDefaultImageParams } from '../../../types/WidgetTypes';

const ICON_WIDTH = 14;
const ICON_HEIGHT = 28;
const ICON_X = 40;
const ICON_Y_BASE = -125; // first icon, just above health bar
const ICON_Y_STEP = -32; // each subsequent icon goes further up

/**
 * Dynamically creates one ImageWidget per dagger charge and syncs visibility
 * each frame. No hardcoded count — adapts to whatever maxCharges the ThrowSystem reports.
 */
export class DaggerHUDSystem {
  private widgets: ImageWidget[] = [];
  private resolved = false;
  private lastCharges = -1;

  private resolve(maxCharges: number): void {
    if (this.resolved) return;
    this.resolved = true;

    const ui = Engine.getUI();

    for (let i = 0; i < maxCharges; i++) {
      const params = createDefaultWidgetParams();
      params.anchor = 'bottom-left';
      params.x = ICON_X;
      params.y = ICON_Y_BASE + i * ICON_Y_STEP;
      params.width = ICON_WIDTH;
      params.height = ICON_HEIGHT;
      params.visible = true;

      const imageParams = createDefaultImageParams();
      imageParams.texture = 'white.png';
      imageParams.size = { x: ICON_WIDTH, y: ICON_HEIGHT };
      imageParams.color = { r: 1.0, g: 0.75, b: 0.1, a: 0.9 };

      const name = `dagger_icon_${i}`;
      const widget = new ImageWidget(name, name, params, imageParams);

      ui.registerWidget(widget);
      ui.registerAlias(widget);
      ui.activateWidget(name);

      this.widgets.push(widget);
    }
  }

  public update(throwSystem: ThrowSystem): void {
    this.resolve(throwSystem.getMaxCharges());

    const charges = throwSystem.getCharges();
    if (charges === this.lastCharges) return;
    this.lastCharges = charges;

    for (let i = 0; i < this.widgets.length; i++) {
      this.widgets[i]!.setVisible(i < charges);
    }
  }
}
