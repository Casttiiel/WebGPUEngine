import { vec3 } from 'gl-matrix';
import type { CameraComponent } from '../../render/CameraComponent';
import type { CapsuleColliderComponent } from '../../physics/CapsuleColliderComponent';

/**
 * IMantleController — Contrato mínimo que MantleSystem necesita del controller.
 * Implementado por CharacterControllerComponent y ArcaneKnightControllerComponent.
 */
export interface IMantleController {
  getVerticalVelocity(): number;
  setVerticalVelocity(v: number): void;
  getIsGrounded(): boolean;
  getIsMantling(): boolean;
  setIsMantling(value: boolean): void;
  getCurrentSpeed(): number;
  getHorizontalVelocity(): vec3;
  setHorizontalVelocity(v: vec3): void;
  getCamera(): CameraComponent | null;
  getCollider(): CapsuleColliderComponent;
  setIsJumping(value: boolean): void;
  /** Solo disponible en controllers con wall-run; devuelve false si no existe. */
  getIsWallRunning?(): boolean;
}

/** Parámetros de MantleSystem extraídos de cualquier data type. */
export interface MantleSystemData {
  mantleDetectionDistance?: number;
  mantleMaxHeight?: number;
  minMantleVelocity?: number;
  mantlingMinVerticalVelocity?: number;
}
