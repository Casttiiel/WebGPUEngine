import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { vec3 } from 'gl-matrix';

/**
 * Marker component placed on an entity that represents a player spawn point.
 *
 * Workflow:
 * 1. In Blender, create an Empty object and add a custom property:
 *      type = "player_spawn"
 *    Export the scene as GLTF — the property appears in the node's `extras`.
 * 2. GLTFLoader detects the extra and creates an entity with this component.
 * 3. On attach, the current world position (already computed by TransformComponent.load)
 *    is stored in the static `pendingPosition`.
 * 4. After Loader.loadSceneFromJSON() finishes, ModuleBoot reads pendingPosition
 *    and teleports the player's physics body there.
 */
export class PlayerSpawnComponent extends Component {
  public static pendingPosition: vec3 | null = null;
  /** Spawn yaw in degrees, derived from the spawn empty's world rotation. */
  public static pendingYawDeg: number | null = null;

  public async load(_data: unknown): Promise<void> {}

  public override async onAttach(): Promise<void> {
    const tc = this.getOwner().getComponent('transform');
    if (!tc) return;

    // TransformComponent.load() already called updateWorldTransform(), so
    // getWorldPosition() is correct even before the first per-frame update.
    const transform = (tc as TransformComponent).getTransform();
    const worldPos = transform.getWorldPosition();

    PlayerSpawnComponent.pendingPosition = vec3.clone(worldPos);

    // Extract yaw (in radians) from the spawn empty's world rotation, convert to degrees.
    const { yaw } = transform.getAngles();
    PlayerSpawnComponent.pendingYawDeg = (yaw * 180) / Math.PI;
  }

  public update(): void {}

  public dispose(): void {}
}
