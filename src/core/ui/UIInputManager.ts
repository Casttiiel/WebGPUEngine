// src/core/ui/UIInputManager.ts
import { vec2 } from 'gl-matrix';
import type { Widget } from '../../components/ui/Widget';

/**
 * UIInputManager - Centralizes input detection for UI widgets.
 * Handles coordinate conversion, AABB collision, hover tracking, and click detection.
 *
 * Features:
 * - Converts window coordinates to UI space
 * - AABB collision detection for widget bounds
 * - Hover tracking with enter/leave events
 * - Click detection on widgets
 */
export class UIInputManager {
  private lastHoveredWidget: Widget | null = null;
  private lastMousePos: vec2 = vec2.create();

  /**
   * Convert window coordinates to UI space coordinates.
   *
   * UI space coordinates:
   * - Origin at top-left (0, 0)
   * - X: 0 to aspectRatio
   * - Y: 0 to 1.0
   *
   * @param windowX Mouse X in window coordinates
   * @param windowY Mouse Y in window coordinates
   * @param width Window width in pixels
   * @param height Window height in pixels
   * @returns vec2 with UI space coordinates
   */
  public windowToUISpace(windowX: number, windowY: number, width: number, height: number): vec2 {
    const aspectRatio = width / height;
    const uiX = (windowX / width) * aspectRatio;
    const uiY = windowY / height;
    return vec2.fromValues(uiX, uiY);
  }

  /**
   * AABB collision detection in 2D.
   * Checks if a point is inside a rectangle defined by center and half-extents.
   *
   * @param point Point to test (UI space)
   * @param center Center of the rectangle (UI space)
   * @param size Size of the rectangle (width, height)
   * @returns true if point is inside rectangle
   */
  public pointInRectangle(point: vec2, center: vec2, size: vec2): boolean {
    const halfWidth = size[0] * 0.5;
    const halfHeight = size[1] * 0.5;

    return (
      point[0] >= center[0] - halfWidth &&
      point[0] <= center[0] + halfWidth &&
      point[1] >= center[1] - halfHeight &&
      point[1] <= center[1] + halfHeight
    );
  }

  /**
   * Extract world position from widget's absolute transformation matrix.
   * The absolute matrix contains the final world position after hierarchy transforms.
   *
   * @param widget Widget to extract position from
   * @returns vec2 with world position (X, Y from matrix translation)
   */
  public getWidgetWorldPosition(widget: Widget): vec2 {
    const absolute = widget.getAbsolute();
    // Extract translation from mat4: elements [12] and [13] are X and Y translation
    return vec2.fromValues(absolute[12], absolute[13]);
  }

  /**
   * Check if mouse is hovering over a widget.
   * Combines world position, size, and AABB detection.
   *
   * @param widget Widget to test
   * @param mouseUIPos Mouse position in UI space
   * @returns true if mouse is over widget
   */
  public checkHover(widget: Widget, mouseUIPos: vec2): boolean {
    // Get widget's world position from its absolute transform
    const worldPos = this.getWidgetWorldPosition(widget);

    // Get widget size
    const size = widget.getSize();

    // AABB collision test
    return this.pointInRectangle(mouseUIPos, worldPos, size);
  }

  /**
   * Process input for all active widgets.
   * Detects hover changes and click events.
   *
   * @param activeWidgets Array of widgets to test (should be sorted by Z-order)
   * @param mouseUIPos Current mouse position in UI space
   * @param isMouseClicked True if mouse was clicked this frame
   */
  public processInput(activeWidgets: Widget[], mouseUIPos: vec2, isMouseClicked: boolean): void {
    let hoveredWidget: Widget | null = null;

    // Find first widget under cursor (respects Z-order if sorted)
    for (const widget of activeWidgets) {
      if (this.checkHover(widget, mouseUIPos)) {
        hoveredWidget = widget;
        break; // First widget wins (topmost in Z-order)
      }
    }

    // Handle hover state changes
    if (hoveredWidget !== this.lastHoveredWidget) {
      // Mouse left previous widget
      if (this.lastHoveredWidget) {
        this.lastHoveredWidget.onMouseLeave?.();
      }

      // Mouse entered new widget
      if (hoveredWidget) {
        hoveredWidget.onMouseEnter?.();
      }

      this.lastHoveredWidget = hoveredWidget;
    }

    // Handle click events
    if (isMouseClicked && hoveredWidget) {
      hoveredWidget.onClick?.();
    }

    // Update last mouse position
    vec2.copy(this.lastMousePos, mouseUIPos);
  }

  /**
   * Reset input state (call when UI is disabled or scene changes).
   */
  public reset(): void {
    if (this.lastHoveredWidget) {
      this.lastHoveredWidget.onMouseLeave?.();
      this.lastHoveredWidget = null;
    }
    vec2.set(this.lastMousePos, 0, 0);
  }

  /**
   * Get the currently hovered widget (if any).
   */
  public getHoveredWidget(): Widget | null {
    return this.lastHoveredWidget;
  }

  /**
   * Get last mouse position in UI space.
   */
  public getLastMousePosition(): vec2 {
    return this.lastMousePos;
  }
}
