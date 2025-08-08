import { Camera } from '../../../core/math/Camera';
import { RenderKey } from '../managers/RenderKeyManager';
import { GPUFrustumCuller, CullableObject } from '../../culling/GPUFrustumCuller';
import { vec3 } from 'gl-matrix';

interface CullingCacheEntry {
  frame: number;
  culledKeys: RenderKey[];
  cameraPosition: vec3;
  cameraDirection: vec3;
  timestamp: number;
}

/**
 * Temporal Culling Manager - AAA-style temporal lag compensation
 *
 * Uses results from previous frames while computing culling for future frames
 * in background, eliminating render thread blocking.
 */
export class TemporalCullingManager {
  private cullingCache = new Map<number, CullingCacheEntry>();
  private frameNumber = 0;
  private gpuCuller: GPUFrustumCuller | null = null;

  // Camera prediction data
  private cameraHistory: Array<{ position: vec3; direction: vec3; timestamp: number }> = [];

  // Background culling state
  private pendingCullingFrame = -1;
  private isGPUCullingActive = false; // Prevent concurrent GPU operations

  // Configuration
  private FRAME_LAG = 2; // Use results from 2 frames ago (configurable via debug)
  private readonly CACHE_SIZE = 10; // Keep last 10 frames
  private readonly HISTORY_SIZE = 5; // Camera history for prediction
  private PREDICTION_STRENGTH = 1.0; // Reduce prediction aggressiveness (0.0 = no prediction, 1.0 = full prediction)

  // Debug stats
  private stats = {
    cacheHits: 0,
    cacheMisses: 0,
    predictionAccuracy: 0,
    totalCacheCleanups: 0,
    totalHistoryCleanups: 0,
  };

  constructor(gpuCuller: GPUFrustumCuller | null = null) {
    this.gpuCuller = gpuCuller;
  }

  /**
   * Perform temporal culling - returns immediately with cached results
   */
  public performCulling(keys: RenderKey[], camera: Camera): RenderKey[] {
    this.frameNumber++;
    this.updateCameraHistory(camera);

    // Get cached results immediately (0ms blocking)
    const cachedResults = this.getCachedResults(keys);

    // Start background culling for future frame
    this.startBackgroundCulling(keys, camera);

    return cachedResults;
  }

  /**
   * Get cached culling results, with fallback strategies
   */
  private getCachedResults(allKeys: RenderKey[]): RenderKey[] {
    const targetFrame = this.frameNumber - this.FRAME_LAG;
    const cacheEntry = this.cullingCache.get(targetFrame);

    if (cacheEntry) {
      this.stats.cacheHits++;

      // Validate cache entry is still relevant
      if (this.isCacheEntryValid(cacheEntry)) {
        return cacheEntry.culledKeys;
      }
    }

    this.stats.cacheMisses++;

    // Fallback strategies
    return this.getFallbackResults(allKeys);
  }

  /**
   * Check if cached entry is still valid based on camera motion
   */
  private isCacheEntryValid(entry: CullingCacheEntry): boolean {
    const currentCamera = this.getCurrentCameraState();
    const ageDelta = Date.now() - entry.timestamp;

    // Too old = invalid
    if (ageDelta > 100) return false; // 100ms max age

    // Too much camera movement = invalid
    const positionDelta = vec3.distance(currentCamera.position, entry.cameraPosition);
    const directionDelta = vec3.dot(currentCamera.direction, entry.cameraDirection);

    // Thresholds based on scene scale
    return positionDelta < 5.0 && directionDelta > 0.9;
  }

  /**
   * Fallback when no valid cache entry exists
   */
  private getFallbackResults(allKeys: RenderKey[]): RenderKey[] {
    // Strategy 1: Use most recent cache entry
    const recentEntry = this.getMostRecentCacheEntry();
    if (recentEntry) {
      return recentEntry.culledKeys;
    }

    // Strategy 2: Conservative culling (render more objects)
    return this.performConservativeCulling(allKeys);
  }

  /**
   * Conservative CPU-based culling as ultimate fallback
   */
  private performConservativeCulling(keys: RenderKey[]): RenderKey[] {
    console.log('🔄 TemporalCulling: Using conservative CPU fallback culling');
    const currentCamera = this.getCurrentCameraState();

    // Simple distance-based culling
    return keys.filter((key) => {
      if (!key.aabb) return true; // No bounds = always render

      const center = vec3.create();
      vec3.add(center, key.aabb.min, key.aabb.max);
      vec3.scale(center, center, 0.5);

      const distance = vec3.distance(currentCamera.position, center);
      return distance < 100; // Render objects within 100 units
    });
  }

