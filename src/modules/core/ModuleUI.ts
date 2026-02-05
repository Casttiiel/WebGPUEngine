// src/modules/core/ModuleUI.ts
import { Module } from './Module';
import type { WidgetClass, WidgetToLerp, WidgetController, Widget } from '../../types/WidgetTypes';

export class ModuleUI extends Module {
  private static instance: ModuleUI | null = null;

  private widgetStructureMap: Map<string, WidgetClass> = new Map();
  private registeredWidgets: Map<string, Widget> = new Map();
  private registeredAlias: Map<string, Widget> = new Map();
  private activeWidgets: Widget[] = [];
  private activeControllers: WidgetController[] = [];
  private widgetsToLerp: WidgetToLerp[] = [];
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
    // TODO: Load UI config, call initWidgetClass()
    return true;
  }

  public update(dt: number): void {
    // Update controllers
    for (const controller of this.activeControllers) {
      controller.update(dt);
    }

    // Update widgets
    for (const widget of this.activeWidgets) {
      widget.update(dt);
    }

    // Update lerp animations
    this.updateLerps(dt);
  }

  private updateLerps(dt: number): void {
    // Process all active lerps
    for (let i = this.widgetsToLerp.length - 1; i >= 0; i--) {
      const lerp = this.widgetsToLerp[i];

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

  public render(): void {
    for (const widget of this.activeWidgets) {
      widget.doRender();
    }
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
  public registerWidgetClass(type: string, path: string, controller?: WidgetController) {
    // TODO: Load widget from path, assign controller, etc.
    const widgetClass: WidgetClass = {
      name: path, // Placeholder: should resolve name from path
      type,
      widget: this.getWidgetByName(path),
      controller,
      enabled: false,
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
