import { quat, vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { TransformComponent } from '../core/TransformComponent';
import { InputManager } from '../../core/input/InputManager';
import { GameAction } from '../../types/GameAction.enum';
import { ViewModelAnimator } from './ViewModelAnimator';
import { ViewModelAnimationData } from '../../types/ViewModelAnimation.type';
import { ProceduralViewModelSystem, ProceduralViewModelConfig } from './ProceduralViewModelSystem';

// ── Slot definition ────────────────────────────────────────────────────────

export interface ViewModelSlot {
  /** Entity name that holds the ViewModelMeshComponent for this slot */
  entityName: string;
  /** Base position offset from camera origin in camera space (metres) */
  socketOffset: [number, number, number];
  /** Base rotation offset in degrees [pitch, yaw, roll] */
  socketRotation: [number, number, number];
  /** Optional clip data path (relative to assets/data/) */
  animationDataPath?: string;
}

export interface ViewModelComponentData {
  /** Right-hand slot (primary weapon / sword) */
  rightHand?: ViewModelSlot;
  /** Left-hand slot (secondary weapon / dagger / shield) */
  leftHand?: ViewModelSlot;
  /** Procedural motion configuration */
  procedural?: ProceduralViewModelConfig;
}

// ── Runtime slot state ─────────────────────────────────────────────────────

interface RuntimeSlot {
  entityName: string;
  socketOffset: vec3;
  socketRotation: quat;
  animator: ViewModelAnimator;
  transform: TransformComponent | null;
  /** Scale read from the entity's TransformComponent once resolved — preserved across frames */
  baseScale: vec3;
  /** Rotation read from the entity's TransformComponent once resolved — applied on top of socketRotation */
  baseRotation: quat;
}

/**
 * ViewModelComponent
 *
 * Attach to MainCamera (or any entity with a CameraComponent).
 *
 * Manages two weapon slots (rightHand, leftHand). Each slot:
 *  1. Resolves the slot entity's TransformComponent.
 *  2. Updates its world matrix each frame to reflect:
 *       socketOffset + animatorOffset + proceduralOffset
 *     expressed in the ViewModelPass camera space (identity view → world IS camera space).
 *  3. Provides access to per-slot ViewModelAnimators for gameplay code.
 *  4. Delegates procedural motion (sway / bob / breathing / landing / recoil) to
 *     ProceduralViewModelSystem.
 *
 * Usage:
 *   const vm = entity.getComponent('view_model') as ViewModelComponent;
 *   vm.getRightAnimator()?.play('attack', 0.1);
 *   vm.triggerRecoil();
 */
export class ViewModelComponent extends Component {
  private rightHand: RuntimeSlot | null = null;
  private leftHand: RuntimeSlot | null = null;
  private procSystem: ProceduralViewModelSystem = new ProceduralViewModelSystem();

  // Scratch vectors (avoid per-frame allocations)
  private readonly _animPos: vec3 = vec3.create();
  private readonly _animRot: quat = quat.create();
  private readonly _finalPos: vec3 = vec3.create();
  private readonly _finalRot: quat = quat.create();
  private readonly _finalScale: vec3 = vec3.create();

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  public async load(data: ViewModelComponentData): Promise<void> {
    if (data.procedural) {
      this.procSystem.configure(data.procedural);
    }

    if (data.rightHand) {
      this.rightHand = await this.buildSlot(data.rightHand);
    }
    if (data.leftHand) {
      this.leftHand = await this.buildSlot(data.leftHand);
    }
  }

  public update(dt: number): void {
    // Gather mouse delta from the input module (raw pixels).
    // Normalize so a typical fast mouse movement (~10 px/frame) maps to ≈1.0,
    // which is the expected range for ProceduralViewModelSystem.updateSway().
    const rawDelta = Engine.getInput().getMouseDelta();
    const NORM = 0.1; // px → normalized sway input
    const mouseDX = rawDelta.x * NORM;
    const mouseDY = rawDelta.y * NORM;

    // Estimate move speed from camera movement direction usage
    const im = InputManager.getInstance();
    const moveX =
      im.getActionValue(GameAction.MOVE_RIGHT) - im.getActionValue(GameAction.MOVE_LEFT);
    const moveZ =
      im.getActionValue(GameAction.MOVE_FORWARD) - im.getActionValue(GameAction.MOVE_BACKWARD);
    const moveSpeed = Math.sqrt(moveX * moveX + moveZ * moveZ); // 0–√2, good proxy

    const procPose = this.procSystem.update(dt, mouseDX, mouseDY, moveSpeed);

    if (this.rightHand) this.updateSlot(this.rightHand, procPose.posOffset, procPose.rotOffset, dt);
    if (this.leftHand) this.updateSlot(this.leftHand, procPose.posOffset, procPose.rotOffset, dt);
  }

  public dispose(): void {
    this.rightHand = null;
    this.leftHand = null;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  public getRightAnimator(): ViewModelAnimator | null {
    return this.rightHand?.animator ?? null;
  }

  public getLeftAnimator(): ViewModelAnimator | null {
    return this.leftHand?.animator ?? null;
  }

  /** Trigger recoil spring (call on weapon fire). */
  public triggerRecoil(): void {
    this.procSystem.triggerRecoil();
  }

  /** Trigger landing impact spring. intensity ∈ [0,1]. */
  public triggerLanding(intensity: number = 1.0): void {
    this.procSystem.triggerLanding(intensity);
  }

  public getProceduralSystem(): ProceduralViewModelSystem {
    return this.procSystem;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async buildSlot(slotData: ViewModelSlot): Promise<RuntimeSlot> {
    const socketOffset = vec3.fromValues(
      slotData.socketOffset[0],
      slotData.socketOffset[1],
      slotData.socketOffset[2],
    );

    const socketRotation = quat.create();
    // pitch=X, yaw=Y, roll=Z in degrees → quat
    quat.fromEuler(
      socketRotation,
      slotData.socketRotation[0],
      slotData.socketRotation[1],
      slotData.socketRotation[2],
    );

    const animator = new ViewModelAnimator();

    if (slotData.animationDataPath) {
      try {
        const resp = await fetch(`/assets/data/${slotData.animationDataPath}`);
        const animData = (await resp.json()) as ViewModelAnimationData;
        animator.loadData(animData);
        if (animator.hasClip('idle')) animator.play('idle');
      } catch (e) {
        console.warn(
          `ViewModelComponent: failed to load animation '${slotData.animationDataPath}'`,
          e,
        );
      }
    }

    // Resolve entity transform (may not be present at load time, retry in update)
    const entity = Engine.getEntities().getEntityByName(slotData.entityName);
    const transform = (entity?.getComponent('transform') as TransformComponent) ?? null;
    const baseScale = transform
      ? vec3.clone(transform.getTransform().getLocalScale())
      : vec3.fromValues(1, 1, 1);
    const baseRotation = transform
      ? quat.clone(transform.getTransform().getLocalRotation())
      : quat.create();

    return {
      entityName: slotData.entityName,
      socketOffset,
      socketRotation,
      animator,
      transform,
      baseScale,
      baseRotation,
    };
  }

  private updateSlot(slot: RuntimeSlot, procPos: vec3, procRot: quat, dt: number): void {
    // Lazy-resolve the transform if it wasn't available at load time
    if (!slot.transform) {
      const entity = Engine.getEntities().getEntityByName(slot.entityName);
      if (!entity) return;
      slot.transform = entity.getComponent('transform') as TransformComponent;
      if (!slot.transform) return;
      // Capture initial scale and rotation now that the transform is resolved
      vec3.copy(slot.baseScale, slot.transform.getTransform().getLocalScale());
      quat.copy(slot.baseRotation, slot.transform.getTransform().getLocalRotation());
    }

    // Advance animator
    const animPose = slot.animator.update(dt);
    vec3.copy(this._animPos, animPose.position);
    quat.copy(this._animRot, animPose.rotation);

    // Final position = socketOffset + animOffset + proceduralOffset
    vec3.add(this._finalPos, slot.socketOffset, this._animPos);
    vec3.add(this._finalPos, this._finalPos, procPos);

    // Final rotation = socketRotation * baseRotation * animRot * procRot
    // baseRotation preserves the model's rotation set in level-1.json (or any scene file)
    quat.multiply(this._finalRot, slot.socketRotation, slot.baseRotation);
    quat.multiply(this._finalRot, this._finalRot, this._animRot);
    quat.multiply(this._finalRot, this._finalRot, procRot);
    quat.normalize(this._finalRot, this._finalRot);

    // Final scale = entity base scale × animator scale
    vec3.multiply(this._finalScale, slot.baseScale, animPose.scale);

    // Set P/R/S directly — avoids mat4 decomposition artifacts with non-uniform scale
    const t = slot.transform.getTransform();
    t.setLocalPosition(this._finalPos);
    t.setLocalRotation(this._finalRot);
    t.setLocalScale(this._finalScale);
    slot.transform.update();
  }
}
