/**
 * Shared wind state for the entire scene.
 * Central source of truth consumed by:
 *   - Procedural sky cloud UV animation (Skybox.ts)
 *   - Froxel volumetric density noise (FroxelVolumetricScattering.ts)
 */
export class Wind {
  /** Wind speed in sky-UV units / second. Also scales froxel world-space noise. */
  public static speed: number = 0.08;

  /** Wind direction in degrees (0° = +X axis, 90° = +Z axis). */
  public static dirAngle: number = 35.0;

  /** Normalized wind direction X component (world XZ plane). */
  public static getDirX(): number {
    return Math.cos((Wind.dirAngle * Math.PI) / 180.0);
  }

  /** Normalized wind direction Z component (world XZ plane). */
  public static getDirZ(): number {
    return Math.sin((Wind.dirAngle * Math.PI) / 180.0);
  }
}
