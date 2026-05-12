/**
 * Pure Phase 1 / Phase 2 warp alignment math, extracted from
 * cockpit-main.ts's tick() loop. The caller wires in the side effects
 * (throttle slider DOM update, server stop_engines call, observe-mode
 * camera bookkeeping); this module is purely numerical.
 *
 * Phase 1 (off-axis): angular error > ALIGN_TOLERANCE — rotate fwd
 *   toward target with throttle pinned to 0 so camera smoothing can't
 *   fight the throttle and you don't fly in circles.
 * Phase 2 (on-axis): angular error ≤ ALIGN_TOLERANCE — snap-track
 *   the target heading, ramp throttle toward autopilot's cap (0.85 ×
 *   current + 0.15 × target — same lerp factor used pre-extraction),
 *   and report `arrived` once we cross the arrival range.
 */
import {
  ALIGN_LERP_RATE,
  ALIGN_TOLERANCE,
  AUTOPILOT_ARRIVAL_LY,
  ORBITAL_DOCK_RANGE_LY,
  WARP_MAX_LY_PER_S,
} from "./constants.js";
import { autopilotTargetThrottle } from "./throttle.js";

export type Vec3 = { x: number; y: number; z: number };

export type WarpAlignmentInput = {
  shipPos: Vec3;
  /** Unit-length current forward vector (caller derives from yaw/pitch). */
  shipFwd: Vec3;
  shipThrottle: number;
  targetPos: Vec3;
  /** True for Orbitals (uses ORBITAL_DOCK_RANGE_LY); false for stars. */
  isOrbital: boolean;
  /** Target body radius in light-years. Added to the base arrival
   *  range so the ship stops 1 AU from the SURFACE rather than 1 AU
   *  from the center — critical for supergiants where the radius
   *  itself can exceed 1 AU and the old "from center" check parked
   *  the ship inside the photosphere. Defaults to 0 (point target,
   *  e.g. ships and orbitals). */
  targetRadiusLy?: number;
  /** Tick delta in seconds. */
  dt: number;
};

export type WarpAlignmentOutput = {
  /** New yaw in radians (yaw=0 looks down -Z). */
  yaw: number;
  /** New pitch in radians (positive = up). */
  pitch: number;
  /** New throttle in [0..1]. Phase 1 returns 0; Phase 2 returns the
   *  smoothed approach throttle, or 0 once arrived. */
  throttle: number;
  /** 1 = rotating to align; 2 = snap-tracking + warping. */
  phase: 1 | 2;
  /** Distance to target after this step, in light-years. */
  distance: number;
  /** True iff Phase 2 has reached the arrival range — caller should
   *  fire its stop_engines side effect. */
  arrived: boolean;
};

/** Convenience: ly/s from throttle. speed = throttle³ × WARP_MAX_LY_PER_S. */
export function speedFromThrottle(throttle: number): number {
  return Math.pow(throttle, 3) * WARP_MAX_LY_PER_S;
}

/** One Phase 1/2 step. Pure — no DOM, no Three.js, no network. */
export function stepWarpAlignment(input: WarpAlignmentInput): WarpAlignmentOutput {
  const dx = input.targetPos.x - input.shipPos.x;
  const dy = input.targetPos.y - input.shipPos.y;
  const dz = input.targetPos.z - input.shipPos.z;
  const dist = Math.hypot(dx, dy, dz) || 1e-12;
  const dirX = dx / dist;
  const dirY = dy / dist;
  const dirZ = dz / dist;

  const cosErr = Math.max(
    -1,
    Math.min(1, input.shipFwd.x * dirX + input.shipFwd.y * dirY + input.shipFwd.z * dirZ),
  );
  const angleErr = Math.acos(cosErr);

  const baseArrival = input.isOrbital ? ORBITAL_DOCK_RANGE_LY : AUTOPILOT_ARRIVAL_LY;
  const arrivalRange = baseArrival + (input.targetRadiusLy ?? 0);

  if (angleErr > ALIGN_TOLERANCE) {
    // Phase 1: lerp current fwd toward target dir, renormalize.
    const blend = Math.min(1, input.dt * ALIGN_LERP_RATE);
    let nfX = input.shipFwd.x + (dirX - input.shipFwd.x) * blend;
    let nfY = input.shipFwd.y + (dirY - input.shipFwd.y) * blend;
    let nfZ = input.shipFwd.z + (dirZ - input.shipFwd.z) * blend;
    const nfLen = Math.hypot(nfX, nfY, nfZ) || 1;
    nfX /= nfLen;
    nfY /= nfLen;
    nfZ /= nfLen;
    return {
      yaw: Math.atan2(nfX, -nfZ),
      pitch: Math.asin(Math.max(-1, Math.min(1, nfY))),
      throttle: 0,
      phase: 1,
      distance: dist,
      arrived: false,
    };
  }

  // Phase 2: snap-track + warp throttle ramp.
  //
  // Lerp is asymmetric. On accel (target > current) keep the gentle
  // 0.85/0.15 ramp so the warp wind-up reads as "spinning up to
  // light speed" instead of an instant jump. On decel (target <
  // current) SNAP to target — with the cubic speed law a 0.85 lerp
  // takes ~1.5 s to converge, during which the ship is still moving
  // fast and overshoots well past the target. The distance-aware
  // target (via autopilotTargetThrottle below) already gives a
  // continuous, position-keyed deceleration curve, so snapping to
  // it produces a smooth exponential slow-down without lag.
  // Speed taper keys off distance-to-SURFACE, not distance-to-center
  // — for big stars (Betelgeuse, R ~ 2 AU) center-distance would keep
  // the ship at cruise speed until 1 AU outside the photosphere, then
  // snap to zero with a ~0.5 AU overshoot. Surface-distance makes the
  // approach feel the same regardless of target radius.
  const distToSurface = Math.max(0, dist - (input.targetRadiusLy ?? 0));
  const targetThrottle = autopilotTargetThrottle(distToSurface);
  const newThrottle = targetThrottle < input.shipThrottle
    ? targetThrottle
    : input.shipThrottle * 0.85 + targetThrottle * 0.15;
  const arrived = dist <= arrivalRange;
  return {
    yaw: Math.atan2(dirX, -dirZ),
    pitch: Math.asin(Math.max(-1, Math.min(1, dirY))),
    throttle: arrived ? 0 : newThrottle,
    phase: 2,
    distance: dist,
    arrived,
  };
}
