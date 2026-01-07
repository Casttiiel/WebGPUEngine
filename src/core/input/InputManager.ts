import { GameAction } from '../../types/GameAction.enum';
import { KeyCode } from '../../types/KeyCode.enum';
import { MouseButton } from '../../types/MouseButton.enum';
import {
  InputBinding,
  InputType,
  ControlMappingConfig,
  DEFAULT_CONTROL_MAPPING,
} from '../../types/ControlMapping.type';
import { InputBuffer } from './InputBuffer';

/**
 * InputManager - Gestor centralizado de control mapping e input buffering
 *
 * Características:
 * - Control Mapping: Mapea acciones abstractas del juego a inputs físicos
 * - Input Buffering: Permite registrar inputs antes de que puedan procesarse
 * - Configuración persistente: Soporta guardar/cargar configuraciones
 * - Múltiples bindings: Una acción puede tener múltiples teclas asignadas
 */
export class InputManager {
  private static instance: InputManager;

  private controlMapping: ControlMappingConfig;
  private inputBuffer: InputBuffer;

  // Estados de input (deben ser actualizados por ModuleInput)
  private currentKeys: Map<KeyCode, boolean> = new Map();
  private previousKeys: Map<KeyCode, boolean> = new Map();
  private currentMouseButtons: Map<MouseButton, boolean> = new Map();
  private previousMouseButtons: Map<MouseButton, boolean> = new Map();
  private mouseDelta: { x: number; y: number } = { x: 0, y: 0 };

  private constructor() {
    this.controlMapping = { ...DEFAULT_CONTROL_MAPPING };
    this.inputBuffer = new InputBuffer(250); // 150ms buffer window
  }

  public static getInstance(): InputManager {
    if (!InputManager.instance) {
      InputManager.instance = new InputManager();
    }
    return InputManager.instance;
  }

  /**
   * Actualiza el estado de inputs (debe llamarse cada frame)
   */
  public update(): void {
    // Actualizar el buffer (elimina entradas expiradas)
    this.inputBuffer.update();

    // Detectar acciones "just pressed" y añadirlas al buffer automáticamente
    this.autoBufferJustPressedActions();
  }

  /**
   * Debe llamarse al INICIO del frame para copiar currentKeys a previousKeys
   */
  public beginFrame(): void {
    this.previousKeys = new Map(this.currentKeys);
    this.previousMouseButtons = new Map(this.currentMouseButtons);
  }

  /**
   * Detecta automáticamente acciones "just pressed" y las añade al buffer
   */
  private autoBufferJustPressedActions(): void {
    for (const actionName in this.controlMapping) {
      const action = actionName as GameAction;

      // Solo bufferear si la acción fue "just pressed"
      if (this.isActionJustPressed(action)) {
        this.inputBuffer.bufferAction(action);
      }
    }
  }

  /**
   * Actualiza el estado de las teclas (llamado por ModuleInput)
   */
  public updateKeyState(key: KeyCode, pressed: boolean): void {
    this.currentKeys.set(key, pressed);
  }

  /**
   * Actualiza el estado de los botones del mouse (llamado por ModuleInput)
   */
  public updateMouseButtonState(button: MouseButton, pressed: boolean): void {
    this.currentMouseButtons.set(button, pressed);
  }

  /**
   * Actualiza el delta del mouse (llamado por ModuleInput)
   */
  public updateMouseDelta(delta: { x: number; y: number }): void {
    this.mouseDelta = delta;
  }

  // ==================== CONTROL MAPPING ====================

