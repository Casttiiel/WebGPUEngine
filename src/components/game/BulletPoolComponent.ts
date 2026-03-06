import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { Loader } from '../../core/loaders/Loader';
import { EntityDataType } from '../../types/SceneData.type';
import { TransformComponent } from '../core/TransformComponent';
import { ProjectileComponent } from './ProjectileComponent';

export type BulletPoolComponentData = {
  /** Path to the bullet prefab relative to assets/prefabs/, e.g. "gameplay/bullet.prefab" */
  prefab: string;
  /** Number of bullets to pre-allocate. Defaults to 20. */
  size?: number;
};

const PARK_POSITION = vec3.fromValues(0, -1000, 0);

/**
 * Pre-allocates a fixed pool of bullet entities at scene load.
 * Attach to a dedicated "BulletManager" entity in the scene.
 *
 * Usage from WeaponComponent:
 *   const pool = Engine.getEntities().getEntityByName('BulletManager')
 *                  ?.getComponent('bullet_pool') as BulletPoolComponent;
 *   const bullet = pool.acquire();
 *   if (bullet) bullet.fire(muzzlePos, direction, pool);
 */
export class BulletPoolComponent extends Component {
  private pool: ProjectileComponent[] = [];
  private prefabPath: string = '';
  private poolSize: number = 20;

  public async load(data: BulletPoolComponentData): Promise<void> {
    this.prefabPath = data.prefab;
    this.poolSize = data.size ?? 20;
    await this.prewarm();
  }

  private async prewarm(): Promise<void> {
    // ResourceManager caches the prefab JSON — only one fetch regardless of poolSize
    const template = await ResourceManager.loadPrefab(this.prefabPath);

    await Promise.all(Array.from({ length: this.poolSize }, () => this.spawnDormant(template)));

    console.log(
      `[BulletPoolComponent] Pooled ${this.pool.length} bullets from "${this.prefabPath}"`,
    );
  }

  private async spawnDormant(template: EntityDataType): Promise<void> {
    // Deep-clone so each entity gets its own data object
    const data: EntityDataType = JSON.parse(JSON.stringify(template));

    // Park underground so it's never visible nor in frustum
    if (data.components?.transform) {
      data.components.transform.position = [0, -1000, 0];
    }

    const entity = await Loader.loadEntityFromJSON(data);
    const projectile = entity.getComponent('projectile') as ProjectileComponent | null;

    if (!projectile) {
      console.warn('[BulletPoolComponent] Bullet prefab has no "projectile" component — skipping.');
      return;
    }

    projectile.enabled = false;
    this.pool.push(projectile);
  }

  /**
   * Returns a dormant projectile from the pool, or null if all are active.
   * Call bullet.fire() on the returned component to activate it.
   *
   * Usage:
   *   const bullet = pool.acquire();
   *   if (bullet) bullet.fire(origin, direction, pool.release.bind(pool));
   */
  public acquire(): ProjectileComponent | null {
    return this.pool.find((p) => !p.enabled) ?? null;
  }

  /**
   * Called automatically by ProjectileComponent when it hits or expires.
   * Disables the projectile and parks its entity underground.
   */
  public release(projectile: ProjectileComponent): void {
    projectile.enabled = false;

    const transform = (
      projectile.getOwner().getComponent('transform') as TransformComponent
    ).getTransform();
    transform.setLocalPosition(PARK_POSITION);
    transform.markDirty();
  }

  /** How many bullets are currently in flight. */
  public get activeCount(): number {
    return this.pool.filter((p) => p.enabled).length;
  }

  /** Total pool capacity. */
  public get capacity(): number {
    return this.pool.length;
  }

  public update(_dt: number): void {}
  public renderDebug(): void {}
}
