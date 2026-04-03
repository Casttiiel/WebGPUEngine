import { vec3 } from 'gl-matrix';

/** A neighboring agent's position + current velocity, used for RVO. */
export interface RVONeighbor {
  pos: vec3;
  vel: vec3; // current world-space XZ velocity
}

/**
 * Steering — stateless Craig Reynolds steering behaviors + RVO.
 *
 * All functions work on the XZ plane (Y is always zeroed in outputs).
 * Functions return velocity vectors (magnitude encodes speed), not pure directions,
 * so callers can weight and blend them before feeding to the controller.
 *
 * Layer architecture:
 *   1. Path Following  — global path → per-frame movement intent
 *   2. Separation      — short-range push from nearby static neighbors
 *   3. RVO             — reciprocal collision avoidance for moving agents
 */
export class Steering {
  // ─── 1. Path Following + Arrival ─────────────────────────────────────────

  /**
   * Classic Path Following with Arrive deceleration at the final waypoint.
   *
   * Returns a velocity vector (XZ) whose magnitude is in [0, maxSpeed]:
   *   - Full speed between intermediate waypoints.
   *   - Linearly ramps down to 10 % speed inside `slowRadius` of the final goal.
   *   - Zero vector once inside `stopRadius` of the final goal (done = true).
   *
   * `nextIdx` may be greater than the input `idx` when the current waypoint
   * is within `waypointRadius` — advance the caller's index accordingly.
   */
  public static pathFollow(
    pos: vec3,
    path: vec3[],
    idx: number,
    maxSpeed: number,
    waypointRadius = 1.2,
    slowRadius = 4.0,
    stopRadius = 1.5,
  ): { vel: vec3; nextIdx: number; done: boolean } {
    if (!path || path.length === 0 || idx >= path.length) {
      return { vel: vec3.create(), nextIdx: idx, done: true };
    }

    const target = path[idx]!;
    const dx = target[0] - pos[0];
    const dz = target[2] - pos[2];
    const dist = Math.sqrt(dx * dx + dz * dz);
    const isFinal = idx === path.length - 1;

    // ── Arrival at final waypoint ────────────────────────────────────────────
    if (isFinal && dist < stopRadius) {
      return { vel: vec3.create(), nextIdx: idx, done: true };
    }

    // ── Advance past intermediate waypoint ──────────────────────────────────
    if (!isFinal && dist < waypointRadius) {
      // Return current direction for this tick; caller increments idx next tick.
      const invDist = dist > 0.001 ? 1 / dist : 0;
      return {
        vel: vec3.fromValues(dx * invDist * maxSpeed, 0, dz * invDist * maxSpeed),
        nextIdx: idx + 1,
        done: false,
      };
    }

    // ── Arrive deceleration near final goal ──────────────────────────────────
    let speed = maxSpeed;
    if (isFinal && dist < slowRadius) {
      speed = Math.max(maxSpeed * 0.1, maxSpeed * (dist / slowRadius));
    }

    const invDist = dist > 0.001 ? 1 / dist : 0;
    return {
      vel: vec3.fromValues(dx * invDist * speed, 0, dz * invDist * speed),
      nextIdx: idx,
      done: false,
    };
  }

  // ─── 2. Separation ────────────────────────────────────────────────────────

  /**
   * Separation: repulsion force away from nearby agents.
   *
   * The force is inversely proportional to distance — strongest when touching,
   * zero at `radius`. The result is an unscaled XZ direction vector; callers
   * multiply by a weight and maxSpeed before blending.
   *
   * @param pos       Agent's current XZ position
   * @param neighbors World positions of other nearby agents
   * @param radius    Maximum influence distance
   */
  public static separate(pos: vec3, neighbors: vec3[], radius: number): vec3 {
    const rx = 0;
    const rz = 0;
    let ax = rx;
    let az = rz;
    if (neighbors.length === 0) return vec3.create();

    for (const nb of neighbors) {
      const dx = pos[0] - nb[0];
      const dz = pos[2] - nb[2];
      const dist2 = dx * dx + dz * dz;
      if (dist2 < 0.0001 || dist2 > radius * radius) continue;
      const dist = Math.sqrt(dist2);
      // Linear falloff: weight = 1 when touching, 0 at radius
      const w = 1.0 - dist / radius;
      ax += (dx / dist) * w;
      az += (dz / dist) * w;
    }

    return vec3.fromValues(ax, 0, az);
  }

  // ─── 3. RVO — Reciprocal Velocity Obstacles ───────────────────────────────

