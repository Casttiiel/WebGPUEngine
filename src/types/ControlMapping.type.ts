import { KeyCode } from './KeyCode.enum';
import { MouseButton } from './MouseButton.enum';

/**
 * Tipo de input que puede ser mapeado a una acción
 */
export enum InputType {
  KEYBOARD = 'keyboard',
  MOUSE_BUTTON = 'mouse_button',
  MOUSE_AXIS = 'mouse_axis',
}

/**
 * Definición de un binding de input
 */
export interface InputBinding {
  type: InputType;
  key?: KeyCode; // Para keyboard
  button?: MouseButton; // Para mouse buttons
  axis?: 'x' | 'y' | 'wheel'; // Para mouse axes
  scale?: number; // Para axes (default 1.0)
}

/**
 * Configuración de control mapping
 * Mapea acciones del juego a inputs físicos
 */
export interface ControlMappingConfig {
  [action: string]: InputBinding | InputBinding[]; // Permite múltiples bindings por acción
}

/**
 * Configuración por defecto del control mapping
 */
export const DEFAULT_CONTROL_MAPPING: ControlMappingConfig = {
  // Movement
  move_forward: { type: InputType.KEYBOARD, key: KeyCode.W },
  move_backward: { type: InputType.KEYBOARD, key: KeyCode.S },
  move_left: { type: InputType.KEYBOARD, key: KeyCode.A },
  move_right: { type: InputType.KEYBOARD, key: KeyCode.D },

  // Actions
  jump: { type: InputType.KEYBOARD, key: KeyCode.SPACE },
  slide: { type: InputType.KEYBOARD, key: KeyCode.SHIFT },
  dive: { type: InputType.KEYBOARD, key: KeyCode.CTRL },

  // Combat
  fire: { type: InputType.MOUSE_BUTTON, button: MouseButton.LEFT },
  aim: { type: InputType.MOUSE_BUTTON, button: MouseButton.RIGHT },
  reload: { type: InputType.KEYBOARD, key: KeyCode.NUM_1 }, // Temporal
  melee: { type: InputType.KEYBOARD, key: KeyCode.NUM_2 }, // Temporal

  // Interaction
  interact: { type: InputType.KEYBOARD, key: KeyCode.E },
  use: { type: InputType.KEYBOARD, key: KeyCode.NUM_3 }, // Temporal

  // Camera (mouse axes)
  look_up: { type: InputType.MOUSE_AXIS, axis: 'y', scale: -1.0 },
  look_down: { type: InputType.MOUSE_AXIS, axis: 'y', scale: 1.0 },
  look_left: { type: InputType.MOUSE_AXIS, axis: 'x', scale: -1.0 },
  look_right: { type: InputType.MOUSE_AXIS, axis: 'x', scale: 1.0 },

  // UI
  pause: { type: InputType.KEYBOARD, key: KeyCode.P },
  inventory: { type: InputType.KEYBOARD, key: KeyCode.TAB },
};
