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
  dash: { type: InputType.KEYBOARD, key: KeyCode.SHIFT },
  roll: { type: InputType.KEYBOARD, key: KeyCode.SHIFT },
  attack: { type: InputType.MOUSE_BUTTON, button: MouseButton.LEFT },
  light_attack: { type: InputType.MOUSE_BUTTON, button: MouseButton.LEFT },
  fire: { type: InputType.MOUSE_BUTTON, button: MouseButton.RIGHT },
  kick: { type: InputType.KEYBOARD, key: KeyCode.F },

  // Alchemist powers
  ability_primary:   { type: InputType.MOUSE_BUTTON, button: MouseButton.RIGHT },
  ability_secondary: { type: InputType.KEYBOARD,     key: KeyCode.Q },
  power_next:        { type: InputType.KEYBOARD,     key: KeyCode.TAB },

  // UI
  pause: { type: InputType.KEYBOARD, key: KeyCode.P },
};
