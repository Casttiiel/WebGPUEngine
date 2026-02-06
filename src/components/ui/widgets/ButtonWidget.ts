// src/components/ui/widgets/ButtonWidget.ts
import { Widget } from '../Widget';
import { vec2, vec4 } from 'gl-matrix';
import type { WidgetParams, ButtonStateConfig } from '../../../types/WidgetTypes';
import { ButtonState } from '../../../types/WidgetTypes';
import { UIRenderUtils } from '../../../renderer/core/UIRenderUtils';
import { Texture } from '../../../renderer/resources/Texture';

/**
 * ButtonWidget - Interactive widget with multiple visual states.
 * Supports multiple states (normal, hover, pressed, disabled) with smooth transitions.
 */
export class ButtonWidget extends Widget {
  private states: Map<string, ButtonStateConfig> = new Map();
  private currentStateName: string = ButtonState.NORMAL;
  private currentState: ButtonStateConfig | null = null;

  // Texture caching for current state
  private cachedImageTexture: Texture | null = null;
  private cachedImageTexturePath: string | null = null;
  private cachedFontTexture: Texture | null = null;
  private cachedFontTexturePath: string | null = null;

  // Callbacks for user interaction
  private onClickCallback?: () => void;
  private onHoverCallback?: () => void;
  private onPressCallback?: () => void;

  constructor(name: string, alias: string, params: WidgetParams) {
    super(name, alias, params);

    // Set up input callbacks to trigger button state changes
    this.onMouseEnter = () => this.triggerHover();
    this.onMouseLeave = () => this.triggerUnhover();
    this.onClick = () => this.triggerClick();
  }

  protected override render(renderPass: GPURenderPassEncoder): void {
    console.log(`[ButtonWidget] Rendering: ${this.name}`);
    const absTransform = this.getAbsolute();
    const pos = [absTransform[12], absTransform[13]];
    const scaleX = Math.sqrt(absTransform[0] * absTransform[0] + absTransform[1] * absTransform[1]);
    const scaleY = Math.sqrt(absTransform[4] * absTransform[4] + absTransform[5] * absTransform[5]);
    console.log(
      `  Position: [${pos[0].toFixed(0)}, ${pos[1].toFixed(0)}], Scale: [${scaleX.toFixed(0)}, ${scaleY.toFixed(0)}]`,
    );
    if (!this.currentState) return;

    // Render the button's background image
    this.renderButtonImage(renderPass);

    // Render the button's text (if font texture is available)
    this.renderButtonText(renderPass);
  }

  /**
   * Render the button's background image for the current state.
   */
  private renderButtonImage(renderPass: GPURenderPassEncoder): void {
    if (!this.currentState?.imageParams?.texture) {
      console.warn(`⚠️ Button "${this.getName()}" has no texture in current state`);
      return;
    }

    const imageParams = this.currentState.imageParams;

    // Check if image texture needs to be loaded/reloaded
    if (this.cachedImageTexturePath !== imageParams.texture) {
      this.cachedImageTexturePath = imageParams.texture;
      this.cachedImageTexture = null;

      // Load texture asynchronously only when texture path changes
      Texture.getAsync(imageParams.texture!)
        .then((texture) => {
          this.cachedImageTexture = texture;
        })
        .catch((error) => {
          console.error(`❌ Failed to load button image texture: ${imageParams.texture}`, error);
        });
    }

    // Only render if texture is loaded
    if (!this.cachedImageTexture) {
      return;
    }

    // Convert color to tint vec4
    const color = imageParams.color;
    const tint = vec4.fromValues(color.r, color.g, color.b, color.a);

    // Convert UV to vec2
    const minUV = vec2.fromValues(imageParams.minUV.x, imageParams.minUV.y);
    const maxUV = vec2.fromValues(imageParams.maxUV.x, imageParams.maxUV.y);

    // Render using UIRenderUtils
    // If widget has anchor, use local transform (absolute positioning)
    // Otherwise use absolute transform (relative to parent hierarchy)
    const transform = this.hasAnchor() ? this.getLocal() : this.getAbsolute();
    UIRenderUtils.renderBitmap(
      renderPass,
      this.cachedImageTexture,
      transform,
      tint,
      minUV,
      maxUV,
      imageParams.additive, // Additive blending mode
    );
  }

  /**
   * Render the button's text for the current state.
   * Note: Text rendering is not fully implemented in UIRenderUtils yet.
   */
  private renderButtonText(_renderPass: GPURenderPassEncoder): void {
    if (!this.currentState?.textParams?.texture || !this.currentState?.textParams?.text) return;

    const textParams = this.currentState.textParams;

    // Check if font texture needs to be loaded/reloaded
    if (this.cachedFontTexturePath !== textParams.texture) {
      this.cachedFontTexturePath = textParams.texture;
      this.cachedFontTexture = null;

      // Load font texture asynchronously
      Texture.getAsync(textParams.texture!)
        .then((texture) => {
          this.cachedFontTexture = texture;
        })
        .catch((error) => {
          console.error(`❌ Failed to load button font texture: ${textParams.texture}`, error);
        });
    }

    // Only proceed if font texture is loaded
    if (!this.cachedFontTexture) return;

    // TODO: Implement proper text rendering once UIRenderUtils.renderText is complete
    // For now, this is a placeholder that loads the font texture but doesn't render text
    //
    // When UIRenderUtils.renderText is implemented, use:
    // const position = vec2.fromValues(0, 0); // Center text on button
    // const scale = Math.min(textParams.size.x, textParams.size.y) / 32; // Scale based on text size
    // const tint = vec4.fromValues(textParams.color.r, textParams.color.g, textParams.color.b, textParams.color.a);
    // UIRenderUtils.renderText(renderPass, textParams.text, this.cachedFontTexture, position, scale, tint);
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

      // Clear cached textures when state changes to force reload if needed
      this.invalidateTextureCache();
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

  public override setOnClick(callback: () => void): void {
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

  // ============================================================================
  // TEXTURE CACHE MANAGEMENT
  // ============================================================================

  /**
   * Clear cached textures to force reload.
   * Called when state changes or widget is disposed.
   */
  private invalidateTextureCache(): void {
    // Don't destroy textures as they may be shared - just clear references
    this.cachedImageTexture = null;
    this.cachedImageTexturePath = null;
    this.cachedFontTexture = null;
    this.cachedFontTexturePath = null;
  }

  /**
   * Clean up resources when widget is destroyed.
   */
  public dispose(): void {
    this.invalidateTextureCache();
    this.states.clear();
    this.currentState = null;
    this.onClickCallback = undefined as any;
    this.onHoverCallback = undefined as any;
    this.onPressCallback = undefined as any;
  }
}
