import { WidgetController } from '../WidgetController';
import { Engine } from '../../engine/Engine';
import { ModuleUI } from '../../../modules/core/ModuleUI';
import { HealthComponent } from '../../../components/game/HealthComponent';
import { StaminaComponent } from '../../../components/game/StaminaComponent';
import { ArcaneKnightControllerComponent } from '../../../components/game/ArcaneKnightControllerComponent';
import { GrappleTargetType } from '../../../types/GrappleTargetType.enum';
import { ImageWidget } from '../../../components/ui/widgets/ImageWidget';
import { UIRenderUtils } from '../../../renderer/core/UIRenderUtils';
import type { Widget } from '../../../components/ui/Widget';
import type { Entity } from '../../ecs/Entity';

/**
 * HUDController — Vincula barras de vida/stamina, cargas de grapple e indicador
 * de target al estado real del jugador.
 */
export class HUDController extends WidgetController {
  // ── Widgets ───────────────────────────────────────────────────────────────
  private healthBar: Widget | null = null;
  private staminaBar: Widget | null = null;
  private healthBarMaxWidth: number = 0;
  private staminaBarMaxWidth: number = 0;

  // Grapple charge fills (up to 5)
  private readonly MAX_CHARGE_SLOTS = 5;
  private chargeFills: (ImageWidget | null)[] = new Array(5).fill(null);
  private chargeFillMaxWidth: number = 36; // matches hud.json fill width
  private chargeWidgetsResolved = false;

  // Grapple target indicator
  private targetIndicator: ImageWidget | null = null;

  // Crosshair
  private crosshair: ImageWidget | null = null;
  private static readonly COLOR_DEFAULT = [1.0, 1.0, 1.0, 0.8] as const;
  private static readonly COLOR_LEDGE = [1.0, 0.0, 0.0, 0.9] as const;
  private static readonly COLOR_CORNER = [0.0, 1.0, 0.0, 0.9] as const;
  private static readonly COLOR_RING = [0.0, 0.0, 1.0, 0.9] as const;
  private static readonly COLOR_PUNCTUAL = [1.0, 0.6, 0.0, 0.9] as const;

  // ── Player components (lazy) ──────────────────────────────────────────────
  private playerEntity: Entity | null = null;
  private health: HealthComponent | null = null;
  private stamina: StaminaComponent | null = null;
  private grappleController: ArcaneKnightControllerComponent | null = null;

  constructor() {
    super('hud_controller');
  }

  public update(_dt: number): void {
    this.resolveWidgets();
    this.resolvePlayer();

    if (this.health && this.healthBar) {
      const ratio = this.health.getHpRatio();
      this.healthBar.setSize(
        Math.max(0, ratio * this.healthBarMaxWidth),
        this.healthBar.getHeight(),
      );
    }

    if (this.stamina && this.staminaBar) {
      const ratio = this.stamina.getStaminaRatio();
      const newW = Math.max(0, ratio * this.staminaBarMaxWidth);
      this.staminaBar.setSize(newW, this.staminaBar.getHeight());
    }
  }

  private resolveWidgets(): void {
    if (this.healthBar && this.staminaBar) return;

    const ui = ModuleUI.getInstance();
    if (!ui) return;

    if (!this.healthBar) {
      const w = ui.getWidgetByAlias('health_bar');
      if (w) {
        this.healthBar = w;
        this.healthBarMaxWidth = w.getWidth();
      }
    }

    if (!this.staminaBar) {
      const w = ui.getWidgetByAlias('stamina_bar');
      if (w) {
        this.staminaBar = w;
        this.staminaBarMaxWidth = w.getWidth();
      }
    }

    // Grapple charge fills
    if (!this.chargeWidgetsResolved) {
      let allFound = true;
      for (let i = 0; i < this.MAX_CHARGE_SLOTS; i++) {
        if (!this.chargeFills[i]) {
          const w = ui.getWidgetByAlias(`grapple_charge_fill_${i}`);
          if (w instanceof ImageWidget) {
            this.chargeFills[i] = w;
          } else {
            allFound = false;
          }
        }
      }
      this.chargeWidgetsResolved = allFound;
    }

    // Grapple target indicator
    if (!this.targetIndicator) {
      const w = ui.getWidgetByAlias('grapple_target_indicator');
      if (w instanceof ImageWidget) this.targetIndicator = w;
    }

    // Crosshair
    if (!this.crosshair) {
      const w = ui.getWidgetByAlias('crosshair');
      if (w instanceof ImageWidget) this.crosshair = w;
    }
  }

