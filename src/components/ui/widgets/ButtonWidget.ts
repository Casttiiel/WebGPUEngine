// src/components/ui/widgets/ButtonWidget.ts
import { Widget } from '../Widget';
import type {
  WidgetParams,
  ButtonStateConfig,
} from '../../../types/WidgetTypes';
import { ButtonState } from '../../../types/WidgetTypes';

/**
 * ButtonWidget - Interactive widget with multiple visual states.
 * Replicates C++ CButton widget with state system.
 */
export class ButtonWidget extends Widget {
  private states: Map<string, ButtonStateConfig> = new Map();
  private currentStateName: string = ButtonState.NORMAL;
  private currentState: ButtonStateConfig | null = null;

  // Callbacks for user interaction
  private onClickCallback?: () => void;
  private onHoverCallback?: () => void;
  private onPressCallback?: () => void;

  constructor(name: string, alias: string, params: WidgetParams) {
    super(name, alias, params);
  }

  protected override render(): void {
    // Rendering will be handled by UIRenderUtils in FASE 7
    // Renders current state's image and text
    if (this.currentState) {
      // UIRenderUtils.renderImage(this.getAbsolute(), this.currentState.imageParams);
      // UIRenderUtils.renderText(this.getAbsolute(), this.currentState.textParams);
    }
  }

  // ============================================================================
  // STATE MANAGEMENT
  // ============================================================================

  /**
   * Add a visual state to the button.
   */
  public addState(stateName: string, config: ButtonStateConfig): void {
    this.states.set(stateName, config);

    // Set as current if it's the first state or if it's the normal state
    if (!this.currentState || stateName === ButtonState.NORMAL) {
      this.setCurrentState(stateName);
    }
  }

  /**
   * Change the current visual state.
   */
  public setCurrentState(stateName: string): void {
    const state = this.states.get(stateName);
    if (state) {
      this.currentStateName = stateName;
      this.currentState = state;
    } else {
      console.warn(`Button state "${stateName}" not found on widget "${this.getName()}"`);
    }
  }

  public getCurrentStateName(): string {
    return this.currentStateName;
  }

  public getCurrentState(): ButtonStateConfig | null {
    return this.currentState;
  }

  public hasState(stateName: string): boolean {
    return this.states.has(stateName);
  }

  // ============================================================================
  // INTERACTION CALLBACKS
  // ============================================================================

  public setOnClick(callback: () => void): void {
    this.onClickCallback = callback;
  }

  public setOnHover(callback: () => void): void {
    this.onHoverCallback = callback;
  }

  public setOnPress(callback: () => void): void {
    this.onPressCallback = callback;
  }

  /**
   * Called by input system when button is clicked.
   */
  public triggerClick(): void {
    if (this.onClickCallback) {
      this.onClickCallback();
    }
  }

  /**
   * Called by input system when button is hovered.
   */
  public triggerHover(): void {
    if (this.onHoverCallback) {
      this.onHoverCallback();
    }

    // Auto-change to hover state if it exists
    if (this.hasState(ButtonState.HOVER)) {
      this.setCurrentState(ButtonState.HOVER);
    }
  }

  /**
   * Called by input system when button is pressed.
   */
  public triggerPress(): void {
    if (this.onPressCallback) {
      this.onPressCallback();
    }

    // Auto-change to pressed state if it exists
    if (this.hasState(ButtonState.PRESSED)) {
      this.setCurrentState(ButtonState.PRESSED);
    }
  }

  /**
   * Called by input system when button loses hover.
   */
  public triggerUnhover(): void {
    // Return to normal state
    if (this.hasState(ButtonState.NORMAL)) {
      this.setCurrentState(ButtonState.NORMAL);
    }
  }

  /**
   * Enable or disable the button.
   */
  public setEnabled(enabled: boolean): void {
    if (enabled) {
      if (this.hasState(ButtonState.NORMAL)) {
        this.setCurrentState(ButtonState.NORMAL);
      }
    } else {
      if (this.hasState(ButtonState.DISABLED)) {
        this.setCurrentState(ButtonState.DISABLED);
      }
    }
  }
}
