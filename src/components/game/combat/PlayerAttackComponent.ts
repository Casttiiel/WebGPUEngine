import { mat4, vec3 } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Entity } from '../../../core/ecs/Entity';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import { TransformComponent } from '../../core/TransformComponent';
import { AnimatorComponent } from '../../render/AnimatorComponent';
import { TrailRendererComponent } from '../../vfx/TrailRendererComponent';
import { ParticleSystemComponent } from '../../render/ParticleSystemComponent';
import { Loader } from '../../../core/loaders/Loader';
import { Msg } from '../../../core/ecs/Msg';
import type { HitStopComponent } from '../HitStopComponent';
import type { CameraShakeComponent } from '../CameraShakeComponent';
import type { CameraArmComponent } from '../CameraArmComponent';
import type { KCCMovement } from '../movement/KCCMovement';
import type { ShockwavePostProcessComponent } from '../../render/ShockwavePostProcessComponent';

export interface PlayerAttackData {
  damage?: number;
  cooldown?: number;
  attackClip?: string;
  bladeLength?: number;
  activeWindowStart?: number;
  activeWindowEnd?: number;
  sweepRadius?: number;
  /** Forward speed (m/s) applied at attack start. Skipped when already within minLungeDistance. Default 12. */
  lungeSpeed?: number;
  /** Min distance to target required to trigger lunge (metres). Default 1.5. */
  minLungeDistance?: number;
  /** Max range of the auto-aim sphere overlap (metres). Default 4. */
  autoAimRange?: number;
  /** Full cone angle for auto-aim (degrees). Default 60. */
  autoAimConeAngle?: number;
  /** Maximum camera-arm yaw rotation toward the auto-aim target (degrees). Default 15. */
  autoRotateMax?: number;
  /** Horizontal impulse speed (m/s) applied to the enemy on hit. Default 5. */
  knockbackSpeed?: number;
}

export class PlayerAttackComponent extends Component {
  // ── Config ─────────────────────────────────────────────────────────────────
  private damage: number = 20;
  private cooldown: number = 0.8;
  private attackClip: string = 'Sword_Attack_Standing';
  private bladeLength: number = 0.65;
  private activeWindowStart: number = 0.2;
  private activeWindowEnd: number = 0.6;
  private sweepRadius: number = 0.15;
  private lungeSpeed: number = 12;
  private minLungeDistance: number = 1.5;
  private autoAimRange: number = 4.0;
  private autoAimConeAngle: number = 60;
  private autoRotateMax: number = 30;
  private knockbackSpeed: number = 2;

  // ── Runtime state ──────────────────────────────────────────────────────────
  private cooldownTimer: number = 0;
  private attackTimer: number = -1;
  private attackLayerId: number = -1;
  private trailStopped: boolean = false;
  private readonly hitSet: Set<number> = new Set();

  // ── Cached references ──────────────────────────────────────────────────────
  private animator: AnimatorComponent | null = null;
  private meshTransform: TransformComponent | null = null;
  private ownerTransform: TransformComponent | null = null;
  private movement: KCCMovement | null = null;
  private trail: TrailRendererComponent | null = null;
  private hitSparks: ParticleSystemComponent | null = null;
  private handJointIndex: number = -1;
  private resolved: boolean = false;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  public load(data: PlayerAttackData): void {
    this.damage = data.damage ?? this.damage;
    this.cooldown = data.cooldown ?? this.cooldown;
    this.attackClip = data.attackClip ?? this.attackClip;
    this.bladeLength = data.bladeLength ?? this.bladeLength;
    this.activeWindowStart = data.activeWindowStart ?? this.activeWindowStart;
    this.activeWindowEnd = data.activeWindowEnd ?? this.activeWindowEnd;
    this.sweepRadius = data.sweepRadius ?? this.sweepRadius;
    this.lungeSpeed = data.lungeSpeed ?? this.lungeSpeed;
    this.minLungeDistance = data.minLungeDistance ?? this.minLungeDistance;
    this.autoAimRange = data.autoAimRange ?? this.autoAimRange;
    this.autoAimConeAngle = data.autoAimConeAngle ?? this.autoAimConeAngle;
    this.autoRotateMax = data.autoRotateMax ?? this.autoRotateMax;
    this.knockbackSpeed = data.knockbackSpeed ?? this.knockbackSpeed;
    this.loadHitSparks();
  }

  private loadHitSparks(): void {
    Loader.parseEntityFromJSON({ prefab: 'effects/hit_sparks.prefab' } as any)
      .then((parsed) => Loader.loadEntityFromJSON(parsed, undefined, false))
      .then((entity) => {
        this.hitSparks = entity.getComponent('particle_system') as ParticleSystemComponent | null;
      })
      .catch(() => {});
  }

  public update(dt: number): void {
    if (this.cooldownTimer > 0) this.cooldownTimer -= dt;
    this.resolve();

    if (this.attackTimer >= 0) {
      this.attackTimer += dt;
      this.tickSwing();
    }

    const canAttack = this.cooldownTimer <= 0 && this.attackTimer < 0;
    if (canAttack && Engine.getInput().isActionJustPressed(GameAction.LIGHT_ATTACK)) {
      this.startAttack();
    }
  }

