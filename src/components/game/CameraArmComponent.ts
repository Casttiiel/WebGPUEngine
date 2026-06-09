import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { CameraComponent } from '../render/CameraComponent';
import { Engine } from '../../core/engine/Engine';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';

export interface CameraArmComponentData {
  // ── Arm ────────────────────────────────────────────────────────────────────
  /** Natural length of the spring arm (metres). Replaces the old `offset` vector. */
  armLength?: number;
  /**
   * Offset of the pivot point from the owner origin in world space.
   * The arm rotates around this point and the camera looks at it.
   * Equivalent to UE5 TargetOffset. (Legacy alias: `targetOffset`.)
   */
  pivotOffset?: number[];
  /**
   * Offset applied at the camera end of the arm in arm-local space [right, up, forward].
   * Use this for over-the-shoulder framing without affecting arm length or look-at target.
   * Equivalent to UE5 SocketOffset.
   */
  socketOffset?: number[];

  // ── Lag ────────────────────────────────────────────────────────────────────
  /** Smooth all three axes of camera position toward the desired position. */
  cameraLag?: boolean;
  /** How fast the camera reaches the desired position (higher = less lag). Default 10. */
  cameraLagSpeed?: number;
  /** Smooth the look-at target so the camera rotation lags slightly. */
  cameraRotationLag?: boolean;
  /** How fast the look-at target updates (higher = less lag). Default 15. */
  cameraRotationLagSpeed?: number;
  /**
   * How fast the pivot's Y position follows the owner.
   * 0 = instant (matches XZ behaviour). Default 0.
   * (Legacy `smoothSpeed` is used here for backward compatibility.)
   */
  pivotLagSpeed?: number;

  // ── Pitch limits ───────────────────────────────────────────────────────────
  pitchMin?: number; // degrees, default -80
  pitchMax?: number; // degrees, default  80

  // ── Collision ──────────────────────────────────────────────────────────────
  /** Raycast from pivot toward desired camera position and shorten arm on hit. */
  enableCollision?: boolean;
  /** Safety margin subtracted from the hit distance. Default 0.15. */
  collisionRadius?: number;
  /**
   * Speed at which the arm returns to its full length after an obstruction clears.
   * 0 = instant (legacy snap-out). Default 6.
   */
  collisionPullOutSpeed?: number;

  // ── Input ──────────────────────────────────────────────────────────────────
  mouseSensitivity?: number;

  // ── Legacy (backward compat) ───────────────────────────────────────────────
  /** Legacy: arm length is derived as vec3.length(offset). */
  offset?: number[];
  /** Legacy alias for pivotOffset. */
  targetOffset?: number[];
  /** Legacy: mapped to pivotLagSpeed. */
  smoothSpeed?: number;
}

/**
 * CameraArmComponent — UE5-style spring arm for third-person cameras.
 *
 * Features:
 *   - Configurable arm length + pivot offset + socket offset
 *   - Camera position lag (all axes)
 *   - Camera rotation lag (smooth look-at)
 *   - Collision avoidance with configurable pull-out speed
 *   - Mouse-driven pitch/yaw with clamping
 *   - Rotates owner entity on Y so the character faces the camera direction
 *
 * Entity setup (unchanged from before):
 *   Player  [camera_arm, capsule_collider, ...]
 *   └── PlayerCamera [camera]
 */
export class CameraArmComponent extends Component {
  // ── Arm ────────────────────────────────────────────────────────────────────
  private armLength: number = 5.0;
  private pivotOffset: vec3 = vec3.fromValues(0, 1.5, 0);
  private socketOffset: vec3 = vec3.fromValues(0, 0, 0);

  // ── Lag ────────────────────────────────────────────────────────────────────
  private cameraLag: boolean = false;
  private cameraLagSpeed: number = 10.0;
  private cameraRotationLag: boolean = false;
  private cameraRotationLagSpeed: number = 15.0;
  private pivotLagSpeed: number = 0;

  // ── Pitch limits ───────────────────────────────────────────────────────────
  private pitchMin: number = -80;
  private pitchMax: number = 80;

  // ── Collision ──────────────────────────────────────────────────────────────
  private enableCollision: boolean = false;
  private collisionRadius: number = 0.5;
  private collisionPullOutSpeed: number = 6.0;

  // ── Input ──────────────────────────────────────────────────────────────────
  private mouseSensitivity: number = 0.15;

  // ── Runtime state ──────────────────────────────────────────────────────────
  private pitch: number = 0;
  private yaw: number = 0;

  private currentPivot: vec3 = vec3.create();
  private isPivotInitialized: boolean = false;

  private currentCamPos: vec3 = vec3.create();
  private isCamPosInitialized: boolean = false;

  private currentLookTarget: vec3 = vec3.create();
  private isLookTargetInitialized: boolean = false;

  // Current arm length after collision, driven toward armLength at pullOutSpeed.
  private currentArmLength: number = 5.0;

