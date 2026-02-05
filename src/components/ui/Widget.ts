// src/components/ui/Widget.ts
import { mat4, vec3 } from 'gl-matrix';
import type { WidgetEffect, WidgetParams } from '../../types/WidgetTypes';

/**
 * Widget base class with integrated 4x4 matrix transformations.
 * Replicates C++/DirectX11 UI system architecture.
 *
 * ⚠️ Uses mat4 (4x4) with Z=0 for 2D transformations (NOT 2D matrices).
 */
export class Widget {
  private name: string;
  private alias: string;
  private params: WidgetParams;
  private parent: Widget | null = null;
  private children: Widget[] = [];
  private effects: WidgetEffect[] = [];

  // ⚠️ Transformation matrices (4x4) - integrated in Widget like C++ original
  private pivot: mat4 = mat4.create();
  private local: mat4 = mat4.create();
  private absolute: mat4 = mat4.create();

  // Transformation parameters (2D with Z=0)
  private position: vec3 = vec3.fromValues(0, 0, 0);
  private pivotPoint: vec3 = vec3.fromValues(0, 0, 0);
  private scale: vec3 = vec3.fromValues(1, 1, 1);
  private rotation: number = 0;

  constructor(name: string, alias: string, params: WidgetParams) {
    this.name = name;
    this.alias = alias;
    this.params = params;

    // Initialize transformation parameters from params
    if (params.position) {
      this.position = vec3.fromValues(params.position.x, params.position.y, 0);
    }
    if (params.pivot) {
      this.pivotPoint = vec3.fromValues(params.pivot.x, params.pivot.y, 0);
    }
    if (params.scale) {
      this.scale = vec3.fromValues(params.scale.x, params.scale.y, 1);
    }
    if (params.rotation !== undefined) {
      this.rotation = params.rotation;
    }
  }

  // ============================================================================
  // LIFECYCLE METHODS
  // ============================================================================

  public start(): void {
    for (const fx of this.effects) fx.start();
    for (const child of this.children) child.start();
  }

  public stop(): void {
    for (const fx of this.effects) fx.stop();
    for (const child of this.children) child.stop();
  }

  public update(dt: number): void {
    for (const fx of this.effects) fx.update(dt);
    for (const child of this.children) child.update(dt);
  }

  protected render(): void {
    // To be implemented by subclasses
  }

  public doRender(): void {
    if (!this.params.visible) return;
    this.render();
    for (const child of this.children) child.doRender();
  }

  public onActivate(): void {
    for (const child of this.children) child.onActivate();
  }

  public onDeactivate(): void {
    for (const fx of this.effects) fx.onDeactivate?.();
    for (const child of this.children) child.onDeactivate();
  }

  public updateTransform(): void {
    this.computeAbsolute();
    for (const child of this.children) child.updateTransform();
  }

  // ============================================================================
  // HIERARCHY MANAGEMENT
  // ============================================================================

  public setParent(parent: Widget | null): void {
    this.removeFromParent();
    if (!parent) return;
    this.parent = parent;
    parent.children.push(this);
  }

  public removeFromParent(): void {
    if (!this.parent) return;
    const idx = this.parent.children.indexOf(this);
    if (idx >= 0) this.parent.children.splice(idx, 1);
    this.parent = null;
  }

  public addChild(child: Widget): void {
    child.setParent(this);
  }

  public getChildAt(pos: number): Widget | undefined {
    return this.children[pos];
  }

  public getAllChildren(): Widget[] {
    return this.children;
  }

  // ============================================================================
  // EFFECT MANAGEMENT
  // ============================================================================

  public addEffect(effect: WidgetEffect): void {
    this.effects.push(effect);
  }

  public removeEffect(effect: WidgetEffect): void {
    const idx = this.effects.indexOf(effect);
    if (idx >= 0) this.effects.splice(idx, 1);
  }

  public getEffect(name: string): WidgetEffect | undefined {
    return this.effects.find((e) => e.getName() === name);
  }

  public getAllEffects(): WidgetEffect[] {
    return this.effects;
  }

  // ============================================================================
  // VISIBILITY AND ACTIVATION
  // ============================================================================

  public setVisible(visible: boolean): void {
    this.params.visible = visible;
  }

  public isVisible(): boolean {
    return this.params.visible;
  }

  public childAppears(
    getFromChildren: boolean,
    darkAlpha: boolean,
    initialTime: number,
    lerpTime: number,
  ): void {
    // Fade-in animation for widgets
    // This would integrate with ModuleUI.lerp() system
    // For now, it's a placeholder for future implementation
    if (getFromChildren) {
      for (const child of this.children) {
        child.childAppears(true, darkAlpha, initialTime, lerpTime);
      }
    }
  }

  // ============================================================================
  // TRANSFORMATION SYSTEM (replicates C++/DirectX11 original)
  // ============================================================================

  /**
   * Compute pivot matrix: Identity * Translation(-pivot.x, -pivot.y, 0)
   * Identical to C++ implementation.
   */
  protected computePivot(): void {
    mat4.identity(this.pivot);
    mat4.translate(
      this.pivot,
      this.pivot,
      vec3.fromValues(-this.pivotPoint[0], -this.pivotPoint[1], 0),
    );
  }

  /**
   * Compute local matrix: translation * scale * rotation * pivot
   * Identical to C++: local = rot * sc * tr
   * Order: pivot → translation → scale → rotation
   */
  protected computeLocal(): void {
    this.computePivot();

    const tr = mat4.create();
    const sc = mat4.create();
    const rot = mat4.create();

    // Translation in X,Y with Z=0
    mat4.fromTranslation(tr, this.position);

    // Scale in X,Y with Z=1 (no Z scaling)
    mat4.fromScaling(sc, this.scale);

    // Rotation only on Z axis
    mat4.fromZRotation(rot, this.rotation);

    // Correct order: local = pivot * translation * scale * rotation
    mat4.multiply(this.local, tr, this.pivot);
    mat4.multiply(this.local, sc, this.local);
    mat4.multiply(this.local, rot, this.local);
  }

  /**
   * Compute absolute (world) matrix with parent hierarchy.
   * Identical to C++: absolute = parent ? local * parent.absolute : local
   */
  protected computeAbsolute(): void {
    this.computeLocal();

    if (this.parent) {
      mat4.multiply(this.absolute, this.local, this.parent.absolute);
    } else {
      mat4.copy(this.absolute, this.local);
    }
  }

  // ============================================================================
  // PUBLIC SETTERS FOR TRANSFORMATIONS
  // ============================================================================

  public setPosition(x: number, y: number): void {
    vec3.set(this.position, x, y, 0);
  }

  public setPivot(x: number, y: number): void {
    vec3.set(this.pivotPoint, x, y, 0);
  }

  public setScale(x: number, y: number): void {
    vec3.set(this.scale, x, y, 1);
  }

  public setRotation(radians: number): void {
    this.rotation = radians;
  }

  public setParentWidget(parent: Widget | null): void {
    this.parent = parent;
  }

  // Getters for transformation parameters
  public getPosition(): vec3 {
    return this.position;
  }
  public getPivot(): vec3 {
    return this.pivotPoint;
  }
  public getScale(): vec3 {
    return this.scale;
  }
  public getRotation(): number {
    return this.rotation;
  }
  public getName(): string {
    return this.name;
  }
  public getAlias(): string {
    return this.alias;
  }
  public getParams(): WidgetParams {
    return this.params;
  }
}
