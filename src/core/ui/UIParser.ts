// src/core/ui/UIParser.ts
import { Widget } from '../../components/ui/Widget';
import { ImageWidget } from '../../components/ui/widgets/ImageWidget';
import { TextWidget } from '../../components/ui/widgets/TextWidget';
import { ButtonWidget } from '../../components/ui/widgets/ButtonWidget';
import { ProgressWidget } from '../../components/ui/widgets/ProgressWidget';
import { SpriteWidget } from '../../components/ui/widgets/SpriteWidget';
import { FXAnimateUV } from './effects/FXAnimateUV';
import { FXScale } from './effects/FXScale';
import { FXRotate } from './effects/FXRotate';
import { FXFade } from './effects/FXFade';
import { WidgetEffect } from './WidgetEffect';
import { ModuleUI } from '../../modules/core/ModuleUI';
import { ResourceManager } from '../engine/ResourceManager';
import {
  WidgetParams,
  ImageParams,
  TextParams,
  ButtonState,
  ButtonStateConfig,
  ProgressParams,
  EffectMode,
  createDefaultWidgetParams,
  createDefaultImageParams,
  createDefaultTextParams,
  createDefaultProgressParams,
} from '../../types/WidgetTypes';
import { vec2 } from 'gl-matrix';

/**
 * UIParser - Loads and parses UI widgets from JSON files.
 * Integrated with ResourceManager for asset loading.
 */
export class UIParser {
  // ============================================================================
  // MAIN LOADING METHODS
  // ============================================================================

  /**
   * Load multiple widgets from a JSON file containing an array.
   */
  public async loadFile(widgetsListFile: string): Promise<void> {
    const jData = await this.loadJson(widgetsListFile);

    if (Array.isArray(jData)) {
      for (const widgetFile of jData) {
        await this.loadWidget(widgetFile);
      }
    } else {
      console.warn(`UIParser.loadFile: ${widgetsListFile} is not an array`);
    }
  }

  /**
   * Load a single widget from a JSON file.
   */
  public async loadWidget(widgetFile: string): Promise<Widget | null> {
    const jData = await this.loadJson(widgetFile);
    const widget = await this.parseWidget(jData, null);

    if (widget) {
      widget.updateTransform();
      ModuleUI.getInstance()?.registerWidget(widget);
    }

    return widget;
  }

  /**
   * Load widget from file and return its name.
   */
  public async loadFileByName(file: string): Promise<string> {
    const jData = await this.loadJson(file);
    const widget = await this.parseWidget(jData, null);

    if (widget) {
      widget.updateTransform();
      ModuleUI.getInstance()?.registerWidget(widget);
      return jData['name'] || 'unnamed_widget';
    }

    return 'error_widget';
  }

  // ============================================================================
  // WIDGET PARSING
  // ============================================================================

  /**
   * Parse a widget from JSON data.
   */
  public async parseWidget(jData: any, parent: Widget | null): Promise<Widget | null> {
    if (!jData) return null;

    const alias: string = jData['alias'] || '';
    const type: string = jData['type'] || 'widget';

    let widget: Widget | null = null;

    // Factory pattern for widget creation
    switch (type) {
      case 'image':
        widget = await this.parseImage(jData);
        break;
      case 'text':
        widget = await this.parseText(jData);
        break;
      case 'button':
        widget = await this.parseButton(jData);
        break;
      case 'progress':
      case 'bar':
        widget = await this.parseProgress(jData);
        break;
      case 'sprite':
        widget = await this.parseSprite(jData);
        break;
      default:
        widget = this.parseWidgetBase(jData);
        break;
    }

    if (!widget) return null;

    // Name and alias are already set by the widget constructors

    // Set parent relationship
    if (parent) {
      widget.setParent(parent);
    }

    // Parse and add effects
    if (jData.effects && Array.isArray(jData.effects)) {
      for (const jEffectData of jData.effects) {
        const fx = this.parseEffect(jEffectData);
        if (fx) {
          fx.setOwner(widget);
          widget.addEffect(fx);
        }
      }
    }

    // Parse children recursively
    if (jData.children && Array.isArray(jData.children)) {
      for (const jChildData of jData.children) {
        await this.parseWidget(jChildData, widget);
      }
    }

    // Register alias
    if (alias) {
      ModuleUI.getInstance()?.registerAlias(widget);
    }

    return widget;
  }

