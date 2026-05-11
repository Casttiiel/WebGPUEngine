import { vec3, vec4 } from 'gl-matrix';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import type { IMovementController } from './IMovementController';
import { TransformComponent } from '../../core/TransformComponent';
import { GrappleTargetType } from '../../../types/GrappleTargetType.enum';
import { Engine } from '../../../core/engine/Engine';
import type { ColliderComponent } from '../../physics/ColliderComponent';
import { GrappleTargetComponent } from '../GrappleTargetComponent';

export interface GrappleSystemData {
  /** Distance threshold (metres) at which arrival is detected. Default 0.4. */
  grappleArrivalDistance?: number;

  // ─ Duration ────────────────────────────────────────────────────
  /** Minimum travel duration (seconds). Short grapples are never faster than this. Default 0.25. */
  grappleMinDuration?: number;
  /** Maximum travel duration (seconds). Long grapples are never slower than this. Default 0.7. */
  grappleMaxDuration?: number;
  /** Reference distance (metres) that maps to grappleMaxDuration. Default 15. */
  grappleReferenceDistance?: number;

  // ─ Arc (BÃ©zier control points) ──────────────────────────────────
  /**
   * Global arc intensity multiplier [0..1]. Scales all Bezier control-point
   * offsets. 0 = straight line, 1 = full arc. Default 0.35.
   */
  grappleArcIntensity?: number;
  /**
   * Vertical lift applied to CP1 when destination is higher than origin
   * (expressed as a fraction of the total distance). Default 0.55.
   */
  grappleArcLiftFactor?: number;
  /**
   * Forward/down offset for CP1 when destination is lower/same level
   * (fraction of distance). Default 0.3.
   */
  grappleArcSwingFactor?: number;

  // ─ Ease curve ────────────────────────────────────────────────
  /**
   * Ease-in exponent: higher = stronger acceleration at the start. Default 3.
   * Applies over the first grappleEaseInEnd fraction of the motion.
   */
  grappleEaseInPow?: number;
  /**
   * Ease-out exponent: higher = softer deceleration at arrival. Default 2.
   * Applies over the last (1 - grappleEaseOutStart) fraction of the motion.
   */
  grappleEaseOutPow?: number;
  /** Normalised t at which the ease-in phase ends. Default 0.30. */
  grappleEaseInEnd?: number;
  /** Normalised t at which the ease-out phase begins. Default 0.70. */
  grappleEaseOutStart?: number;

  // ─ Momentum transfer ────────────────────────────────────────────
  /** Fraction of grapple exit velocity transferred as horizontal/vertical impulse. Default 0.8. */
  grappleMomentumTransfer?: number;
  /**
   * When chaining grapples (activating before landing), accumulated momentum
   * is scaled by this factor to prevent runaway speed. Default 0.5.
   */
  grappleChainMomentumScale?: number;

  // ─ Charges ────────────────────────────────────────────────────
  /** Maximum number of grapple charges. Default 3. */
  grappleMaxCharges?: number;
  /** Time (seconds) to recharge one charge after use. Default 2. */
  grappleRechargeTime?: number;
  /** Brief delay (seconds) between activation and launch â€” the "reaching" phase. Default 0.08. */
  grappleReachingDuration?: number;
}

/** Internal phases of the Far Reach ability (Dishonored 2 style). */
const enum FarReachPhase {
  /** Ability is not active. */
  INACTIVE,
  /**
   * Brief pause before the player is launched (~0.1 s).
   * In full implementations, the "tentacle" VFX extends during this phase.
   */
  REACHING,
  /** Player is flying toward the target with reduced gravity. */
  PULLING,
}

/**
 * GrappleSystem â€” Far Reach (Dishonored 2 style).
 *
 * Behaviour:
 *  1. REACHING  â€” short delay after activation (~0.1 s). Player stays still.
 *  2. PULLING   â€” player receives an initial launch velocity toward the target
 *                 (with an upward bias to create an arc). Reduced gravity is
 *                 applied each frame instead of normal gravity.
 *  3. Arrival   â€” when the player is within arrivalDistance of the target the
 *                 grapple ends and the controller resumes normal physics.
 *
 * The controller is responsible for:
 *  - Calling tryActivate() from IDLE state when the ability input fires.
 *  - Routing movement through getGrappleVelocity() while GRAPPLING.
 */
