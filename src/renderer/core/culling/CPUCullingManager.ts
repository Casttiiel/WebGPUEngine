import { Camera } from '../../../core/math/Camera';
import { RenderKey } from '../managers/RenderKeyManager';
import { mat4, vec3 } from 'gl-matrix';

/**
 * Simple CPU-based Culling Manager
 *
 * Performs basic frustum culling on the CPU for simplicity and reliability.
 * No temporal optimization or caching - direct frustum testing per frame.
 */
export class CPUCullingManager {
  // Debug statistics
  private stats = {
    totalObjects: 0,
    culledObjects: 0,
    visibleObjects: 0,
    lastCullTime: 0,
  };

  constructor() {
    // Simple constructor - no complex initialization needed
  }

  /**
   * Perform CPU-based frustum culling
   * @param keys - Array of render keys to test
   * @param camera - Camera to test against
   * @returns Array of visible render keys
   */
  public performCulling(keys: RenderKey[], camera: Camera): RenderKey[] {
    const startTime = performance.now();

    this.stats.totalObjects = keys.length;
    const visibleKeys: RenderKey[] = [];

    // Get camera frustum planes
    const frustumPlanes = this.extractFrustumPlanes(camera);

    // Test each object against frustum
    for (const key of keys) {
      if (this.isVisibleInFrustum(key, frustumPlanes)) {
        visibleKeys.push(key);
      }
    }

    // Update statistics
    this.stats.visibleObjects = visibleKeys.length;
    this.stats.culledObjects = this.stats.totalObjects - this.stats.visibleObjects;
    this.stats.lastCullTime = performance.now() - startTime;

    return visibleKeys;
  }

  /**
   * Extract frustum planes from camera view-projection matrix
   */
  private extractFrustumPlanes(camera: Camera): Float32Array[] {
    const viewProjMatrix = mat4.create();
    mat4.multiply(viewProjMatrix, camera.getProjection(), camera.getView());

    // Extract 6 frustum planes (left, right, bottom, top, near, far)
    const planes: Float32Array[] = [];

    // Left plane: matrix[3] + matrix[0]
    planes.push(
      new Float32Array([
        viewProjMatrix[3] + viewProjMatrix[0],
        viewProjMatrix[7] + viewProjMatrix[4],
        viewProjMatrix[11] + viewProjMatrix[8],
        viewProjMatrix[15] + viewProjMatrix[12],
      ]),
    );

    // Right plane: matrix[3] - matrix[0]
    planes.push(
      new Float32Array([
        viewProjMatrix[3] - viewProjMatrix[0],
        viewProjMatrix[7] - viewProjMatrix[4],
        viewProjMatrix[11] - viewProjMatrix[8],
        viewProjMatrix[15] - viewProjMatrix[12],
      ]),
    );

    // Bottom plane: matrix[3] + matrix[1]
    planes.push(
      new Float32Array([
        viewProjMatrix[3] + viewProjMatrix[1],
        viewProjMatrix[7] + viewProjMatrix[5],
        viewProjMatrix[11] + viewProjMatrix[9],
        viewProjMatrix[15] + viewProjMatrix[13],
      ]),
    );

    // Top plane: matrix[3] - matrix[1]
    planes.push(
      new Float32Array([
        viewProjMatrix[3] - viewProjMatrix[1],
        viewProjMatrix[7] - viewProjMatrix[5],
        viewProjMatrix[11] - viewProjMatrix[9],
        viewProjMatrix[15] - viewProjMatrix[13],
      ]),
    );

    // Near plane: matrix[3] + matrix[2]
    planes.push(
      new Float32Array([
        viewProjMatrix[3] + viewProjMatrix[2],
        viewProjMatrix[7] + viewProjMatrix[6],
        viewProjMatrix[11] + viewProjMatrix[10],
        viewProjMatrix[15] + viewProjMatrix[14],
      ]),
    );

    // Far plane: matrix[3] - matrix[2]
    planes.push(
      new Float32Array([
        viewProjMatrix[3] - viewProjMatrix[2],
        viewProjMatrix[7] - viewProjMatrix[6],
        viewProjMatrix[11] - viewProjMatrix[10],
        viewProjMatrix[15] - viewProjMatrix[14],
      ]),
    );

    // Normalize planes
    for (const plane of planes) {
      const length = Math.sqrt(
        plane[0]! * plane[0]! + plane[1]! * plane[1]! + plane[2]! * plane[2]!,
      );
      if (length > 0) {
        plane[0]! /= length;
        plane[1]! /= length;
        plane[2]! /= length;
        plane[3]! /= length;
      }
    }

    return planes;
  }