  /**
   * Reciprocal Velocity Obstacles (Van den Berg et al., 2008).
   *
   * Adjusts `prefVel` so that agent A avoids collisions with all `neighbors`
   * within the next `timeHorizon` seconds, with each agent sharing half the
   * avoidance responsibility (the "reciprocal" property).
   *
   * Algorithm per neighbor B:
   *   1. Compute the VO cone in velocity space, shifted by avgVel = (v_A + v_B)/2
   *      (this is the RVO shift — B's cone center is at avgVel, not just v_B).
   *   2. Check if `prefVel` falls inside the cone.
   *   3. If yes, compute the minimum velocity perturbation to exit the cone
   *      (nearest surface escape on XZ plane).
   *   4. Apply half the perturbation (A takes 50 % responsibility; B does the rest).
   *
   * @param pos          Agent A's world position
   * @param prefVel      Desired velocity from path following (may be modified)
   * @param currentVel   A's actual current velocity (used for RVO centering)
   * @param neighbors    Nearby agent positions + velocities
   * @param agentRadius  Per-agent capsule radius — combined radius = 2 × this
   * @param timeHorizon  Seconds of look-ahead for collision detection
   * @param maxSpeed     Maximum speed clamp on the returned velocity
   */
  public static rvo(
    pos: vec3,
    prefVel: vec3,
    currentVel: vec3,
    neighbors: RVONeighbor[],
    agentRadius: number,
    timeHorizon: number,
    maxSpeed: number,
  ): vec3 {
    if (neighbors.length === 0) return vec3.clone(prefVel);

    let vx = prefVel[0];
    let vz = prefVel[2];

    for (const nb of neighbors) {
      // ── Relative position: B - A ──────────────────────────────────────────
      const relPx = nb.pos[0] - pos[0];
      const relPz = nb.pos[2] - pos[2];
      const dist2 = relPx * relPx + relPz * relPz;
      if (dist2 < 0.0001) continue;
      const dist = Math.sqrt(dist2);
      const combinedR = agentRadius * 2;

      // Skip if too far to collide within timeHorizon at maximum speed
      if (dist > combinedR + maxSpeed * timeHorizon * 1.5) continue;

      // ── RVO shift: center the VO at the average velocity ──────────────────
      // In RVO, each agent owns half the responsibility. We check whether
      // (v_A - avgVel) is inside the plain VO cone. avgVel = (v_A + v_B) / 2.
      const avgVx = (currentVel[0] + nb.vel[0]) * 0.5;
      const avgVz = (currentVel[2] + nb.vel[2]) * 0.5;

      // Relative velocity in the RVO frame: w = v_A - avgVel = (v_A - v_B) / 2
      const wx = vx - avgVx;
      const wz = vz - avgVz;

      // ── Build the VO cone in (wx, wz) space ───────────────────────────────
      // Cone axis: unit vector from A toward B (relP / dist)
      const axisX = relPx / dist;
      const axisZ = relPz / dist;

      // Half-angle of cone: theta = arcsin(combinedR / dist), clamped to pi/2
      const sinTheta = Math.min(combinedR / dist, 0.9999);
      const cosTheta = Math.sqrt(1.0 - sinTheta * sinTheta);

      // ── Check if w is inside the cone ────────────────────────────────────
      // The VO cone has apex at origin, opens toward axis (= toward B).
      // A velocity w is inside if:
      //   dot(w_hat, axis) > cosTheta  (angle less than theta)
      //   AND |w| >= 0 (in front of apex — any magnitude inside the angle is in VO)
      const wLen2 = wx * wx + wz * wz;
      if (wLen2 < 0.0001) continue; // w ≈ 0, prefer any direction — skip adjustment

      const wLen = Math.sqrt(wLen2);
      const wHatX = wx / wLen;
      const wHatZ = wz / wLen;
      const dotAxisW = wHatX * axisX + wHatZ * axisZ; // cos of angle between w and axis

      if (dotAxisW <= cosTheta) continue; // Outside the cone — no collision, skip

      // ── w is inside the VO cone → compute minimum exit perturbation ───────
      // Two escape routes: left side and right side of the cone.
      // We pick the nearer one (smaller angular deviation).
      // Cone side tangent vectors (perpendiculars to the cone's leg directions):
      //   Right leg direction: rotate axis by +theta
      //   Left  leg direction: rotate axis by -theta
      // Using 2D rotation:
      //   Right: (axisX * cosTheta - axisZ * sinTheta, axisX * sinTheta + axisZ * cosTheta)
      //   Left:  (axisX * cosTheta + axisZ * sinTheta, -axisX * sinTheta + axisZ * cosTheta)
      const rightLegX = axisX * cosTheta - axisZ * sinTheta;
      const rightLegZ = axisX * sinTheta + axisZ * cosTheta;
      const leftLegX = axisX * cosTheta + axisZ * sinTheta;
      const leftLegZ = -axisX * sinTheta + axisZ * cosTheta;

      // Project w onto each leg direction to find nearest surface point
      const projRight = wx * rightLegX + wz * rightLegZ;
      const projLeft = wx * leftLegX + wz * leftLegZ;

      // Nearest surface point: projection of w onto the nearer leg
      let nearX: number, nearZ: number;
      if (projRight < projLeft) {
        // Right side is nearer
        nearX = rightLegX * projRight;
        nearZ = rightLegZ * projRight;
      } else {
        // Left side is nearer
        nearX = leftLegX * projLeft;
        nearZ = leftLegZ * projLeft;
      }

      // The required perturbation: u = nearestSurface - w
      const ux = nearX - wx;
      const uz = nearZ - wz;

      // RVO: each agent contributes half → apply 0.5 * u to absolute velocity
      vx += ux * 0.5;
      vz += uz * 0.5;
    }

    // Clamp to maxSpeed
    const finalSpeed2 = vx * vx + vz * vz;
    if (finalSpeed2 > maxSpeed * maxSpeed) {
      const inv = maxSpeed / Math.sqrt(finalSpeed2);
      vx *= inv;
      vz *= inv;
    }

    return vec3.fromValues(vx, 0, vz);
  }
}
