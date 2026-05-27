import { Engine } from '../../../core/engine/Engine';
import { ImageWidget } from '../../ui/widgets/ImageWidget';
import { createDefaultWidgetParams, createDefaultImageParams } from '../../../types/WidgetTypes';
import type { MarkSystem } from './MarkSystem';

const ICON_W = 22; // billboard icon width in reference px
const ICON_H = 22; // billboard icon height in reference px
const POOL_SIZE = 8; // max simultaneous mark icons
const REF_W = 1920; // reference canvas width
const REF_H = 1080; // reference canvas height
const PULSE_SPEED = 3.5; // alpha oscillation frequency (rad/s)
const URGENT_THRESHOLD = 3; // seconds remaining when pulsing speeds up

/**
 * MarkerBillboardSystem — World-space mark indicators.
 *
 * Each frame, iterates over all active marks in the MarkSystem and projects
 * a point above each marked enemy's transform into screen-space (reference
 * 1920×1080), then positions a pooled ImageWidget there.
 *
 * The icon pulses (alpha oscillates) so the player can easily spot marked
 * enemies. Pulsing speeds up when the mark is about to expire.
 */
export class MarkerBillboardSystem {
  private icons: ImageWidget[] = [];
  private resolved = false;
  private pulseTime = 0;

  private resolve(): void {
    if (this.resolved) return;
    this.resolved = true;

    const ui = Engine.getUI();

    for (let i = 0; i < POOL_SIZE; i++) {
      const params = createDefaultWidgetParams();
      params.anchor = 'top-left';
      params.x = 0;
      params.y = 0;
      params.width = ICON_W;
      params.height = ICON_H;
      params.visible = false;

      const imgParams = createDefaultImageParams();
      imgParams.texture = 'white.png';
      imgParams.size = { x: ICON_W, y: ICON_H };
      imgParams.color = { r: 0.8, g: 0.2, b: 1.0, a: 0.9 }; // magenta/purple mark tint

      const name = `mark_billboard_${i}`;
      const widget = new ImageWidget(name, name, params, imgParams);
      ui.registerWidget(widget);
      ui.registerAlias(widget);
      ui.activateWidget(name);
      this.icons.push(widget);
    }
  }

  public update(dt: number, markSystem: MarkSystem): void {
    this.resolve();
    this.pulseTime += dt * PULSE_SPEED;

    if (markSystem.getMarkedCount() === 0) {
      for (const icon of this.icons) icon.setVisible(false);
      return;
    }

    let slotIndex = 0;

    markSystem.forEach((entityId, remaining) => {
      if (slotIndex >= POOL_SIZE) return;
      const icon = this.icons[slotIndex]!;

      const ndc = markSystem.getNdc(entityId);
      if (!ndc || !ndc.inFrustum) {
        icon.setVisible(false);
        slotIndex++;
        return;
      }

      // Convert precomputed NDC → reference-space (1920×1080)
      const refX = (ndc.ndcX + 1) * 0.5 * REF_W - ICON_W * 0.5;
      const refY = (1 - ndc.ndcY) * 0.5 * REF_H - ICON_H * 0.5;

      icon.setPosition(refX, refY);

      // Pulse alpha — speeds up when mark is close to expiring
      const urgency = remaining < URGENT_THRESHOLD ? 2.2 : 1.0;
      const alpha = 0.6 + 0.4 * Math.sin(this.pulseTime * urgency);
      icon.setColor(0.8, 0.2, 1.0, alpha);
      icon.setVisible(true);

      slotIndex++;
    });

    // World marks — distinct color (yellow) so player can tell them apart
    markSystem.forEachWorldMark((id, remaining) => {
      if (slotIndex >= POOL_SIZE) return;
      const icon = this.icons[slotIndex]!;

      const ndc = markSystem.getWorldMarkNdc(id);
      if (!ndc || !ndc.inFrustum) {
        icon.setVisible(false);
        slotIndex++;
        return;
      }

      const refX = (ndc.ndcX + 1) * 0.5 * REF_W - ICON_W * 0.5;
      const refY = (1 - ndc.ndcY) * 0.5 * REF_H - ICON_H * 0.5;

      icon.setPosition(refX, refY);

      const urgency = remaining < URGENT_THRESHOLD ? 2.2 : 1.0;
      const alpha = 0.6 + 0.4 * Math.sin(this.pulseTime * urgency);
      icon.setColor(1.0, 0.85, 0.1, alpha); // yellow tint for world marks
      icon.setVisible(true);

      slotIndex++;
    });

    // Hide unused pool slots
    for (let i = slotIndex; i < this.icons.length; i++) {
      this.icons[i]!.setVisible(false);
    }
  }
}
