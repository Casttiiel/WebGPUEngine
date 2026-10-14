import { vec3 } from 'gl-matrix';
import { GroundMarker } from './GroundMarker';

const SHAFT_WIDTH = 0.5;
const HEAD_LENGTH = 0.75;
const HEAD_WIDTH = 1.05;
const CHEVRON_LENGTH = 0.4;
const CHEVRON_WIDTH = 0.6;
const CHEVRON_SPACING = 0.6;
/** Velocidad a la que corren los chevrones hacia la punta (m/s). */
const CHEVRON_SPEED = 1.4;
const MAX_CHEVRONS = 16;
/** Hueco entre el objeto y donde empieza la flecha (m). */
const START_GAP = 0.12;
const IMPACT_SIZE = 1.2;

/** Un juego de piezas de un color (claro: no golpea; rojo: golpea a alguien). */
interface ArrowParts {
  shaft: GroundMarker;
  head: GroundMarker;
  chevrons: GroundMarker[];
}

/**
 * AimArrow — indicador en el suelo de hacia dónde sale un objeto empujado (como en Marvel's
 * Midnight Suns): una flecha desde el objeto hasta donde choca o se para, con chevrones que
 * corren hacia la punta, el hueco donde acabará el objeto y, si golpea a alguien, la flecha en
 * rojo y una marca de impacto en el punto del choque.
 */
export class AimArrow {
  private readonly ok: ArrowParts;
  private readonly hit: ArrowParts;
  private readonly landing = new GroundMarker('tactical/aim_landing.prefab');
  private readonly impact = new GroundMarker('tactical/aim_impact.prefab');
  private shown = false;
  private readonly start = vec3.create();
  private readonly end = vec3.create();
  private readonly tmp = vec3.create();

  constructor() {
    const parts = (variant: 'ok' | 'hit'): ArrowParts => ({
      shaft: new GroundMarker(`tactical/aim_shaft_${variant}.prefab`),
      head: new GroundMarker(`tactical/aim_head_${variant}.prefab`),
      chevrons: Array.from(
        { length: MAX_CHEVRONS },
        () => new GroundMarker(`tactical/aim_chevron_${variant}.prefab`),
      ),
    });
    this.ok = parts('ok');
    this.hit = parts('hit');
    for (const m of this.all()) void m.spawn();
  }

  /**
   * Flecha de un objeto de radio `radius` (pies en `from`) que sale en `dir` (horizontal,
   * normalizada) y recorre `travel` m. `hits`: al llegar choca con alguien (en rojo, con la
   * marca de impacto delante).
   */
  public show(from: vec3, dir: vec3, travel: number, radius: number, hits: boolean): void {
    const yaw = Math.atan2(dir[0]!, dir[2]!);
    const parts = hits ? this.hit : this.ok;
    hideParts(hits ? this.ok : this.hit);

    // De la cara delantera del objeto ahora (más un hueco) a la cara delantera al llegar.
    vec3.scaleAndAdd(this.start, from, dir, radius + START_GAP);
    const length = travel - START_GAP;
    const shaftLength = Math.max(0, length - HEAD_LENGTH);
    if (length > HEAD_LENGTH * 0.5) {
      this.placeAlong(parts.head, dir, yaw, shaftLength + HEAD_LENGTH / 2, HEAD_WIDTH, HEAD_LENGTH);
    } else {
      parts.head.hide();
    }
    if (shaftLength > 0.05) {
      this.placeAlong(parts.shaft, dir, yaw, shaftLength / 2, SHAFT_WIDTH, shaftLength);
    } else {
      parts.shaft.hide();
    }
    // Chevrones corriendo hacia la punta.
    const offset = ((performance.now() / 1000) * CHEVRON_SPEED) % CHEVRON_SPACING;
    let used = 0;
    for (
      let d = offset + CHEVRON_LENGTH / 2;
      d < shaftLength - CHEVRON_LENGTH / 2;
      d += CHEVRON_SPACING
    ) {
      if (used >= MAX_CHEVRONS) break;
      this.placeAlong(parts.chevrons[used++]!, dir, yaw, d, CHEVRON_WIDTH, CHEVRON_LENGTH);
    }
    for (let i = used; i < MAX_CHEVRONS; i++) parts.chevrons[i]!.hide();

    const to = vec3.scaleAndAdd(this.end, from, dir, travel);
    this.landing.showOriented(to, yaw, radius * 2 + 0.2, radius * 2 + 0.2);
    if (hits) {
      vec3.scaleAndAdd(this.tmp, to, dir, radius + 0.1);
      this.impact.showOriented(this.tmp, yaw, IMPACT_SIZE, IMPACT_SIZE);
    } else {
      this.impact.hide();
    }
    this.shown = true;
  }

  public hide(): void {
    if (!this.shown) return;
    this.shown = false;
    hideParts(this.ok);
    hideParts(this.hit);
    this.landing.hide();
    this.impact.hide();
  }

  public destroy(): void {
    for (const m of this.all()) m.destroy();
  }

  /** Coloca `marker` centrado a `distance` m del inicio de la flecha. */
  private placeAlong(
    marker: GroundMarker,
    dir: vec3,
    yaw: number,
    distance: number,
    width: number,
    length: number,
  ): void {
    vec3.scaleAndAdd(this.tmp, this.start, dir, distance);
    marker.showOriented(this.tmp, yaw, width, length);
  }

  private all(): GroundMarker[] {
    return [
      ...[this.ok, this.hit].flatMap((p) => [p.shaft, p.head, ...p.chevrons]),
      this.landing,
      this.impact,
    ];
  }
}

function hideParts(parts: ArrowParts): void {
  parts.shaft.hide();
  parts.head.hide();
  for (const c of parts.chevrons) c.hide();
}
