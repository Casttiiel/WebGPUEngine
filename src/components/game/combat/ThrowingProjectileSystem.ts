import { vec3 } from 'gl-matrix';
import { Engine } from '../../../core/engine/Engine';
import type { CameraComponent } from '../../render/CameraComponent';
import { BulletPoolComponent } from '../BulletPoolComponent';
import { GameAction } from '../../../types/GameAction.enum';

export class ThrowingProjectileSystem {
  private readonly cooldown: number; // seconds between bursts
  private readonly poolName: string;

  private cooldownTimer: number = 0;

  // Lazily resolved on first fire
  private pool: BulletPoolComponent | null = null;

  constructor() {
    this.cooldown = 0.6;
    this.poolName = 'DaggerManager';
  }

  public update(dt: number, camera: CameraComponent | null): void {
    if (this.cooldownTimer > 0) {
      this.cooldownTimer -= dt;
    }

    const input = Engine.getInput();
    if (input.isActionPressed(GameAction.FIRE) && this.cooldownTimer <= 0) {
      this.cooldownTimer = this.cooldown;
      this.fireOne(camera);
    }
  }

  // ──────────────────────────────────────────────────────────
  // INTERNALS
  // ──────────────────────────────────────────────────────────

  private fireOne(camera: CameraComponent | null): void {
    if (!camera) return;

    if (!this.pool) {
      const entity = Engine.getEntities().getEntityByName(this.poolName);
      this.pool = (entity?.getComponent('bullet_pool') as BulletPoolComponent) ?? null;
      if (!this.pool) {
        console.warn(
          `[ThrowingProjectileSystem] No bullet_pool found on entity "${this.poolName}"`,
        );
        return;
      }
    }

    const dagger = this.pool.acquire();
    if (!dagger) return; // all daggers already in flight

    const cam = camera.getCamera();
    const origin = cam.getPosition();
    const dir = cam.getFront();

    // Spawn dagger slightly in front of the camera so it starts outside the capsule
    const muzzle = vec3.scaleAndAdd(vec3.create(), origin, dir, 0.6);
    dagger.fire(muzzle, dir, this.pool.release.bind(this.pool));
  }
}
