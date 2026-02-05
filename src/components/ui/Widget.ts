// src/components/ui/Widget.ts
import { mat4, vec2, vec3 } from 'gl-matrix';
import type { WidgetEffect, WidgetParams } from '../../types/WidgetTypes';
import { AnchorType, UIAnchorSystem } from '../../core/ui/UIAnchorSystem.js';
import { UIRenderUtils } from '../../renderer/core/UIRenderUtils.js';

/**
 * Widget base class with integrated 4x4 matrix transformations.
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

  // ⚠️ Transformation matrices (4x4)
  private pivot: mat4 = mat4.create();
  private local: mat4 = mat4.create();
  private absolute: mat4 = mat4.create();

  // Transformation parameters (2D with Z=0)
  private position: vec3 = vec3.fromValues(0, 0, 0);
  private pivotPoint: vec3 = vec3.fromValues(0, 0, 0);
  private scale: vec3 = vec3.fromValues(1, 1, 1);
  private rotation: number = 0;

  // Anchor system (Phase 2)
  private anchorType?: AnchorType; // Optional anchor point (e.g., "top-left")
  private anchorOffset: vec2 = vec2.create(); // Offset from anchor position

  // Size mode: 'fixed' (absolute pixels) or 'relative' (scaled from 1920x1080)
  private sizeMode: 'fixed' | 'relative' = 'relative'; // Default: relative
  private baseScale: vec3 = vec3.fromValues(1, 1, 1); // Original scale before UI scaling

  // Input event callbacks (optional)
  public onMouseEnter?: () => void;
  public onMouseLeave?: () => void;
  public onClick?: () => void;

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
      this.baseScale = vec3.clone(this.scale); // Store original scale
    }
    if (params.rotation !== undefined) {
      this.rotation = params.rotation;
    }

    // Initialize size mode (default: relative)
    if (params.sizeMode) {
      this.sizeMode = params.sizeMode;
    }

    // Initialize anchor system (Phase 2)
    if (params.anchor) {
      this.anchorType = UIAnchorSystem.parseAnchorType(params.anchor);
    }
    if (params.offset) {
      vec2.set(this.anchorOffset, params.offset.x, params.offset.y);
    }
  }

  // ============================================================================
  // LIFECYCLE METHODS
  // ============================================================================

  public start(): void {
    // Force initial transform calculation for anchored widgets
    if (this.anchorType !== undefined) {
      console.log(
        '[Widget] Starting anchored widget:',
        this.name,
        '- anchorType:',
        this.anchorType,
        '- offset:',
        this.anchorOffset,
      );
      this.updateTransform();
    } else {
      console.log('[Widget] Starting widget:', this.name, '- position:', this.position);
    }

    for (const fx of this.effects) fx.start();
    for (const child of this.children) child.start();
  }

  public stop(): void {
    for (const fx of this.effects) fx.stop();
    for (const child of this.children) child.stop();
  }

  public update(dt: number): void {
    // If using anchor system, only recalculate transform when screen size changes
    if (this.anchorType !== undefined && UIRenderUtils.hasScreenSizeChanged()) {
      this.updateTransform();
    }

    for (const fx of this.effects) fx.update(dt);
    for (const child of this.children) child.update(dt);
  }

  protected render(_renderPass: GPURenderPassEncoder): void {
    // To be implemented by subclasses
  }

  public doRender(renderPass: GPURenderPassEncoder): void {
    if (!this.params.visible) return;
    this.render(renderPass);
    for (const child of this.children) child.doRender(renderPass);
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
  // TRANSFORMATION SYSTEM
  // ============================================================================

  /**
   * Compute pivot matrix: Identity * Translation(-pivot.x, -pivot.y, 0)
   */
  protected computePivot(): void {
    mat4.identity(this.pivot);
    mat4.translate(
      this.pivot,
      this.pivot,
      vec3.fromValues(-this.pivotPoint[0], -this.pivotPoint[1], 0),
    );

    // Log pivot for debugging
    if (this.anchorType !== undefined) {
      console.log(
        '[Widget]',
        this.name,
        '- Pivot:',
        this.pivotPoint[0].toFixed(1),
        this.pivotPoint[1].toFixed(1),
      );
    }
  }

  /**
   * Compute local matrix: translation * rotation * scale * pivot
   * Order ensures position is in pixels, not affected by scale
   *
   * If anchor is defined, calculates position from anchor point:
   *   finalPosition = anchorPosition + anchorOffset (scaled)
   */
  protected computeLocal(): void {
    this.computePivot();

    // Calculate final position based on anchor (if set) or direct position
    let finalPosition = vec3.clone(this.position);

    if (this.anchorType !== undefined) {
      // Get current screen dimensions
      const screenWidth = UIRenderUtils.getScreenWidth();
      const screenHeight = UIRenderUtils.getScreenHeight();

      // Calculate anchor position in screen space
      const anchorPos = UIAnchorSystem.getAnchorPosition(
        this.anchorType,
        screenWidth,
        screenHeight,
      );

      // Get UI scale factor (based on 1920x1080 reference)
      // This ensures offsets scale proportionally with screen size
      const scaleFactor = UIRenderUtils.getUIScaleFactor();

      console.log(
        '[Widget]',
        this.name,
        '- Screen:',
        screenWidth,
        'x',
        screenHeight,
        '- Anchor:',
        this.anchorType,
        '- AnchorPos:',
        anchorPos,
        '- Scale:',
        scaleFactor.toFixed(3),
      );

      // Apply anchor position + scaled offset
      finalPosition = vec3.fromValues(
        anchorPos[0] + this.anchorOffset[0] * scaleFactor,
        anchorPos[1] + this.anchorOffset[1] * scaleFactor,
        0,
      );

      console.log(
        '[Widget]',
        this.name,
        '- FinalPos:',
        finalPosition[0].toFixed(1),
        finalPosition[1].toFixed(1),
      );
    }

    const tr = mat4.create();
    const sc = mat4.create();
    const rot = mat4.create();

    // Translation in X,Y with Z=0 (using calculated finalPosition)
    mat4.fromTranslation(tr, finalPosition);

    // Apply UI scale factor to size if mode is 'relative'
    let finalScale = vec3.clone(this.baseScale);
    if (this.sizeMode === 'relative') {
      // Scale each axis independently (allows deformation)
      const [scaleX, scaleY] = UIRenderUtils.getUIScaleFactors();

      // baseScale is in CSS pixels, need to convert to physical first
      const dpr = window.devicePixelRatio || 1;
      finalScale[0] = this.baseScale[0] * dpr * scaleX;
      finalScale[1] = this.baseScale[1] * dpr * scaleY;
      finalScale[2] = this.baseScale[2]; // Z unchanged

      console.log(
        '[Widget]',
        this.name,
        '- BaseScale:',
        this.baseScale[0],
        'x',
        this.baseScale[1],
        '| DPR:',
        dpr.toFixed(2),
        '| ScaleFactors:',
        scaleX.toFixed(3),
        scaleY.toFixed(3),
        '| FinalScale:',
        finalScale[0].toFixed(1),
        'x',
        finalScale[1].toFixed(1),
      );

      // Calculate actual screen coverage
      const screenHeight = UIRenderUtils.getScreenHeight();
      const coverage = ((finalScale[1] / screenHeight) * 100).toFixed(1);
      console.log(
        '[Widget]',
        this.name,
        '- Screen height:',
        screenHeight,
        '| Coverage:',
        coverage + '%',
      );
    }

    // Scale in X,Y with Z=1 (no Z scaling)
    mat4.fromScaling(sc, finalScale);

    // Rotation only on Z axis
    mat4.fromZRotation(rot, this.rotation);

    // Correct order for 2D UI: local = translation * rotation * scale * pivot
    // This ensures position is in pixels, unaffected by scale
    mat4.multiply(this.local, tr, rot); // local = tr * rot
    mat4.multiply(this.local, this.local, sc); // local = (tr * rot) * sc
    mat4.multiply(this.local, this.local, this.pivot); // local = (tr * rot * sc) * pivot

    // Log final matrix translation and scale for debugging
    if (this.anchorType !== undefined && this.name === 'background') {
      console.log(
        '[Widget]',
        this.name,
        '- Final matrix - Translation:',
        this.local[12].toFixed(1),
        this.local[13].toFixed(1),
        '| Scale:',
        this.local[0].toFixed(1),
        this.local[5].toFixed(1),
      );
    }
  }

  /**
   * Compute absolute (world) matrix with parent hierarchy.
   * Formula: absolute = parent ? local * parent.absolute : local
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
    vec3.set(this.baseScale, x, y, 1);
    vec3.set(this.scale, x, y, 1);
  }

  public setRotation(radians: number): void {
    this.rotation = radians;
  }

  public setParentWidget(parent: Widget | null): void {
    this.parent = parent;
  }

  // Anchor system setters (Phase 2)
  public setAnchor(anchor: AnchorType, offsetX: number = 0, offsetY: number = 0): void {
    this.anchorType = anchor;
    vec2.set(this.anchorOffset, offsetX, offsetY);
  }

  public clearAnchor(): void {
    this.anchorType = undefined;
    vec2.set(this.anchorOffset, 0, 0);
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

  // Anchor system getters (Phase 2)
  public getAnchor(): AnchorType | undefined {
    return this.anchorType;
  }
  public getAnchorOffset(): vec2 {
    return this.anchorOffset;
  }

  // Getters for transformation matrices
  public getLocal(): mat4 {
    return this.local;
  }

  public getAbsolute(): mat4 {
    return this.absolute;
  }

  public getPivotMatrix(): mat4 {
    return this.pivot;
  }

  // ============================================================================
  // INPUT DETECTION SUPPORT
  // ============================================================================

  /**
   * Get widget size for AABB collision detection.
   * Returns size from params, scaled by current scale transform.
   * Subclasses can override for dynamic sizes.
   *
   * @returns vec2 with width and height in UI space
   */
  public getSize(): vec2 {
    const baseSize = this.params.size || { x: 1.0, y: 1.0 };
    // Apply scale transform to base size
    return vec2.fromValues(baseSize.x * this.scale[0], baseSize.y * this.scale[1]);
  }

  /**
   * Set input event callbacks.
   */
  public setOnMouseEnter(callback: () => void): void {
    this.onMouseEnter = callback;
  }

  public setOnMouseLeave(callback: () => void): void {
    this.onMouseLeave = callback;
  }

  public setOnClick(callback: () => void): void {
    this.onClick = callback;
  }
}
