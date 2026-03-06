// src/components/ui/Widget.ts
import { mat4, vec2 } from 'gl-matrix';
import type { WidgetEffect, WidgetParams } from '../../types/WidgetTypes';
import { AnchorType, UIAnchorSystem } from '../../core/ui/UIAnchorSystem.js';
import { UIRenderUtils } from '../../renderer/core/UIRenderUtils.js';

/**
 * Widget base class â€” reference-space (1920Ã—1080) coordinate system.
 *
 * Key rules:
 *  - `x, y` is the TOP-LEFT corner of the element in the 1920Ã—1080 design canvas.
 *  - `width, height` is the element size in the same reference space.
 *  - `pivotX/Y` (0â€“1) only affects the centre of rotation/scale, NOT position.
 *  - Children's x,y is an offset from the parent's top-left corner.
 *  - Anchor is only meaningful on root widgets (no parent).
 *  - The render matrix (`absolute`) is in physical pixels, ready for the ortho projection.
 *
 * Transform formula:
 *   gs       = globalScale  (or DPR if scaleWithScreen:false)
 *   originX  = anchorBase + x * gs   (root)  |  parent.originX + x * gs  (child)
 *   pivX     = originX + pivotX * width * gs
 *   absolute = T(pivX,pivY) * R(rotation) * T((0.5âˆ’pivX)*w*gs, (0.5âˆ’pivY)*h*gs) * S(w*gs, h*gs)
 */
export class Widget {
  protected name: string;
  protected alias: string;
  protected params: WidgetParams;
  private parent: Widget | null = null;
  private children: Widget[] = [];
  private effects: WidgetEffect[] = [];

  // â”€â”€ Reference-space parameters â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  protected x: number;
  protected y: number;
  protected width: number;
  protected height: number;
  protected pivotX: number;
  protected pivotY: number;
  protected rotation: number;
  protected scaleWithScreen: boolean;
  protected anchorType: AnchorType | undefined = undefined;

  // ── Effect scale (used by FXScale / FXFade effects) ─────────────────────────
  private effectScaleX: number = 1;
  private effectScaleY: number = 1;

  // â”€â”€ Physical-pixel computed values â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  /** Top-left corner in physical pixels (updated by computeAbsolute). */
  public originX: number = 0;
  public originY: number = 0;
  /** Render matrix in physical pixels â€” fed to the ortho projection in UIRenderUtils. */
  protected absolute: mat4 = mat4.create();

  // â”€â”€ Input callbacks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  public onMouseEnter?: () => void;
  public onMouseLeave?: () => void;
  public onClick?: () => void;

  constructor(name: string, alias: string, params: WidgetParams) {
    this.name = name;
    this.alias = alias;
    this.params = params;

    this.x = params.x ?? 0;
    this.y = params.y ?? 0;
    this.width = params.width ?? 100;
    this.height = params.height ?? 100;
    this.pivotX = params.pivotX ?? 0;
    this.pivotY = params.pivotY ?? 0;
    this.rotation = params.rotation ?? 0;
    this.scaleWithScreen = params.scaleWithScreen ?? true;

    if (params.anchor) {
      const parsed = UIAnchorSystem.parseAnchorType(params.anchor);
      if (parsed !== null) this.anchorType = parsed;
    }
  }

  // ============================================================================
  // LIFECYCLE
  // ============================================================================

  public start(): void {
    this.updateTransform();
    for (const fx of this.effects) fx.start();
    for (const child of this.children) child.start();
  }

  public stop(): void {
    for (const fx of this.effects) fx.stop();
    for (const child of this.children) child.stop();
  }

  public update(dt: number): void {
    // Recompute on resize (flag set by UIRenderUtils.updateScreenSize)
    if (UIRenderUtils.hasScreenSizeChanged()) {
      this.updateTransform();
    }
    for (const fx of this.effects) fx.update(dt);
    for (const child of this.children) child.update(dt);
  }

  protected render(_renderPass: GPURenderPassEncoder): void {
    // Override in subclasses
  }

  public doRender(renderPass: GPURenderPassEncoder): void {
    if (!this.params.visible) return;
    this.render(renderPass);
    for (const child of this.children) child.doRender(renderPass);
  }

  public renderDebug(): void {}

  public onActivate(): void {
    for (const child of this.children) child.onActivate();
  }

  public onDeactivate(): void {
    for (const fx of this.effects) fx.onDeactivate?.();
    for (const child of this.children) child.onDeactivate();
  }

  // ============================================================================
  // TRANSFORM
  // ============================================================================

  /**
   * Recompute the absolute render matrix for this widget and all its children.
   * Call after any position/size/anchor change, or when screen size changes.
   */
  public updateTransform(): void {
    this.computeAbsolute();
    for (const child of this.children) child.updateTransform();
  }