  /**
   * Start background GPU culling for future frame (non-blocking)
   */
  private startBackgroundCulling(keys: RenderKey[], camera: Camera): void {
    const futureFrame = this.frameNumber + this.FRAME_LAG;

    // Skip if already processing this frame OR if GPU culling is active
    if (this.pendingCullingFrame === futureFrame || !this.gpuCuller || this.isGPUCullingActive) {
      return;
    }

    this.pendingCullingFrame = futureFrame;
    this.isGPUCullingActive = true; // Mark GPU culling as active

    // Predict future camera position
    const predictedCamera = this.predictCameraPosition(camera, this.FRAME_LAG);

    // Start async culling (no await in calling code)
    this.performAsyncGPUCulling(keys, predictedCamera, futureFrame)
      .then((culledKeys) => {
        this.storeCullingResults(futureFrame, culledKeys, predictedCamera);
        this.pendingCullingFrame = -1;
        this.isGPUCullingActive = false; // Mark GPU culling as inactive
      })
      .catch((error) => {
        console.warn('Background culling failed:', error);
        this.pendingCullingFrame = -1;
        this.isGPUCullingActive = false; // Mark GPU culling as inactive
      });
  }

  /**
   * Perform actual GPU culling (async)
   */
  private async performAsyncGPUCulling(
    keys: RenderKey[],
    camera: Camera,
    _targetFrame: number,
  ): Promise<RenderKey[]> {
    if (!this.gpuCuller) return keys;

    // Convert to cullable objects
    const cullableObjects: CullableObject[] = keys.map((key) => ({
      id: key.id,
      bounds: key.aabb || { min: [-1, -1, -1], max: [1, 1, 1] },
      modelMatrix: new Float32Array(key.transform.getTransform().getWorldMatrix()),
    }));

    // Perform GPU culling
    const cullResult = await this.gpuCuller.cullObjects(camera, cullableObjects);

    // Filter keys based on results
    const visibleKeys: RenderKey[] = [];
    for (const visibleIndex of cullResult.visibleIndices) {
      if (visibleIndex < keys.length) {
        const key = keys[visibleIndex];
        if (key) {
          visibleKeys.push(key);
        }
      }
    }

    return visibleKeys;
  }

  /**
   * Predict camera position for future frame using REAL camera motion history
   * This uses actual camera positions, not predicted ones, to avoid error accumulation
   */
  private predictCameraPosition(currentCamera: Camera, frameDelta: number): Camera {
    // Need at least 2 REAL camera history entries for velocity calculation
    if (this.cameraHistory.length < 2) {
      return currentCamera; // Not enough REAL history, use current camera
    }

    // Get the most recent REAL camera positions
    const recent = this.cameraHistory[this.cameraHistory.length - 1]!; // Most recent REAL camera
    const previous = this.cameraHistory[this.cameraHistory.length - 2]!; // Previous REAL camera

    // Calculate time delta between REAL camera measurements
    const timeDelta = (recent.timestamp - previous.timestamp) / 1000; // Convert to seconds
    if (timeDelta <= 0) {
      return currentCamera; // Invalid time delta
    }

    // Calculate REAL velocity (change in REAL camera position per second)
    const realPositionVelocity = vec3.create();
    vec3.subtract(realPositionVelocity, recent.position, previous.position);
    vec3.scale(realPositionVelocity, realPositionVelocity, 1 / timeDelta);

    // Calculate REAL direction velocity
    const realDirectionVelocity = vec3.create();
    vec3.subtract(realDirectionVelocity, recent.direction, previous.direction);
    vec3.scale(realDirectionVelocity, realDirectionVelocity, 1 / timeDelta);

    // Calculate predicted time offset
    const frameTime = 1 / 60; // Assume 60 FPS for prediction
    const predictedTime = frameDelta * frameTime;

    // Predict future position using REAL velocity with conservative strength
    const predictedPosition = vec3.create();
    const motionOffset = vec3.create();
    vec3.scale(motionOffset, realPositionVelocity, predictedTime * this.PREDICTION_STRENGTH);
    vec3.add(predictedPosition, recent.position, motionOffset);

    // Predict future direction using REAL direction velocity
    const predictedDirection = vec3.create();
    const directionOffset = vec3.create();
    vec3.scale(directionOffset, realDirectionVelocity, predictedTime * this.PREDICTION_STRENGTH);
    vec3.add(predictedDirection, recent.direction, directionOffset);
    vec3.normalize(predictedDirection, predictedDirection); // Ensure unit vector

    // Create predicted camera
    const tempCamera = new Camera();

    // Calculate predicted target point (position + direction)
    const predictedTarget = vec3.create();
    vec3.add(predictedTarget, predictedPosition, predictedDirection);

    tempCamera.setNearPlane(currentCamera.getNear());
    tempCamera.setFarPlane(currentCamera.getFar());
    tempCamera.setFovRadians(currentCamera.getFov());
    tempCamera.setViewport(currentCamera.getViewport().width, currentCamera.getViewport().height);
    tempCamera.lookAt(predictedPosition, predictedTarget);
    tempCamera.updateUniforms();

    return tempCamera;
  }

