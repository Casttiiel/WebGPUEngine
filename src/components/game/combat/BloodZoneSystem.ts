import { vec3 } from 'gl-matrix';
import { Engine } from '../../../core/engine/Engine';
import { MouseButton } from '../../../types/MouseButton.enum';
import type { CameraComponent } from '../../render/CameraComponent';
import type { BloodComponent } from '../BloodComponent';
import { BulletPoolComponent } from '../BulletPoolComponent';
import { BloodBallProjectileComponent } from './BloodBallProjectileComponent';

/**
 * BloodZoneSystem — Right-click ability: lob a slow blood ball that arcs
 * through the air and spawns a slowing / damaging zone on impact.
 *
 * Uses a pre-warmed BulletPoolComponent (entity name: 'BloodBallManager') so
 * there is zero allocation cost per shot. Pool size 2 is enough given the
 * cooldown.
 *
 * On RMB press (cooldown expired, enough blood):
 *  1. Checks blood cost.
 *  2. Acquires a ball from the pool, overrides its zone parameters.
 *  3. Fires the ball from the camera muzzle.
 *  4. The ball travels in an arc; on hit it creates a blood_zone entity.
 */
export class BloodZoneSystem {
  private readonly bloodCost: number;
  private readonly cooldown: number;
  private readonly poolName: string;
  private readonly zoneRadius: number;
  private readonly zoneDuration: number;
  private readonly zoneDamagePerSecond: number;
  private readonly zoneSlowFactor: number;
  private readonly getBlood: (() => BloodComponent | null) | null;

  private cooldownTimer: number = 0;
  // Lazily resolved on first fire
  private pool: BulletPoolComponent | null = null;

  constructor(data?: {
    bloodCost?: number;
    cooldown?: number;
    poolName?: string;
    zoneRadius?: number;
    zoneDuration?: number;
    zoneDamagePerSecond?: number;
    zoneSlowFactor?: number;
    getBlood?: () => BloodComponent | null;
  }) {
    this.bloodCost = data?.bloodCost ?? 15;
    this.cooldown = data?.cooldown ?? 1.5;
    this.poolName = data?.poolName ?? 'BloodBallManager';
    this.zoneRadius = data?.zoneRadius ?? 4;
    this.zoneDuration = data?.zoneDuration ?? 9;
    this.zoneDamagePerSecond = data?.zoneDamagePerSecond ?? 5;
    this.zoneSlowFactor = data?.zoneSlowFactor ?? 0.4;
    this.getBlood = data?.getBlood ?? null;
  }

  // ── Update loop ───────────────────────────────────────────────────────────

  public update(dt: number, camera: CameraComponent | null): void {
    if (this.cooldownTimer > 0) this.cooldownTimer -= dt;

    const input = Engine.getInput();
    if (!input.isMouseButtonJustPressed(MouseButton.RIGHT)) return;
    if (this.cooldownTimer > 0) return;
    if (!camera) return;

    const blood = this.getBlood?.();
    if (blood && blood.getBlood() < this.bloodCost) {
      console.log('[BloodZone] Not enough blood.');
      return;
    }

    blood?.spendClamped(this.bloodCost);
    this.cooldownTimer = this.cooldown;
    this.fireBloodBall(camera);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private fireBloodBall(camera: CameraComponent): void {
    // Lazy pool resolution
    if (!this.pool) {
      const entity = Engine.getEntities().getEntityByName(this.poolName);
      this.pool = (entity?.getComponent('bullet_pool') as BulletPoolComponent) ?? null;
      if (!this.pool) {
        console.warn(`[BloodZoneSystem] No bullet_pool found on entity "${this.poolName}"`);
        return;
      }
    }

    const ball = this.pool.acquire() as BloodBallProjectileComponent | null;
    if (!ball) return; // both slots already in flight

    const cam = camera.getCamera();
    const origin = cam.getPosition() as vec3;
    const dir = cam.getFront() as vec3;

    // Override zone parameters from system config (may differ from prefab defaults)
    ball.setZoneParams(
      this.zoneRadius,
      this.zoneDuration,
      this.zoneDamagePerSecond,
      this.zoneSlowFactor,
    );

    // Muzzle slightly in front of camera to avoid self-collision
    const muzzle = vec3.scaleAndAdd(vec3.create(), origin, dir, 0.8);
    ball.fire(muzzle, dir, this.pool.release.bind(this.pool));
  }
}
