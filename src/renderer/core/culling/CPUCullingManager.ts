import { PointLightComponent } from '../../../components/render/PointLightComponent';
import { SpotLightComponent } from '../../../components/render/SpotLightComponent';
import { Engine } from '../../../core/engine/Engine';
import { AABB } from '../../../core/math/AABB';
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

  // ✅ Reusable frustum planes array (6 planes, 4 floats each)
  private frustumPlanes: Float32Array[] = [
    new Float32Array(4), // Left
    new Float32Array(4), // Right
    new Float32Array(4), // Bottom
    new Float32Array(4), // Top
    new Float32Array(4), // Near
    new Float32Array(4), // Far
  ];

  // ✅ Reusable matrix for view-projection calculation
  private viewProjMatrix: mat4 = mat4.create();

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

    // Get camera frustum planes (zero-allocation version)
    this.extractFrustumPlanes(camera);

    // Test each object against frustum
    for (const key of keys) {
      if (key.isInstanced || this.isVisibleInFrustum(key, this.frustumPlanes)) {
        visibleKeys.push(key);
      }
    }

    // Update statistics
    this.stats.visibleObjects = visibleKeys.length;
    this.stats.culledObjects = this.stats.totalObjects - this.stats.visibleObjects;
    this.stats.lastCullTime = performance.now() - startTime;

    return visibleKeys;
  }

  public performLightCulling(camera: Camera): void {
    // Get camera frustum planes (zero-allocation version)
    this.extractFrustumPlanes(camera);

    for (const comp of Engine.getEntities().getObjectManagerByName('spot_light')?.getList() ?? []) {
      const spotLightComponent = comp as SpotLightComponent;
      const isVisible = this.isLightVisibleInFrustum(
        spotLightComponent.getAABB(),
        this.frustumPlanes,
      );
      spotLightComponent.setIsVisible(isVisible);
    }

    for (const comp of Engine.getEntities().getObjectManagerByName('point_light')?.getList() ??
      []) {
      const pointLightComponent = comp as PointLightComponent;
      const isVisible = this.isLightVisibleInFrustum(
        pointLightComponent.getAABB(),
        this.frustumPlanes,
      );
      pointLightComponent.setIsVisible(isVisible);
    }
  }

  /**
   * Extract frustum planes from camera view-projection matrix
   * ✅ Zero-allocation version using reusable Float32Arrays
   */
  private extractFrustumPlanes(camera: Camera): void {
    mat4.multiply(this.viewProjMatrix, camera.getProjection(), camera.getView());

    const m = this.viewProjMatrix;

    // Left plane: matrix[3] + matrix[0]
    this.frustumPlanes[0]![0] = m[3] + m[0];
    this.frustumPlanes[0]![1] = m[7] + m[4];
    this.frustumPlanes[0]![2] = m[11] + m[8];
    this.frustumPlanes[0]![3] = m[15] + m[12];

    // Right plane: matrix[3] - matrix[0]
    this.frustumPlanes[1]![0] = m[3] - m[0];
    this.frustumPlanes[1]![1] = m[7] - m[4];
    this.frustumPlanes[1]![2] = m[11] - m[8];
    this.frustumPlanes[1]![3] = m[15] - m[12];

    // Bottom plane: matrix[3] + matrix[1]
    this.frustumPlanes[2]![0] = m[3] + m[1];
    this.frustumPlanes[2]![1] = m[7] + m[5];
    this.frustumPlanes[2]![2] = m[11] + m[9];
    this.frustumPlanes[2]![3] = m[15] + m[13];

    // Top plane: matrix[3] - matrix[1]
    this.frustumPlanes[3]![0] = m[3] - m[1];
    this.frustumPlanes[3]![1] = m[7] - m[5];
    this.frustumPlanes[3]![2] = m[11] - m[9];
    this.frustumPlanes[3]![3] = m[15] - m[13];

    // Near plane: matrix[3] + matrix[2]
    this.frustumPlanes[4]![0] = m[3] + m[2];
    this.frustumPlanes[4]![1] = m[7] + m[6];
    this.frustumPlanes[4]![2] = m[11] + m[10];
    this.frustumPlanes[4]![3] = m[15] + m[14];

    // Far plane: matrix[3] - matrix[2]
    this.frustumPlanes[5]![0] = m[3] - m[2];
    this.frustumPlanes[5]![1] = m[7] - m[6];
    this.frustumPlanes[5]![2] = m[11] - m[10];
    this.frustumPlanes[5]![3] = m[15] - m[14];

    // Normalize planes
    for (const plane of this.frustumPlanes) {
      const length = Math.sqrt(
        plane[0]! * plane[0]! + plane[1]! * plane[1]! + plane[2]! * plane[2]!,
      );
      if (length > 0) {
        const invLength = 1.0 / length;
        plane[0]! *= invLength;
        plane[1]! *= invLength;
        plane[2]! *= invLength;
        plane[3]! *= invLength;
      }
    }
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

  private isLightVisibleInFrustum(aabb: AABB, frustumPlanes: Float32Array[]): boolean {
    const worldAABB = aabb;

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