  /**
   * Store culling results in cache - use current REAL camera data for validation
   */
  private storeCullingResults(
    frame: number,
    culledKeys: RenderKey[],
    _predictedCamera: Camera,
  ): void {
    // Use REAL camera data from history for cache validation, not predicted camera
    const currentCameraState = this.getCurrentCameraState();

    const entry: CullingCacheEntry = {
      frame,
      culledKeys,
      cameraPosition: vec3.clone(currentCameraState.position), // Use REAL camera position
      cameraDirection: vec3.clone(currentCameraState.direction), // Use REAL camera direction
      timestamp: Date.now(),
    };

    this.cullingCache.set(frame, entry);

    // Cleanup old entries
    this.cleanupCache();
  }

  /**
   * Update camera history for motion prediction - USE REAL CAMERA DATA ONLY
   */
  private updateCameraHistory(camera: Camera): void {
    const now = Date.now();
    const entry = {
      position: vec3.clone(camera.getPosition()), // REAL camera position
      direction: vec3.clone(camera.getFront()), // REAL camera direction
      timestamp: now,
    };

    this.cameraHistory.push(entry);

    // Keep only recent history
    while (this.cameraHistory.length > this.HISTORY_SIZE) {
      this.cameraHistory.shift();
    }

    // Periodic cleanup to prevent memory leaks
    if (this.frameNumber % 60 === 0) {
      this.cleanupCameraHistory();
    }
  }

  /**
   * Get current camera state
   */
  private getCurrentCameraState(): { position: vec3; direction: vec3 } {
    if (this.cameraHistory.length === 0) {
      return {
        position: vec3.create(),
        direction: vec3.fromValues(0, 0, -1),
      };
    }

    const recent = this.cameraHistory[this.cameraHistory.length - 1]!; // Safe because length > 0
    return {
      position: recent.position,
      direction: recent.direction,
    };
  }

  /**
   * Get most recent valid cache entry
   */
  private getMostRecentCacheEntry(): CullingCacheEntry | null {
    let mostRecent: CullingCacheEntry | null = null;
    let latestFrame = -1;

    for (const [frame, entry] of this.cullingCache) {
      if (frame > latestFrame) {
        latestFrame = frame;
        mostRecent = entry;
      }
    }

    return mostRecent;
  }

  /**
   * Cleanup old cache entries - more aggressive cleanup
   */
  private cleanupCache(): void {
    const cutoffFrame = this.frameNumber - this.CACHE_SIZE;
    const now = Date.now();
    const maxAge = 5000; // 5 seconds max age for any cache entry

    let cleanedEntries = 0;

    for (const [frame, entry] of this.cullingCache) {
      // Remove if too old by frame number OR too old by timestamp
      if (frame < cutoffFrame || now - entry.timestamp > maxAge) {
        this.cullingCache.delete(frame);
        cleanedEntries++;
      }
    }

    if (cleanedEntries > 0) {
      this.stats.totalCacheCleanups += cleanedEntries;
    }
  }

  /**
   * Cleanup old camera history - prevent memory leaks
   */
  private cleanupCameraHistory(): void {
    const now = Date.now();
    const maxAge = 2000; // 2 seconds max age for camera history
    const originalLength = this.cameraHistory.length;

    // Remove entries older than maxAge
    this.cameraHistory = this.cameraHistory.filter((entry) => now - entry.timestamp <= maxAge);

    // Also ensure we don't exceed HISTORY_SIZE (double safety)
    while (this.cameraHistory.length > this.HISTORY_SIZE) {
      this.cameraHistory.shift();
    }

    const cleanedEntries = originalLength - this.cameraHistory.length;
    if (cleanedEntries > 0) {
      this.stats.totalHistoryCleanups += cleanedEntries;
    }
  }

  /**
   * Configure temporal culling parameters
   */
  public setFrameLag(lag: number): void {
    this.FRAME_LAG = Math.max(1, Math.min(5, Math.floor(lag)));
  }

  public setPredictionStrength(strength: number): void {
    this.PREDICTION_STRENGTH = Math.max(0, Math.min(1, strength));
  }

  public getFrameLag(): number {
    return this.FRAME_LAG;
  }

  public getPredictionStrength(): number {
    return this.PREDICTION_STRENGTH;
  }

  /**
   * Get debug statistics
   */
  public getDebugStats() {
    const totalRequests = this.stats.cacheHits + this.stats.cacheMisses;
    const hitRate = totalRequests > 0 ? (this.stats.cacheHits / totalRequests) * 100 : 0;

    return {
      frameNumber: this.frameNumber,
      frameLag: this.FRAME_LAG,
      predictionStrength: this.PREDICTION_STRENGTH.toFixed(2),
      cacheSize: this.cullingCache.size,
      hitRate: hitRate.toFixed(1) + '%',
      activeCulling: this.isGPUCullingActive,
      pendingFrame: this.pendingCullingFrame,
      cameraHistorySize: this.cameraHistory.length,
      totalCacheCleanups: this.stats.totalCacheCleanups,
      totalHistoryCleanups: this.stats.totalHistoryCleanups,
    };
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.cullingCache.clear();
    this.cameraHistory = [];
    this.gpuCuller = null;
    this.isGPUCullingActive = false;
    this.pendingCullingFrame = -1;
  }
}