  /**
   * Compute `originX/Y` (physical-px top-left) and `absolute` render matrix.
   *
   * No rotation, pivotX=0 example:
   *   originX  = canvasOffX + x * gs
   *   centre   = (originX + w*gs/2, originY + h*gs/2)
   *   absolute = T(centre) * S(w*gs, h*gs)
   *
   * With pivot=(0.5, 0.5) and rotation r:
   *   pivX = originX + 0.5*w*gs  (centre)
   *   absolute = T(pivX,pivY) * R(r) * T(0,0) * S(w*gs,h*gs)
   */
  protected computeAbsolute(): void {
    const gs = this.scaleWithScreen
      ? UIRenderUtils.getGlobalScale()
      : (window.devicePixelRatio || 1);

    const physW = this.width * gs;
    const physH = this.height * gs;

    // â”€â”€ Compute top-left origin in physical pixels â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (this.parent === null) {
      if (this.anchorType !== undefined) {
        const [bx, by] = UIAnchorSystem.getAnchorBasePhysical(this.anchorType);
        this.originX = bx + this.x * gs;
        this.originY = by + this.y * gs;
      } else {
        const [ox, oy] = UIRenderUtils.getCanvasOffset();
        this.originX = ox + this.x * gs;
        this.originY = oy + this.y * gs;
      }
    } else {
      // Child: offset from parent's top-left
      this.originX = this.parent.originX + this.x * gs;
      this.originY = this.parent.originY + this.y * gs;
    }

    // â”€â”€ Build render matrix â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Pivot point in physical px
    const pivX = this.originX + this.pivotX * physW;
    const pivY = this.originY + this.pivotY * physH;
    // Offset from pivot to quad centre (mesh is [-0.5..0.5] centred)
    const offX = (0.5 - this.pivotX) * physW;
    const offY = (0.5 - this.pivotY) * physH;

    mat4.identity(this.absolute);
    mat4.translate(this.absolute, this.absolute, [pivX, pivY, 0]);
    if (this.rotation !== 0) {
      mat4.rotateZ(this.absolute, this.absolute, this.rotation);
    }
    mat4.translate(this.absolute, this.absolute, [offX, offY, 0]);
    mat4.scale(this.absolute, this.absolute, [physW * this.effectScaleX, physH * this.effectScaleY, 1]);
  }

  // ============================================================================
  // HIERARCHY
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
  // EFFECTS
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
  // VISIBILITY / ACTIVATION
  // ============================================================================

  public setVisible(visible: boolean): void {
    this.params.visible = visible;
  }

  public isVisible(): boolean {
    return this.params.visible;
  }

  /** Alias of setVisible â€” used by CarouselController and similar. */
  public setActive(active: boolean): void {
    this.setVisible(active);
  }

  // ============================================================================
  // SETTERS  (all call updateTransform so the matrix stays current)
  // ============================================================================

  public setPosition(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.updateTransform();
  }

  /** Return the current visual effect scale (used by FXScale). */
  public getScale(): [number, number] {
    return [this.effectScaleX, this.effectScaleY];
  }

  /** Set visual effect scale without affecting layout/hit-detection size. */
  public setScale(x: number, y: number): void {
    this.effectScaleX = x;
    this.effectScaleY = y;
  }

  public setSize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.updateTransform();
  }

  public setRotation(radians: number): void {
    this.rotation = radians;
    this.updateTransform();
  }

  public setPivot(px: number, py: number): void {
    this.pivotX = px;
    this.pivotY = py;
    this.updateTransform();
  }

  public setAnchor(anchor: AnchorType, offsetX: number = 0, offsetY: number = 0): void {
    this.anchorType = anchor;
    this.x = offsetX;
    this.y = offsetY;
    this.updateTransform();
  }

  public clearAnchor(): void {
    this.anchorType = undefined;
    this.updateTransform();
  }

  /** Low-level parent assignment (no addChild bookkeeping). */
  public setParentWidget(parent: Widget | null): void {
    this.parent = parent;
  }

  // ============================================================================
  // GETTERS
  // ============================================================================

  public getName(): string { return this.name; }
  public getAlias(): string { return this.alias; }
  public getParams(): WidgetParams { return this.params; }

  public getX(): number { return this.x; }
  public getY(): number { return this.y; }
  public getWidth(): number { return this.width; }
  public getHeight(): number { return this.height; }
  public getRotation(): number { return this.rotation; }
  public getAnchor(): AnchorType | undefined { return this.anchorType; }
  public hasAnchor(): boolean { return this.anchorType !== undefined; }

  /** Absolute render matrix in physical pixels. Always use this for rendering. */
  public getAbsolute(): mat4 { return this.absolute; }
  /** Backwards-compat alias. */
  public getAbsoluteTransform(): mat4 { return this.absolute; }

  /** Top-left corner in physical pixels (for hit detection). */
  public getOrigin(): [number, number] { return [this.originX, this.originY]; }

  /**
   * Size in physical pixels â€” used for AABB hit detection.
   * Subclasses can override if they manage their own size logic.
   */
  public getSize(): vec2 {
    const gs = this.scaleWithScreen
      ? UIRenderUtils.getGlobalScale()
      : (window.devicePixelRatio || 1);
    return vec2.fromValues(this.width * gs, this.height * gs);
  }

  // â”€â”€ Input callback setters â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  public setOnMouseEnter(callback: () => void): void { this.onMouseEnter = callback; }
  public setOnMouseLeave(callback: () => void): void { this.onMouseLeave = callback; }
  public setOnClick(callback: () => void): void { this.onClick = callback; }

  // â”€â”€ Legacy compat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /** @deprecated Use getX() / getY(). */
  public getPosition(): { x: number; y: number } { return { x: this.x, y: this.y }; }

  /**
   * childAppears â€” legacy fade-in stub.
   * @deprecated Use FXFade effect instead.
   */
  public childAppears(
    getFromChildren: boolean,
    _darkAlpha: boolean,
    _initialTime: number,
    _lerpTime: number,
  ): void {
    if (getFromChildren) {
      for (const child of this.children) {
        child.childAppears(true, _darkAlpha, _initialTime, _lerpTime);
      }
    }
  }
}
