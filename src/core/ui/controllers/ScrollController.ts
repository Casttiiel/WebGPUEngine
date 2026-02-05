// src/core/ui/controllers/ScrollController.ts
import { vec2 } from 'gl-matrix';
import { WidgetController } from '../WidgetController';
import { Widget } from '../../../components/ui/Widget';
import { Engine } from '../../engine/Engine';

/**
 * ScrollController - Manages scrollable content areas.
 *
 * Features:
 * - Mouse wheel scrolling
 * - Keyboard scrolling (arrow keys)
 * - Scroll bounds clamping
 * - Smooth scrolling with interpolation
 */
export class ScrollController extends WidgetController {
  // ============================================================================
  // STATE
  // ============================================================================

  private container: Widget | null = null;
  private content: Widget | null = null;

  private scrollOffset: number = 0;
  private targetScrollOffset: number = 0;
  private scrollSpeed: number = 50.0; // pixels per second
  private smoothScrolling: boolean = true;
  private smoothSpeed: number = 5.0; // interpolation speed

  // Bounds
  private minScroll: number = 0;
  private maxScroll: number = 0;

  // ============================================================================
  // CONFIGURATION
  // ============================================================================

  /**
   * Set container and content widgets.
   * Container defines visible area, content is what scrolls.
   */
  public setWidgets(container: Widget, content: Widget): void {
    this.container = container;
    this.content = content;
    this.updateScrollBounds();
  }

  /**
   * Set scroll speed in pixels per second.
   */
  public setScrollSpeed(speed: number): void {
    this.scrollSpeed = speed;
  }

  /**
   * Enable/disable smooth scrolling.
   */
  public setSmoothScrolling(enabled: boolean, speed: number = 5.0): void {
    this.smoothScrolling = enabled;
    this.smoothSpeed = speed;
  }

  /**
   * Update scroll bounds based on container and content sizes.
   */
  public updateScrollBounds(): void {
    if (!this.container || !this.content) return;

    const containerSize = this.container.getSize();
    const contentSize = this.content.getSize();

    // Max scroll is when content bottom aligns with container bottom
    this.maxScroll = Math.max(0, contentSize[1] - containerSize[1]);
    this.minScroll = 0;

    // Clamp current scroll
    this.scrollOffset = Math.max(this.minScroll, Math.min(this.scrollOffset, this.maxScroll));
    this.targetScrollOffset = this.scrollOffset;
  }

  // ============================================================================
  // SCROLLING
  // ============================================================================

  /**
   * Scroll by delta amount (positive = down, negative = up).
   */
  public scroll(delta: number): void {
    this.targetScrollOffset += delta;
    this.targetScrollOffset = Math.max(
      this.minScroll,
      Math.min(this.targetScrollOffset, this.maxScroll),
    );

    if (!this.smoothScrolling) {
      this.scrollOffset = this.targetScrollOffset;
      this.applyScroll();
    }
  }

  /**
   * Set scroll position directly.
   */
  public setScrollPosition(position: number): void {
    this.targetScrollOffset = Math.max(this.minScroll, Math.min(position, this.maxScroll));

    if (!this.smoothScrolling) {
      this.scrollOffset = this.targetScrollOffset;
      this.applyScroll();
    }
  }

  /**
   * Scroll to top.
   */
  public scrollToTop(): void {
    this.setScrollPosition(this.minScroll);
  }

  /**
   * Scroll to bottom.
   */
  public scrollToBottom(): void {
    this.setScrollPosition(this.maxScroll);
  }

  /**
   * Apply current scroll offset to content widget.
   */
  private applyScroll(): void {
    if (!this.content) return;

    // Update content position based on scroll offset
    const currentPos = this.content.getPosition();
    this.content.setPosition(currentPos[0], -this.scrollOffset);
    this.content.updateTransform();
  }

  // ============================================================================
  // UPDATE
  // ============================================================================

  public update(dt: number): void {
    if (!this.container || !this.content) return;

    // Get input module
    const input = Engine.getInput();
    if (!input) return;

    // ============================================================================
    // MOUSE WHEEL SCROLLING
    // ============================================================================

    const wheelDelta = input.getMouseWheelDelta();
    if (wheelDelta !== 0) {
      // Scroll by wheel delta (multiply by scroll speed for sensitivity)
      this.scroll(wheelDelta * this.scrollSpeed * 0.1);
    }

    // ============================================================================
    // KEYBOARD SCROLLING
    // ============================================================================

    if (input.isKeyDown('ArrowDown') || input.isKeyDown('KeyS')) {
      this.scroll(this.scrollSpeed * dt);
    }

    if (input.isKeyDown('ArrowUp') || input.isKeyDown('KeyW')) {
      this.scroll(-this.scrollSpeed * dt);
    }

    if (input.isKeyPressed('Home')) {
      this.scrollToTop();
    }

    if (input.isKeyPressed('End')) {
      this.scrollToBottom();
    }

    // ============================================================================
    // SMOOTH SCROLLING INTERPOLATION
    // ============================================================================

    if (this.smoothScrolling) {
      const diff = this.targetScrollOffset - this.scrollOffset;

      if (Math.abs(diff) > 0.1) {
        this.scrollOffset += diff * this.smoothSpeed * dt;
        this.applyScroll();
      } else {
        this.scrollOffset = this.targetScrollOffset;
      }
    }
  }

  // ============================================================================
  // GETTERS
  // ============================================================================

  public getScrollOffset(): number {
    return this.scrollOffset;
  }

  public getScrollProgress(): number {
    if (this.maxScroll === 0) return 0;
    return this.scrollOffset / this.maxScroll;
  }

  public getMaxScroll(): number {
    return this.maxScroll;
  }
}
