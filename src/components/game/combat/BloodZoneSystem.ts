import { vec3 } from 'gl-matrix';
import { Engine } from '../../../core/engine/Engine';
import { Loader } from '../../../core/loaders/Loader';
import { MouseButton } from '../../../types/MouseButton.enum';
import type { CameraComponent } from '../../render/CameraComponent';
import type { BloodComponent } from '../BloodComponent';
import type { EntityDataType } from '../../../types/SceneData.type';
import { BloodBallProjectileComponent } from './BloodBallProjectileComponent';

/**
 * BloodZoneSystem — Right-click ability: lob a slow blood ball that arcs
 * through the air and spawns a slowing / damaging zone on impact.
 *
 * On RMB press (cooldown expired, enough blood):
 *  1. Checks blood cost.
 *  2. Spends blood.
 *  3. Dynamically spawns a blood_ball_projectile entity from the camera muzzle.
 *  4. The projectile travels in an arc; on hit it creates a blood_zone.
 */
export class BloodZoneSystem {
  private readonly bloodCost: number;
  private readonly maxRange: number;
  private readonly cooldown: number;
  private readonly ballSpeed: number;
  private readonly ballGravity: number;
  private readonly zoneRadius: number;
  private readonly zoneDuration: number;
  private readonly zoneDamagePerSecond: number;
  private readonly zoneSlowFactor: number;
  private readonly getBlood: (() => BloodComponent | null) | null;

  private cooldownTimer: number = 0;

  constructor(data?: {
    bloodCost?: number;
    maxRange?: number;
    cooldown?: number;
    ballSpeed?: number;
    ballGravity?: number;
    zoneRadius?: number;
    zoneDuration?: number;
    zoneDamagePerSecond?: number;
    zoneSlowFactor?: number;
    getBlood?: () => BloodComponent | null;
  }) {
    this.bloodCost = data?.bloodCost ?? 15;
    this.maxRange = data?.maxRange ?? 25;
    this.cooldown = data?.cooldown ?? 1.5;
    this.ballSpeed = data?.ballSpeed ?? 12;
    this.ballGravity = data?.ballGravity ?? 6;
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
    const cam = camera.getCamera();
    const origin = cam.getPosition() as vec3;
    const dir = cam.getFront() as vec3;

    // Spawn slightly in front of the camera to avoid self-collision
    const muzzle = vec3.scaleAndAdd(vec3.create(), origin, dir, 0.8);

    const entityData = {
      components: {
        name: 'BloodBall',
        transform: {
          position: [muzzle[0], muzzle[1], muzzle[2]] as [number, number, number],
        },
        blood_ball_projectile: {
          speed: this.ballSpeed,
          gravity: this.ballGravity,
          maxRange: this.maxRange,
          damage: 0,
          zoneRadius: this.zoneRadius,
          zoneDuration: this.zoneDuration,
          zoneDamagePerSecond: this.zoneDamagePerSecond,
          zoneSlowFactor: this.zoneSlowFactor,
        },
      },
    } as unknown as EntityDataType;

    Loader.loadEntityFromJSON(entityData, undefined, false)
      .then((entity) => {
        const ball = entity.getComponent(
          'blood_ball_projectile',
        ) as BloodBallProjectileComponent | null;
        if (!ball) {
          console.error(
            '[BloodZoneSystem] blood_ball_projectile component missing on spawned entity',
          );
          Engine.getEntities().destroyEntity(entity);
          return;
        }
        // fire() sets position, direction, enables the component
        ball.fire(muzzle, dir, () => Engine.getEntities().destroyEntity(entity));
      })
      .catch((e) => console.error('[BloodZoneSystem] Failed to spawn blood ball:', e));
  }
}
