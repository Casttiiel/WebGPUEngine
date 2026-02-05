// src/core/ui/WidgetController.ts

/**
 * WidgetController - Base class for UI controllers.
 * Replicates C++ CController architecture.
 *
 * Controllers manage widget behavior and user interaction logic.
 */
export abstract class WidgetController {
  protected name: string = '';

  constructor(name: string) {
    this.name = name;
  }

  // ============================================================================
  // LIFECYCLE METHODS
  // ============================================================================

  /**
   * Called every frame to update controller logic.
   */
  public abstract update(dt: number): void;

  // ============================================================================
  // GETTERS
  // ============================================================================

  public getName(): string {
    return this.name;
  }

  public setName(name: string): void {
    this.name = name;
  }
}
