// src/core/ui/controllers/CarouselController.ts
import { WidgetController } from '../WidgetController';
import { Widget } from '../../../components/ui/Widget';
import { Engine } from '../../engine/Engine';

/**
 * CarouselController - Manages carousel/slideshow navigation.
 *
 * Features:
 * - Left/right navigation
 * - Automatic slide transitions
 * - Callback system for slide changes
 * - Loop control
 */
export class CarouselController extends WidgetController {
  // ============================================================================
  // STATE
  // ============================================================================

  private slides: Widget[] = [];
  private currentSlide: number = 0;
  private autoAdvance: boolean = false;
  private autoAdvanceTime: number = 3.0; // seconds
  private timeSinceLastAdvance: number = 0;
  private loop: boolean = true;

  // Callbacks
  private onSlideChange: ((index: number) => void) | null = null;

  // ============================================================================
  // CONFIGURATION
  // ============================================================================

  /**
   * Add a slide widget to the carousel.
   */
  public addSlide(slide: Widget): void {
    this.slides.push(slide);

    // Hide all slides except the current one
    if (this.slides.length > 1) {
      slide.setActive(false);
    }
  }

  /**
   * Set current slide by index.
   */
  public setCurrentSlide(index: number): void {
    if (index < 0 || index >= this.slides.length) return;

    // Deactivate current slide
    if (this.currentSlide >= 0 && this.currentSlide < this.slides.length) {
      this.slides[this.currentSlide].setActive(false);
    }

    // Activate new slide
    this.currentSlide = index;
    this.slides[this.currentSlide].setActive(true);

    // Reset auto-advance timer
    this.timeSinceLastAdvance = 0;

    // Trigger callback
    if (this.onSlideChange) {
      this.onSlideChange(this.currentSlide);
    }
  }

  /**
   * Enable/disable automatic slide advancement.
   */
  public setAutoAdvance(enabled: boolean, intervalSeconds: number = 3.0): void {
    this.autoAdvance = enabled;
    this.autoAdvanceTime = intervalSeconds;
    this.timeSinceLastAdvance = 0;
  }

  /**
   * Enable/disable looping.
   */
  public setLoop(loop: boolean): void {
    this.loop = loop;
  }

  /**
   * Set callback for slide changes.
   */
  public setOnSlideChange(callback: (index: number) => void): void {
    this.onSlideChange = callback;
  }

  // ============================================================================
  // NAVIGATION
  // ============================================================================

  /**
   * Go to next slide.
   */
  public nextSlide(): void {
    if (this.slides.length === 0) return;

    let nextIndex = this.currentSlide + 1;

    if (nextIndex >= this.slides.length) {
      nextIndex = this.loop ? 0 : this.slides.length - 1;
    }

    this.setCurrentSlide(nextIndex);
  }

  /**
   * Go to previous slide.
   */
  public previousSlide(): void {
    if (this.slides.length === 0) return;

    let prevIndex = this.currentSlide - 1;

    if (prevIndex < 0) {
      prevIndex = this.loop ? this.slides.length - 1 : 0;
    }

    this.setCurrentSlide(prevIndex);
  }

  // ============================================================================
  // UPDATE
  // ============================================================================

  public update(dt: number): void {
    if (this.slides.length === 0) return;

    // Get input module
    const input = Engine.getInput();
    if (!input) return;

    // ============================================================================
    // KEYBOARD NAVIGATION
    // ============================================================================

    if (input.isKeyPressed('ArrowRight') || input.isKeyPressed('KeyD')) {
      this.nextSlide();
    }

    if (input.isKeyPressed('ArrowLeft') || input.isKeyPressed('KeyA')) {
      this.previousSlide();
    }

    // ============================================================================
    // AUTO-ADVANCE
    // ============================================================================

    if (this.autoAdvance) {
      this.timeSinceLastAdvance += dt;

      if (this.timeSinceLastAdvance >= this.autoAdvanceTime) {
        this.nextSlide();
        this.timeSinceLastAdvance = 0;
      }
    }
  }

  // ============================================================================
  // GETTERS
  // ============================================================================

  public getCurrentSlide(): number {
    return this.currentSlide;
  }

  public getSlidesCount(): number {
    return this.slides.length;
  }

  public getSlide(index: number): Widget | null {
    if (index >= 0 && index < this.slides.length) {
      return this.slides[index];
    }
    return null;
  }
}
