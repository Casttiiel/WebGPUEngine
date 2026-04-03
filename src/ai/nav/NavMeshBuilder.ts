import { mat4 } from 'gl-matrix';
import { NavMesh } from './NavMesh';

/**
 * NavMeshBuilder — thin wrapper that extracts raw GLTF geometry
 * and feeds it to the NavMesh singleton.
 *
 * Called by GLTFLoader when a mesh node with extras.type === "navmesh" is detected.
 */
export class NavMeshBuilder {
  /**
   * @param positions  POSITION accessor data (Float32Array, xyz triples)
   * @param indices    Index accessor data (Uint16Array or Uint32Array)
   * @param worldMatrix  Optional node-to-world transform (column-major, gl-matrix order)
   */
  public static async build(
    positions: Float32Array,
    indices: Uint32Array | Uint16Array,
    worldMatrix?: mat4,
  ): Promise<void> {
    await NavMesh.getInstance().build(positions, indices, worldMatrix);
  }
}
