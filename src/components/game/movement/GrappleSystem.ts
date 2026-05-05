import { vec3 } from 'gl-matrix';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import type { IMovementController } from './IMovementController';
import { TransformComponent } from '../../core/TransformComponent';
import { GrappleTargetType } from '../../../types/GrappleTargetType.enum';
import { Engine } from '../../../core/engine/Engine';
import type { ColliderComponent } from '../../physics/ColliderComponent';

export interface GrappleSystemData {
  /** Maximum range (metres) for the Far Reach raycast. Default 20. */
  grappleMaxDistance?: number;
  /** Target travel time (seconds) from launch to arrival. Default 0.35. */
  grappleTravelTime?: number;
  /** Minimum upward component of the launch direction (prevents flat trajectories). Default 0.2. */
  grappleUpwardBias?: number;
  /** Reduced gravity applied during flight (m/s²). Default -8. */
  grappleFlightGravity?: number;
  /** Brief delay (seconds) between activation and launch — the "reaching" phase. Default 0.1. */
  grappleReachingDuration?: number;
  /** Distance threshold (metres) at which the grapple ends on arrival. Default 0.8. */
  grappleArrivalDistance?: number;
  /** Safety timeout (seconds) before the grapple is forcefully cancelled. Default 2.0. */
  grappleMaxDuration?: number;
  /** Maximum number of grapple charges. Default 3. */
  grappleMaxCharges?: number;
  /** Time (seconds) to recharge one charge after use. Default 8. */
  grappleRechargeTime?: number;
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
 * GrappleSystem — Far Reach (Dishonored 2 style).
 *
 * Behaviour:
 *  1. REACHING  — short delay after activation (~0.1 s). Player stays still.
 *  2. PULLING   — player receives an initial launch velocity toward the target
 *                 (with an upward bias to create an arc). Reduced gravity is
 *                 applied each frame instead of normal gravity.
 *  3. Arrival   — when the player is within arrivalDistance of the target the
 *                 grapple ends and the controller resumes normal physics.
 *
 * The controller is responsible for:
 *  - Calling tryActivate() from IDLE state when the ability input fires.
 *  - Routing movement through getGrappleVelocity() while GRAPPLING.
 */
export class GrappleSystem {
  private readonly maxDistance: number;
  private readonly travelTime: number;
  private readonly upwardBias: number;
  private readonly flightGravity: number;
  private readonly reachingDuration: number;
  private readonly arrivalDistance: number;
  private readonly maxDuration: number;
  private readonly rechargeTime: number;

  // ── Charge economy ────────────────────────────────────────
  private maxCharges: number;
  private chargeCount: number;
  /** Per-used-charge recharge countdown timers (seconds remaining). */
  private rechargeTimers: number[] = [];

  private phase: FarReachPhase = FarReachPhase.INACTIVE;
  private reachingTimer: number = 0;
  private safetyTimer: number = 0;
  private currentTargetType: GrappleTargetType = GrappleTargetType.LEDGE;
  /** When true, startGrapple only plays the trail VFX — no character movement. */
  public trailOnlyMode: boolean = true;

  private targetPoint: vec3 = vec3.create();
  private startPoint: vec3 = vec3.create();
  /** Visual-only target — the raw raycast hit point (no capsule-height offset). */
  private visualTargetPoint: vec3 = vec3.create();
  /** Velocity applied each frame during PULLING. Gravity accumulates into [1]. */
  private flyVelocity: vec3 = vec3.create();
  /** Last computed velocity, exposed via getGrappleVelocity(). */
  private currentVelocity: vec3 = vec3.create();

  // ── Snap targeting ─────────────────────────────────────────────────────
  /** Best valid grapple candidate found this frame. Null if none in range. */
  private pendingTarget: {
    point: vec3;
    visualPoint: vec3;
    type: GrappleTargetType;
  } | null = null;

