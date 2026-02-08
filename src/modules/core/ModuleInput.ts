import { Module } from '../core/Module';
import { KeyCode } from '../../types/KeyCode.enum';
import { MouseButton } from '../../types/MouseButton.enum';
import { Render } from '../../renderer/core/pipeline/Render';
import { InputManager } from '../../core/input/InputManager';
import { GameAction } from '../../types/GameAction.enum';
import { ControlMappingConfig, InputBinding } from '../../types/ControlMapping.type';
import { Engine } from '../../core/engine/Engine';

export class ModuleInput extends Module {
  private mousePosition: { x: number; y: number } = { x: 0, y: 0 }; // Para UI (no usado en cámaras)
  private mouseMovement: { x: number; y: number } = { x: 0, y: 0 }; // Acumula movimiento durante el frame
  private mouseMovementConsumed: { x: number; y: number } = { x: 0, y: 0 }; // Último delta consumido
  private mouseButtons: Map<MouseButton, boolean> = new Map();
  private mouseButtonsLastFrame: Map<MouseButton, boolean> = new Map();
  private keys: Map<KeyCode, boolean> = new Map();
  private keysLastFrame: Map<KeyCode, boolean> = new Map();
  private mouseWheelDelta: number = 0;

  // Mouse smoothing (exponential filter)
  private mouseSmoothing: boolean = true;
  private mouseSmoothFactor: number = 0.01; // 0-1 (menor = más suave, 1 = sin smoothing)
  private smoothedMouseDelta: { x: number; y: number } = { x: 0, y: 0 };

  // Pointer Lock support
  private pointerLockEnabled: boolean = true;
  private pointerLockActive: boolean = false;
  private lastGamestate: string = '';

  // Valores observables para Tweakpane
  private debugValues = {
    mouseLeft: { name: 'Mouse Left', value: false },
    mouseRight: { name: 'Mouse Right', value: false },
    keyW: { name: 'Key W', value: false },
    keyA: { name: 'Key A', value: false },
    keyS: { name: 'Key S', value: false },
    keyD: { name: 'Key D', value: false },
    mouseDeltaX: { name: 'Mouse Delta X', value: 0 },
    mouseDeltaY: { name: 'Mouse Delta Y', value: 0 },
    mouseWheel: { name: 'Mouse Wheel', value: 0 },
  };

  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    const canvas = Render.getInstance().getCanvas();
    canvas.addEventListener('contextmenu', this.handleContextMenu);

    window.addEventListener('mousemove', this.handleMouseMove.bind(this));
    window.addEventListener('mousedown', this.handleMouseDown.bind(this));
    window.addEventListener('mouseup', this.handleMouseUp.bind(this));
    window.addEventListener('wheel', this.handleMouseWheel.bind(this), { passive: false });
    window.addEventListener('keydown', this.handleKeyDown.bind(this), { passive: false });
    window.addEventListener('keyup', this.handleKeyUp.bind(this), { passive: false });

    // Pointer Lock setup
    document.addEventListener('pointerlockchange', this.handlePointerLockChange.bind(this));

    // Click listener para activar pointer lock (solo si está habilitado Y en modo gameplay)
    canvas.addEventListener('click', () => {
      const currentGamestate = Engine.getModules().getCurrentGamestate();
      const isEditorMode = currentGamestate === 'gs_editor';

      if (this.pointerLockEnabled && !this.pointerLockActive && !isEditorMode) {
        canvas.requestPointerLock();
      }
    });

