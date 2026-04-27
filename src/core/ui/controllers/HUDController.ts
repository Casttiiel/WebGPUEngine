import { WidgetController } from '../WidgetController';
import { Engine } from '../../engine/Engine';
import { ModuleUI } from '../../../modules/core/ModuleUI';
import { HealthComponent } from '../../../components/game/HealthComponent';
import { StaminaComponent } from '../../../components/game/StaminaComponent';
import type { Widget } from '../../../components/ui/Widget';
import type { Entity } from '../../ecs/Entity';

/**
 * HUDController — Vincula las barras de vida y stamina del HUD al estado
 * real del jugador (HealthComponent + StaminaComponent).
 *
 * Busca el jugador la primera vez que lo encuentra (lazy), y cada frame
 * actualiza el ancho de las barras proporcionalmente al ratio actual.
 */
export class HUDController extends WidgetController {
  // ── Widgets ───────────────────────────────────────────────────────────────
  private healthBar: Widget | null = null;
  private staminaBar: Widget | null = null;
  private healthBarMaxWidth: number = 0;
  private staminaBarMaxWidth: number = 0;

  // ── Player components (lazy) ──────────────────────────────────────────────
  private playerEntity: Entity | null = null;
  private health: HealthComponent | null = null;
  private stamina: StaminaComponent | null = null;

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

  private _debugLogged = false;

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
  }
}
