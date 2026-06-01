import { Component } from '../../core/ecs/Component';

/**
 * BasePlayerController — Clase base abstracta para todos los controladores de jugador.
 *
 * Propósito:
 *  Permite que código genérico del engine (PerceptionComponent, ReflectionProbe,
 *  ModuleBoot, etc.) localice al jugador usando la clave unificada 'player_controller',
 *  sin importar qué controlador concreto esté activo en la escena.
 *
 * Cómo funciona:
 *  El Loader registra cada subclase bajo su clave específica ('parkour_controller',
 *  'arcane_knight_controller', etc.) Y también bajo el alias 'player_controller' en
 *  la entidad. Solo la clave específica entra en el ECS manager (updates); el alias
 *  es únicamente para lookups con getComponent/hasComponent.
 *
 * Contrato mínimo compartido:
 *  - setActive(): para activar/desactivar el controlador (editor mode, etc.)
 *
 * Los controladores concretos exponen su API completa propia. Código que necesite
 * funcionalidad específica (parkour, combate, etc.) debe castear al tipo concreto.
 */
export abstract class BasePlayerController extends Component {
  /** Activa o desactiva el controlador (p.ej. al entrar en modo editor). */
  public abstract setActive(active: boolean): void;

  // ── Contrato de movimiento genérico ────────────────────────────────
  // Suficiente para que HeadBob, CameraFOV, LandingCamera, HeadTilt, etc.
  // funcionen con cualquier subclase sin conocer su tipo concreto.

  /** Velocidad horizontal actual (módulo). */
  public abstract getCurrentSpeed(): number;

  /** Velocidad horizontal máxima configurada. */
  public abstract getMaxSpeed(): number;

  /** true si el personaje está apoyado en el suelo. */
  public abstract getIsGrounded(): boolean;

  /** Velocidad vertical actual (positiva = subiendo). */
  public abstract getVerticalVelocity(): number;

  /** Aplica un impulso de un pad de lanzamiento. */
  public abstract applyImpulseFromPad(impulse: import('gl-matrix').vec3): void;

  // ── Estados opcionales de movimiento ───────────────────────────────
  // Implementación por defecto: false/null. Las subclases que soporten
  // estas mecánicas las sobreescriben.

  /** true si el personaje está en animación de roll/dodge. */
  public getIsRolling(): boolean {
    return false;
  }

  /** true si el personaje está haciendo mantle (trepar un saliente). */
  public getIsMantling(): boolean {
    return false;
  }

  /** true si el personaje está corriendo por una pared. */
  public getIsWallRunning(): boolean {
    return false;
  }

  /** true si el personaje está ejecutando un dash. */
  public getIsDashing(): boolean {
    return false;
  }

  /** Normal de la pared en la que corre el personaje, o null si no aplica. */
  public getWallNormal(): import('gl-matrix').vec3 | null {
    return null;
  }
}