export class GrappleSystem {
  private readonly arrivalDistance: number;
  private readonly minDuration: number;
  private readonly maxDuration: number;
  private readonly referenceDistance: number;
  private readonly easeInPow: number;
  private readonly easeOutPow: number;
  private readonly easeInEnd: number;
  private readonly easeOutStart: number;
  private readonly momentumTransfer: number;
  private readonly reachingDuration: number;
  private readonly rechargeTime: number;

  // ─ Charges ──────────────────────────────────────────────────────────────
  private maxCharges: number;
  private chargeCount: number;
  private rechargeTimers: number[] = [];

  // ─ Phase ────────────────────────────────────────────────────────────────
  private phase: FarReachPhase = FarReachPhase.INACTIVE;
  private reachingTimer: number = 0;
  private currentTargetType: GrappleTargetType = GrappleTargetType.LEDGE;
  public trailOnlyMode: boolean = false;

  // ─ Bezier travel state ──────────────────────────────────────────────────
  private targetPoint: vec3 = vec3.create();
  private startPoint: vec3 = vec3.create();
  private visualTargetPoint: vec3 = vec3.create();
  /** Bezier control point 1 (near origin). */
  private cp1: vec3 = vec3.create();
  /** Bezier control point 2 (near destination). */
  private cp2: vec3 = vec3.create();
  /** Normalised travel progress [0..1]. */
  private travelT: number = 0;
  /** Total duration of the current grapple in seconds. */
  private travelDuration: number = 0;
  /** Position on the curve at the previous frame, for velocity derivation. */
  private prevCurvePos: vec3 = vec3.create();
  /** Velocity vector derived from curve derivative, exposed via getGrappleVelocity(). */
  private currentVelocity: vec3 = vec3.create();
  /** Accumulated momentum from a previous grapple that hasn't been consumed yet. */
  private pendingChainMomentum: vec3 = vec3.create();

  // ─ Snap targeting ───────────────────────────────────────────────────────
  private pendingTarget: {
    point: vec3;
    visualPoint: vec3;
    type: GrappleTargetType;
    /** NDC X in [-1, 1] and NDC Y in [-1, 1] of the visualPoint this frame. */
    ndcX: number;
    ndcY: number;
  } | null = null;

  /** Cosine of the max allowed angle between camera forward and a hook target direction (~45Â°). */
  private static readonly HOOK_CONE_COS_THRESHOLD = Math.cos((45 * Math.PI) / 180);

  /**
   * Devuelve el punto del segmento [segA, segB] más cercano al ray (origin, dir).
   * Puramente geométrico, sin colliders.
   */
  private static closestPointOnSegmentToRay(
    rayOrigin: vec3,
    rayDir: vec3,
    segA: vec3,
    segB: vec3,
  ): vec3 {
    const d = vec3.subtract(vec3.create(), segB, segA);
    const w = vec3.subtract(vec3.create(), segA, rayOrigin);

    const a = vec3.dot(d, d);
    const b = vec3.dot(d, rayDir);
    const c = vec3.dot(rayDir, rayDir);
    const e = vec3.dot(d, w);
    const f = vec3.dot(rayDir, w);

    const denom = a * c - b * b;
    // Si denom ≈ 0 el ray y el segmento son (casi) paralelos → midpoint como fallback.
    const t = denom > 1e-6 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0.5;

    return vec3.scaleAndAdd(vec3.create(), segA, d, t);
  }

  constructor(
    private readonly controller: IMovementController,
    data: GrappleSystemData = {},
  ) {
    this.arrivalDistance = data.grappleArrivalDistance ?? 0.8;
    this.minDuration = data.grappleMinDuration ?? 0.15;
    this.maxDuration = data.grappleMaxDuration ?? 0.45;
    this.referenceDistance = data.grappleReferenceDistance ?? 15;
    this.easeInPow = data.grappleEaseInPow ?? 4;
    this.easeOutPow = data.grappleEaseOutPow ?? 1.5;
    this.easeInEnd = data.grappleEaseInEnd ?? 0.3;
    this.easeOutStart = data.grappleEaseOutStart ?? 0.8;
    this.momentumTransfer = data.grappleMomentumTransfer ?? 0.9;
    this.reachingDuration = data.grappleReachingDuration ?? 0.5;
    this.rechargeTime = data.grappleRechargeTime ?? 2;
    this.maxCharges = data.grappleMaxCharges ?? 3;
    this.chargeCount = this.maxCharges;
  }

