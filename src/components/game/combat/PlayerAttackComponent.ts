import { mat4, vec3 } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import { TransformComponent } from '../../core/TransformComponent';
import { AnimatorComponent } from '../../render/AnimatorComponent';
import { Msg } from '../../../core/ecs/Msg';
import type { HitStopComponent } from '../HitStopComponent';

export interface PlayerAttackData {
  damage?: number;
  cooldown?: number;
  attackClip?: string;
  /** World-space blade length in metres (hilt to tip). Default 0.65 */
  bladeLength?: number;
  /** Seconds after attack start when the blade begins dealing damage. Default 0.2 */
  activeWindowStart?: number;
  /** Seconds after attack start when the blade stops dealing damage. Default 0.6 */
  activeWindowEnd?: number;
  /** Radius of the per-point overlap sphere used for hit detection. Default 0.15 */
  sweepRadius?: number;
}

/**
 * PlayerAttackComponent — swept-blade melee attack system.
 *
 * On each active frame of the swing (activeWindowStart → activeWindowEnd):
 *   • Reads the hand_r bone world position (hilt) from AnimatorComponent
 *   • Computes tip = hilt + boneZ * bladeLength
 *   • Does an overlapSphere at both hilt and tip
 *   • Tracks which entities were hit this swing (no double-damage)
 */
export class PlayerAttackComponent extends Component {
  // ── Config ─────────────────────────────────────────────────────────────────
  private damage: number = 20;
  private cooldown: number = 0.8;
  private attackClip: string = 'Sword_Attack_Standing';
  private bladeLength: number = 0.65;
  private activeWindowStart: number = 0.2;
  private activeWindowEnd: number = 0.6;
  private sweepRadius: number = 0.15;

  // ── Runtime state ──────────────────────────────────────────────────────────
  private cooldownTimer: number = 0;
  /** Elapsed time since the current attack started. -1 = no attack in progress. */
  private attackTimer: number = -1;
  private attackLayerId: number = -1;
  /** Entities that already received damage this swing. Reset on new attack. */
  private readonly hitSet: Set<number> = new Set();

  // ── Cached references ──────────────────────────────────────────────────────
  private animator: AnimatorComponent | null = null;
  private meshTransform: TransformComponent | null = null;
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
  }

  public update(dt: number): void {
    if (this.cooldownTimer > 0) this.cooldownTimer -= dt;
    this.resolve();

    // Tick ongoing swing
    if (this.attackTimer >= 0) {
      this.attackTimer += dt;
      this.tickSwing();
    }

    // Trigger new attack
    const canAttack = this.cooldownTimer <= 0 && this.attackTimer < 0;
    if (canAttack && Engine.getInput().isActionJustPressed(GameAction.LIGHT_ATTACK)) {
      this.startAttack();
    }
  }

  // ── Attack lifecycle ───────────────────────────────────────────────────────

  private startAttack(): void {
    if (!this.animator) return;
    this.attackLayerId =
      this.animator.addLayer(this.attackClip, {
        loop: false,
        weight: 1.0,
        blendInTime: 0.05,
      }) ?? -1;
    this.attackTimer = 0;
    this.hitSet.clear();
    this.cooldownTimer = this.cooldown;
  }

  private tickSwing(): void {
    const inWindow =
      this.attackTimer >= this.activeWindowStart && this.attackTimer <= this.activeWindowEnd;

    if (inWindow) {
      const { hilt, tip } = this.getBladePositions();
      if (hilt && tip) this.checkHits(hilt, tip);
    }

    // End attack state after the damage window + small buffer
    if (this.attackTimer > this.activeWindowEnd + 0.3) {
      if (this.attackLayerId >= 0) {
        this.animator?.removeLayer(this.attackLayerId, 0.15);
      }
      this.attackTimer = -1;
      this.attackLayerId = -1;
    }
  }

  // ── Blade position ─────────────────────────────────────────────────────────

  private getBladePositions(): { hilt: vec3 | null; tip: vec3 | null } {
    if (!this.animator || !this.meshTransform || this.handJointIndex < 0) {
      return { hilt: null, tip: null };
    }

    const jointModelMat = this.animator.getJointModelMatrix(this.handJointIndex) as mat4 | null;
    if (!jointModelMat) return { hilt: null, tip: null };

    // bone world = meshEntityWorld * jointModelSpace
    const meshWorldMat = this.meshTransform.getTransform().getWorldMatrix();
    const boneWorldMat = mat4.mul(mat4.create(), meshWorldMat, jointModelMat);

    const hilt = vec3.create();
    mat4.getTranslation(hilt, boneWorldMat);

    // Blade extends along the bone's local Z axis (column 2 of the rotation)
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

    // Sample at tip and midpoint to cover the full blade each frame
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
          (entity.getComponent('hit_stop') as HitStopComponent | null)?.freeze(10 / 60);
          (ownerEntity.getComponent('hit_stop') as HitStopComponent | null)?.freeze(6 / 60);
        }
        return true;
      });
    }
  }

  // ── Resolution ─────────────────────────────────────────────────────────────

  private resolve(): void {
    if (this.resolved) return;
    for (const child of this.getOwner().getChildren()) {
      const anim = child.getComponent('animator') as AnimatorComponent | null;
      if (anim) {
        this.animator = anim;
        this.meshTransform = child.getComponent('transform') as TransformComponent | null;
        this.handJointIndex = anim.getJointIndex('hand_r');
        break;
      }
    }
    this.resolved = true;
  }

  public renderDebug(): void {}
}
