// src/modules/core/ModuleUI.ts
import { Module } from './Module';
import { UIInputManager } from '../../core/ui/UIInputManager';
import { Engine } from '../../core/engine/Engine';
import { MouseButton } from '../../types/MouseButton.enum';
import { UIParser } from '../../core/ui/UIParser';
import { UIRenderUtils } from '../../renderer/core/UIRenderUtils';
import { Render } from '../../renderer/core/pipeline/Render';
import type { WidgetClass, WidgetToLerp, WidgetController, Widget } from '../../types/WidgetTypes';

export class ModuleUI extends Module {
  private static instance: ModuleUI | null = null;

  // Canvas dimensions will match screen size directly
  // No reference canvas or scaling

  private widgetStructureMap: Map<string, WidgetClass> = new Map();
  private registeredWidgets: Map<string, Widget> = new Map();
  private registeredAlias: Map<string, Widget> = new Map();
  private activeWidgets: Widget[] = [];
  private activeControllers: WidgetController[] = [];
  private widgetsToLerp: WidgetToLerp[] = [];

  // Input system
  private inputManager: UIInputManager = new UIInputManager();
  private lastMouseClicked: boolean = false;

  // Legacy variables kept for future implementation
  // private sizeUI = 0;
  // private botonPulsadoGameOver = 0;
  // private botonPulsadoPause = 0;

  constructor(name: string) {
    super(name);
    ModuleUI.instance = this;
  }

  public static getInstance(): ModuleUI | null {
    return ModuleUI.instance;
  }

  public async start(): Promise<boolean> {
    // Initialize all widget classes (like C++ initWidgetClass())
    await this.initWidgetClass();

    return true;
  }

  /**
   * Initialize widget classes - loads JSON files and registers them with type names.
   * This matches the C++ CModuleUI::initWidgetClass() pattern.
   */
  private async initWidgetClass(): Promise<void> {
    const parser = new UIParser();

    // Main Menu widgets
    await this.registerWidgetClass('MAIN_MENU_BACKGROUND', 'main_menu.json', parser);

    // TODO: Create MenuController for main menu buttons
    // const menuController = new MenuController();
    // await this.registerWidgetClass('MAIN_MENU_BUTTONS', 'assets/ui/main_menu_buttons.json', parser, menuController);
    // menuController.registerOption(...);
    // menuController.setCurrentOption(0);
  }

  /**
   * Register a widget class by loading its JSON file and associating it with a type name.
   */
  private async registerWidgetClass(
    type: string,
    widgetPath: string,
    parser: UIParser,
    controller?: WidgetController,
  ): Promise<void> {
    // Load widget from JSON file
    const widgetName = await parser.loadFileByName(widgetPath);
    const widget = this.getWidgetByName(widgetName);

    if (!widget) {
      console.warn(`Failed to load widget from: ${widgetPath}`);
      return;
    }

    // Create widget class structure
    const widgetClass: WidgetClass = {
      name: widgetName,
      type: type,
      widget: widget,
      enabled: false,
      controller: controller,
    };

    this.widgetStructureMap.set(type, widgetClass);
  }

  public update(dt: number): void {
    // Update screen dimensions FIRST (before widgets check for size changes)
    const canvas = Render.getInstance().getCanvas();
    const physicalWidth = canvas.width;
    const physicalHeight = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    UIRenderUtils.updateScreenSize(physicalWidth, physicalHeight, dpr);

    // Update input system (must be done before controllers/widgets)
    this.updateInput();

    // Update controllers
    for (const controller of this.activeControllers) {
      controller.update(dt);
    }

    // Update widgets (they can now detect screen size changes)
    for (const widget of this.activeWidgets) {
      widget.update(dt);
    }

    // Update lerp animations
    this.updateLerps(dt);
  }

  private updateInput(): void {
    const input = Engine.getInput();
    if (!input) return;

    // Get canvas dimensions
    const canvas = document.querySelector('canvas');
    if (!canvas) return;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    // Get mouse position from ModuleInput
    const mousePos = input.getMousePosition();

    // Convert window coordinates to UI space
    const mouseUIPos = this.inputManager.windowToUISpace(mousePos.x, mousePos.y, width, height);

    // Detect click (transition from not pressed to pressed)
    const isMousePressed = input.isMouseButtonPressed(MouseButton.LEFT);
    const isMouseClicked = isMousePressed && !this.lastMouseClicked;
    this.lastMouseClicked = isMousePressed;

    // Process input for all active widgets
    this.inputManager.processInput(this.activeWidgets, mouseUIPos, isMouseClicked);
  }

  private updateLerps(dt: number): void {
    // Process all active lerps
    for (let i = this.widgetsToLerp.length - 1; i >= 0; i--) {
      const lerp = this.widgetsToLerp[i];
      if (!lerp) continue;

      // Store max element value on first frame
      if (lerp.isFirstFrame) {
        lerp.maxElement = lerp.element.value;
        lerp.isFirstFrame = false;
      }

      // Update time
      lerp.currentTime += dt;

      // Calculate lerp ratio
      const ratio = Math.min(lerp.currentTime / lerp.lerpTime, 1.0);

      // Interpolate value
      lerp.element.value = lerp.maxElement + (lerp.value - lerp.maxElement) * ratio;

      // Remove completed lerps
      if (ratio >= 1.0) {
        this.widgetsToLerp.splice(i, 1);
      }
    }
  }