  /**
   * Test if an object's bounding box is visible in the frustum
   * Uses the same algorithm as the GPU shader: center + half extents method
   */
  private isVisibleInFrustum(key: RenderKey, frustumPlanes: Float32Array[]): boolean {
    // If no AABB, assume visible (safety fallback)
    if (!key.aabb) {
      return true;
    }

    // Transform AABB to world space using the object's model matrix
    const modelMatrix = key.transform.getTransform().getWorldMatrix();
    const worldAABB = this.transformAABBToWorldSpace(key.aabb, modelMatrix);

    // Calculate AABB center and half extents (like GPU shader)
    const aabbCenter = vec3.create();
    const aabbHalf = vec3.create();

    vec3.add(aabbCenter, worldAABB.min, worldAABB.max);
    vec3.scale(aabbCenter, aabbCenter, 0.5);

    vec3.subtract(aabbHalf, worldAABB.max, worldAABB.min);
    vec3.scale(aabbHalf, aabbHalf, 0.5);

    // Test against each frustum plane using GPU shader algorithm
    for (const plane of frustumPlanes) {
      const planeNormal = vec3.fromValues(plane[0]!, plane[1]!, plane[2]!);
      const planeDistance = plane[3]!;

      // GPU shader algorithm:
      // const float r = dot( abs( plane.xyz ), instance.aabb_half );
      // const float c = dot( plane.xyz, instance.aabb_center ) + plane.w;
      // if( c < -r ) return false;

      const absNormal = vec3.fromValues(
        Math.abs(planeNormal[0]),
        Math.abs(planeNormal[1]),
        Math.abs(planeNormal[2]),
      );
      const r = vec3.dot(absNormal, aabbHalf);
      const c = vec3.dot(planeNormal, aabbCenter) + planeDistance;

      if (c < -r) {
        return false; // AABB is completely outside this plane
      }
    }

    // AABB intersects or is inside all planes
    return true;
  }

  /**
   * Transform AABB to world space by transforming all 8 corners
   * This matches the GPU shader transformAABB function
   */
  private transformAABBToWorldSpace(
    aabb: { min: number[]; max: number[] },
    modelMatrix: mat4,
  ): { min: vec3; max: vec3 } {
    const minCorner = vec3.fromValues(1e30, 1e30, 1e30);
    const maxCorner = vec3.fromValues(-1e30, -1e30, -1e30);

    // Transform all 8 corners and find new min/max (matches GPU shader logic)
    for (let i = 0; i < 8; i++) {
      const corner = vec3.fromValues(
        (i & 1) !== 0 ? aabb.max[0]! : aabb.min[0]!,
        (i & 2) !== 0 ? aabb.max[1]! : aabb.min[1]!,
        (i & 4) !== 0 ? aabb.max[2]! : aabb.min[2]!,
      );

      // Transform corner to world space
      const worldCorner = vec3.create();
      vec3.transformMat4(worldCorner, corner, modelMatrix);

      // Update min/max
      vec3.min(minCorner, minCorner, worldCorner);
      vec3.max(maxCorner, maxCorner, worldCorner);
    }

    return {
      min: minCorner,
      max: maxCorner,
    };
  }

  /**
   * Get culling statistics for debugging
   */
  public getDebugStats() {
    const cullPercentage =
      this.stats.totalObjects > 0
        ? ((this.stats.culledObjects / this.stats.totalObjects) * 100).toFixed(1)
        : '0.0';

    return {
      totalObjects: this.stats.totalObjects,
      visibleObjects: this.stats.visibleObjects,
      culledObjects: this.stats.culledObjects,
      cullPercentage: cullPercentage + '%',
      lastCullTime: this.stats.lastCullTime.toFixed(2) + 'ms',
    };
  }

  /**
   * Reset statistics
   */
  public resetStats(): void {
    this.stats.totalObjects = 0;
    this.stats.culledObjects = 0;
    this.stats.visibleObjects = 0;
    this.stats.lastCullTime = 0;
  }

  /**
   * Dispose resources (nothing to clean up for CPU culling)
   */
  public dispose(): void {
    this.resetStats();
  }
}
