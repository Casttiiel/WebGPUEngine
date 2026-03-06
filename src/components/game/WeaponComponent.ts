import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { MouseButton } from '../../types/MouseButton.enum';
import { BulletPoolComponent } from './BulletPoolComponent';
import { CameraComponent } from '../render/CameraComponent';

export type WeaponComponentData = {
  /** Shots per second. Default 8. */
  fireRate?: number;
  /** 'semi' = one shot per click, 'auto' = hold to fire. Default 'semi'. */
  fireMode?: 'semi' | 'auto';
  /** Name of the entity that holds BulletPoolComponent. Default 'BulletManager'. */
  poolName?: string;
};

export class WeaponComponent extends Component {
  private fireRate: number = 8;
  private fireMode: 'semi' | 'auto' = 'semi';
  private poolName: string = 'BulletManager';

  private timeSinceLastShot: number = 0;

  // Resolved lazily on first shoot() call so load order doesn't matter
  private cameraComponent: CameraComponent | null = null;
  private pool: BulletPoolComponent | null = null;

  public load(data: WeaponComponentData): void {
    this.fireRate = data.fireRate ?? 8;
    this.fireMode = data.fireMode ?? 'semi';
    this.poolName = data.poolName ?? 'BulletManager';
  }

  public update(dt: number): void {
    this.timeSinceLastShot += dt;

    const input = Engine.getInput();
    const fireInterval = 1 / this.fireRate;

    const shouldFire =
      this.fireMode === 'auto'
        ? input.isMouseButtonPressed(MouseButton.LEFT)
        : input.isMouseButtonJustPressed(MouseButton.LEFT);

    if (shouldFire && this.timeSinceLastShot >= fireInterval) {
      this.shoot();
      this.timeSinceLastShot = 0;
    }
  }

  private shoot(): void {
    // Lazy-resolve: find the camera child entity (has the actual rendered view direction)
    if (!this.cameraComponent) {
      const cameraEntity = this.getOwner().getChildren().find(c => c.hasComponent('camera'));
      this.cameraComponent = (cameraEntity?.getComponent('camera') as CameraComponent) ?? null;

      if (!this.cameraComponent) {
        console.warn('WeaponComponent: no camera child entity found on owner');
        return;
      }
    }

    // Lazy-resolve pool (separate BulletManager entity)
    if (!this.pool) {
      const poolEntity = Engine.getEntities().getEntityByName(this.poolName);
      this.pool = (poolEntity?.getComponent('bullet_pool') as BulletPoolComponent) ?? null;

      if (!this.pool) {
        console.warn(`WeaponComponent: no bullet_pool found on entity "${this.poolName}"`);
        return;
      }
    }

    // Use the camera's ground-truth position and direction (same values used by the renderer)
    const cam = this.cameraComponent.getCamera();
    const eyePos = cam.getPosition();
    const dir = cam.getFront();

    // Offset muzzle forward so the bullet starts in front of the camera
    const muzzle = vec3.scaleAndAdd(vec3.create(), eyePos, dir, 0.5);

    const bullet = this.pool.acquire();
    if (!bullet) return;

    bullet.fire(muzzle, dir, this.pool.release.bind(this.pool));
  }

  public renderDebug(): void {}
}
