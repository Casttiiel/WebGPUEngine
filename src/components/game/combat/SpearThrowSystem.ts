import { vec3 } from 'gl-matrix';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import type { CameraComponent } from '../../render/CameraComponent';
import type { TransformComponent } from '../../core/TransformComponent';
import type { SpearProjectileComponent } from './SpearProjectileComponent';

export interface SpearThrowSystemData {
  /** Name of the scene entity that holds the SpearProjectileComponent. Default: 'LynxSpear'. */
  spearEntityName?: string;
  /** Offset from player origin along camera forward when throwing (units). Default: 0.5. */
  muzzleForwardOffset?: number;
  /** Vertical offset of the throw origin relative to player root (units). Default: 1.4. */
  muzzleHeightOffset?: number;
  /** Speed of the dash-to-spear movement (m/s). Default: 22. */
  spearDashSpeed?: number;
  /** Max travel distance for a spear dash before it gives up (units). Default: 25. */
  spearDashMaxDistance?: number;
}

const enum SpearSystemState {
  READY = 0,
  IN_FLIGHT = 1,
  EMBEDDED = 2,
  RETURNING = 3,
  DASHING_TO_SPEAR = 4,
}

/**
 * SpearThrowSystem — Manages Lynx's single throwing spear.
 *
 * Mechanics:
 *   - THROW action:  Launches the spear from camera origin.  Only works when READY.
 *   - Proximity:     Walking within pickupRadius of an embedded spear auto-recovers it.
 *   - ABILITY_R:     Recalls the embedded spear back to the player (Thor's hammer).
 *
 * There is no pool — exactly one spear entity lives in the scene.
 * The entity name is configurable via `spearEntityName` (default: 'LynxSpear').
 */
export class SpearThrowSystem {
  private readonly spearEntityName: string;
  private readonly muzzleForwardOffset: number;
  private readonly muzzleHeightOffset: number;
  private readonly spearDashSpeed: number;
  private readonly spearDashMaxDistance: number;

  private state: SpearSystemState = SpearSystemState.READY;
  private spear: SpearProjectileComponent | null = null;
  private justPickedUp = false;

  // Dash-to-spear state
  private dashDir: vec3 = vec3.create();
  private dashTraveled: number = 0;
  /** Distance from player to spear at the moment the dash was started. Used for arc progress. */
  private dashTotalDist: number = 0;

  constructor(data?: SpearThrowSystemData) {
    this.spearEntityName = data?.spearEntityName ?? 'LynxSpear';
    this.muzzleForwardOffset = data?.muzzleForwardOffset ?? 0.5;
    this.muzzleHeightOffset = data?.muzzleHeightOffset ?? 1.4;
    this.spearDashSpeed = data?.spearDashSpeed ?? 22;
    this.spearDashMaxDistance = data?.spearDashMaxDistance ?? 25;
  }

  // ── Update (call from LynxControllerComponent IDLE state) ─────────────────

  public update(
    dt: number,
    camera: CameraComponent | null,
    playerTransform: TransformComponent,
  ): void {
    void dt;
    this.resolveSpear();
    if (!this.spear || !camera) return;

    const input = Engine.getInput();

    switch (this.state) {
      case SpearSystemState.READY: {
        if (input.isActionJustPressed(GameAction.THROW)) {
          this.throwSpear(camera, playerTransform);
        }
        break;
      }

      case SpearSystemState.IN_FLIGHT: {
        // Waiting for the hit callback — nothing to do.
        break;
      }

      case SpearSystemState.EMBEDDED: {
        // Recall: press R → spear flies back.
        if (input.isActionJustPressed(GameAction.ABILITY_R)) {
          const spear = this.spear;
          this.state = SpearSystemState.RETURNING;
          spear.startRecall(() => this.getRecallTarget(camera, playerTransform));
          break;
        }

        // Dash to spear: press Shift while roughly facing it.
        if (input.isActionJustPressed(GameAction.ROLL)) {
          if (this.tryStartSpearDash(camera, playerTransform)) break;
        }

        // Auto-pickup: walk close enough.
        const playerPos = playerTransform.getTransform().getWorldPosition();
        if (this.spear.tryAutoPickup(playerPos)) {
          // onPickedUp callback will set READY
        }
        break;
      }

      case SpearSystemState.RETURNING: {
        // Waiting for the onPickedUp callback — nothing to do.
        break;
      }

      case SpearSystemState.DASHING_TO_SPEAR: {
        // Movement handled by LynxControllerComponent via updateSpearDash().
        break;
      }
    }
  }

  // ── State queries ──────────────────────────────────────────────────────────

  /** True when the player is holding the spear and can throw it. */
  public isReady(): boolean {
    return this.state === SpearSystemState.READY;
  }

  /** True when the spear is stuck somewhere and has not been recalled yet. */
  public isEmbedded(): boolean {
    return this.state === SpearSystemState.EMBEDDED;
  }

  /** True while the spear is flying back toward the player after a recall. */
  public isReturning(): boolean {
    return this.state === SpearSystemState.RETURNING;
  }

