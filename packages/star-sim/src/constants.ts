/**
 * Physics constants shared between the iframe-side simulation and the
 * server-side tools. Numerical values must match what cockpit-main.ts
 * had inline before this package existed — Pass 1 is a no-behavior
 * refactor.
 *
 * Note: server.ts has its own `DOCK_RANGE_LY = 0.5 * (1 / 63241.077)`
 * which is numerically identical to ORBITAL_DOCK_RANGE_LY here. Server
 * keeps its inline copy for now to avoid coupling tool registration to
 * this package; a Pass-2 cleanup can de-duplicate.
 */

/** 1 ly in AU. */
export const LY_PER_AU = 1 / 63241.077;

/** Sol radius in AU. */
export const SOL_RADIUS_AU = 0.00465047;
/** Sol radius in light-years (R☉ × LY_PER_AU). */
export const SOL_RADIUS_LY = SOL_RADIUS_AU * LY_PER_AU;

/** Earth radius in AU. */
export const EARTH_RADIUS_AU = 4.26e-5;
/** Earth radius in light-years. */
export const EARTH_RADIUS_LY = EARTH_RADIUS_AU * LY_PER_AU;

/** Outer radius of the autobrake cordon, in AU. Inside this distance to
 *  the closest star the throttle is capped per the deceleration ladder. */
export const BRAKE_RANGE_AU = 100;
export const BRAKE_RANGE_LY = BRAKE_RANGE_AU * LY_PER_AU;

/** Top warp speed at full throttle. The cube law speed = throttle³ ×
 *  WARP_MAX_LY_PER_S means the slider's lower 60% is in the impulse
 *  range and the upper 40% does the actual interstellar travel. */
export const WARP_MAX_LY_PER_S = 20;

/** Range at which the cockpit holds short of the target so you can
 *  observe instead of plowing through (currently == BRAKE_RANGE_LY,
 *  ≈ 100 AU). */
export const OBSERVE_RANGE_LY = BRAKE_RANGE_LY;

/** Where autopilot disengages and parks the ship — 1 AU drops you at
 *  planetary range so the system is right there. */
export const AUTOPILOT_ARRIVAL_LY = 1 * LY_PER_AU;

/** Mirror of server-side DOCK_RANGE_LY — dockable radius around an Orbital. */
export const ORBITAL_DOCK_RANGE_LY = 0.5 * LY_PER_AU;

/** Phase-1 / Phase-2 warp alignment threshold in radians (~2.3°).
 *  Above this angular error the ship rotates with throttle pinned to 0;
 *  below it, snap-track + throttle ramp. */
export const ALIGN_TOLERANCE = 0.04;

/** Phase-1 rotation blend rate (effective per-second; the per-tick
 *  blend factor is min(1, dt × ALIGN_LERP_RATE)). */
export const ALIGN_LERP_RATE = 6;