  /**
   * Verifica si una acción está actualmente presionada
   */
  public isActionPressed(action: GameAction): boolean {
    const bindings = this.getBindingsForAction(action);

    for (const binding of bindings) {
      if (this.isBindingPressed(binding)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Verifica si una acción fue presionada este frame
   */
  public isActionJustPressed(action: GameAction): boolean {
    const bindings = this.getBindingsForAction(action);

    for (const binding of bindings) {
      if (this.isBindingJustPressed(binding)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Obtiene el valor de una acción (útil para ejes/analógicos)
   * @returns Valor entre -1 y 1 para ejes, 0 o 1 para botones
   */
  public getActionValue(action: GameAction): number {
    const bindings = this.getBindingsForAction(action);

    for (const binding of bindings) {
      const value = this.getBindingValue(binding);
      if (Math.abs(value) > 0.01) {
        return value;
      }
    }

    return 0;
  }

  // ==================== INPUT BUFFER ====================

  /**
   * Verifica si una acción está buffereada
   */
  public isActionBuffered(action: GameAction): boolean {
    return this.inputBuffer.isActionBuffered(action);
  }

  /**
   * Consume una acción del buffer
   * Útil cuando quieres procesar un input buffereado y eliminarlo
   */
  public consumeBufferedAction(action: GameAction): boolean {
    return this.inputBuffer.consumeAction(action);
  }

  /**
   * Buffearea manualmente una acción
   * (normalmente se hace automáticamente, pero puede ser útil en algunos casos)
   */
  public bufferAction(action: GameAction): void {
    this.inputBuffer.bufferAction(action);
  }

  /**
   * Limpia el buffer de inputs
   */
  public clearBuffer(): void {
    this.inputBuffer.clear();
  }

  /**
   * Obtiene/establece la ventana de buffer en milisegundos
   */
  public getBufferWindow(): number {
    return this.inputBuffer.getBufferWindow();
  }

  public setBufferWindow(ms: number): void {
    this.inputBuffer.setBufferWindow(ms);
  }

  // ==================== CONFIGURACIÓN ====================

  /**
   * Mapea una acción a un binding
   */
  public mapAction(action: GameAction, binding: InputBinding): void {
    this.controlMapping[action] = binding;
  }

  /**
   * Añade un binding adicional a una acción (múltiples teclas para la misma acción)
   */
  public addBinding(action: GameAction, binding: InputBinding): void {
    const current = this.controlMapping[action];

    if (!current) {
      this.controlMapping[action] = binding;
    } else if (Array.isArray(current)) {
      current.push(binding);
    } else {
      this.controlMapping[action] = [current, binding];
    }
  }

  /**
   * Elimina todos los bindings de una acción
   */
  public clearAction(action: GameAction): void {
    delete this.controlMapping[action];
  }

  /**
   * Resetea el control mapping a los valores por defecto
   */
  public resetToDefaults(): void {
    this.controlMapping = { ...DEFAULT_CONTROL_MAPPING };
  }

  /**
   * Obtiene la configuración actual
   */
  public getConfig(): ControlMappingConfig {
    return { ...this.controlMapping };
  }

  /**
   * Carga una configuración
   */
  public loadConfig(config: ControlMappingConfig): void {
    this.controlMapping = { ...config };
  }

  /**
   * Guarda la configuración en localStorage
   */
  public saveConfig(): void {
    try {
      localStorage.setItem('inputConfig', JSON.stringify(this.controlMapping));
    } catch (error) {
      console.warn('Failed to save input config:', error);
    }
  }

  /**
   * Carga la configuración desde localStorage
   */
  public loadConfigFromStorage(): boolean {
    try {
      const stored = localStorage.getItem('inputConfig');
      if (stored) {
        this.controlMapping = JSON.parse(stored);
        return true;
      }
    } catch (error) {
      console.warn('Failed to load input config:', error);
    }
    return false;
  }

  // ==================== HELPERS PRIVADOS ====================

  private getBindingsForAction(action: GameAction): InputBinding[] {
    const binding = this.controlMapping[action];
    if (!binding) return [];

    return Array.isArray(binding) ? binding : [binding];
  }

  private isBindingPressed(binding: InputBinding): boolean {
    switch (binding.type) {
      case InputType.KEYBOARD:
        return this.currentKeys.get(binding.key!) || false;

      case InputType.MOUSE_BUTTON:
        return this.currentMouseButtons.get(binding.button!) || false;

      case InputType.MOUSE_AXIS:
        // Para ejes, consideramos "presionado" si el valor absoluto es significativo
        return Math.abs(this.getBindingValue(binding)) > 0.01;

      default:
        return false;
    }
  }

  private isBindingJustPressed(binding: InputBinding): boolean {
    switch (binding.type) {
      case InputType.KEYBOARD:
        const currentKey = this.currentKeys.get(binding.key!) || false;
        const previousKey = this.previousKeys.get(binding.key!) || false;
        return currentKey && !previousKey;

      case InputType.MOUSE_BUTTON:
        const currentButton = this.currentMouseButtons.get(binding.button!) || false;
        const previousButton = this.previousMouseButtons.get(binding.button!) || false;
        return currentButton && !previousButton;

      case InputType.MOUSE_AXIS:
        // Los ejes no tienen "just pressed"
        return false;

      default:
        return false;
    }
  }

  private getBindingValue(binding: InputBinding): number {
    switch (binding.type) {
      case InputType.KEYBOARD:
        return this.currentKeys.get(binding.key!) || false ? 1.0 : 0.0;

      case InputType.MOUSE_BUTTON:
        return this.currentMouseButtons.get(binding.button!) || false ? 1.0 : 0.0;

      case InputType.MOUSE_AXIS:
        const scale = binding.scale || 1.0;
        if (binding.axis === 'x') {
          return this.mouseDelta.x * scale;
        } else if (binding.axis === 'y') {
          return this.mouseDelta.y * scale;
        }
        return 0.0;

      default:
        return 0.0;
    }
  }
}
