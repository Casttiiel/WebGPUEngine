import { Module } from '../core/Module';
import { KeyCode } from '../../types/KeyCode.enum';
import { MouseButton } from '../../types/MouseButton.enum';
import { Render } from '../../renderer/core/pipeline/Render';

export class ModuleInput extends Module {
  private mousePosition: { x: number; y: number } = { x: 0, y: 0 };
  private lastMousePosition: { x: number; y: number } = { x: 0, y: 0 };
  private mouseButtons: Map<MouseButton, boolean> = new Map();
  private keys: Map<KeyCode, boolean> = new Map();
  private keysLastFrame: Map<KeyCode, boolean> = new Map();
  private mouseWheelDelta: number = 0;

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
    window.addEventListener('wheel', this.handleMouseWheel.bind(this));
    window.addEventListener('keydown', this.handleKeyDown.bind(this));
    window.addEventListener('keyup', this.handleKeyUp.bind(this));
    return true;
  }

  public stop(): void {
    const canvas = Render.getInstance().getCanvas();
    canvas.removeEventListener('contextmenu', this.handleContextMenu);

    window.removeEventListener('mousemove', this.handleMouseMove.bind(this));
    window.removeEventListener('mousedown', this.handleMouseDown.bind(this));
    window.removeEventListener('mouseup', this.handleMouseUp.bind(this));
    window.removeEventListener('wheel', this.handleMouseWheel.bind(this));
    window.removeEventListener('keydown', this.handleKeyDown.bind(this));
    window.removeEventListener('keyup', this.handleKeyUp.bind(this));
  }

  private handleMouseMove(event: MouseEvent): void {
    this.mousePosition = { x: event.clientX, y: event.clientY };
  }

  private handleMouseDown(event: MouseEvent): void {
    this.mouseButtons.set(event.button as MouseButton, true);
  }

  private handleMouseUp(event: MouseEvent): void {
    this.mouseButtons.set(event.button as MouseButton, false);
  }

  private handleMouseWheel(event: WheelEvent): void {
    this.mouseWheelDelta = event.deltaY;
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const key = event.code.toLowerCase() as KeyCode;
    this.keys.set(key, true);
  }

  private handleKeyUp(event: KeyboardEvent): void {
    const key = event.code.toLowerCase() as KeyCode;
    this.keys.set(key, false);
  }

  private handleContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  public update(): void {
    // Update last frame's key states
    this.keysLastFrame = new Map(this.keys);

    // Calcular el delta del mouse antes de actualizar lastMousePosition
    const mouseDelta = this.getMouseDelta();
    this.debugValues.mouseDeltaX.value = mouseDelta.x;
    this.debugValues.mouseDeltaY.value = mouseDelta.y;

    // Actualizar mouseWheelDelta antes de resetearlo
    this.debugValues.mouseWheel.value = this.mouseWheelDelta;

    // Reset per-frame values
    this.lastMousePosition = { ...this.mousePosition };
    this.mouseWheelDelta = 0;

    // Actualizar valores para Tweakpane
    this.debugValues.mouseLeft.value = this.isMouseButtonPressed(MouseButton.LEFT);
    this.debugValues.mouseRight.value = this.isMouseButtonPressed(MouseButton.RIGHT);
    this.debugValues.keyW.value = this.isKeyPressed(KeyCode.W);
    this.debugValues.keyA.value = this.isKeyPressed(KeyCode.A);
    this.debugValues.keyS.value = this.isKeyPressed(KeyCode.S);
    this.debugValues.keyD.value = this.isKeyPressed(KeyCode.D);
  }

  public renderDebug(): void {
    // No visual debug needed
  }

  public override renderInMenu(): void {
    // Llamado cada frame para mantener los valores actualizados

    // Mouse Buttons
    this.addDebugControl(this.debugValues.mouseLeft, 'value', this.debugValues.mouseLeft.name);
    this.addDebugControl(this.debugValues.mouseRight, 'value', this.debugValues.mouseRight.name);

    // Movement Keys
    this.addDebugControl(this.debugValues.keyW, 'value', this.debugValues.keyW.name);
    this.addDebugControl(this.debugValues.keyA, 'value', this.debugValues.keyA.name);
    this.addDebugControl(this.debugValues.keyS, 'value', this.debugValues.keyS.name);
    this.addDebugControl(this.debugValues.keyD, 'value', this.debugValues.keyD.name);

    // Mouse Movement
    this.addDebugControl(this.debugValues.mouseDeltaX, 'value', this.debugValues.mouseDeltaX.name);
    this.addDebugControl(this.debugValues.mouseDeltaY, 'value', this.debugValues.mouseDeltaY.name);
    this.addDebugControl(this.debugValues.mouseWheel, 'value', this.debugValues.mouseWheel.name);
  }

  // Utility methods for other modules
  public isMouseButtonPressed(button: MouseButton): boolean {
    return this.mouseButtons.get(button) || false;
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
    return {
      x: this.mousePosition.x - this.lastMousePosition.x,
      y: this.mousePosition.y - this.lastMousePosition.y,
    };
  }

  public getMouseWheelDelta(): number {
    return this.mouseWheelDelta;
  }
}
