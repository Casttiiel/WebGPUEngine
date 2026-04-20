import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import { PlayerCombatState } from '../../../types/PlayerCombatState.enum';
import type { ArcaneKnightControllerComponentDataType } from '../../../types/ArcaneKnightControllerComponentData.type';

/**
 * CombatSystem — Gestiona la state machine de combate del jugador.
 *
 * Estados (mutuamente exclusivos):
 *   IDLE → LIGHT_ATTACKING (duración fija) → IDLE
 *   IDLE → HEAVY_ATTACKING (duración fija) → IDLE
 *   IDLE → BLOCKING (mantenido) → PARRYING (ventana) → IDLE
 *   IDLE → DASHING (duración fija) → IDLE
 *
 * El combate y el movimiento/habilidades coexisten: CombatSystem no
 * bloquea el movimiento, pero el componente principal puede consultarlo
 * con getState() para modular animaciones, velocidad o input.
 *
 * TODO: conectar con sistema de animaciones, hitboxes y daño.
 */
export class CombatSystem {
  // ──────────────────────────────────────────────
  // PARÁMETROS
  // ──────────────────────────────────────────────
  private lightAttackDuration: number;
  private heavyAttackDuration: number;
  private dashDuration: number;
  private parryWindow: number;

  // ──────────────────────────────────────────────
  // ESTADO
  // ──────────────────────────────────────────────
  private state: PlayerCombatState = PlayerCombatState.IDLE;
  /** Segundos restantes del estado actual (≤ 0 → vuelve a IDLE). */
  private stateTimer: number = 0;

  constructor(data: ArcaneKnightControllerComponentDataType) {
    this.lightAttackDuration = data.lightAttackDuration ?? 0.35;
    this.heavyAttackDuration = data.heavyAttackDuration ?? 0.65;
    this.dashDuration = data.dashDuration ?? 0.2;
    this.parryWindow = data.parryWindow ?? 0.2;
  }

  // ──────────────────────────────────────────────
  // UPDATE
  // ──────────────────────────────────────────────

  public update(dt: number): void {
    this.tickTimer(dt);
    this.processInput();
  }

  private tickTimer(dt: number): void {
    if (this.stateTimer <= 0) return;
    this.stateTimer -= dt;
    if (this.stateTimer <= 0) {
      this.setState(PlayerCombatState.IDLE);
    }
  }

  private processInput(): void {
    const input = Engine.getInput();

    // Solo aceptar nuevo input desde IDLE o BLOCKING
    switch (this.state) {
      case PlayerCombatState.IDLE:
        if (input.isActionJustPressed(GameAction.LIGHT_ATTACK)) {
          this.startLightAttack();
        } else if (input.isActionJustPressed(GameAction.HEAVY_ATTACK)) {
          this.startHeavyAttack();
        } else if (input.isActionJustPressed(GameAction.DASH)) {
          this.startDash();
        } else if (input.isActionPressed(GameAction.SHIELD)) {
          this.setState(PlayerCombatState.BLOCKING);
        }
        break;

      case PlayerCombatState.BLOCKING:
        if (!input.isActionPressed(GameAction.SHIELD)) {
          this.setState(PlayerCombatState.IDLE);
        } else if (input.isActionJustPressed(GameAction.LIGHT_ATTACK)) {
          // Parry: ataque recibido durante el bloqueo activo
          this.startParry();
        }
        break;

      default:
        break;
    }
  }

  // ──────────────────────────────────────────────
  // TRANSICIONES
  // ──────────────────────────────────────────────

  private startLightAttack(): void {
    this.setState(PlayerCombatState.LIGHT_ATTACKING);
    this.stateTimer = this.lightAttackDuration;
    // TODO: reproducir animación, activar hitbox
  }

  private startHeavyAttack(): void {
    this.setState(PlayerCombatState.HEAVY_ATTACKING);
    this.stateTimer = this.heavyAttackDuration;
    // TODO: reproducir animación de carga + golpe, activar hitbox
  }

  private startDash(): void {
    this.setState(PlayerCombatState.DASHING);
    this.stateTimer = this.dashDuration;
    // TODO: aplicar impulso horizontal en dirección del input
  }

  private startParry(): void {
    this.setState(PlayerCombatState.PARRYING);
    this.stateTimer = this.parryWindow;
    // TODO: detectar proyectiles/ataques en la ventana y reflejarlos
  }

  private setState(next: PlayerCombatState): void {
    this.state = next;
  }

  // ──────────────────────────────────────────────
  // CONSULTAS PÚBLICAS
  // ──────────────────────────────────────────────

  public getState(): PlayerCombatState {
    return this.state;
  }

  public isIdle(): boolean {
    return this.state === PlayerCombatState.IDLE;
  }

  public isBlocking(): boolean {
    return this.state === PlayerCombatState.BLOCKING;
  }

  public isDashing(): boolean {
    return this.state === PlayerCombatState.DASHING;
  }
}