  private cameraEntity: any = null;

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  public async load(data: CameraArmComponentData): Promise<void> {
    // Arm length: explicit or derived from legacy offset vector length
    if (data.armLength !== undefined) {
      this.armLength = data.armLength;
    } else if (data.offset && data.offset.length === 3) {
      const len = Math.sqrt(data.offset[0]! ** 2 + data.offset[1]! ** 2 + data.offset[2]! ** 2);
      this.armLength = len > 0.01 ? len : 5.0;
    }
    this.currentArmLength = this.armLength;

    // Pivot offset (new name preferred; legacy targetOffset also accepted)
    const pivot = data.pivotOffset ?? data.targetOffset;
    if (pivot && pivot.length === 3) {
      vec3.set(this.pivotOffset, pivot[0]!, pivot[1]!, pivot[2]!);
    }

    if (data.socketOffset && data.socketOffset.length === 3) {
      vec3.set(
        this.socketOffset,
        data.socketOffset[0]!,
        data.socketOffset[1]!,
        data.socketOffset[2]!,
      );
    }

    // Lag
    this.cameraLag = data.cameraLag ?? false;
    this.cameraLagSpeed = data.cameraLagSpeed ?? 10.0;
    this.cameraRotationLag = data.cameraRotationLag ?? false;
    this.cameraRotationLagSpeed = data.cameraRotationLagSpeed ?? 15.0;

    // Pivot lag: explicit → legacy smoothSpeed → 0 (instant)
    if (data.pivotLagSpeed !== undefined) {
      this.pivotLagSpeed = data.pivotLagSpeed;
    } else if (data.smoothSpeed !== undefined) {
      this.pivotLagSpeed = data.smoothSpeed;
    }

    this.pitchMin = data.pitchMin ?? -80;
    this.pitchMax = data.pitchMax ?? 80;

    this.enableCollision = data.enableCollision ?? false;
    this.collisionRadius = data.collisionRadius ?? 0.15;
    this.collisionPullOutSpeed = data.collisionPullOutSpeed ?? 6.0;

    this.mouseSensitivity = data.mouseSensitivity ?? 0.15;
  }