    return true;
  }

  public override stop(): void {
    const canvas = Render.getInstance().getCanvas();
    canvas.removeEventListener('contextmenu', this.handleContextMenu);

    window.removeEventListener('mousemove', this.handleMouseMove.bind(this));
    window.removeEventListener('mousedown', this.handleMouseDown.bind(this));
    window.removeEventListener('mouseup', this.handleMouseUp.bind(this));
    window.removeEventListener('wheel', this.handleMouseWheel.bind(this));
    window.removeEventListener('keydown', this.handleKeyDown.bind(this));
    window.removeEventListener('keyup', this.handleKeyUp.bind(this));

    // Cleanup Pointer Lock
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange.bind(this));
    if (this.pointerLockActive) {
      document.exitPointerLock();
    }
  }

  private handleMouseMove(event: MouseEvent): void {
    const currentGamestate = Engine.getModules().getCurrentGamestate();
    const isEditorMode = currentGamestate === 'gs_editor';

    // En modo editor, procesar siempre. En gameplay, solo si hay pointer lock
    if (!isEditorMode && !this.pointerLockActive) return;

    // Acumular movimiento durante el frame (puede haber múltiples eventos por frame)
    this.mouseMovement.x += event.movementX;
    this.mouseMovement.y += event.movementY;

    // También trackear posición absoluta para UI (si se necesita)
    this.mousePosition = { x: event.clientX, y: event.clientY };
  }

  private handleMouseDown(event: MouseEvent): void {
    const currentGamestate = Engine.getModules().getCurrentGamestate();
    const isEditorMode = currentGamestate === 'gs_editor';

    // En modo editor, procesar siempre. En gameplay, permitir LEFT para activar lock
    if (!isEditorMode && !this.pointerLockActive && event.button !== MouseButton.LEFT) return;

    this.mouseButtons.set(event.button as MouseButton, true);
  }

  private handleMouseUp(event: MouseEvent): void {
    const currentGamestate = Engine.getModules().getCurrentGamestate();
    const isEditorMode = currentGamestate === 'gs_editor';

    // En modo editor, procesar siempre. En gameplay, permitir LEFT para activar lock
    if (!isEditorMode && !this.pointerLockActive && event.button !== MouseButton.LEFT) return;

    this.mouseButtons.set(event.button as MouseButton, false);
  }

  private handleMouseWheel(event: WheelEvent): void {
    const currentGamestate = Engine.getModules().getCurrentGamestate();
    const isEditorMode = currentGamestate === 'gs_editor';

    // En modo editor, procesar siempre. En gameplay, solo si hay pointer lock
    if (!isEditorMode && !this.pointerLockActive) return;

    event.preventDefault(); // Prevenir scroll del navegador
    this.mouseWheelDelta = event.deltaY;
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const currentGamestate = Engine.getModules().getCurrentGamestate();
    const isEditorMode = currentGamestate === 'gs_editor';

    // En modo editor, procesar siempre. En gameplay, solo si hay pointer lock
    if (!isEditorMode && !this.pointerLockActive) return;

    event.preventDefault();
    event.stopPropagation();
    const key = event.code.toLowerCase() as KeyCode;
    this.keys.set(key, true);
  }

  private handleKeyUp(event: KeyboardEvent): void {
    const currentGamestate = Engine.getModules().getCurrentGamestate();
    const isEditorMode = currentGamestate === 'gs_editor';

    // En modo editor, procesar siempre. En gameplay, solo si hay pointer lock
    if (!isEditorMode && !this.pointerLockActive) return;

    event.preventDefault();
    event.stopPropagation();
    const key = event.code.toLowerCase() as KeyCode;
    this.keys.set(key, false);
  }

  private handleContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  private handlePointerLockChange(): void {
    const canvas = Render.getInstance().getCanvas();
    this.pointerLockActive = document.pointerLockElement === canvas;

    if (this.pointerLockActive) {
      console.log('Pointer Lock ACTIVADO (ESC para salir)');
    } else {
      console.log('Pointer Lock DESACTIVADO');
      // Reset movement cuando se desactiva
      this.mouseMovement = { x: 0, y: 0 };
    }
  }

  public update(): void {
    // 0. Detectar cambio de gamestate y liberar pointer lock si entramos en modo editor
    const currentGamestate = Engine.getModules().getCurrentGamestate();
    if (currentGamestate !== this.lastGamestate) {
      this.lastGamestate = currentGamestate;
      // Si cambiamos a modo editor, liberar pointer lock
      if (currentGamestate === 'gs_editor' && this.pointerLockActive) {
        document.exitPointerLock();
        console.log('🔓 Pointer lock released (entering editor mode)');
      } else if (currentGamestate === 'gs_gameplay' && !this.pointerLockActive) {
        const canvas = Render.getInstance().getCanvas();
        canvas.requestPointerLock();
        console.log('🔓 Pointer lock locked (entering gameplay mode)');
      }
    }

    // 1. Copiar currentKeys a previousKeys al inicio del frame
    const inputManager = InputManager.getInstance();
    inputManager.beginFrame();

    // 1. Aplicar smoothing al mouse delta (exponential filter)
    let finalMouseDelta = this.mouseMovement;
    if (this.mouseSmoothing && this.mouseSmoothFactor > 0.001) {
      this.smoothedMouseDelta.x =
        this.smoothedMouseDelta.x * (1 - this.mouseSmoothFactor) +
        this.mouseMovement.x * this.mouseSmoothFactor;
      this.smoothedMouseDelta.y =
        this.smoothedMouseDelta.y * (1 - this.mouseSmoothFactor) +
        this.mouseMovement.y * this.mouseSmoothFactor;
      finalMouseDelta = this.smoothedMouseDelta;
    }

    // 2. Sincronizar estados actuales con InputManager
    for (const [key, pressed] of this.keys.entries()) {
      inputManager.updateKeyState(key, pressed);
    }
    for (const [button, pressed] of this.mouseButtons.entries()) {
      inputManager.updateMouseButtonState(button, pressed);
    }
    inputManager.updateMouseDelta(finalMouseDelta);

    // 3. Actualizar InputManager (procesa buffer, pero ya NO copia current->previous)
    inputManager.update();

    // 4. Copiar estado actual a lastFrame (para métodos locales tipo isKeyJustPressed)
    this.keysLastFrame = new Map(this.keys);
    this.mouseButtonsLastFrame = new Map(this.mouseButtons);

    // 5. Capturar el delta acumulado del frame ANTES de resetearlo (raw, antes de smoothing)
    this.mouseMovementConsumed.x = this.mouseMovement.x;
    this.mouseMovementConsumed.y = this.mouseMovement.y;

    // 6. Actualizar valores de debug (mostrar delta suavizado)
    this.debugValues.mouseDeltaX.value = finalMouseDelta.x;
    this.debugValues.mouseDeltaY.value = finalMouseDelta.y;
    this.debugValues.mouseWheel.value = this.mouseWheelDelta;

    // 7. Actualizar valores para Tweakpane
    this.debugValues.mouseLeft.value = this.isMouseButtonPressed(MouseButton.LEFT);
    this.debugValues.mouseRight.value = this.isMouseButtonPressed(MouseButton.RIGHT);
    this.debugValues.keyW.value = this.isKeyPressed(KeyCode.W);
    this.debugValues.keyA.value = this.isKeyPressed(KeyCode.A);
    this.debugValues.keyS.value = this.isKeyPressed(KeyCode.S);
    this.debugValues.keyD.value = this.isKeyPressed(KeyCode.D);

    // 8. Reset per-frame values AL FINAL del update (después de que todos los módulos lo hayan consumido)
    this.mouseWheelDelta = 0;
    this.mouseMovement = { x: 0, y: 0 };
  }

  public renderDebug(): void {
    // No visual debug needed
  }

  public override renderInMenu(): void {}

  // Utility methods for other modules
  public isMouseButtonPressed(button: MouseButton): boolean {
    return this.mouseButtons.get(button) || false;
  }

  public isMouseButtonJustPressed(button: MouseButton): boolean {
    return (
      (this.mouseButtons.get(button) || false) && !(this.mouseButtonsLastFrame.get(button) || false)
    );
  }

  public isMouseButtonJustReleased(button: MouseButton): boolean {
    return (
      !(this.mouseButtons.get(button) || false) && (this.mouseButtonsLastFrame.get(button) || false)
    );
  }

  public isKeyPressed(key: KeyCode): boolean {
    return this.keys.get(key) || false;
  }

  public isKeyJustPressed(key: KeyCode): boolean {
    return (this.keys.get(key) || false) && !(this.keysLastFrame.get(key) || false);
  }

  public getMousePosition(): { x: number; y: number } {
    return this.mousePosition;
  }

  public getMouseDelta(): { x: number; y: number } {
    // Devolver el delta acumulado del frame actual
    // Este valor se acumula desde el último reset (al final del update anterior)
    return { x: this.mouseMovement.x, y: this.mouseMovement.y };
  }

  public getMouseWheelDelta(): number {
    return this.mouseWheelDelta;
  }

  // Pointer Lock state
  public isPointerLockEnabled(): boolean {
    return this.pointerLockEnabled;
  }

  public setPointerLockEnabled(enabled: boolean): void {
    this.pointerLockEnabled = enabled;
    if (!enabled && this.pointerLockActive) {
      document.exitPointerLock();
    }
  }

  public isPointerLockActive(): boolean {
    return this.pointerLockActive;
  }

  // ==================== INPUT MANAGER PROXY METHODS ====================

  /**
   * Verifica si una acción está actualmente presionada
   */
  public isActionPressed(action: GameAction): boolean {
    return InputManager.getInstance().isActionPressed(action);
  }

  /**
   * Verifica si una acción fue presionada este frame
   */
  public isActionJustPressed(action: GameAction): boolean {
    return InputManager.getInstance().isActionJustPressed(action);
  }

  /**
   * Obtiene el valor de una acción (útil para ejes/analógicos)
   * @returns Valor entre -1 y 1 para ejes, 0 o 1 para botones
   */
  public getActionValue(action: GameAction): number {
    return InputManager.getInstance().getActionValue(action);
  }

  /**
   * Verifica si una acción está buffereada
   */
  public isActionBuffered(action: GameAction): boolean {
    return InputManager.getInstance().isActionBuffered(action);
  }

  /**
   * Consume una acción del buffer
   * Útil cuando quieres procesar un input buffereado y eliminarlo
   */
  public consumeBufferedAction(action: GameAction): boolean {
    return InputManager.getInstance().consumeBufferedAction(action);
  }

  /**
   * Buffearea manualmente una acción
   */
  public bufferAction(action: GameAction): void {
    InputManager.getInstance().bufferAction(action);
  }

  /**
   * Limpia el buffer de inputs
   */
  public clearBuffer(): void {
    InputManager.getInstance().clearBuffer();
  }

  /**
   * Obtiene la ventana de buffer en milisegundos
   */
  public getBufferWindow(): number {
    return InputManager.getInstance().getBufferWindow();
  }

  /**
   * Establece la ventana de buffer en milisegundos
   */
  public setBufferWindow(ms: number): void {
    InputManager.getInstance().setBufferWindow(ms);
  }

  /**
   * Mapea una acción a un binding
   */
  public mapAction(action: GameAction, binding: InputBinding): void {
    InputManager.getInstance().mapAction(action, binding);
  }

  /**
   * Añade un binding adicional a una acción (múltiples teclas para la misma acción)
   */
  public addBinding(action: GameAction, binding: InputBinding): void {
    InputManager.getInstance().addBinding(action, binding);
  }

  /**
   * Elimina todos los bindings de una acción
   */
  public clearAction(action: GameAction): void {
    InputManager.getInstance().clearAction(action);
  }

  /**
   * Resetea el control mapping a los valores por defecto
   */
  public resetToDefaults(): void {
    InputManager.getInstance().resetToDefaults();
  }

  /**
   * Obtiene la configuración actual
   */
  public getInputConfig(): ControlMappingConfig {
    return InputManager.getInstance().getConfig();
  }

  /**
   * Carga una configuración
   */
  public loadInputConfig(config: ControlMappingConfig): void {
    InputManager.getInstance().loadConfig(config);
  }

  /**
   * Guarda la configuración en localStorage
   */
  public saveInputConfig(): void {
    InputManager.getInstance().saveConfig();
  }

  /**
   * Carga la configuración desde localStorage
   */
  public loadInputConfigFromStorage(): boolean {
    return InputManager.getInstance().loadConfigFromStorage();
  }

  /**
   * Acceso directo al InputManager (para casos avanzados)
   */
  public getInputManager(): InputManager {
    return InputManager.getInstance();
  }
}
