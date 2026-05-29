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
}

const enum SpearSystemState {
  READY = 0,
  IN_FLIGHT = 1,
  EMBEDDED = 2,
  RETURNING = 3,
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

  private state: SpearSystemState = SpearSystemState.READY;
  private spear: SpearProjectileComponent | null = null;

  constructor(data?: SpearThrowSystemData) {
    this.spearEntityName = data?.spearEntityName ?? 'LynxSpear';
    this.muzzleForwardOffset = data?.muzzleForwardOffset ?? 0.5;
    this.muzzleHeightOffset = data?.muzzleHeightOffset ?? 1.4;
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