  /** Half-angle (radians) of the snap cone. ~10° spread. */
  private static readonly SNAP_CONE_HALF_ANGLE = (10 * Math.PI) / 180;
  /** Frames a new LEDGE/CORNER type must be stable before the change is accepted. */
  private static readonly CLASSIFICATION_DEBOUNCE_FRAMES = 4;
  /** A hit more than this multiple of minHitDist away is considered an outlier. */
  private static readonly OUTLIER_DISTANCE_FACTOR = 2.0;
  private lastClassifiedType: GrappleTargetType | null = null;
  private pendingClassificationType: GrappleTargetType | null = null;
  private classificationStableFrames: number = 0;

  constructor(
    private readonly controller: IMovementController,
    data: GrappleSystemData = {},
  ) {
    this.maxDistance = data.grappleMaxDistance ?? 10;
    this.travelTime = data.grappleTravelTime ?? 0.35;
    this.upwardBias = data.grappleUpwardBias ?? 0.2;
    this.flightGravity = data.grappleFlightGravity ?? -8;
    this.reachingDuration = data.grappleReachingDuration ?? 0.1;
    this.arrivalDistance = data.grappleArrivalDistance ?? 0.8;
    this.maxDuration = data.grappleMaxDuration ?? 2.0;
    this.maxCharges = data.grappleMaxCharges ?? 3;
    this.rechargeTime = data.grappleRechargeTime ?? 8;
    this.chargeCount = this.maxCharges;
  }

  // ──────────────────────────────────────────────────────────
  // PUBLIC API
  // ──────────────────────────────────────────────────────────

  /** Maximum reach range in metres — used by the controller for the raycast. */
  public getMaxDistance(): number {
    return this.maxDistance;
  }

  // ── Charge economy ────────────────────────────────────────

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

  /** Expand max charges — call from the progression system. */
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

  /** World-space position of the raw raycast hit point — used for VFX alignment. */
  public getVisualTargetPoint(): vec3 {
    return this.visualTargetPoint;
  }