  /**
   * Parse base widget parameters.
   */
  public parseWidgetBase(jData: any): Widget {
    const name = jData['name'] || 'unnamed_widget';
    const alias = jData['alias'] || '';
    const params = this.parseWidgetParams(jData);
    return new Widget(name, alias, params);
  }

  // ============================================================================
  // WIDGET TYPE PARSERS
  // ============================================================================

  /**
   * Parse ImageWidget from JSON.
   */
  private async parseImage(jData: any): Promise<ImageWidget> {
    const name = jData['name'] || 'unnamed_image';
    const alias = jData['alias'] || '';
    const params = this.parseWidgetParams(jData);

    // Support both nested imageParams and flat structure (C++ compatibility)
    // Flat: { texture: "...", size: "..." }
    // Nested: { imageParams: { texture: "...", size: "..." } }
    const imageParamsSource = jData.imageParams || jData;
    const imageParams = this.parseImageParams(imageParamsSource);

    return new ImageWidget(name, alias, params, imageParams);
  }

  /**
   * Parse TextWidget from JSON.
   */
  private async parseText(jData: any): Promise<TextWidget> {
    const name = jData['name'] || 'unnamed_text';
    const alias = jData['alias'] || '';
    const params = this.parseWidgetParams(jData);
    const textParams = this.parseTextParams(jData.textParams || {});
    return new TextWidget(name, alias, params, textParams);
  }

  /**
   * Parse ButtonWidget from JSON.
   */
  private async parseButton(jData: any): Promise<ButtonWidget> {
    const name = jData['name'] || 'unnamed_button';
    const alias = jData['alias'] || '';
    const params = this.parseWidgetParams(jData);
    const button = new ButtonWidget(name, alias, params);

    // Parse button states
    if (jData.states && typeof jData.states === 'object') {
      for (const [stateName, stateData] of Object.entries(jData.states)) {
        const stateConfig = this.parseButtonState(stateData as any);
        button.addState(stateName as ButtonState, stateConfig);
      }
    }

    // Set initial state
    if (jData.initialState) {
      button.setCurrentState(jData.initialState);
    }

    return button;
  }

  /**
   * Parse ProgressWidget from JSON.
   */
  private async parseProgress(jData: any): Promise<ProgressWidget> {
    const name = jData['name'] || 'unnamed_progress';
    const alias = jData['alias'] || '';
    const params = this.parseWidgetParams(jData);
    const imageParams = this.parseImageParams(jData.imageParams || {});
    const progressParams = this.parseProgressParams(jData.progressParams || jData.barParams || {});
    return new ProgressWidget(name, alias, params, imageParams, progressParams);
  }

  /**
   * Parse SpriteWidget from JSON.
   */
  private async parseSprite(jData: any): Promise<SpriteWidget> {
    const name = jData['name'] || 'unnamed_sprite';
    const alias = jData['alias'] || '';
    const params = this.parseWidgetParams(jData);
    const imageParams = this.parseImageParams(jData.imageParams || {});
    const sprite = new SpriteWidget(name, alias, params, imageParams);

    // Parse sprite animations
    if (jData.sprites && Array.isArray(jData.sprites)) {
      for (const spriteData of jData.sprites) {
        const config = this.parseSpriteConfig(spriteData);
        sprite.addSprite(config);
      }
    }

    // Set initial sprite
    if (jData.initialSprite) {
      sprite.setPlayingSprite(jData.initialSprite);
    }

    return sprite;
  }

  // ============================================================================
  // PARAMETER PARSERS
  // ============================================================================

