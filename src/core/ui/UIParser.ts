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
   * Load widget(s) from a file and return the root widget name(s).
   * Supports both single-object JSON (returns one-element array) and
   * array JSON (returns an array of names — used for multi-anchor HUD files).
   */
  public async loadFileByName(file: string): Promise<string[]> {
    const jData = await this.loadJson(file);

    if (Array.isArray(jData)) {
      // Multiple independent root widgets in one file
      const names: string[] = [];
      for (const itemData of jData) {
        const widget = await this.parseWidget(itemData, null);
        if (widget) {
          widget.updateTransform();
          ModuleUI.getInstance()?.registerWidget(widget);
          names.push(itemData['name'] || 'unnamed_widget');
        }
      }
      return names;
    }

    // Single root widget
    const widget = await this.parseWidget(jData, null);
    if (widget) {
      widget.updateTransform();
      ModuleUI.getInstance()?.registerWidget(widget);
      return [jData['name'] || 'unnamed_widget'];
    }

    return ['error_widget'];
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

    // When no explicit widget size was provided, inherit from imageParams.size.
    // This keeps hud.json / legacy JSONs working where only imageParams.size is set.
    const hasExplicitSize =
      jData.width !== undefined || jData.height !== undefined || jData.size !== undefined;
    if (!hasExplicitSize && imageParams.size.x > 0 && imageParams.size.y > 0) {
      params.width = imageParams.size.x;
      params.height = imageParams.size.y;
    }

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

    // Parse button states - support both formats:
    // 1. New format: { states: { "normal": { imageParams: {...}, textParams: {...} } } }
    // 2. Legacy format: { states: [{ name: "enabled", texture: "..." }], texture: "...", size: "..." }

    if (jData.states) {
      if (Array.isArray(jData.states)) {
        // Legacy format: states array with flat structure
        this.parseButtonStatesLegacy(jData, button);
      } else if (typeof jData.states === 'object') {
        // New format: states object with nested structure
        this.parseButtonStatesNested(jData, button);
      }
    }

    // Set initial state
    if (jData.initialState) {
      button.setCurrentState(jData.initialState);
    } else if (button.hasState('normal')) {
      button.setCurrentState('normal');
    } else if (button.hasState('enabled')) {
      button.setCurrentState('enabled');
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

    // ── Anchor ────────────────────────────────────────────────────────────
    if (jData.anchor && typeof jData.anchor === 'string') {
      params.anchor = jData.anchor;
    }

    // ── Position: new (x/y) or legacy (position array/string / offset) ────
    // New format: explicit x/y
    if (jData.x !== undefined) params.x = jData.x;
    if (jData.y !== undefined) params.y = jData.y;

    // Legacy: position: [x, y] or "x y"
    if (jData.position !== undefined && jData.x === undefined) {
      const p = this.parseVec2(jData.position);
      if (p) {
        params.x = p[0];
        params.y = p[1];
      }
    }

    // Legacy: offset: [x, y] overrides x/y when anchor is set (old anchor+offset pattern)
    if (jData.offset !== undefined && jData.x === undefined && jData.y === undefined) {
      const o = Array.isArray(jData.offset) ? jData.offset : null;
      if (o) {
        params.x = o[0] ?? 0;
        params.y = o[1] ?? 0;
      }
    }

    // ── Size: new (width/height) or legacy (size array/string) ───────────
    if (jData.width !== undefined) params.width = jData.width;
    if (jData.height !== undefined) params.height = jData.height;

    // Legacy: size: [w, h] or "w h"
    if (jData.size !== undefined && jData.width === undefined) {
      const s = this.parseVec2(jData.size);
      if (s) {
        params.width = s[0];
        params.height = s[1];
      }
    }

    // ── Pivot ─────────────────────────────────────────────────────────────
    // New format: pivotX/pivotY (0–1 fractions)
    if (jData.pivotX !== undefined) params.pivotX = jData.pivotX;
    if (jData.pivotY !== undefined) params.pivotY = jData.pivotY;

    // Legacy: pivot: [x, y] (old fractional pivot or pixel-based ignored)
    if (jData.pivot && Array.isArray(jData.pivot) && jData.pivotX === undefined) {
      params.pivotX = jData.pivot[0] ?? 0;
      params.pivotY = jData.pivot[1] ?? 0;
    }

    // ── Other ─────────────────────────────────────────────────────────────
    if (jData.rotation !== undefined) params.rotation = jData.rotation;
    if (jData.scaleWithScreen !== undefined) params.scaleWithScreen = jData.scaleWithScreen;

    return params;
  }

  /** Parse a vec2 from [x, y] array or "x y" string. Returns null on failure. */
  private parseVec2(value: any): [number, number] | null {
    if (Array.isArray(value) && value.length >= 2) {
      const a = value[0] as string | number;
      const b = value[1] as string | number;
      return [parseFloat(String(a)), parseFloat(String(b))];
    }
    if (typeof value === 'string') {
      const parts = value.trim().split(/\s+/);
      const p0 = parts[0] ?? '';
      const p1 = parts[1] ?? '';
      if (p0 && p1) return [parseFloat(p0), parseFloat(p1)];
    }
    return null;
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
   * Parse button states in new nested format.
   * Example: { states: { "normal": { imageParams: {...}, textParams: {...} } } }
   */
  private parseButtonStatesNested(jData: any, button: ButtonWidget): void {
    for (const [stateName, stateData] of Object.entries(jData.states)) {
      const stateConfig = this.parseButtonState(stateData as any);
      button.addState(stateName as ButtonState, stateConfig);
    }
  }

  /**
   * Parse button states in legacy flat format.
   * Example: { states: [{ name: "enabled", texture: "..." }], texture: "...", size: "..." }
   */
  private parseButtonStatesLegacy(jData: any, button: ButtonWidget): void {
    // Extract base button properties for all states
    const baseTexture = jData.texture || '';
    const baseSize = jData.size || '100 100';
    const fontTexture = jData.font_texture || 'ui/fonts/font.png';
    const fontSize = jData.font_size || '16 16';
    const buttonText = jData.text || jData.name?.toUpperCase() || 'BUTTON';

    for (const stateData of jData.states) {
      const stateName = stateData.name || 'normal';
      const stateTexture = stateData.texture || baseTexture;

      // Create imageParams from flat structure
      const imageParams = this.parseImageParams({
        texture: stateTexture,
        size: baseSize,
        color: stateData.color || [1, 1, 1, 1],
        additive: stateData.additive || false,
        minUV: stateData.minUV || [0, 0],
        maxUV: stateData.maxUV || [1, 1],
      });

      // Create textParams for button text
      const textParams = this.parseTextParams({
        text: stateData.text || buttonText,
        texture: stateData.font_texture || fontTexture,
        size: stateData.font_size || fontSize,
      });

      const stateConfig: ButtonStateConfig = {
        imageParams,
        textParams,
      };

      // Map legacy state names to standard names
      let standardStateName = stateName;
      if (stateName === 'enabled') standardStateName = 'normal';
      if (stateName === 'selected') standardStateName = 'hover';

      button.addState(standardStateName as ButtonState, stateConfig);
    }
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
