import { vec3 } from 'gl-matrix';
import type { CameraComponent } from '../../render/CameraComponent';
import type { CapsuleColliderComponent } from '../../physics/CapsuleColliderComponent';
import { IMantleController } from './IMantleController';

/**
 * IMovementController — Contrato completo que los subsistemas de movimiento
 * (MovementSystem, JumpSystem, RollSystem, DashSystem, SwingSystem, WallRunSystem)
 * necesitan del controller.
 *
 * Extiende IMantleController (usado por MantleSystem) y añade los métodos
 * necesarios para el resto de sistemas.
 *
 * Implementado por cualquier controller que quiera usar estos subsistemas,
 * p. ej. ParkourControllerComponent.
 */
export interface IMovementController extends IMantleController {
  // ── Velocidades ──────────────────────────────────────────────────────────
  getBoostedSpeed(): number;
  setBoostedSpeed(speed: number): void;

  // ── Flags de estado ──────────────────────────────────────────────────────
  /** Requerido (sobreescribe el opcional de IMantleController). */
  getIsWallRunning(): boolean;
  setIsWallRunning(value: boolean): void;

  getIsJumping(): boolean;

  getIsDashing(): boolean;
  setIsDashing(value: boolean): void;

  getIsDodging(): boolean;
  setIsDodging(value: boolean): void;

  getIsSwinging(): boolean;
  setIsSwinging(value: boolean): void;

  getIsRolling(): boolean;
  setIsRolling(value: boolean): void;

  // ── Input ─────────────────────────────────────────────────────────────────
  isInputDisabled(): boolean;
  setInputDisableTimer(time: number): void;

  // ── Física ───────────────────────────────────────────────────────────────
  getGroundNormal(): vec3;

  // ── Delegación de salto ───────────────────────────────────────────────────
  /** Aplica el impulso de salto calculado por JumpSystem. */
  applyJumpFromSystem(): void;
}
