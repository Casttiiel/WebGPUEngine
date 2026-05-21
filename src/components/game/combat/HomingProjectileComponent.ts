import { vec3 } from 'gl-matrix';
import RAPIER from '@dimforge/rapier3d';
import { ProjectileComponent, ProjectileComponentData } from '../ProjectileComponent';
import { Engine } from '../../../core/engine/Engine';
import { TransformComponent } from '../../core/TransformComponent';

export type HomingProjectileData = ProjectileComponentData & {
  /**
   * Maximum angular correction in radians/second.
   * Lower values = gentle curve; higher values = tighter tracking.
   * Default: 1.2 (curves but cannot fully home)
   */
  trackingStrength?: number;
};

/**
 * HomingProjectileComponent — A projectile with soft homing toward the player.
 *
 * Not pure homing: `trackingStrength` caps the angular correction per second so
 * the player must keep moving even after dodging the initial arc.
 *
 * Falls back to straight flight if the player entity ('Player') is not found.
 *
 * Component key: 'homing_projectile'
 */
export class HomingProjectileComponent extends ProjectileComponent {
  private trackingStrength: number = 1.2;

  /** Cached player transform — resolved lazily on first update. */
  private playerTransform: TransformComponent | null = null;
  private playerSearched: boolean = false;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  public override load(data: HomingProjectileData): void {
    const filled: HomingProjectileData = {
      speed: data?.speed ?? 16,
      maxRange: data?.maxRange ?? 30,
      damage: data?.damage ?? 15,
      gravity: data?.gravity ?? 0,
      ...data,
    };
    super.load(filled);
    this.trackingStrength = data?.trackingStrength ?? this.trackingStrength;
    this.enabled = false;
  }

  // ── Override fire to reset player search per shot ─────────────────────────

  public override fire(
    origin: vec3,
    direction: vec3,
    onRelease: (proj: ProjectileComponent) => void,
    shooterBody?: RAPIER.RigidBody,
  ): void {
    this.playerTransform = null;
    this.playerSearched = false;
    super.fire(origin, direction, onRelease, shooterBody);
  }

  // ── Per-frame update with angular steering ────────────────────────────────

  public override update(dt: number): void {
    if (!this.enabled) return;

    // Steer direction toward player before the base class moves the projectile
    const playerPos = this.getPlayerPosition();
    if (playerPos) {
      this.steerToward(playerPos, dt);
    }

    super.update(dt);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Rotates the internal direction vector toward `target` by at most
   * `trackingStrength * dt` radians (XZ plane only — no vertical tracking).
   */
  private steerToward(target: vec3, dt: number): void {
    // Access direction through the public getter exposed by ProjectileComponent
    // We need to reach the protected `direction` field. Since TypeScript
    // doesn't allow protected access from outside, we access it via the
    // inherited public `getDirection()` helper we add below.
    const dir = this.getDirection();

    // Desired direction (XZ only — ignore Y of target vs projectile pos)
    const tc = this.getOwner().getComponent('transform') as TransformComponent | null;
    if (!tc) return;
    const myPos = tc.getTransform().getWorldPosition() as vec3;

    const toTarget = vec3.fromValues(target[0] - myPos[0], 0, target[2] - myPos[2]);
    if (vec3.length(toTarget) < 0.01) return;
    vec3.normalize(toTarget, toTarget);

    // Flatten current direction to XZ for angle computation
    const flatDir = vec3.fromValues(dir[0], 0, dir[2]);
    const flatLen = vec3.length(flatDir);
    if (flatLen < 0.001) return;
    vec3.scale(flatDir, flatDir, 1 / flatLen);

    // Cross product Y (sign of angle from flatDir to toTarget)
    const crossY = flatDir[0] * toTarget[2] - flatDir[2] * toTarget[0];
    // Dot (cosine of angle)
    const dot = Math.max(-1, Math.min(1, vec3.dot(flatDir, toTarget)));
    const angle = Math.acos(dot);

    const step = Math.min(angle, this.trackingStrength * dt);
    if (step < 0.0001) return;

    // Rotate dir around Y by `step` in the direction of crossY
    const sign = crossY >= 0 ? 1 : -1;
    const s = Math.sin(sign * step);
    const c = Math.cos(sign * step);
    const newX = dir[0] * c + dir[2] * s;
    const newZ = -dir[0] * s + dir[2] * c;
    dir[0] = newX;
    dir[2] = newZ;
    // Y component is untouched (gravity is handled by base class)
  }

  private getPlayerPosition(): vec3 | null {
    if (!this.playerSearched) {
      this.playerSearched = true;
      const player = Engine.getEntities().getEntityByName('Player');
      this.playerTransform =
        (player?.getComponent('transform') as TransformComponent | null) ?? null;
    }
    if (!this.playerTransform) return null;
    return this.playerTransform.getTransform().getWorldPosition() as vec3;
  }
}
