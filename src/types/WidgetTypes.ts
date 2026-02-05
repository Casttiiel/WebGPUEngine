// types/ui/WidgetTypes.ts
import { vec2, vec4 } from 'gl-matrix';

// ============================================================================
// FORWARD DECLARATIONS
// ============================================================================

export interface WidgetController {
  update(dt: number): void;
}

export interface WidgetEffect {
  start(): void;
  stop(): void;
  update(dt: number): void;
  onDeactivate?(): void;
  getName(): string;
  changeSpeedUV?(x: number, y: number): void;
  stopUiFx?(): void;
}

// Widget will be imported from components/ui/Widget
export type Widget = any;

// ============================================================================
// CORE WIDGET PARAMETERS (from C++/DirectX11 TParams)
// ============================================================================

/**
 * Base widget transformation parameters.
 * Replicates C++ TParams structure.
 */
export interface WidgetParams {
  pivot: { x: number; y: number };
  position: { x: number; y: number };
  scale: { x: number; y: number };
  rotation: number;
  visible: boolean;
  [key: string]: any; // Allow additional properties
}

/**
 * Image/Sprite widget parameters.
 * Replicates C++ TImageParams structure.
 */
export interface ImageParams {
  texture: string | null; // Texture path
  size: { x: number; y: number }; // Widget size in UI coordinates
  additive: boolean; // Additive blending mode (for glow effects)
  color: { r: number; g: number; b: number; a: number }; // RGBA tint color
  minUV: { x: number; y: number }; // UV min coordinates (for sprite sheets)
  maxUV: { x: number; y: number }; // UV max coordinates (for sprite sheets)
}

/**
 * Text widget parameters.
 * Replicates C++ TTextParams structure.
 */
export interface TextParams {
  text: string; // Text content
  texture: string | null; // Bitmap font texture path
  size: { x: number; y: number }; // Text size in UI coordinates
}

/**
 * Progress bar parameters.
 * Replicates C++ TProgressParams structure.
 */
export interface ProgressParams {
  ratio: number; // Progress ratio (0.0 to 1.0)
  // varName could be added for dynamic binding to game variables
}

/**
 * Bar widget parameters (identical to ProgressParams).
 * Replicates C++ TBarParams structure.
 * Note: Bar and Progress are essentially the same in the original.
 */
export interface BarParams {
  ratio: number; // Bar fill ratio (0.0 to 1.0)
  // value could be added for direct value display
}

// ============================================================================
// BUTTON WIDGET TYPES
// ============================================================================

/**
 * Button state names (normal, hover, pressed, disabled).
 */
export enum ButtonState {
  NORMAL = 'normal',
  HOVER = 'hover',
  PRESSED = 'pressed',
  DISABLED = 'disabled',
}

/**
 * Button state configuration.
 * Each state has its own visual appearance (image + text).
 */
export interface ButtonStateConfig {
  imageParams: ImageParams;
  textParams: TextParams;
}

/**
 * Button states map (state name -> configuration).
 */
export type ButtonStatesMap = Map<string, ButtonStateConfig>;

// ============================================================================
// SPRITE ANIMATION TYPES
// ============================================================================

/**
 * Sprite frame configuration for frame-by-frame animation.
 */
export interface SpriteFrame {
  minUV: { x: number; y: number }; // UV coordinates for this frame
  maxUV: { x: number; y: number };
  duration: number; // Frame duration in seconds
}

/**
 * Sprite animation configuration.
 */
export interface SpriteAnimationParams {
  texture: string | null;
  size: { x: number; y: number };
  frames: SpriteFrame[]; // Frame sequence
  fps: number; // Frames per second (if uniform timing)
  loop: boolean; // Loop animation
  autoPlay: boolean; // Start playing automatically
}

// ============================================================================
// UI SYSTEM TYPES
// ============================================================================

/**
 * Widget class registration (for ModuleUI).
 */
export interface WidgetClass {
  name: string; // Widget class name (from JSON)
  type: string; // Widget type identifier
  widget?: Widget;
  controller?: WidgetController;
}

/**
 * Lerp/Tween data for smooth value transitions.
 * Used by ModuleUI lerp manager.
 */
export interface WidgetToLerp {
  element: { value: number }; // Target object with value property
  maxElement: number; // Maximum value
  value: number; // Target value
  initialTime: number; // Start time
  lerpTime: number; // Duration
  currentTime: number; // Current elapsed time
  isFirstFrame: boolean; // First frame flag
}

// ============================================================================
// EFFECT PARAMETERS
// ============================================================================

/**
 * Effect mode enumeration.
 */
export enum EffectMode {
  SINGLE = 'single', // Play once
  LOOP = 'loop', // Loop continuously
  PING_PONG = 'pingpong', // Play forward then backward
}

/**
 * Scale effect parameters.
 */
export interface FXScaleParams {
  scale: { x: number; y: number }; // Target scale
  duration: number; // Animation duration
  mode: EffectMode; // Animation mode
  interpolator: string; // Interpolator type name
}

/**
 * Animate UV effect parameters.
 */
export interface FXAnimateUVParams {
  speedU: number; // UV scroll speed on U axis
  speedV: number; // UV scroll speed on V axis
  mode: EffectMode;
}

/**
 * Fade effect parameters.
 */
export interface FXFadeParams {
  targetAlpha: number; // Target alpha value (0.0 to 1.0)
  duration: number;
  mode: EffectMode;
  interpolator: string;
}

/**
 * Rotate effect parameters.
 */
export interface FXRotateParams {
  targetRotation: number; // Target rotation in radians
  duration: number;
  mode: EffectMode;
  interpolator: string;
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

/**
 * Helper to create default WidgetParams.
 */
export function createDefaultWidgetParams(): WidgetParams {
  return {
    pivot: { x: 0, y: 0 },
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    visible: true,
  };
}

/**
 * Helper to create default ImageParams.
 */
export function createDefaultImageParams(): ImageParams {
  return {
    texture: null,
    size: { x: 1, y: 1 },
    additive: false,
    color: { r: 1, g: 1, b: 1, a: 1 },
    minUV: { x: 0, y: 0 },
    maxUV: { x: 1, y: 1 },
  };
}

/**
 * Helper to create default TextParams.
 */
export function createDefaultTextParams(): TextParams {
  return {
    text: '',
    texture: null,
    size: { x: 1, y: 1 },
  };
}

/**
 * Helper to create default ProgressParams.
 */
export function createDefaultProgressParams(): ProgressParams {
  return {
    ratio: 1.0,
  };
}
