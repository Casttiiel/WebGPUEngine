// src/core/ui/WidgetEffect.ts
import type { Widget } from '../../components/ui/Widget';

/**
 * WidgetEffect - Base class for UI visual effects.
 * Effects modify widget properties over time (scale, UV, rotation, etc.).
 */
export abstract class WidgetEffect {
  protected owner: Widget | null = null;
  protected name: string = '';

  constructor(name: string) {
    this.name = name;
  }

  // ============================================================================
  // LIFECYCLE METHODS
  // ============================================================================

  /**
   * Called when effect is activated.
   */
  public start(): void {
    // Override in subclasses if needed
  }

  /**
   * Called when effect is deactivated.
   */
  public stop(): void {
    // Override in subclasses if needed
  }

  /**
   * Called every frame to update effect.
   */
  public abstract update(dt: number): void;

  /**
   * Called when widget is deactivated.
   */
  public onDeactivate(): void {
    // Override in subclasses if needed
  }

  // ============================================================================
  // OWNER MANAGEMENT
  // ============================================================================

  public setOwner(owner: Widget): void {
    this.owner = owner;
  }

  public getOwner(): Widget | null {
    return this.owner;
  }

  public getName(): string {
    return this.name;
  }

  public setName(name: string): void {
    this.name = name;
  }

  // ============================================================================
  // OPTIONAL METHODS (implemented by specific effects)
  // ============================================================================

  /**
   * Stop UI effect immediately.
   */
  public stopUiFx(): void {
    // Override in subclasses if needed
  }

  /**
   * Change UV animation speed (for FXAnimateUV).
   */
  public changeSpeedUV(_x: number, _y: number): void {
    // Override in FXAnimateUV
  }

  /**
   * Change effect duration (for time-based effects).
   */
  public changeDuration(_duration: number): void {
    // Override in subclasses if needed
  }

  /**
   * Set target scale (for FXScale).
   */
  public setScale(_x: number, _y: number): void {
    // Override in FXScale
  }

  /**
   * Set initial scale (for FXScale).
   */
  public setInitialScale(_x: number, _y: number): void {
    // Override in FXScale
  }

  /**
   * Set effect time (for seeking).
   */
  public setTime(_time: number): void {
    // Override in subclasses if needed
  }

  /**
   * Set min UV (for FXAnimateUV).
   */
  public setMinUV(_u: number, _v: number): void {
    // Override in FXAnimateUV
  }

  /**
   * Set max UV (for FXAnimateUV).
   */
  public setMaxUV(_u: number, _v: number): void {
    // Override in FXAnimateUV
  }
}