  public update(dt: number): void {
    // ── Resolve camera child (cached after first find) ──────────────────────
    if (!this.cameraEntity) {
      for (const child of this.getOwner().getChildren()) {
        if (child.hasComponent('camera')) {
          this.cameraEntity = child;
          break;
        }
      }
      if (!this.cameraEntity) return;
    }

    const ownerTransform = this.getOwner().getComponent('transform') as TransformComponent;
    if (!ownerTransform) return;
    const cameraTransform = this.cameraEntity.getComponent('transform') as TransformComponent;
    const cameraComponent = this.cameraEntity.getComponent('camera') as CameraComponent;
    if (!cameraTransform || !cameraComponent) return;

    // ── Mouse input → pitch / yaw ───────────────────────────────────────────
    const mouseDelta = Engine.getInput().getMouseDelta();
    this.yaw -= mouseDelta.x * this.mouseSensitivity;
    this.pitch += mouseDelta.y * this.mouseSensitivity;
    this.pitch = Math.max(this.pitchMin, Math.min(this.pitchMax, this.pitch));
    this.yaw = ((this.yaw + 180) % 360) - 180;

    // ── Pivot (look-at target) ──────────────────────────────────────────────
    const ownerWorldPos = ownerTransform.getTransform().getWorldPosition();
    const targetPivot = vec3.add(vec3.create(), ownerWorldPos, this.pivotOffset);

    if (!this.isPivotInitialized) {
      vec3.copy(this.currentPivot, targetPivot);
      this.isPivotInitialized = true;
    }

    if (this.pivotLagSpeed <= 0) {
      vec3.copy(this.currentPivot, targetPivot);
    } else {
      const a = Math.min(1.0, dt * this.pivotLagSpeed);
      vec3.lerp(this.currentPivot, this.currentPivot, targetPivot, a);
    }

    // ── Arm direction (unit vector from pivot toward camera) ────────────────
    const pitchRad = (this.pitch * Math.PI) / 180;
    const yawRad = (this.yaw * Math.PI) / 180;
    const armDir = vec3.fromValues(
      -Math.cos(pitchRad) * Math.sin(yawRad),
      Math.sin(pitchRad),
      -Math.cos(pitchRad) * Math.cos(yawRad),
    );

    // ── Collision: update current arm length ────────────────────────────────
    if (this.enableCollision) {
      const safeDist = this.castCollision(this.currentPivot, armDir, this.armLength);
      if (safeDist < this.currentArmLength) {
        // Obstacle detected → snap camera in immediately
        this.currentArmLength = safeDist;
      } else {
        // No closer obstacle → pull back out at configured speed
        if (this.collisionPullOutSpeed <= 0) {
          this.currentArmLength = safeDist;
        } else {
          this.currentArmLength = Math.min(
            safeDist,
            this.currentArmLength + this.collisionPullOutSpeed * dt,
          );
        }
      }
    } else {
      this.currentArmLength = this.armLength;
    }

    // ── Camera desired position = pivot + armDir * armLength ────────────────
    let desiredPos = vec3.scaleAndAdd(
      vec3.create(),
      this.currentPivot,
      armDir,
      this.currentArmLength,
    );

    // ── Socket offset: shift camera in arm-local space [right, up, forward] ─
    const soX = this.socketOffset[0]!,
      soY = this.socketOffset[1]!,
      soZ = this.socketOffset[2]!;
    if (soX !== 0 || soY !== 0 || soZ !== 0) {
      const worldUp = vec3.fromValues(0, 1, 0);
      // Right = cross(worldUp, armDir). Falls back to world X when arm is vertical.
      let armRight = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), worldUp, armDir));
      if (vec3.length(armRight) < 0.001) vec3.set(armRight, 1, 0, 0);
      const armUp = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), armDir, armRight));

      if (soX !== 0) vec3.scaleAndAdd(desiredPos, desiredPos, armRight, soX);
      if (soY !== 0) vec3.scaleAndAdd(desiredPos, desiredPos, armUp, soY);
      if (soZ !== 0) vec3.scaleAndAdd(desiredPos, desiredPos, armDir, soZ);

      // Secondary sweep: the primary sweep (along armDir) can't detect walls the socket
      // offset pushes the camera into (e.g. right wall when soX > 0). Cast from pivot
      // to the final socket-adjusted position and pull back if blocked.
      if (this.enableCollision) {
        const toCam = vec3.sub(vec3.create(), desiredPos, this.currentPivot);
        const toCamDist = vec3.length(toCam);
        if (toCamDist > 0.001) {
          const toCamDir = vec3.scale(vec3.create(), toCam, 1.0 / toCamDist);
          const safeFinal = this.castCollision(this.currentPivot, toCamDir, toCamDist);
          if (safeFinal < toCamDist) {
            vec3.scaleAndAdd(desiredPos, this.currentPivot, toCamDir, safeFinal);
          }
        }
      }
    }

    // ── Camera position lag ─────────────────────────────────────────────────
    let finalCamPos: vec3;
    if (this.cameraLag) {
      if (!this.isCamPosInitialized) {
        vec3.copy(this.currentCamPos, desiredPos);
        this.isCamPosInitialized = true;
      }
      const a = Math.min(1.0, dt * this.cameraLagSpeed);
      vec3.lerp(this.currentCamPos, this.currentCamPos, desiredPos, a);
      finalCamPos = this.currentCamPos;
    } else {
      finalCamPos = desiredPos;
      vec3.copy(this.currentCamPos, desiredPos);
      this.isCamPosInitialized = true;
    }

    // ── Camera rotation lag (smooth look-at target) ─────────────────────────
    let lookTarget: vec3;
    if (this.cameraRotationLag) {
      if (!this.isLookTargetInitialized) {
        vec3.copy(this.currentLookTarget, this.currentPivot);
        this.isLookTargetInitialized = true;
      }
      const a = Math.min(1.0, dt * this.cameraRotationLagSpeed);
      vec3.lerp(this.currentLookTarget, this.currentLookTarget, this.currentPivot, a);
      lookTarget = this.currentLookTarget;
    } else {
      lookTarget = this.currentPivot;
    }

    // ── Apply to camera ─────────────────────────────────────────────────────
    cameraTransform.getTransform().setWorldPosition(finalCamPos);
    cameraComponent
      .getCamera()
      .lookAt(
        Array.from(finalCamPos) as [number, number, number],
        Array.from(lookTarget) as [number, number, number],
        [0, 1, 0],
      );
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Sphere sweep from `pivot` along `dir` up to `maxDist`.
   * Uses a Ball of radius `collisionRadius` so the camera is always that far from
   * any surface — the margin is geometric, not a post-hoc subtraction.
   * Handles fast movement and oblique angles better than a thin ray.
   */
  private castCollision(pivot: vec3, dir: vec3, maxDist: number): number {
    const physics = Engine.getPhysics();
    if (!physics) return maxDist;

    const capsule = this.getOwner().getComponent('capsule_collider') as any;
    const playerRigidBody = capsule?.getRigidBody?.() ?? undefined;

    const sphere = new RAPIER.Ball(this.collisionRadius);
    const hit = physics.getWorld().castShape(
      { x: pivot[0]!, y: pivot[1]!, z: pivot[2]! },
      { x: 0, y: 0, z: 0, w: 1 },
      { x: dir[0]!, y: dir[1]!, z: dir[2]! },
      sphere,
      0, // targetDistance: 0 = report contact as soon as sphere touches anything
      maxDist, // maxToi
      true, // stopAtPenetration
      QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      playerRigidBody,
    );

    if (hit) {
      // time_of_impact = distance the sphere center travels before the surface touches the wall.
      // Camera placed at that center → sphere surface is already collisionRadius from the wall.
      return Math.max(this.collisionRadius, hit.time_of_impact);
    }
    return maxDist;
  }

  public setActive(isActive: boolean): void {
    this.enabled = isActive;
  }

  public getPitch(): number {
    return this.pitch;
  }
  public getYaw(): number {
    return this.yaw;
  }

  public override renderInMenu(): void {}
  public renderDebug(): void {}
  public override dispose(): void {}
}
