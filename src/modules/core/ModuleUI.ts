// src/modules/ui/ModuleUI.ts
import { Module } from './Module';
import type { WidgetClass, WidgetToLerp, WidgetController, Widget } from '../../types/WidgetTypes';

export class ModuleUI extends Module {
  private widgetStructureMap: Map<string, WidgetClass> = new Map();
  private registeredWidgets: Map<string, Widget> = new Map();
  private registeredAlias: Map<string, Widget> = new Map();
  private activeWidgets: Widget[] = [];
  private activeControllers: WidgetController[] = [];
  private widgetsToLerp: WidgetToLerp[] = [];
  private sizeUI = 0;
  private botonPulsadoGameOver = 0;
  private botonPulsadoPause = 0;

  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    // TODO: Load UI config, call initWidgetClass()
    return true;
  }

  public update(dt: number): void {
    for (const controller of this.activeControllers) controller.update(dt);
    for (const widget of this.activeWidgets) widget.update(dt);
    // Lerp logic (stub, see C++ for full logic)
  }

  private render(): void {
    for (const widget of this.activeWidgets) widget.doRender();
  }

  public override renderInMenu(): void {}

  public override stop(): void {
    throw new Error('Method not implemented.');
  }
  public override renderDebug(): void {
    throw new Error('Method not implemented.');
  }

  private registerWidget(widget: Widget): void {
    this.registeredWidgets.set(widget.name, widget);
  }

  private registerAlias(widget: Widget): void {
    this.registeredAlias.set(widget.alias, widget);
  }

  private activateWidget(name: string): void {
    const widget = this.getWidgetByName(name);
    if (widget) {
      this.activeWidgets.push(widget);
      widget.start();
    }
  }

  private deactivateWidget(name: string): void {
    const idx = this.activeWidgets.findIndex((w) => w.name === name);
    if (idx >= 0) {
      this.activeWidgets[idx].stop();
      this.activeWidgets.splice(idx, 1);
    }
  }

  private registerController(controller: WidgetController): void {
    this.activeControllers.push(controller);
  }

  private unregisterController(controller?: WidgetController): void {
    if (!controller) {
      this.activeControllers = [];
      return;
    }
    const idx = this.activeControllers.indexOf(controller);
    if (idx >= 0) this.activeControllers.splice(idx, 1);
  }

  private getWidgetByName(name: string): Widget | undefined {
    return this.registeredWidgets.get(name);
  }

  private getWidgetByAlias(alias: string): Widget | undefined {
    return this.registeredAlias.get(alias);
  }

  // --- WidgetClass logic ---
  private registerWidgetClass(type: string, path: string, controller?: WidgetController) {
    // TODO: Load widget from path, assign controller, etc.
    const widgetClass: WidgetClass = {
      name: path, // Placeholder: should resolve name from path
      type,
      widget: this.getWidgetByName(path),
      controller,
    };
    this.widgetStructureMap.set(type, widgetClass);
  }

  private activateWidgetClass(name: string): Widget | undefined {
    const widgetClass = this.widgetStructureMap.get(name);
    if (!widgetClass || widgetClass.enabled) return undefined;
    const widget = this.getWidgetByName(widgetClass.name);
    if (widget) {
      widget.onActivate();
      widgetClass.enabled = true;
      this.widgetStructureMap.set(name, widgetClass);
      this.activeWidgets.push(widget);
      if (widgetClass.controller) this.registerController(widgetClass.controller);
      return widget;
    }
    return undefined;
  }

  private deactivateWidgetClass(name: string): void {
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

  private getWidget(name: string): Widget | undefined {
    return this.widgetStructureMap.get(name)?.widget;
  }

  private getWidgetController(type: string): WidgetController | undefined {
    return this.widgetStructureMap.get(type)?.controller;
  }

  // Lerp logic stub
  private lerp(
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