  /**
   * Normalised progress of the current phase:
   *  - INACTIVE  → 0
   *  - REACHING  → 0→1 as the reaching timer elapses
   *  - PULLING   → 1
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
    if (dist > this.maxDistance) return false;

    this.currentTargetType = targetType;
    //this.chargeCount--;
    this.rechargeTimers.push(this.rechargeTime);

    vec3.copy(this.targetPoint, point);
    vec3.copy(this.startPoint, playerPos);
    vec3.copy(this.visualTargetPoint, visualTarget ?? point);

    console.log(
      `[GrappleSystem] START — origin: (${playerPos[0].toFixed(2)}, ${playerPos[1].toFixed(2)}, ${playerPos[2].toFixed(2)})` +
        `  target: (${point[0].toFixed(2)}, ${point[1].toFixed(2)}, ${point[2].toFixed(2)})` +
        `  dist: ${dist.toFixed(2)} m`,
    );

    if (this.trailOnlyMode) {
      // Trail-only: show VFX without moving the character.
      // Enter REACHING so the tentacle animates, but skip movement setup and
      // do NOT call setIsGrappling so the controller stays in IDLE.
      vec3.zero(this.flyVelocity);
      vec3.zero(this.currentVelocity);
      this.phase = FarReachPhase.REACHING;
      this.reachingTimer = this.reachingDuration;
      this.safetyTimer = this.maxDuration;
      return true;
    }

    // Compute launch velocity: direction with upward bias, speed = distance / travelTime.
    const toTarget = vec3.subtract(vec3.create(), point, playerPos);
    const launchDir = vec3.normalize(vec3.create(), toTarget);
    launchDir[1] = Math.max(launchDir[1], this.upwardBias);
    vec3.normalize(launchDir, launchDir);

    const speed = dist / this.travelTime;
    vec3.scale(this.flyVelocity, launchDir, speed);

    // Halt current movement so the reach starts cleanly.
    this.controller.setVerticalVelocity(0);
    vec3.zero(this.currentVelocity);

    this.phase = FarReachPhase.REACHING;
    this.reachingTimer = this.reachingDuration;
    this.safetyTimer = this.maxDuration;
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

    this.safetyTimer -= dt;
    if (this.safetyTimer <= 0) {
      this.endGrapple();
      return false;
    }

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
    const playerPos = this.getPlayerPos();
    const target = this.targetPoint;
    console.log(
      `[GrappleSystem] CANCELLED — pos: (${playerPos[0].toFixed(2)}, ${playerPos[1].toFixed(2)}, ${playerPos[2].toFixed(2)})` +
        `  target: (${target[0].toFixed(2)}, ${target[1].toFixed(2)}, ${target[2].toFixed(2)})`,
    );
    this.phase = FarReachPhase.INACTIVE;
    vec3.zero(this.currentVelocity);
    vec3.zero(this.flyVelocity);
  }

  // ──────────────────────────────────────────────────────────
  // PRIVATE
  // ──────────────────────────────────────────────────────────

  private updateReaching(dt: number): boolean {
    this.reachingTimer -= dt;
    vec3.zero(this.currentVelocity);

    if (this.reachingTimer <= 0) {
      if (this.trailOnlyMode) {
        // Trail only — end here without launching the character.
        this.phase = FarReachPhase.INACTIVE;
        return false;
      }
      this.phase = FarReachPhase.PULLING;
      const origin = this.startPoint;
      const target = this.targetPoint;
      console.log(
        `[GrappleSystem] PULLING — origin: (${origin[0].toFixed(2)}, ${origin[1].toFixed(2)}, ${origin[2].toFixed(2)})` +
          `  target: (${target[0].toFixed(2)}, ${target[1].toFixed(2)}, ${target[2].toFixed(2)})`,
      );
    }
    return true;
  }

  private updatePulling(dt: number): boolean {
    // Check arrival first.
    const playerPos = this.getPlayerPos();
    const dist = vec3.distance(playerPos, this.targetPoint);
    if (dist <= this.arrivalDistance) {
      const target = this.targetPoint;
      console.log(
        `[GrappleSystem] ARRIVED — pos: (${playerPos[0].toFixed(2)}, ${playerPos[1].toFixed(2)}, ${playerPos[2].toFixed(2)})` +
          `  target: (${target[0].toFixed(2)}, ${target[1].toFixed(2)}, ${target[2].toFixed(2)})  dist: ${dist.toFixed(2)} m`,
      );
      this.endGrapple();
      return false;
    }

    // Apply reduced gravity to the vertical component of the launch velocity.
    this.flyVelocity[1] += this.flightGravity * dt;

    vec3.copy(this.currentVelocity, this.flyVelocity);
    return true;
  }

  private getPlayerPos(): vec3 {
    const t = this.controller
      .getCollider()
      .getOwner()
      .getComponent('transform') as TransformComponent | null;
    return t ? t.getTransform().getWorldPosition() : vec3.create();
  }

  private endGrapple(): void {
    const playerPos = this.getPlayerPos();
    const target = this.targetPoint;
    console.log(
      `[GrappleSystem] END — pos: (${playerPos[0].toFixed(2)}, ${playerPos[1].toFixed(2)}, ${playerPos[2].toFixed(2)})` +
        `  target: (${target[0].toFixed(2)}, ${target[1].toFixed(2)}, ${target[2].toFixed(2)})`,
    );
    this.phase = FarReachPhase.INACTIVE;
    vec3.zero(this.currentVelocity);
    vec3.zero(this.flyVelocity);
    this.controller.setIsGrappling(false);
  }

  // ── Snap targeting ──────────────────────────────────────────────────────

  /**
   * Scans for valid grapple targets every frame (call from IDLE).
   * 5-ray cross + RING entity scan (with LOS). Scored by distance (40 %) + angular centre (60 %).
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
    const up = cam.getUp();
    const right = vec3.cross(vec3.create(), front, up);
    vec3.normalize(right, right);

    const maxDist = this.maxDistance;
    const world = Engine.getPhysics().getWorld();
    const capsuleH = this.controller.getCollider().getCapsuleHeight();
    const capsuleRapierCollider = this.controller.getCollider().getCollider();

    const spreadRad = GrappleSystem.SNAP_CONE_HALF_ANGLE;
    const coneThreshold = Math.cos(spreadRad);

    // ── 5-ray cross (named) ──────────────────────────────────────────────
    const castDir = (dir: vec3) =>
      world.castRayAndGetNormal(
        new RAPIER.Ray(
          { x: origin[0], y: origin[1], z: origin[2] },
          { x: dir[0], y: dir[1], z: dir[2] },
        ),
        maxDist,
        false,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        capsuleRapierCollider,
      );

    const dirC = vec3.clone(front);
    const dirU = vec3.normalize(
      vec3.create(),
      vec3.scaleAndAdd(vec3.create(), front, up, spreadRad),
    );
    const dirD = vec3.normalize(
      vec3.create(),
      vec3.scaleAndAdd(vec3.create(), front, up, -spreadRad),
    );
    const dirL = vec3.normalize(
      vec3.create(),
      vec3.scaleAndAdd(vec3.create(), front, right, -spreadRad),
    );
    const dirR = vec3.normalize(
      vec3.create(),
      vec3.scaleAndAdd(vec3.create(), front, right, spreadRad),
    );

    let hitC = castDir(dirC);
    let hitU = castDir(dirU);
    let hitD = castDir(dirD);
    let hitL = castDir(dirL);
    let hitR = castDir(dirR);

    const isSameSurface = (
      a: NonNullable<ReturnType<typeof castDir>>,
      b: NonNullable<ReturnType<typeof castDir>>,
    ): boolean =>
      a.normal.x * b.normal.x + a.normal.y * b.normal.y + a.normal.z * b.normal.z > 0.85;

    // minHitDistRaw from all 5 unfiltered hits — most conservative reference for outlier detection.
    const minHitDistRaw = Math.min(
      hitC?.timeOfImpact ?? Infinity,
      hitU?.timeOfImpact ?? Infinity,
      hitD?.timeOfImpact ?? Infinity,
      hitL?.timeOfImpact ?? Infinity,
      hitR?.timeOfImpact ?? Infinity,
    );

    // Pass 1: filter the four offset rays.
    // Outlier distance is only applied when the normal differs from hitC — diagonal geometry
    // on the same surface produces larger distances but identical normals, so we keep those.
    // If hitC is null, no surface reference exists → outlier based on minHitDistRaw.
    const applyHitFilters = (hit: ReturnType<typeof castDir>) => {
      if (hit === null) return null;
      //if (hit.normal.y > 0.85) return null;
      if (hitC === null || !isSameSurface(hit, hitC)) {
        if (hit.timeOfImpact > minHitDistRaw * GrappleSystem.OUTLIER_DISTANCE_FACTOR) return null; //IMPROVE
      }
      return hit;
    };

    hitC = applyHitFilters(hitC);
    hitU = applyHitFilters(hitU);
    hitD = applyHitFilters(hitD);
    hitL = applyHitFilters(hitL);
    hitR = applyHitFilters(hitR);

    const freeU = hitU === null;
    const freeD = hitD === null;
    const freeL = hitL === null;
    const freeR = hitR === null;

    const hasAnyHit =
      hitC !== null || hitU !== null || hitD !== null || hitL !== null || hitR !== null;

    let bestCandidate: {
      point: vec3;
      visualPoint: vec3;
      type: GrappleTargetType;
      score: number;
    } | null = null;

    if (hasAnyHit) {
      let surfaceType: GrappleTargetType | null = null;

      // Recursive classifier: cast 4 rays at a narrower spread to disambiguate
      // when both axes appear free. Returns null if it cannot converge.
      const classifyWithSpread = (
        currentSpread: number,
        depth: number,
      ): GrappleTargetType | null => {
        if (depth > 4 || currentSpread < 0.005) return GrappleTargetType.LEDGE;
        const dU = vec3.normalize(
          vec3.create(),
          vec3.scaleAndAdd(vec3.create(), front, up, currentSpread),
        );
        const dD = vec3.normalize(
          vec3.create(),
          vec3.scaleAndAdd(vec3.create(), front, up, -currentSpread),
        );
        const dL = vec3.normalize(
          vec3.create(),
          vec3.scaleAndAdd(vec3.create(), front, right, -currentSpread),
        );
        const dR = vec3.normalize(
          vec3.create(),
          vec3.scaleAndAdd(vec3.create(), front, right, currentSpread),
        );
        const hU = castDir(dU);
        const hD = castDir(dD);
        const hL = castDir(dL);
        const hR = castDir(dR);
        const ok = (h: ReturnType<typeof castDir>) => h !== null && h.normal.y <= 0.85;
        const vFree = !ok(hU) || !ok(hD);
        const lFree = !ok(hL) || !ok(hR);
        if (vFree && !lFree) return GrappleTargetType.LEDGE;
        if (lFree && !vFree) return GrappleTargetType.CORNER;
        if (vFree && lFree) return classifyWithSpread(currentSpread * 0.5, depth + 1);
        return GrappleTargetType.LEDGE;
      };

      if (hitC !== null) {
        // ── Flow A: center hit — you're looking at a surface ──────────────
        const vFree = freeU || freeD;
        const lFree = freeL || freeR;

        if (vFree && !lFree) {
          surfaceType = GrappleTargetType.LEDGE;
        } else if (lFree && !vFree) {
          surfaceType = GrappleTargetType.CORNER;
        } else if (vFree && lFree) {
          // Ambiguous — refine with narrower spread; null if it can't resolve
          surfaceType = classifyWithSpread(spreadRad * 0.5, 1);
        }
        // else: no axis free → flat wall → surfaceType stays null
      } else {
        // ── Flow B: center misses — you're aiming at the gap near an edge ──
        const hasLateralHit = hitL !== null || hitR !== null;
        const hasVerticalHit = hitU !== null || hitD !== null;

        if (hasLateralHit && !hasVerticalHit) {
          surfaceType = GrappleTargetType.CORNER;
        } else if (hasVerticalHit && !hasLateralHit) {
          surfaceType = GrappleTargetType.LEDGE;
        } else if (hasLateralHit && hasVerticalHit) {
          // Compare closest hit on each axis to pick the dominant one
          const distLateral = (hitL ?? hitR)!.timeOfImpact;
          const distVertical = (hitU ?? hitD)!.timeOfImpact;
          surfaceType =
            distLateral < distVertical ? GrappleTargetType.CORNER : GrappleTargetType.LEDGE;
        }
        // else: no hits at all → surfaceType stays null
      }

      if (surfaceType !== null) {
        // Reference hit: prefer center; if null, pick highest-scoring non-null ray.
        const namedRays = [
          { dir: dirC, hit: hitC },
          { dir: dirU, hit: hitU },
          { dir: dirD, hit: hitD },
          { dir: dirL, hit: hitL },
          { dir: dirR, hit: hitR },
        ];

        let referenceHit = hitC;
        let referenceDir = dirC;

        if (referenceHit === null) {
          let bestRefScore = -Infinity;
          for (const { dir, hit } of namedRays) {
            if (hit === null) continue;
            const dot = vec3.dot(front, dir);
            const s =
              (1 - hit.timeOfImpact / maxDist) * 0.4 +
              ((dot - coneThreshold) / (1 - coneThreshold)) * 0.6;
            if (s > bestRefScore) {
              bestRefScore = s;
              referenceHit = hit;
              referenceDir = dir;
            }
          }
        }

        if (referenceHit !== null) {
          const dist = referenceHit.timeOfImpact;
          const hitPoint = vec3.scaleAndAdd(vec3.create(), origin, referenceDir, dist);

          // ── Edge refinement ──────────────────────────────────────────────
          // From hitPoint, cast along the free direction to find the exact
          // ledge top edge or corner side edge.
          //   LEDGE  → vertical ray   (up   if freeU, down  if freeD)
          //   CORNER → horizontal ray (left if freeL, right if freeR)
          let edgeScanDir: vec3 | null = null;
          if (surfaceType === GrappleTargetType.LEDGE) {
            edgeScanDir = vec3.cross(
              vec3.create(),
              vec3.fromValues(referenceHit.normal.x, referenceHit.normal.y, referenceHit.normal.z),
              right,
            );
            vec3.scale(edgeScanDir, edgeScanDir, freeU ? 1 : -1);
          } else {
            // CORNER — use horizontal component of the free lateral ray
            edgeScanDir = vec3.cross(
              vec3.create(),
              vec3.fromValues(referenceHit.normal.x, referenceHit.normal.y, referenceHit.normal.z),
              up,
            );
            vec3.scale(edgeScanDir, edgeScanDir, freeL ? 1 : -1);
          }

          let visualPoint: vec3 | null = null;
          if (edgeScanDir !== null) {
            // Start 10 cm behind hitPoint along the hit normal to ensure
            // the ray origin is inside the geometry so the edge is found.
            const hitNormal = vec3.fromValues(
              referenceHit.normal.x,
              referenceHit.normal.y,
              referenceHit.normal.z,
            );
            const scanOrigin = vec3.scaleAndAdd(vec3.create(), hitPoint, hitNormal, -0.01);
            const edgeHit = world.castRay(
              new RAPIER.Ray(
                { x: scanOrigin[0], y: scanOrigin[1], z: scanOrigin[2] },
                { x: edgeScanDir[0], y: edgeScanDir[1], z: edgeScanDir[2] },
              ),
              3.0,
              false,
              QueryFilterFlags.EXCLUDE_SENSORS,
              undefined,
              capsuleRapierCollider,
            );
            if (edgeHit) {
              visualPoint = vec3.scaleAndAdd(
                vec3.create(),
                scanOrigin,
                edgeScanDir,
                edgeHit.timeOfImpact,
              );
            }
            // Scan missed → no valid edge exists here
          }

          if (visualPoint !== null) {
            // Validate that the actual edge point is within grapple range.
            const edgeDist = vec3.distance(origin, visualPoint);
            if (edgeDist <= maxDist) {
              // Recompute score based on real edge distance and direction.
              const edgeDir = vec3.scale(
                vec3.create(),
                vec3.subtract(vec3.create(), visualPoint, origin),
                1 / edgeDist,
              );
              const edgeDot = vec3.dot(front, edgeDir);
              const edgeDistanceScore = 1 - edgeDist / maxDist;
              const edgeCenterScore = (edgeDot - coneThreshold) / (1 - coneThreshold);
              const edgeScore = edgeDistanceScore * 0.4 + edgeCenterScore * 0.6;

              // LEDGE gets capsule-half Y offset (refined further by downward ray at the end);
              // CORNER arrives at the edge hit Y.
              const movementTarget = vec3.clone(visualPoint);
              if (surfaceType === GrappleTargetType.LEDGE) {
                movementTarget[1] += capsuleH * 0.5;
              }
              bestCandidate = {
                point: movementTarget,
                visualPoint,
                type: surfaceType,
                score: edgeScore,
              };
            }
          }
        }
      }
    }

    // — Scan RING entities (GrappleHookComponent prefabs) with LOS check —
    for (const entity of Engine.getEntities().getAllEntities()) {
      if (!entity.getComponent('grapple_hook')) continue;
      const transform = entity.getComponent('transform') as TransformComponent | null;
      if (!transform) continue;
      const worldPos = transform.getTransform().getWorldPosition();
      const toTarget = vec3.subtract(vec3.create(), worldPos, origin);
      const dist = vec3.length(toTarget);
      if (dist > maxDist || dist < 0.1) continue;
      const dirToTarget = vec3.scale(vec3.create(), toTarget, 1 / dist);
      const dot = vec3.dot(front, dirToTarget);
      if (dot < coneThreshold) continue;

      // Line-of-sight: skip rings behind geometry.
      // Exclude both the player capsule and the ring's own collider so
      // the ring's box_collider doesn't falsely report itself as an occluder.
      const ringColliderComp = entity.getComponent('box_collider') as ColliderComponent | null;
      const ringCol = ringColliderComp?.getCollider();
      const playerCol = capsuleRapierCollider;
      const occluded = world.castRay(
        new RAPIER.Ray(
          { x: origin[0], y: origin[1], z: origin[2] },
          { x: dirToTarget[0], y: dirToTarget[1], z: dirToTarget[2] },
        ),
        dist - 0.1,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        undefined,
        undefined,
        (col: RAPIER.Collider) =>
          col.handle !== playerCol.handle && (!ringCol || col.handle !== ringCol.handle),
      );
      if (occluded) continue;

      const distanceScore = 1 - dist / maxDist;
      const centerScore = (dot - coneThreshold) / (1 - coneThreshold);
      const score = distanceScore * 0.4 + centerScore * 0.6;

      if (!bestCandidate || score > bestCandidate.score) {
        bestCandidate = {
          point: vec3.clone(worldPos),
          visualPoint: vec3.clone(worldPos),
          type: GrappleTargetType.RING,
          score,
        };
      }
    }

    // — Classification debounce (LEDGE ↔ CORNER only) —
    // Counts consecutive frames where the *same* new type appears before accepting it.
    // RING switches are always immediate.
    if (bestCandidate) {
      const newType = bestCandidate.type;
      const isAmbiguous = (t: GrappleTargetType): boolean =>
        t === GrappleTargetType.LEDGE || t === GrappleTargetType.CORNER;

      if (
        this.lastClassifiedType !== null &&
        newType !== this.lastClassifiedType &&
        isAmbiguous(newType) &&
        isAmbiguous(this.lastClassifiedType)
      ) {
        // Type wants to change — only accept after DEBOUNCE_FRAMES consecutive frames
        // with the same candidate to avoid flickering.
        if (newType === this.pendingClassificationType) {
          this.classificationStableFrames++;
        } else {
          // Different candidate than last frame — restart the counter
          this.pendingClassificationType = newType;
          this.classificationStableFrames = 1;
        }

        if (this.classificationStableFrames >= GrappleSystem.CLASSIFICATION_DEBOUNCE_FRAMES) {
          this.lastClassifiedType = newType;
          this.pendingClassificationType = null;
          this.classificationStableFrames = 0;
        } else {
          bestCandidate.type = this.lastClassifiedType; // hold previous type
        }
      } else {
        // Type is stable or no previous type — accept immediately and reset pending
        this.lastClassifiedType = newType;
        this.pendingClassificationType = null;
        this.classificationStableFrames = 0;
      }
    } else {
      this.lastClassifiedType = null;
      this.pendingClassificationType = null;
      this.classificationStableFrames = 0;
    }

    this.pendingTarget = bestCandidate
      ? {
          point: bestCandidate.point,
          visualPoint: bestCandidate.visualPoint,
          type: bestCandidate.type,
        }
      : null;

    // Refine LEDGE target: find actual top-of-ledge surface via downward raycast.
    if (this.pendingTarget?.type === GrappleTargetType.LEDGE) {
      const vp = this.pendingTarget.visualPoint;
      const forwardXZ = vec3.fromValues(front[0], 0, front[2]);
      vec3.normalize(forwardXZ, forwardXZ);
      const castOrigin = {
        x: vp[0] + forwardXZ[0] * 0.5,
        y: vp[1] + capsuleH,
        z: vp[2] + forwardXZ[2] * 0.5,
      };
      const downRay = new RAPIER.Ray(castOrigin, { x: 0, y: -1, z: 0 });
      const surfaceHit = world.castRay(
        downRay,
        capsuleH * 2,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        capsuleRapierCollider,
      );
      if (surfaceHit) {
        const surfaceY = castOrigin.y - surfaceHit.timeOfImpact;
        this.pendingTarget.point = vec3.fromValues(
          castOrigin.x,
          surfaceY + capsuleH * 0.5,
          castOrigin.z,
        );
      }
    }
  }

  /** Returns the current best grapple candidate, or null if none is in range. */
  public getPendingTarget(): {
    point: vec3;
    visualPoint: vec3;
    type: GrappleTargetType;
  } | null {
    return this.pendingTarget;
  }
}
