import { vec3 } from 'gl-matrix';
import { Engine } from '../../../core/engine/Engine';
import { ModuleUI } from '../../../modules/core/ModuleUI';
import { TextWidget } from '../../ui/widgets/TextWidget';
import { UIRenderUtils } from '../../../renderer/core/UIRenderUtils';
import { GroundMarker } from './GroundMarker';

const SPACING = 0.6; // metros entre puntos
const START_GAP = 0.5; // sin puntos pegados a los pies de la unidad
const MAX_DOTS = 48;
const LABEL_OFFSET = 22; // px de referencia desde el cursor

/**
 * PathPreview — vista previa del camino bajo el cursor: una línea de puntos en el suelo
 * (claros hasta donde llega el movimiento del turno, rojos el resto) y una etiqueta con los
 * metros junto al cursor (widget `cursor_label` de combat_hud.json).
 */
export class PathPreview {
  private okDots: GroundMarker[] = [];
  private farDots: GroundMarker[] = [];
  private lastKey = '';
  private readonly tmp = vec3.create();

  constructor() {
    for (let i = 0; i < MAX_DOTS; i++) {
      const ok = new GroundMarker('tactical/path_dot_ok.prefab');
      const far = new GroundMarker('tactical/path_dot_far.prefab');
      void ok.spawn();
      void far.spawn();
      this.okDots.push(ok);
      this.farDots.push(far);
    }
  }

  /**
   * Muestra el camino. `budget` = metros disponibles (Infinity: todo el camino es válido).
   * `label` = texto junto al cursor (null: sin etiqueta).
   */
  public show(points: vec3[], budget: number, label: string | null): void {
    const key = `${budget.toFixed(2)}|${points.map((p) => `${p[0]!.toFixed(2)},${p[2]!.toFixed(2)}`).join(';')}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.placeDots(points, budget);
    }
    this.showLabel(label);
  }

  public hide(): void {
    this.hideDots();
    this.showLabel(null);
  }

  /** Solo la etiqueta junto al cursor, sin camino (p.ej. tooltip de un objetivo). */
  public showLabelOnly(label: string): void {
    this.hideDots();
    this.showLabel(label);
  }

  private hideDots(): void {
    if (this.lastKey === '') return;
    this.lastKey = '';
    for (const d of this.okDots) d.hide();
    for (const d of this.farDots) d.hide();
  }

  public destroy(): void {
    for (const d of [...this.okDots, ...this.farDots]) d.destroy();
    this.okDots = [];
    this.farDots = [];
  }

  private placeDots(points: vec3[], budget: number): void {
    let ok = 0;
    let far = 0;
    let travelled = 0;
    let nextDot = START_GAP;
    for (let i = 1; i < points.length && ok + far < MAX_DOTS * 2; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      const segment = vec3.distance(a, b);
      while (nextDot <= travelled + segment) {
        vec3.lerp(this.tmp, a, b, (nextDot - travelled) / segment);
        if (nextDot <= budget) {
          if (ok < MAX_DOTS) this.okDots[ok++]!.showAt(this.tmp);
        } else if (far < MAX_DOTS) {
          this.farDots[far++]!.showAt(this.tmp);
        }
        nextDot += SPACING;
      }
      travelled += segment;
    }
    for (let i = ok; i < MAX_DOTS; i++) this.okDots[i]!.hide();
    for (let i = far; i < MAX_DOTS; i++) this.farDots[i]!.hide();
  }

  private showLabel(text: string | null): void {
    const label = ModuleUI.getInstance()?.getWidgetByAlias('cursor_label') as
      | TextWidget
      | undefined;
    if (!label) return;
    if (text === null) {
      label.setVisible(false);
      return;
    }
    // Cursor (px CSS) → coordenadas de referencia de la UI (widget raíz sin ancla).
    const mouse = Engine.getInput().getMousePosition();
    const dpr = window.devicePixelRatio || 1;
    const gs = UIRenderUtils.getGlobalScale();
    const [ox, oy] = UIRenderUtils.getCanvasOffset();
    label.setText(text);
    label.setPosition(
      (mouse.x * dpr - ox) / gs + LABEL_OFFSET,
      (mouse.y * dpr - oy) / gs + LABEL_OFFSET,
    );
    label.setVisible(true);
  }
}
