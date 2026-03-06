// types/ui/WidgetTypes.ts

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
 * Base widget parameters — reference-space (1920×1080) coordinates.
 *
 * - `x, y`          — top-left corner of the element in the 1920×1080 reference canvas.
 *                    With `anchor`, this is the offset from that screen edge.
 * - `width, height` — element size in the reference canvas.
 * - `pivotX/Y`      — 0–1 fraction, only affects rotation/scale centre, NOT position.
 * - `anchor`        — only on root widgets; ties the element to a screen edge.
 * - `scaleWithScreen` — if false, the element keeps a fixed physical-pixel size (icon use-case).
 */
export interface WidgetParams {
  x: number;
  y: number;
  width: number;
  height: number;
  pivotX: number;
  pivotY: number;
  rotation: number;
  scaleWithScreen: boolean;
  anchor?: string;
  visible: boolean;
  // widget name / alias
  name?: string;
  alias?: string;
  [key: string]: any;
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
  name: string; // Primary widget name (first in the array, or the sole widget)
  names?: string[]; // All widget names when a class maps to multiple root widgets
  type: string; // Widget type identifier
  widget?: Widget;
  controller?: WidgetController;
  enabled: boolean; // Whether this widget class is currently active
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
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    pivotX: 0,
    pivotY: 0,
    rotation: 0,
    scaleWithScreen: true,
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