  // ── Attack lifecycle ───────────────────────────────────────────────────────

  private startAttack(): void {
    if (!this.animator || !this.ownerTransform) return;

    this.attackLayerId =
      this.animator.addLayer(this.attackClip, {
        loop: false,
        weight: 1.0,
        blendInTime: 0.05,
      }) ?? -1;

    this.attackTimer = 0;
    this.trailStopped = false;
    this.hitSet.clear();
    this.cooldownTimer = this.cooldown;
    this.trail?.reset();

    // ── Auto-aim + conditional lunge ──────────────────────────────────────────
    const ownerPos = this.ownerTransform.getTransform().getWorldPosition();
    const worldMat = this.ownerTransform.getTransform().getWorldMatrix();
    const forward = vec3.normalize(vec3.create(), [worldMat[8]!, 0, worldMat[10]!]);

    let lungeDir = vec3.clone(forward);
    let shouldLunge = true;

    if (this.autoAimRange > 0) {
      const aimResult = this.findAutoAimTarget(ownerPos, forward);
      if (aimResult) {
        const delta = this.computeYawDelta(ownerPos, forward, aimResult.entity);
        if (delta !== 0) {
          const arm = this.getOwner().getComponent('camera_arm') as CameraArmComponent | null;
          arm?.addYaw(delta);
          // Rotate forward for immediate lunge alignment (arm yaw takes effect next frame).
          const rad = (delta * Math.PI) / 180;
          const c = Math.cos(rad);
          const s = Math.sin(rad);
          lungeDir[0] = forward[0] * c + forward[2] * s;
          lungeDir[2] = -forward[0] * s + forward[2] * c;
        }
        // Skip lunge when already within melee range — lunging through the enemy looks wrong.
        if (aimResult.dist < this.minLungeDistance) shouldLunge = false;
      }
    }

    if (shouldLunge && this.lungeSpeed > 0 && this.movement) {
      this.movement.setHorizontalVelocity(vec3.scale(vec3.create(), lungeDir, this.lungeSpeed));
    }
  }

  private tickSwing(): void {
    const inWindow =
      this.attackTimer >= this.activeWindowStart && this.attackTimer <= this.activeWindowEnd;

    if (inWindow) {
      const { hilt, tip } = this.getBladePositions();
      if (hilt && tip) this.checkHits(hilt, tip);
    }

    if (!this.trailStopped && this.attackTimer > this.activeWindowEnd) {
      this.trail?.stopEmitting();
      this.trailStopped = true;
    }

    if (this.attackTimer > this.activeWindowEnd + 0.3) {
      if (this.attackLayerId >= 0) this.animator?.removeLayer(this.attackLayerId, 0.15);
      this.attackTimer = -1;
      this.attackLayerId = -1;
    }
  }

  // ── Auto-aim helpers ───────────────────────────────────────────────────────

  /**
   * Finds the closest entity with a health component inside the attack cone.
   * Returns both the entity and its horizontal distance from the player.
   */
  private findAutoAimTarget(
    ownerPos: vec3,
    forward: vec3,
  ): { entity: Entity; dist: number } | null {
    const ownerEntity = this.getOwner();
    const halfAngleCos = Math.cos((this.autoAimConeAngle * 0.5 * Math.PI) / 180);

    let bestTarget: Entity | null = null;
    let bestDist = Infinity;

    Engine.getPhysics().overlapSphere(ownerPos, this.autoAimRange, (entityId) => {
      const entity = Engine.getEntities().getEntityById(entityId);
      if (!entity || entity === ownerEntity) return true;
      if (!entity.getComponent('health')) return true;

      const tc = entity.getComponent('transform') as TransformComponent | null;
      if (!tc) return true;

      const targetPos = tc.getTransform().getWorldPosition();
      const dx = targetPos[0] - ownerPos[0];
      const dz = targetPos[2] - ownerPos[2];
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 0.01) return true;

      const dot = forward[0] * (dx / dist) + forward[2] * (dz / dist);
      if (dot < halfAngleCos) return true;

      if (dist < bestDist) {
        bestDist = dist;
        bestTarget = entity;
      }
      return true;
    });