  /**
   * Parse base widget parameters.
   */
  private parseWidgetParams(jData: any): WidgetParams {
    const params = createDefaultWidgetParams();

    if (jData.name) params.name = jData.name;
    if (jData.alias) params.alias = jData.alias;
    if (jData.visible !== undefined) params.visible = jData.visible;

    // Parse position - explicit position parameter
    let hasExplicitPosition = false;
    if (jData.position && Array.isArray(jData.position)) {
      params.position = { x: jData.position[0], y: jData.position[1] };
      hasExplicitPosition = true;
    }

    // Parse scale - explicit scale parameter
    if (jData.scale && Array.isArray(jData.scale)) {
      params.scale = { x: jData.scale[0], y: jData.scale[1] };
    }

    // Parse size - support both array [1920, 1080] and string "1920 1080" (C++ format)
    if (jData.size) {
      if (Array.isArray(jData.size)) {
        params.size = { x: jData.size[0], y: jData.size[1] };
      } else if (typeof jData.size === 'string') {
        const parts = jData.size.trim().split(/\s+/);
        if (parts.length >= 2) {
          params.size = { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
        }
      }

      // If no explicit scale was provided, use size as scale
      if (!jData.scale && params.size) {
        params.scale = { x: params.size.x, y: params.size.y };
      }

      // If no explicit position was provided, center the widget based on size
      // This ensures that a widget with size "1920 1080" is centered at (960, 540)
      if (!hasExplicitPosition && params.size) {
        params.position = { x: params.size.x / 2, y: params.size.y / 2 };
      }
    }

    if (jData.pivot && Array.isArray(jData.pivot)) {
      params.pivot = { x: jData.pivot[0], y: jData.pivot[1] };
    }

    if (jData.rotation !== undefined) {
      params.rotation = jData.rotation;
    }

    return params;
  }

  /**
   * Parse image parameters.
   */
  private parseImageParams(jData: any): ImageParams {
    const params = createDefaultImageParams();

    if (jData.texture) params.texture = jData.texture;

    // Parse size - support both array [1920, 1080] and string "1920 1080" (C++ format)
    if (jData.size) {
      if (Array.isArray(jData.size)) {
        params.size = { x: jData.size[0], y: jData.size[1] };
      } else if (typeof jData.size === 'string') {
        const parts = jData.size.trim().split(/\s+/);
        if (parts.length >= 2) {
          params.size = { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
        }
      }
    }

    if (jData.color && Array.isArray(jData.color)) {
      params.color = {
        r: jData.color[0],
        g: jData.color[1],
        b: jData.color[2],
        a: jData.color[3] !== undefined ? jData.color[3] : 1.0,
      };
    }

    if (jData.minUV && Array.isArray(jData.minUV)) {
      params.minUV = { x: jData.minUV[0], y: jData.minUV[1] };
    }

    if (jData.maxUV && Array.isArray(jData.maxUV)) {
      params.maxUV = { x: jData.maxUV[0], y: jData.maxUV[1] };
    }

    if (jData.additive !== undefined) {
      params.additive = jData.additive;
    }

    return params;
  }

  /**
   * Parse text parameters.
   */
  private parseTextParams(jData: any): TextParams {
    const params = createDefaultTextParams();

    if (jData.text) params.text = jData.text;
    if (jData.texture) params.texture = jData.texture;

    if (jData.size && Array.isArray(jData.size)) {
      params.size = { x: jData.size[0], y: jData.size[1] };
    }

    return params;
  }

  /**
   * Parse button state configuration.
   */
  private parseButtonState(jData: any): ButtonStateConfig {
    const stateConfig: ButtonStateConfig = {
      imageParams: this.parseImageParams(jData.imageParams || jData),
      textParams: this.parseTextParams(jData.textParams || {}),
    };

    return stateConfig;
  }

  /**
   * Parse progress bar parameters.
   */
  private parseProgressParams(jData: any): ProgressParams {
    const params = createDefaultProgressParams();

    if (jData.ratio !== undefined) params.ratio = jData.ratio;

    return params;
  }

  /**
   * Parse sprite animation configuration.
   */
  private parseSpriteConfig(jData: any): {
    texture: string;
    originalImageSize: vec2;
    frameSize: vec2;
    numFrames: number;
    framesPerSecond: number;
  } {
    return {
      texture: jData.texture || '',
      originalImageSize: vec2.fromValues(jData.sheetWidth || 1024, jData.sheetHeight || 1024),
      frameSize: vec2.fromValues(jData.frameWidth || 64, jData.frameHeight || 64),
      numFrames: jData.numFrames || 1,
      framesPerSecond: jData.fps || 12,
    };
  }

  // ============================================================================
  // EFFECT PARSERS
  // ============================================================================

  /**
   * Parse effect from JSON data.
   */
  public parseEffect(jData: any): WidgetEffect | null {
    if (!jData || !jData.type) return null;

    const type = jData.type;

    switch (type) {
      case 'animate_uv':
      case 'uv':
        return this.parseFXAnimateUV(jData);
      case 'scale':
        return this.parseFXScale(jData);
      case 'rotate':
        return this.parseFXRotate(jData);
      case 'fade':
        return this.parseFXFade(jData);
      default:
        console.warn(`UIParser: Unknown effect type: ${type}`);
        return null;
    }
  }

  /**
   * Parse FXAnimateUV effect.
   */
  private parseFXAnimateUV(jData: any): FXAnimateUV {
    const name = jData.name || 'fx_animate_uv';
    const speedU = jData.speed?.[0] || jData.speedU || 0;
    const speedV = jData.speed?.[1] || jData.speedV || 0;

    return new FXAnimateUV(name, speedU, speedV);
  }

  /**
   * Parse FXScale effect.
   */
  private parseFXScale(jData: any): FXScale {
    const name = jData.name || 'fx_scale';
    const targetScale = vec2.fromValues(jData.scale?.[0] || 1.0, jData.scale?.[1] || 1.0);
    const duration = jData.duration || 1.0;
    const mode = this.parseEffectMode(jData.mode);
    const interpolatorType = jData.interpolator || 'linear';

    return new FXScale(name, targetScale, duration, mode, interpolatorType);
  }

  /**
   * Parse FXRotate effect.
   */
  private parseFXRotate(jData: any): FXRotate {
    const name = jData.name || 'fx_rotate';
    const targetRotation = jData.rotation || 0;
    const duration = jData.duration || 1.0;
    const mode = this.parseEffectMode(jData.mode);
    const interpolatorType = jData.interpolator || 'linear';

    return new FXRotate(name, targetRotation, duration, mode, interpolatorType);
  }

  /**
   * Parse FXFade effect.
   */
  private parseFXFade(jData: any): FXFade {
    const name = jData.name || 'fx_fade';
    const targetAlpha = jData.alpha !== undefined ? jData.alpha : 1.0;
    const duration = jData.duration || 1.0;
    const mode = this.parseEffectMode(jData.mode);
    const interpolatorType = jData.interpolator || 'linear';

    return new FXFade(name, targetAlpha, duration, mode, interpolatorType);
  }

  /**
   * Parse effect mode from string.
   */
  private parseEffectMode(modeStr: string | undefined): EffectMode {
    if (!modeStr) return EffectMode.SINGLE;

    const mode = modeStr.toUpperCase();
    switch (mode) {
      case 'SINGLE':
        return EffectMode.SINGLE;
      case 'LOOP':
        return EffectMode.LOOP;
      case 'PING_PONG':
      case 'PINGPONG':
        return EffectMode.PING_PONG;
      default:
        console.warn(`UIParser: Unknown effect mode: ${modeStr}, using SINGLE`);
        return EffectMode.SINGLE;
    }
  }

  // ============================================================================
  // JSON LOADING
  // ============================================================================

  /**
   * Load and parse JSON from file using ResourceManager.
   */
  private async loadJson(path: string): Promise<any> {
    try {
      const response = await ResourceManager.fetch(`assets/ui/${path}`);
      return await response.json();
    } catch (error) {
      console.error(`UIParser: Failed to load JSON from ${path}:`, error);
      throw error;
    }
  }
}