  /**
   * Activates Far Reach toward the given world-space point.
   *
   * @param point        Movement destination (capsule-centre aligned).
   * @param visualTarget Raw raycast hit point for VFX. Defaults to `point` if omitted.
   * @param targetType   Classified surface type that drives arrival behaviour.
   */
  public startGrapple(
    point: vec3,
    visualTarget?: vec3,
    targetType: GrappleTargetType = GrappleTargetType.LEDGE,
  ): boolean {
    if (this.phase !== FarReachPhase.INACTIVE) return false;
    if (this.chargeCount <= 0) return false;

    const playerPos = this.getPlayerPos();
    const dist = vec3.distance(playerPos, point);

    this.currentTargetType = targetType;
    this.rechargeTimers.push(this.rechargeTime);

    vec3.copy(this.targetPoint, point);
    vec3.copy(this.startPoint, playerPos);
    vec3.copy(this.visualTargetPoint, visualTarget ?? point);
    vec3.copy(this.prevCurvePos, playerPos);

    if (this.trailOnlyMode) {
      vec3.zero(this.currentVelocity);
      this.phase = FarReachPhase.REACHING;
      this.reachingTimer = this.reachingDuration;
      return true;
    }

    // Duration scales linearly with distance, clamped to [minDuration, maxDuration].
    this.travelDuration = Math.min(
      this.maxDuration,
      Math.max(this.minDuration, (dist / this.referenceDistance) * this.maxDuration),
    );

    // Build Bezier control points.
    this.computeControlPoints(playerPos, point, dist);

    vec3.zero(this.pendingChainMomentum);

    this.travelT = 0;
    this.controller.setVerticalVelocity(0);
    vec3.zero(this.currentVelocity);

    this.phase = FarReachPhase.REACHING;
    this.reachingTimer = this.reachingDuration;
    this.controller.setIsGrappling(true);

    return true;
  }

  /**
   * Called every frame while movementState === GRAPPLING.
   * Returns true while active, false when the grapple ends.
   */
  public update(dt: number): boolean {
    // In trail-only mode the controller stays in IDLE, so we drive the phase
    // directly without checking getIsGrappling().
    if (!this.trailOnlyMode && !this.controller.getIsGrappling()) return false;

    switch (this.phase) {
      case FarReachPhase.REACHING:
        return this.updateReaching(dt);
      case FarReachPhase.PULLING:
        return this.updatePulling(dt);
      default:
        this.endGrapple();
        return false;
    }
  }

  /** Velocity to pass to applyMovement() this frame. */
  public getGrappleVelocity(): vec3 {
    return this.currentVelocity;
  }

  /**
   * Cancels the grapple without calling setIsGrappling on the controller.
   * Use this when an external system has already changed movementState.
   */
  public cancel(): void {
    if (this.phase === FarReachPhase.PULLING) {
      // Store velocity as pending chain momentum for the next grapple.
      vec3.scale(this.pendingChainMomentum, this.currentVelocity, this.momentumTransfer);
    } else {
      vec3.zero(this.pendingChainMomentum);
    }
    this.phase = FarReachPhase.INACTIVE;
    vec3.zero(this.currentVelocity);
  }

  // ──────────────────────────────────────────────────────────
  // PRIVATE
  // ──────────────────────────────────────────────────────────

  private updateReaching(dt: number): boolean {
    this.reachingTimer -= dt;
    vec3.zero(this.currentVelocity);

    if (this.reachingTimer <= 0) {
      if (this.trailOnlyMode) {
        this.phase = FarReachPhase.INACTIVE;
        return false;
      }
      this.phase = FarReachPhase.PULLING;
    }
    return true;
  }