  private resolvePlayer(): void {
    // 1. Encontrar la entidad del jugador una sola vez
    if (!this.playerEntity) {
      const entities = Engine.getEntities().getAllEntities();
      for (const entity of entities) {
        if (entity.hasComponent('player_controller')) {
          this.playerEntity = entity;
          break;
        }
      }
      if (!this.playerEntity) return;
    }

    // 2. Obtener componentes individualmente — se reintenta cada frame hasta encontrarlos
    if (!this.health) {
      this.health = this.playerEntity.getComponent('health') as HealthComponent | null;
    }
    if (!this.stamina) {
      this.stamina = this.playerEntity.getComponent('stamina') as StaminaComponent | null;
    }
    if (!this.grappleController) {
      this.grappleController = this.playerEntity.getComponent(
        'player_controller',
      ) as ArcaneKnightControllerComponent | null;
    }
  }

  // ── Grapple charge HUD ─────────────────────────────────────────

  private updateGrappleCharges(): void {
    if (!this.grappleController) return;
    const gs = this.grappleController.getGrappleSystem();
    const maxCharges = gs.getMaxCharges();
    const charges = gs.getCharges();

    // Track how many recharging slots there are (charged from right)
    // Slot index 0 = leftmost. Slots 0..charges-1 are full, rest are empty/recharging.
    for (let i = 0; i < this.MAX_CHARGE_SLOTS; i++) {
      const fill = this.chargeFills[i];
      if (!fill) continue;

      // Hide slots beyond maxCharges
      fill.setVisible(i < maxCharges);
      if (i >= maxCharges) continue;

      if (i < charges) {
        // Full charge — white, full width
        fill.setColor(0.8, 0.85, 1.0, 1.0);
        fill.setSize(this.chargeFillMaxWidth, fill.getHeight());
      } else {
        // Used charge slot: grey background, fill width = recharge progress
        const rechargeSlotIndex = i - charges; // which recharge timer to read
        const progress = gs.getRechargeProgress(rechargeSlotIndex);
        const fillW = Math.max(2, progress * this.chargeFillMaxWidth);
        fill.setColor(0.35, 0.37, 0.45, 0.8);
        fill.setSize(fillW, fill.getHeight());
      }
    }
  }

  // ── Crosshair tint ──────────────────────────────────────────────────

  private updateCrosshair(): void {
    if (!this.crosshair) return;

    const target = this.grappleController?.getPendingGrappleTarget() ?? null;
    if (!target) {
      const [r, g, b, a] = HUDController.COLOR_DEFAULT;
      this.crosshair.setColor(r, g, b, a);
      return;
    }

    let color: readonly [number, number, number, number];
    switch (target.type) {
      case GrappleTargetType.LEDGE:
        color = HUDController.COLOR_LEDGE;
        break;
      case GrappleTargetType.CORNER:
        color = HUDController.COLOR_CORNER;
        break;
      case GrappleTargetType.RING:
        color = HUDController.COLOR_RING;
        break;
      case GrappleTargetType.PUNCTUAL:
        color = HUDController.COLOR_PUNCTUAL;
        break;
      default:
        color = HUDController.COLOR_DEFAULT;
    }
    this.crosshair.setColor(color[0], color[1], color[2], color[3]);
  }
}
