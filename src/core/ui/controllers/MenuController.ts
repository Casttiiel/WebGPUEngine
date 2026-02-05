// src/core/ui/controllers/MenuController.ts
import { vec2 } from 'gl-matrix';
import { WidgetController } from '../WidgetController';
import { ButtonWidget } from '../../../components/ui/widgets/ButtonWidget';
import { Engine } from '../../engine/Engine';

/**
 * MenuOption - Represents a menu button with its callback.
 */
interface MenuOption {
  button: ButtonWidget;
  callback: () => void;
}

/**
 * MenuController - Manages menu navigation and selection.
 * Replicates C++ CMenuController.
 *
 * Features:
 * - Keyboard navigation (up/down/confirm)
 * - Mouse hover detection
 * - Button state management (enabled/selected)
 * - Callback system for menu actions
 */
export class MenuController extends WidgetController {
  // ============================================================================
  // STATE
  // ============================================================================

  private options: MenuOption[] = [];
  private currentOption: number = 0;
  private lastMousePos: vec2 = vec2.fromValues(-1, -1);

  // ============================================================================
  // CONFIGURATION
  // ============================================================================

  /**
   * Register a menu option with button and callback.
   */
  public registerOption(button: ButtonWidget, callback: () => void): void {
    if (!button) {
      console.error('MenuController.registerOption: button is null or undefined');
      return;
    }
    this.options.push({ button, callback });

    // If this is the first option, make it selected
    if (this.options.length === 1) {
      this.setCurrentOption(0);
    }
  }

  /**
   * Register option by button name (searches in ModuleUI).
   */
  public registerOptionByName(buttonName: string, callback: () => void): void {
    // This will be implemented once ModuleUI exists
    console.warn(
      `MenuController.registerOptionByName: ModuleUI not yet implemented for "${buttonName}"`,
    );
  }

  /**
   * Set current selected option by index.
   */
  public setCurrentOption(idx: number): void {
    // Clamp index to valid range
    this.currentOption = Math.max(0, Math.min(idx, this.options.length - 1));

    // Reset all buttons to enabled state
    for (const option of this.options) {
      option.button.setCurrentState('NORMAL');
    }

    // Set current button to selected state
    if (this.currentOption >= 0 && this.currentOption < this.options.length) {
      this.options[this.currentOption].button.setCurrentState('HOVER');
    }
  }

  // ============================================================================
  // UPDATE
  // ============================================================================

  public update(dt: number): void {
    if (this.options.length === 0) return;

    // Get input module
    const input = Engine.getInput();
    if (!input) return;

    // ============================================================================
    // MOUSE HANDLING
    // ============================================================================

    const mousePos = input.getMousePosition();
    const mouseVec = vec2.fromValues(mousePos.x, mousePos.y);

    // Check if mouse moved
    const mouseMoved = !vec2.equals(mouseVec, this.lastMousePos);
    if (mouseMoved) {
      vec2.copy(this.lastMousePos, mouseVec);

      // Check which button is under mouse
      const touchedButton = this.getButtonAtPosition(mouseVec);
      if (touchedButton !== -1) {
        this.setCurrentOption(touchedButton);
      }
    }

    // ============================================================================
    // KEYBOARD NAVIGATION
    // ============================================================================

    // Check for navigation keys (using standard key codes)
    if (input.isKeyPressed('ArrowDown') || input.isKeyPressed('KeyS')) {
      this.setCurrentOption(this.currentOption + 1);
    }

    if (input.isKeyPressed('ArrowUp') || input.isKeyPressed('KeyW')) {
      this.setCurrentOption(this.currentOption - 1);
    }

    // ============================================================================
    // CONFIRMATION (Keyboard or Mouse)
    // ============================================================================

    const confirmPressed = input.isKeyPressed('Enter') || input.isKeyPressed('Space');

    if (confirmPressed) {
      if (this.currentOption >= 0 && this.currentOption < this.options.length) {
        // Trigger callback
        this.options[this.currentOption].callback();
      }
    }

    // Handle mouse click separately with justPressed check
    if (input.isMouseButtonPressed('LEFT')) {
      const clickedButton = this.getButtonAtPosition(mouseVec);
      if (clickedButton !== -1) {
        this.setCurrentOption(clickedButton);
        this.options[clickedButton].callback();
      }
    }
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  /**
   * Find which button is at the given screen position.
   * Returns button index or -1 if none found.
   */
  private getButtonAtPosition(mousePos: vec2): number {
    for (let i = 0; i < this.options.length; i++) {
      const button = this.options[i].button;

      // Get button bounds from absolute transform
      if (this.isPointInButton(mousePos, button)) {
        return i;
      }
    }

    return -1;
  }

  /**
   * Check if point is inside button bounds.
   */
  private isPointInButton(point: vec2, button: ButtonWidget): boolean {
    if (!button) return false;

    // Get button transform
    const transform = button.getAbsoluteTransform();
    if (!transform) return false;

    const size = button.getSize();
    if (!size || size[0] === 0 || size[1] === 0) return false;

    // Extract position from transform (elements 12, 13 are X, Y translation)
    const buttonX = transform[12];
    const buttonY = transform[13];

    // Check if point is inside rectangle
    const minX = buttonX - size[0] / 2;
    const maxX = buttonX + size[0] / 2;
    const minY = buttonY - size[1] / 2;
    const maxY = buttonY + size[1] / 2;

    return point[0] >= minX && point[0] <= maxX && point[1] >= minY && point[1] <= maxY;
  }

  // ============================================================================
  // GETTERS
  // ============================================================================

  public getCurrentOption(): number {
    return this.currentOption;
  }

  public getOptionsCount(): number {
    return this.options.length;
  }

  public getOption(index: number): MenuOption | null {
    if (index >= 0 && index < this.options.length) {
      return this.options[index];
    }
    return null;
  }
}