  private updatePulling(dt: number): boolean {
    this.travelT += dt / this.travelDuration;

    if (this.travelT >= 1.0) {
      this.travelT = 1.0;
      // Transfer momentum to controller before ending.
      this.transferMomentum();
      this.endGrapple();
      return false;
    }

    const easedT = this.easeT(this.travelT);
    const curPos = this.evalBezier(easedT);

    // Arrival check: close enough to end of curve.
    const remaining = vec3.distance(curPos, this.targetPoint);
    if (remaining <= this.arrivalDistance) {
      this.transferMomentum();
      this.endGrapple();
      return false;
    }

    // Velocity = (curPos - prevCurvePos) / dt
    vec3.subtract(this.currentVelocity, curPos, this.prevCurvePos);
    vec3.scale(this.currentVelocity, this.currentVelocity, 1 / dt);

    vec3.copy(this.prevCurvePos, curPos);
    return true;
  }

  // ── Bezier helpers ────────────────────────────────────────────────────────

  /**
   * Computes CP1 and CP2 based on the geometry between start and end.
   * All offsets are scaled by arcIntensity * dist so the arc magnitude is
   * proportional to the distance.
   */
  private computeControlPoints(origin: vec3, dest: vec3, _dist: number): void {
    // Straight line: place control points at 1/3 and 2/3 along the segment.
    vec3.lerp(this.cp1, origin, dest, 1 / 3);
    vec3.lerp(this.cp2, origin, dest, 2 / 3);
  }

  /**
   * Evaluates the cubic Bezier at t \u2208 [0,1].
   * B(t) = (1-t)^3 P0 + 3(1-t)^2 t CP1 + 3(1-t) t^2 CP2 + t^3 P3
   */
  private evalBezier(t: number): vec3 {
    const u = 1 - t;
    const u2 = u * u;
    const u3 = u2 * u;
    const t2 = t * t;
    const t3 = t2 * t;
    return vec3.fromValues(
      u3 * this.startPoint[0] +
        3 * u2 * t * this.cp1[0] +
        3 * u * t2 * this.cp2[0] +
        t3 * this.targetPoint[0],
      u3 * this.startPoint[1] +
        3 * u2 * t * this.cp1[1] +
        3 * u * t2 * this.cp2[1] +
        t3 * this.targetPoint[1],
      u3 * this.startPoint[2] +
        3 * u2 * t * this.cp1[2] +
        3 * u * t2 * this.cp2[2] +
        t3 * this.targetPoint[2],
    );
  }

  /**
   * Asymmetric ease curve:
   *  [0 .. easeInEnd]       â€” ease-in  (pow = easeInPow)
   *  [easeInEnd .. easeOutStart] â€” linear
   *  [easeOutStart .. 1]    â€” ease-out (pow = easeOutPow)
   */
  private easeT(t: number): number {
    const i = this.easeInEnd;
    const o = this.easeOutStart;

    if (t <= i) {
      // Normalise to [0,1] within the ease-in window, apply pow, then map back.
      const n = t / i;
      return Math.pow(n, this.easeInPow) * i;
    }
    if (t >= o) {
      // Normalise to [0,1] within the ease-out window, apply inverse pow.
      const n = (t - o) / (1 - o);
      return o + (1 - Math.pow(1 - n, this.easeOutPow)) * (1 - o);
    }
    // Linear mid-section.
    return t;
  }

  /** Applies exit velocity as momentum to the character controller. */
  private transferMomentum(): void {
    const exitVel = vec3.scale(vec3.create(), this.currentVelocity, this.momentumTransfer);
    // Store for potential chain usage.
    vec3.copy(this.pendingChainMomentum, exitVel);
    // Transfer horizontal into controller.
    const hVel = this.controller.getHorizontalVelocity();
    vec3.set(hVel, exitVel[0], 0, exitVel[2]);
    this.controller.setHorizontalVelocity(hVel);
    this.controller.setVerticalVelocity(exitVel[1]);
  }

  private getPlayerPos(): vec3 {
    const t = this.controller
      .getCollider()
      .getOwner()
      .getComponent('transform') as TransformComponent | null;
    return t ? t.getTransform().getWorldPosition() : vec3.create();
  }

