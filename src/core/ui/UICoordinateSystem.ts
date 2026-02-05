// src/core/ui/UICoordinateSystem.ts
import { mat4, vec2 } from 'gl-matrix';

/**
 * UICoordinateSystem - Centralizes UI coordinate conversions.
 *
 * ⚠️ UI COORDINATE SYSTEM (TOP-LEFT ORIGIN):
 * - Origin: Top-left (0, 0)
 * - X-axis: 0 → aspectRatio (e.g., 1.777 for 16:9)
 * - Y-axis: 0 → 1.0 (normalized vertically)
 * - NOT a centered system like traditional OpenGL
 *
 * Examples for 1920x1080 (aspectRatio = 1.777):
 * - Top-left corner: [0, 0]
 * - Center: [0.888, 0.5] (aspectRatio/2, 0.5)
 * - Bottom-right: [1.777, 1.0]
 */
export class UICoordinateSystem {
  private static aspectRatio: number = 16 / 9;

  /**
   * Update aspect ratio when window resizes.
   */
  public static setAspectRatio(width: number, height: number): void {
    this.aspectRatio = width / height;
  }

  public static getAspectRatio(): number {
    return this.aspectRatio;
  }

  /**
   * Convert window pixel coordinates to UI normalized coordinates.
   * @param windowX - X coordinate in pixels (0 to width)
   * @param windowY - Y coordinate in pixels (0 to height)
   * @param width - Window width in pixels
   * @param height - Window height in pixels
   * @returns UI coordinates [0→aspectRatio, 0→1.0]
   */
  public static windowToUI(windowX: number, windowY: number, width: number, height: number): vec2 {
    const aspectRatio = width / height;
    const uiX = (windowX / width) * aspectRatio;
    const uiY = windowY / height;
    return vec2.fromValues(uiX, uiY);
  }

  /**
   * Convert UI normalized coordinates to NDC (Normalized Device Coordinates).
   * Used for WebGPU rendering.
   * @param uiX - UI X coordinate (0 to aspectRatio)
   * @param uiY - UI Y coordinate (0 to 1.0)
   * @returns NDC coordinates [-1→1, -1→1] for WebGPU
   */
  public static uiToNDC(uiX: number, uiY: number): vec2 {
    const aspectRatio = this.aspectRatio;

    // Convert UI to NDC:
    // UI X: [0, aspectRatio] → NDC X: [-1, 1]
    // UI Y: [0, 1.0] → NDC Y: [1, -1] (inverted for top-left origin)
    const ndcX = (uiX / aspectRatio) * 2.0 - 1.0;
    const ndcY = 1.0 - uiY * 2.0; // Invert Y axis

    return vec2.fromValues(ndcX, ndcY);
  }

  /**
   * Get orthographic projection matrix for UI rendering.
   * Creates a projection that maps UI coordinates directly to screen.
   * @param width - Window width in pixels
   * @param height - Window height in pixels
   * @returns mat4 orthographic projection matrix
   */
  public static getProjectionMatrix(width: number, height: number): mat4 {
    const aspectRatio = width / height;
    const orthoMatrix = mat4.create();

    // Orthographic projection for UI:
    // Left: 0, Right: aspectRatio
    // Bottom: 1.0, Top: 0 (inverted Y for top-left origin)
    // Near: -1, Far: 1
    mat4.ortho(
      orthoMatrix,
      0.0, // left
      aspectRatio, // right (e.g., 1.777)
      1.0, // bottom (Y inverted)
      0.0, // top
      -1.0, // near
      1.0, // far
    );

    return orthoMatrix;
  }

  /**
   * Convert NDC coordinates back to UI coordinates.
   * Useful for debugging and mouse picking.
   */
  public static ndcToUI(ndcX: number, ndcY: number): vec2 {
    const aspectRatio = this.aspectRatio;

    // NDC X: [-1, 1] → UI X: [0, aspectRatio]
    // NDC Y: [1, -1] → UI Y: [0, 1.0]
    const uiX = ((ndcX + 1.0) / 2.0) * aspectRatio;
    const uiY = (1.0 - ndcY) / 2.0;

    return vec2.fromValues(uiX, uiY);
  }

  /**
   * Get UI bounds for current aspect ratio.
   * Useful for boundary checks and clamping.
   */
  public static getBounds(): { minX: number; maxX: number; minY: number; maxY: number } {
    return {
      minX: 0,
      maxX: this.aspectRatio,
      minY: 0,
      maxY: 1.0,
    };
  }

  /**
   * Clamp UI coordinates to valid bounds.
   */
  public static clampToUI(x: number, y: number): vec2 {
    const bounds = this.getBounds();
    const clampedX = Math.max(bounds.minX, Math.min(bounds.maxX, x));
    const clampedY = Math.max(bounds.minY, Math.min(bounds.maxY, y));
    return vec2.fromValues(clampedX, clampedY);
  }

  /**
   * Check if UI coordinates are within valid bounds.
   */
  public static isInBounds(x: number, y: number): boolean {
    const bounds = this.getBounds();
    return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
  }
}
