// src/components/ui/Widget.ts
import type { WidgetEffect, WidgetParams } from '../../types/WidgetTypes';

export class Widget {
  private name: string;
  private alias: string;
  private params: WidgetParams;
  private parent: Widget | null = null;
  private children: Widget[] = [];
  private effects: WidgetEffect[] = [];
  private local: any = null; // Placeholder for transform matrix
  private pivot: any = null;
  private absolute: any = null;

  constructor(name: string, alias: string, params: WidgetParams) {
    this.name = name;
    this.alias = alias;
    this.params = params;
  }

  private start(): void {
    for (const fx of this.effects) fx.start();
    for (const child of this.children) child.start();
  }

  private stop(): void {
    for (const fx of this.effects) fx.stop();
    for (const child of this.children) child.stop();
  }

  private update(dt: number): void {
    for (const fx of this.effects) fx.update(dt);
    for (const child of this.children) child.update(dt);
  }

  private render(): void {
    // To be implemented by subclasses or UI system
  }

  private doRender(): void {
    if (!this.params.visible) return;
    this.render();
    for (const child of this.children) child.doRender();
  }

  private onActivate(): void {
    for (const child of this.children) child.onActivate();
  }

  private onDeactivate(): void {
    for (const fx of this.effects) fx.onDeactivate?.();
    for (const child of this.children) child.onDeactivate();
  }

  private updateTransform(): void {
    this.computeAbsolute();
    for (const child of this.children) child.updateTransform();
  }

  private setParent(parent: Widget | null): void {
    this.removeFromParent();
    if (!parent) return;
    this.parent = parent;
    parent.children.push(this);
  }

  private removeFromParent(): void {
    if (!this.parent) return;
    const idx = this.parent.children.indexOf(this);
    if (idx >= 0) this.parent.children.splice(idx, 1);
    this.parent = null;
  }

  private getAbsolute(): any {
    return this.absolute;
  }

  private getChildren(pos: number): Widget | undefined {
    return this.children[pos];
  }

  private getEffect(name: string): WidgetEffect | undefined {
    return this.effects.find((e) => e.getName() === name);
  }

  private childAppears(
    getFromChildren: boolean,
    darkAlpha: boolean,
    initialTime: number,
    lerpTime: number,
  ): void {
    // This is a stub. Real implementation would animate alpha, etc.
    // Integration with ModuleUI.lerp() would be needed.
  }

  // --- Matrix methods are placeholders ---
  protected computePivot(): void {}
  protected computeLocal(): void {}
  protected computeAbsolute(): void {}
}
