import type { Entity } from '../../../core/ecs/Entity';
import type { CameraComponent } from '../../render/CameraComponent';

export interface AlchemistPowerConfig {
  type: string;
  maxResource?: number;
  primaryCost?: number;
  imbueRate?: number;
}

/**
 * AlchemistPower — base class for all alchemist powers.
 *
 * Each power owns its resource pool. The controller drives the timing:
 *   - usePrimary()       fires the active ability once (consumes primaryCost)
 *   - onImbueStart/Stop  toggle the passive imbue effect
 *   - onImbueUpdate(dt)  ticks while the imbue is active
 *   - drainImbue(dt)     deducts imbueRate * dt from resource; returns false when depleted
 *
 * Resource never regenerates on its own — supply/refill is game-design's concern.
 */
export abstract class AlchemistPower {
  resource: number;
  readonly maxResource: number;
  readonly primaryCost: number;
  readonly imbueRate: number;

  constructor(config: AlchemistPowerConfig) {
    this.maxResource  = config.maxResource  ?? 100;
    this.primaryCost  = config.primaryCost  ?? 10;
    this.imbueRate    = config.imbueRate    ?? 5;
    this.resource     = this.maxResource;
  }

  canUsePrimary(): boolean { return this.resource >= this.primaryCost; }
  canStartImbue(): boolean { return this.resource > 0; }

  consumePrimary(): void {
    this.resource = Math.max(0, this.resource - this.primaryCost);
  }

  /**
   * Called every frame while the imbue is active.
   * Returns false when resource is exhausted — the controller auto-deactivates.
   */
  drainImbue(dt: number): boolean {
    this.resource -= this.imbueRate * dt;
    if (this.resource <= 0) {
      this.resource = 0;
      return false;
    }
    return true;
  }

  getResourceRatio(): number {
    return this.maxResource > 0 ? this.resource / this.maxResource : 0;
  }

  abstract readonly id: string;
  abstract usePrimary(owner: Entity, camera: CameraComponent | null): void;
  abstract onImbueStart(owner: Entity): void;
  abstract onImbueStop(owner: Entity): void;
  abstract onImbueUpdate(dt: number, owner: Entity): void;
}
