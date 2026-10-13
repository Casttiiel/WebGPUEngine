import { PointLightComponent } from '../../../components/render/PointLightComponent';
import { SpotLightComponent } from '../../../components/render/SpotLightComponent';
import { Engine } from '../../../core/engine/Engine';
import { AABB } from '../../../core/math/AABB';
import { Camera } from '../../../core/math/Camera';
import { RenderKey } from '../managers/RenderKeyManager';
import { mat4 } from 'gl-matrix';

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

  /**
   * Count-only version of performCulling — no array allocation.
   * Used to show an estimated visible object count in the debug UI
   * when the GPU culling path is active (no readback available).
   */
  public countVisible(keys: RenderKey[], camera: Camera): number {
    this.extractFrustumPlanes(camera);
    let count = 0;
    for (const key of keys) {
      if (key.isInstanced || this.isVisibleInFrustum(key, this.frustumPlanes)) {
        count++;
      }
    }
    return count;
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

  /** Scratch world matrix (Transform.getWorldMatrix() allocates a new mat4 per call). */
  private readonly _cullMatrix = mat4.create();

  /**
   * Test if an object's bounding box is visible in the frustum
   * Uses the same algorithm as the GPU shader: center + half extents method.
   * Allocation-free: the world AABB comes from Arvo's method (|M|·halfExtents), which gives
   * the same box as transforming the 8 corners, without temporaries.
   */
  private isVisibleInFrustum(key: RenderKey, frustumPlanes: Float32Array[]): boolean {
    // If no AABB, assume visible (safety fallback)
    if (!key.aabb) {
      return true;
    }

    const t = key.transform.getTransform();
    const m = mat4.fromRotationTranslationScale(
      this._cullMatrix,
      t.getWorldRotation(),
      t.getWorldPosition(),
      t.getWorldScale(),
    );
    const a = key.aabb;
    const lcx = (a.min[0]! + a.max[0]!) * 0.5;
    const lcy = (a.min[1]! + a.max[1]!) * 0.5;
    const lcz = (a.min[2]! + a.max[2]!) * 0.5;
    const lhx = (a.max[0]! - a.min[0]!) * 0.5;
    const lhy = (a.max[1]! - a.min[1]!) * 0.5;
    const lhz = (a.max[2]! - a.min[2]!) * 0.5;

    const cx = m[0]! * lcx + m[4]! * lcy + m[8]! * lcz + m[12]!;
    const cy = m[1]! * lcx + m[5]! * lcy + m[9]! * lcz + m[13]!;
    const cz = m[2]! * lcx + m[6]! * lcy + m[10]! * lcz + m[14]!;
    const hx = Math.abs(m[0]!) * lhx + Math.abs(m[4]!) * lhy + Math.abs(m[8]!) * lhz;
    const hy = Math.abs(m[1]!) * lhx + Math.abs(m[5]!) * lhy + Math.abs(m[9]!) * lhz;
    const hz = Math.abs(m[2]!) * lhx + Math.abs(m[6]!) * lhy + Math.abs(m[10]!) * lhz;

    return this.boxInFrustum(cx, cy, cz, hx, hy, hz, frustumPlanes);
  }

  private isLightVisibleInFrustum(aabb: AABB, frustumPlanes: Float32Array[]): boolean {
    const cx = (aabb.min[0]! + aabb.max[0]!) * 0.5;
    const cy = (aabb.min[1]! + aabb.max[1]!) * 0.5;
    const cz = (aabb.min[2]! + aabb.max[2]!) * 0.5;
    const hx = (aabb.max[0]! - aabb.min[0]!) * 0.5;
    const hy = (aabb.max[1]! - aabb.min[1]!) * 0.5;
    const hz = (aabb.max[2]! - aabb.min[2]!) * 0.5;
    return this.boxInFrustum(cx, cy, cz, hx, hy, hz, frustumPlanes);
  }

  /**
   * GPU shader algorithm:
   *   r = dot(abs(plane.xyz), half);  c = dot(plane.xyz, center) + plane.w;  outside if c < -r
   */
  private boxInFrustum(
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
    frustumPlanes: Float32Array[],
  ): boolean {
    for (const plane of frustumPlanes) {
      const px = plane[0]!,
        py = plane[1]!,
        pz = plane[2]!;
      const r = Math.abs(px) * hx + Math.abs(py) * hy + Math.abs(pz) * hz;
      const c = px * cx + py * cy + pz * cz + plane[3]!;
      if (c < -r) return false; // AABB is completely outside this plane
    }
    return true;
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