  private endGrapple(): void {
    this.phase = FarReachPhase.INACTIVE;
    vec3.zero(this.currentVelocity);
    this.controller.setIsGrappling(false);
  }

  // ── Snap targeting ──────────────────────────────────────────────────────

  /**
   * Scans in-range GrappleHookComponent entities every frame (call from IDLE).
   *
   * Pipeline:
   *  1. Iterate only entities whose sphere trigger reports the player inside.
   *  2. Skip if behind the camera (dot < 0) or outside the 45° cone.
   *  3. LOS raycast — skip if occluded by solid geometry.
   *  4. Score by centrality (60%) + proximity (40%) and keep the best.
   *
   * Result is stored internally and readable via getPendingTarget().
   */
  public updatePendingTarget(): void {
    const cameraComp = this.controller.getCamera();
    if (!cameraComp) {
      this.pendingTarget = null;
      return;
    }

    const cam = cameraComp.getCamera();
    const origin = cam.getPosition();
    const front = cam.getFront();

    const world = Engine.getPhysics().getWorld();
    const capsuleRapierCollider = this.controller.getCollider().getCollider();
    const playerEntityId = this.controller.getCollider().getOwner().id;
    const coneThreshold = GrappleSystem.HOOK_CONE_COS_THRESHOLD;

    let bestCandidate: {
      point: vec3;
      visualPoint: vec3;
      type: GrappleTargetType;
      score: number;
      ndcX: number;
      ndcY: number;
    } | null = null;

    for (const hookComp of GrappleTargetComponent.getInRangeComponents(playerEntityId)) {
      const entity = hookComp.getOwner();

      // Obtiene el segmento en world space (degenerado a un punto si shape === POINT).
      const { a, b } = hookComp.getWorldSegment();

      // ── Cono check preliminar (vs. centro del segmento) ─────────────────────
      const center = vec3.lerp(vec3.create(), a, b, 0.5);
      const toCenter = vec3.subtract(vec3.create(), center, origin);
      const distToCenter = vec3.length(toCenter);
      if (distToCenter < 0.1) continue;

      const dirToCenter = vec3.scale(vec3.create(), toCenter, 1 / distToCenter);
      const dot = vec3.dot(front, dirToCenter);
      if (dot < coneThreshold) continue;

      // ── Punto de agarre real ─────────────────────────────────────────────────
      // Para POINT: a === b, la función devuelve ese único punto.
      // Para SEGMENT: devuelve el punto de la barra más cercano a la línea de visión.
      const graspPoint = GrappleSystem.closestPointOnSegmentToRay(origin, front, a, b);

      // ── LOS hacia graspPoint ─────────────────────────────────────────────────
      const toGrasp = vec3.subtract(vec3.create(), graspPoint, origin);
      const distToGrasp = vec3.length(toGrasp);
      if (distToGrasp < 0.1) continue;

      const dirToGrasp = vec3.scale(vec3.create(), toGrasp, 1 / distToGrasp);

      // LOS: exclude sensors, the player capsule, and the hook's own sphere collider.
      const hookColliderComp = entity.getComponent('sphere_collider') as ColliderComponent | null;
      const hookCol = hookColliderComp?.getCollider();
      const occluded = world.castRay(
        new RAPIER.Ray(
          { x: origin[0], y: origin[1], z: origin[2] },
          { x: dirToGrasp[0], y: dirToGrasp[1], z: dirToGrasp[2] },
        ),
        distToGrasp - 0.05,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        undefined,
        undefined,
        (col: RAPIER.Collider) =>
          col.handle !== capsuleRapierCollider.handle &&
          (!hookCol || col.handle !== hookCol.handle),
      );
      if (occluded) continue;

      // ── Score en base al graspPoint ──────────────────────────────────────────
      const dotGrasp = vec3.dot(front, dirToGrasp);
      const centerScore = (dotGrasp - coneThreshold) / (1 - coneThreshold);
      const proximityScore = Math.max(0, 1 - distToGrasp / this.referenceDistance);
      const score = centerScore * 0.6 + proximityScore * 0.4;

      if (!bestCandidate || score > bestCandidate.score) {
        // Compute NDC of graspPoint here, using the same camera, before storing.
        const vp = cam.getUnjitteredViewProjection();
        const clip = vec4.fromValues(graspPoint[0], graspPoint[1], graspPoint[2], 1.0);
        vec4.transformMat4(clip, clip, vp);
        const targetNdcX = clip[3] > 0 ? clip[0] / clip[3] : 0;
        const targetNdcY = clip[3] > 0 ? clip[1] / clip[3] : 0;

        bestCandidate = {
          point: graspPoint,
          visualPoint: graspPoint,
          type: hookComp.getHookType(),
          score,
          ndcX: targetNdcX,
          ndcY: targetNdcY,
        };
      }
    }

    this.pendingTarget = bestCandidate
      ? {
          point: bestCandidate.point,
          visualPoint: bestCandidate.visualPoint,
          type: bestCandidate.type,
          ndcX: bestCandidate.ndcX,
          ndcY: bestCandidate.ndcY,
        }
      : null;
  }

