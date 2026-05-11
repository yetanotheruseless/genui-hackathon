/**
 * Pure throttle/brake math. Both the autopilot's target throttle and
 * the autobrake's cap come from the same deceleration ladder so a
 * cruise-into-system run is smooth whether autopilot-driven or
 * manually aimed.
 */
import { LY_PER_AU } from "./constants.js";

/** Unified deceleration ladder used by BOTH autopilot's target throttle
 *  and the autobrake's cap.
 *
 *  Budget: starting at 1 ly out, the throttles below land you at 1 AU
 *  in ~20 s under the cubic speed law (speed = throttle³ · 20 ly/s):
 *    1 ly → 100 AU :  5 s  @ 0.2 ly/s
 *    100 → 10 AU   :  5 s  through stepped cap (30 / 18 / 6 AU/s)
 *    10 → 1 AU     : 10 s  through stepped cap (2 / 0.6 AU/s)
 *
 *  Caps were derived as cbrt(au_per_sec / 63241 / WARP_MAX_LY_PER_S);
 *  re-derive if WARP_MAX_LY_PER_S ever changes. */
export function speedCapThrottleByLy(distLy: number): number {
  if (distLy > 1.0) return 1.0;
  const distAu = distLy / LY_PER_AU;
  if (distAu > 100) return 0.215;   // 0.2 ly/s   (cruise→approach)
  if (distAu > 50)  return 0.0286;  // 30 AU/s
  if (distAu > 20)  return 0.0242;  // 18 AU/s
  if (distAu > 10)  return 0.0168;  // 6 AU/s
  if (distAu > 5)   return 0.0117;  // 2 AU/s
  if (distAu > 1)   return 0.00782; // 0.6 AU/s
  return 0.00684;                   // 0.4 AU/s near the photosphere
}

/** Autobrake cap by distance to the closest star, in AU. Outside the
 *  brake range (100 AU) full throttle is allowed; inside, the same
 *  ladder as autopilot so a cruise→approach is smooth and consistent. */
export function maxImpulseThrottle(distAu: number): number {
  if (distAu > 100) return 1.0;
  return speedCapThrottleByLy(distAu * LY_PER_AU);
}

/** Looser cap used when the player is clearly DEPARTING a star but
 *  still inside the INNER_AU cordon — symmetric arrival caps are too
 *  conservative outbound, where there's no risk of a misaimed yaw
 *  putting you on a planet. The ladder is shifted up one band so that
 *  a 1 → 10 AU outbound trip takes ~3s instead of ~9s. */
export function departingImpulseThrottle(distAu: number): number {
  if (distAu > 5)  return 0.0168;   // 6 AU/s   (vs 2 on approach)
  if (distAu > 1)  return 0.0117;   // 2 AU/s   (vs 0.6 on approach)
  return 0.00782;                   // 0.6 AU/s (vs 0.4 near photosphere)
}

/** Autopilot's target throttle from distance-to-target. At cruise
 *  range (> 1 ly) we want full warp; closer in we share the brake's
 *  deceleration ladder so the smoothing converges to the right cap
 *  band without fighting the brake. */
export function autopilotTargetThrottle(distLy: number): number {
  if (distLy > 1.0) return 0.95;
  return speedCapThrottleByLy(distLy);
}