  /**
   * Returns true (once) when the spear was just collected by the player.
   * Consumes the flag — subsequent calls return false until the next pickup.
   */
  public consumeJustPickedUp(): boolean {
    const v = this.justPickedUp;
    this.justPickedUp = false;
    return v;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private throwSpear(camera: CameraComponent, playerTransform: TransformComponent): void {
    const spear = this.spear!;

    const cam = camera.getCamera();
    const camPos = cam.getPosition();
    const camFront = cam.getFront();

    // Muzzle position: slightly in front of the camera, at chest height
    const playerRoot = playerTransform.getTransform().getWorldPosition();
    const origin = vec3.fromValues(
      playerRoot[0] + camFront[0] * this.muzzleForwardOffset,
      playerRoot[1] + this.muzzleHeightOffset,
      playerRoot[2] + camFront[2] * this.muzzleForwardOffset,
    );
    // Use the camera position's Y so vertical aiming is respected
    origin[1] = camPos[1];

    const direction = vec3.clone(camFront as vec3);

    this.state = SpearSystemState.IN_FLIGHT;

    spear.fire(
      origin,
      direction,
      () => this.getRecallTarget(camera, playerTransform),
      (_hitPoint) => {
        // Spear embedded — transition to EMBEDDED state
        this.state = SpearSystemState.EMBEDDED;
      },
      () => {
        // Spear returned to player (pickup, recall, or auto-recall arrived)
        this.justPickedUp = true;
        this.state = SpearSystemState.READY;
      },
    );
  }

  /** Target position for the recall: camera position (where the player is looking from). */
  private getRecallTarget(
    camera: CameraComponent | null,
    playerTransform: TransformComponent,
  ): vec3 {
    if (camera) {
      return vec3.clone(camera.getCamera().getPosition());
    }
    const root = playerTransform.getTransform().getWorldPosition();
    return vec3.fromValues(root[0], root[1] + this.muzzleHeightOffset, root[2]);
  }

  // ── Spear dash ─────────────────────────────────────────────────────────────

  /** True while the player is dashing toward the embedded spear. */
  public isDashingToSpear(): boolean {
    return this.state === SpearSystemState.DASHING_TO_SPEAR;
  }

  /**
   * Advances the spear dash by one frame.
   * Returns the velocity to apply (world-space); returns a zero vector when done.
   * Automatically transitions back to EMBEDDED so auto-pickup fires next frame.
   *
   * Feel:
   *  - Dynamic steering: direction recomputed each frame toward current spear position.
   *  - Speed burst: 1.4× at launch tapering to 1.0× at arrival.
   *  - Straight line: no vertical arc.
   */
  public updateSpearDash(dt: number, playerPos: vec3): vec3 {
    if (!this.spear) {
      this.state = SpearSystemState.EMBEDDED;
      return vec3.create();
    }

    const spearPos = this.spear.getEmbeddedPosition();
    if (spearPos === null) {
      this.state = SpearSystemState.EMBEDDED;
      return vec3.create();
    }

    // Dynamic direction — always steer toward the actual spear position.
    const toSpear = vec3.subtract(vec3.create(), spearPos, playerPos);
    const dist = vec3.length(toSpear);

    if (dist < 1.5) {
      this.state = SpearSystemState.EMBEDDED;
      return vec3.create();
    }

    const dirToSpear = vec3.scale(vec3.create(), toSpear, 1 / dist);

    const progress =
      this.dashTotalDist > 0 ? Math.min(this.dashTraveled / this.dashTotalDist, 1.0) : 0;

    // Speed burst: 1.4× at launch, fades to 1.0× at arrival.
    const speed = this.spearDashSpeed * (1.0 + 0.4 * (1.0 - progress));

    this.dashTraveled += speed * dt;
    if (this.dashTraveled >= this.spearDashMaxDistance) {
      this.state = SpearSystemState.EMBEDDED;
      return vec3.create();
    }

    return vec3.fromValues(dirToSpear[0] * speed, dirToSpear[1] * speed, dirToSpear[2] * speed);
  }

  /**
   * Checks whether a spear dash can start (spear embedded, player roughly facing it)
   * and initiates it.
   */
  private tryStartSpearDash(
    camera: CameraComponent | null,
    playerTransform: TransformComponent,
  ): boolean {
    if (!this.spear || !camera) return false;
    const spearPos = this.spear.getEmbeddedPosition();
    if (!spearPos) return false;

    const playerPos = playerTransform.getTransform().getWorldPosition();
    const toSpear = vec3.subtract(vec3.create(), spearPos, playerPos);
    const dist = vec3.length(toSpear);
    if (dist < 0.5) return false; // already on top of it

    vec3.scale(toSpear, toSpear, 1 / dist); // normalize in-place

    // Require the player to be roughly facing the spear (~65° cone).
    const camFront = camera.getCamera().getFront() as vec3;
    if (vec3.dot(toSpear, camFront) < 0.4) return false;

    vec3.copy(this.dashDir, toSpear);
    this.dashTraveled = 0;
    this.dashTotalDist = dist;
    this.state = SpearSystemState.DASHING_TO_SPEAR;
    return true;
  }

  /** Lazy-resolve the spear entity by name. */
  private resolveSpear(): void {
    if (this.spear) return;
    const entity = Engine.getEntities().getEntityByName(this.spearEntityName);
    this.spear =
      (entity?.getComponent('spear_projectile') as SpearProjectileComponent | undefined) ?? null;
    if (!this.spear) {
      // Entity not ready yet — will retry next frame.
    }
  }
}