  /** Returns the current best grapple candidate, or null if none is in range. */
  public getPendingTarget(): {
    point: vec3;
    visualPoint: vec3;
    type: GrappleTargetType;
    ndcX: number;
    ndcY: number;
  } | null {
    return this.pendingTarget;
  }

  /** Current available charges. */
  public getCharges(): number {
    return this.chargeCount;
  }

  /** Maximum charges (default 3, unlockable to 5). */
  public getMaxCharges(): number {
    return this.maxCharges;
  }

  /**
   * Normalised recharge progress [0..1] for the i-th used charge (0 = just used, 1 = recharged).
   * Used by the HUD to animate the fill animation per slot.
   */
  public getRechargeProgress(index: number): number {
    const timer = this.rechargeTimers[index];
    if (timer === undefined) return 1;
    return 1 - timer / this.rechargeTime;
  }

  /** Expand max charges â€” call from the progression system. */
  public setMaxCharges(n: number): void {
    const delta = n - this.maxCharges;
    this.maxCharges = n;
    if (delta > 0) this.chargeCount = Math.min(this.chargeCount + delta, this.maxCharges);
  }

  /**
   * Advances per-charge recharge timers. Must be called every frame from the
   * controller regardless of movement state.
   */
  public tickRecharge(dt: number): void {
    for (let i = this.rechargeTimers.length - 1; i >= 0; i--) {
      const t = this.rechargeTimers[i]!;
      this.rechargeTimers[i] = t - dt;
      if (this.rechargeTimers[i]! <= 0) {
        this.chargeCount = Math.min(this.chargeCount + 1, this.maxCharges);
        this.rechargeTimers.splice(i, 1);
      }
    }
  }

  // ── Target type ───────────────────────────────────────────

  /** The grapple target type set on the last successful startGrapple() call. */
  public getTargetType(): GrappleTargetType {
    return this.currentTargetType;
  }

  /** World-space position of the player at the moment the grapple was activated. */
  public getStartPoint(): vec3 {
    return this.startPoint;
  }

  /** World-space position of the grapple target (movement destination, capsule-center). */
  public getTargetPoint(): vec3 {
    return this.targetPoint;
  }

  /** World-space position of the raw raycast hit point â€” used for VFX alignment. */
  public getVisualTargetPoint(): vec3 {
    return this.visualTargetPoint;
  }

  /**
   * Normalised progress of the current phase:
   *  - INACTIVE   0
   *  - REACHING  0-1
   *  - PULLING   1
   */
  public getReachProgress(): number {
    if (this.phase === FarReachPhase.INACTIVE) return 0;
    if (this.phase === FarReachPhase.PULLING) return 1;
    // REACHING: 0 at start, 1 when timer expires
    return 1 - this.reachingTimer / this.reachingDuration;
  }

  /** True while the ability is in REACHING or PULLING phase. */
  public isActive(): boolean {
    return this.phase !== FarReachPhase.INACTIVE;
  }

  /** True only while the player is being pulled toward the target. */
  public isPulling(): boolean {
    return this.phase === FarReachPhase.PULLING;
  }
}