    return bestTarget ? { entity: bestTarget, dist: bestDist } : null;
  }

  /**
   * Returns the signed yaw delta (degrees) needed to rotate the player toward
   * `target`, clamped to ±autoRotateMax.
   * Positive = clockwise from above (rightward).
   */
  private computeYawDelta(ownerPos: vec3, forward: vec3, target: Entity): number {
    const tc = target.getComponent('transform') as TransformComponent | null;
    if (!tc) return 0;

    const targetPos = tc.getTransform().getWorldPosition();
    const dx = targetPos[0] - ownerPos[0];
    const dz = targetPos[2] - ownerPos[2];
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.01) return 0;

    const dirX = dx / dist;
    const dirZ = dz / dist;

    // Cross product Y component: positive → target is CCW from forward (left)
    //                             negative → target is CW from forward (right)
    // Negate so that positive delta = clockwise = rightward addYaw
    const crossY = forward[0] * dirZ - forward[2] * dirX;
    const dot = forward[0] * dirX + forward[2] * dirZ;
    const angleDeg = Math.atan2(-crossY, dot) * (180 / Math.PI);

    return Math.max(-this.autoRotateMax, Math.min(this.autoRotateMax, angleDeg));
  }

  // ── Blade position ─────────────────────────────────────────────────────────

  private getBladePositions(): { hilt: vec3 | null; tip: vec3 | null } {
    if (!this.animator || !this.meshTransform || this.handJointIndex < 0) {
      return { hilt: null, tip: null };
    }

    const jointModelMat = this.animator.getJointModelMatrix(this.handJointIndex) as mat4 | null;
    if (!jointModelMat) return { hilt: null, tip: null };

    const meshWorldMat = this.meshTransform.getTransform().getWorldMatrix();
    const boneWorldMat = mat4.mul(mat4.create(), meshWorldMat, jointModelMat);

    const hilt = vec3.create();
    mat4.getTranslation(hilt, boneWorldMat);

    const bladeDir = vec3.normalize(vec3.create(), [
      boneWorldMat[8]!,
      boneWorldMat[9]!,
      boneWorldMat[10]!,
    ]);
    const tip = vec3.scaleAndAdd(vec3.create(), hilt, bladeDir, this.bladeLength);

    return { hilt, tip };
  }

  // ── Hit detection ──────────────────────────────────────────────────────────

  private checkHits(hilt: vec3, tip: vec3): void {
    const ownerEntity = this.getOwner();
    const physics = Engine.getPhysics();

    const mid = vec3.lerp(vec3.create(), hilt, tip, 0.5);
    const points: vec3[] = [tip, mid];

    for (const pt of points) {
      physics.overlapSphere(pt, this.sweepRadius, (entityId) => {
        if (this.hitSet.has(entityId)) return true;
        const entity = Engine.getEntities().getEntityById(entityId);
        if (!entity || entity === ownerEntity) return true;

        if (entity.getComponent('health')) {
          this.hitSet.add(entityId);
          entity.sendMsg(Msg.damage({ amount: this.damage, instigator: ownerEntity }));
          // Delay the freeze so the hit-reaction animation can start blending first
          (entity.getComponent('hit_stop') as HitStopComponent | null)?.freeze(10 / 60, 2 / 60);
          (ownerEntity.getComponent('hit_stop') as HitStopComponent | null)?.freeze(6 / 60, 1 / 60);
          (ownerEntity.getComponent('camera_shake') as CameraShakeComponent | null)?.shake(0.2);

          // Knockback: push enemy away from player
          if (this.knockbackSpeed > 0 && this.ownerTransform) {
            const enemyTc = entity.getComponent('transform') as TransformComponent | null;
            const enemyPos = enemyTc?.getTransform().getWorldPosition();
            const playerPos = this.ownerTransform.getTransform().getWorldPosition();
            if (enemyPos) {
              const dx = enemyPos[0] - playerPos[0];
              const dz = enemyPos[2] - playerPos[2];
              const d = Math.sqrt(dx * dx + dz * dz);
              if (d > 0.01) {
                const kcc = entity.getComponent('kcc_movement') as KCCMovement | null;
                kcc?.applyImpulse(
                  vec3.fromValues(
                    (dx / d) * this.knockbackSpeed,
                    0,
                    (dz / d) * this.knockbackSpeed,
                  ),
                );
              }
            }
          }

          // Hit sparks at impact point
          this.hitSparks?.burst(24, pt);

          // Shockwave distortion at impact point
          const camEntity = Engine.getEntities().getEntityByName('MainCamera');
          const sw = camEntity?.getComponent('shockwave') as ShockwavePostProcessComponent | null;
          sw?.spawn([pt[0], pt[1], pt[2]], { speed: 14, maxRadius: 20, intensity: 0.04, thickness: 2.0 });
        }
        return true;
      });
    }
  }

  // ── Resolution ─────────────────────────────────────────────────────────────

  private resolve(): void {
    if (this.resolved) return;
    this.resolved = true;

    const owner = this.getOwner();
    this.ownerTransform = owner.getComponent('transform') as TransformComponent | null;
    this.movement = owner.getComponent('kcc_movement') as KCCMovement | null;

    for (const child of owner.getChildren()) {
      const anim = child.getComponent('animator') as AnimatorComponent | null;
      if (anim) {
        this.animator = anim;
        this.meshTransform = child.getComponent('transform') as TransformComponent | null;
        this.handJointIndex = anim.getJointIndex('hand_r');
        break;
      }
    }

    this.trail = this.findTrailInDescendants(owner);
  }

  private findTrailInDescendants(entity: Entity): TrailRendererComponent | null {
    const trail = entity.getComponent('trail_renderer') as TrailRendererComponent | null;
    if (trail) return trail;
    for (const child of entity.getChildren()) {
      const found = this.findTrailInDescendants(child);
      if (found) return found;
    }
    return null;
  }

  public renderDebug(): void {}
}