  public render(renderPass: GPURenderPassEncoder): void {
    // Get current dimensions for logging
    const canvas = Render.getInstance().getCanvas();
    const physicalWidth = canvas.width;
    const physicalHeight = canvas.height;
    const dpr = window.devicePixelRatio || 1;

    console.log(
      '[UI] Physical:',
      physicalWidth,
      'x',
      physicalHeight,
      '| DPR:',
      dpr.toFixed(2),
      '| CSS:',
      canvas.clientWidth,
      'x',
      canvas.clientHeight,
    );

    console.log('[UI] Rendering', this.activeWidgets.length, 'active widgets');

    // Render all active widgets
    for (const widget of this.activeWidgets) {
      widget.doRender(renderPass);
    }

    // Reset screen size change flag after rendering
    UIRenderUtils.resetScreenSizeChanged();
  }

  public override renderInMenu(): void {
    // Debug UI rendering for ModuleUI
    // TODO: Add debug controls if needed
  }

  public override stop(): void {
    // Deactivate all widgets
    for (const widget of this.activeWidgets) {
      widget.stop();
    }
    this.activeWidgets = [];
    this.activeControllers = [];
    this.widgetsToLerp = [];

    // Reset input manager
    this.inputManager.reset();
    this.lastMouseClicked = false;
  }

  public override renderDebug(): void {
    // Debug rendering for widgets
    for (const widget of this.activeWidgets) {
      widget.renderDebug();
    }
  }

  public registerWidget(widget: Widget): void {
    this.registeredWidgets.set(widget.name, widget);
  }

  public registerAlias(widget: Widget): void {
    if (widget.alias) {
      this.registeredAlias.set(widget.alias, widget);
    }
  }

  public activateWidget(name: string): void {
    const widget = this.getWidgetByName(name);
    if (widget) {
      if (!this.activeWidgets.includes(widget)) {
        this.activeWidgets.push(widget);
      }
      widget.start();
    }
  }

  public deactivateWidget(name: string): void {
    const idx = this.activeWidgets.findIndex((w) => w.name === name);
    if (idx >= 0) {
      this.activeWidgets[idx].stop();
      this.activeWidgets.splice(idx, 1);
    }
  }

  public registerController(controller: WidgetController): void {
    if (!this.activeControllers.includes(controller)) {
      this.activeControllers.push(controller);
    }
  }

  public unregisterController(controller?: WidgetController): void {
    if (!controller) {
      this.activeControllers = [];
      return;
    }
    const idx = this.activeControllers.indexOf(controller);
    if (idx >= 0) this.activeControllers.splice(idx, 1);
  }

  public getWidgetByName(name: string): Widget | undefined {
    return this.registeredWidgets.get(name);
  }

  public getWidgetByAlias(alias: string): Widget | undefined {
    return this.registeredAlias.get(alias);
  }

  // --- WidgetClass logic ---
  /**
   * Register a widget class manually (public API).
   * For initial setup, use the private async version called from initWidgetClass().
   */
  public registerWidgetClassManually(
    type: string,
    widgetName: string,
    controller?: WidgetController,
  ): void {
    const widget = this.getWidgetByName(widgetName);

    const widgetClass: WidgetClass = {
      name: widgetName,
      type: type,
      widget: widget,
      enabled: false,
      controller: controller,
    };

    this.widgetStructureMap.set(type, widgetClass);
  }

  public activateWidgetClass(name: string): Widget | undefined {
    const widgetClass = this.widgetStructureMap.get(name);
    if (!widgetClass || widgetClass.enabled) return undefined;
    const widget = this.getWidgetByName(widgetClass.name);
    if (widget) {
      widget.onActivate();
      widgetClass.enabled = true;
      this.widgetStructureMap.set(name, widgetClass);
      if (!this.activeWidgets.includes(widget)) {
        this.activeWidgets.push(widget);
      }
      if (widgetClass.controller) this.registerController(widgetClass.controller);
      return widget;
    }
    return undefined;
  }

  public deactivateWidgetClass(name: string): void {
    const widgetClass = this.widgetStructureMap.get(name);
    if (!widgetClass) return;
    const widget = this.getWidgetByName(widgetClass.name);
    if (widget) {
      widget.onDeactivate();
      const idx = this.activeWidgets.indexOf(widget);
      if (idx >= 0) this.activeWidgets.splice(idx, 1);
    }
    widgetClass.enabled = false;
    this.widgetStructureMap.set(name, widgetClass);
    if (widgetClass.controller) this.unregisterController(widgetClass.controller);
  }

  public getWidget(name: string): Widget | undefined {
    return this.widgetStructureMap.get(name)?.widget;
  }

  public getWidgetController(type: string): WidgetController | undefined {
    return this.widgetStructureMap.get(type)?.controller;
  }

  // ============================================================================
  // INPUT SYSTEM ACCESS
  // ============================================================================

  /**
   * Get the UIInputManager instance for advanced input handling.
   * Controllers can use this for custom input detection.
   */
  public getInputManager(): UIInputManager {
    return this.inputManager;
  }

  // ============================================================================
  // LERP/TWEEN ANIMATION SYSTEM
  // ============================================================================

  // Lerp/Tween animation system
  public lerp(
    element: { value: number },
    valueToLerp: number,
    initialTime: number,
    lerpTime: number,
  ) {
    const widgetToLerp: WidgetToLerp = {
      element,
      maxElement: element.value,
      value: valueToLerp,
      initialTime,
      currentTime: 0,
      lerpTime,
      isFirstFrame: true,
    };
    this.widgetsToLerp.push(widgetToLerp);
  }
}
