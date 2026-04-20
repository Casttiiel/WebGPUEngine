import type { AbilityId } from '../../../types/AbilityId.enum';
import type { CameraComponent } from '../../render/CameraComponent';
import type { CapsuleColliderComponent } from '../../physics/CapsuleColliderComponent';
import type { TransformComponent } from '../../core/TransformComponent';

/**
 * Contexto pasado a cada habilidad durante su carga y ejecución.
 * Proporciona acceso a los recursos del jugador sin acoplar
 * la habilidad al componente concreto.
 */
export interface AbilityContext {
  camera: CameraComponent;
  collider: CapsuleColliderComponent;
  transform: TransformComponent;
}

/**
 * Interfaz que deben implementar todas las habilidades mágicas del jugador.
 *
 * Ciclo de vida:
 *  1. Se crea la instancia (constructor sin argumentos).
 *  2. Se llama a load(ctx) la primera vez que la habilidad se desbloquea.
 *  3. update(dt) se llama cada frame mientras la habilidad esté equipada.
 *  4. activate() se llama cuando el jugador pulsa la tecla del slot.
 *  5. deactivate() se llama al soltar la tecla o al interrumpir la habilidad.
 *  6. dispose() limpia recursos GPU al destruir la entidad.
 */
export interface IAbility {
  readonly id: AbilityId;

  load(ctx: AbilityContext): Promise<void>;
  update(dt: number): void;

  /** Devuelve true si la habilidad puede activarse ahora mismo (cooldown, mana, etc.) */
  canActivate(): boolean;
  activate(): void;
  deactivate(): void;

  dispose(): void;
}
