/**
 * Compact mono-friendly formatters for the cockpit reticle readout
 * and any other surface that wants the same style.
 */
import { LY_PER_AU, WARP_MAX_LY_PER_S } from "./constants.js";

/** Speed model: speed = throttle³ × WARP_MAX_LY_PER_S.
 *
 *  Three display tiers, picked so the user can always tell whether
 *  the ship is moving:
 *   - WARP (≥ warp 1, lyPerS ≥ 0.005): "warp 1".."warp 9".
 *   - IMPULSE C-fraction (≥ 0.01c in game units, where 1c = 0.005
 *     ly/s): "0.01c".."1.00c". The game's c is a UI fiction — see
 *     ENGINE_ARCHITECTURE notes.
 *   - SUB-IMPULSE physical-units (below 0.01c): actual m/s, km/s, or
 *     Mm/s depending on magnitude. Previously rounded to "0.00c"
 *     which made the user think they weren't moving when in fact
 *     they were doing thousands of km/s. 1 ly = 9.461e15 m.
 */
const M_PER_LY = 9.461e15;
export function formatSpeedShort(throttle: number): string {
  const lyPerS = Math.pow(throttle, 3) * WARP_MAX_LY_PER_S;
  if (lyPerS >= 0.005) {
    const warp = Math.min(9, Math.max(1, 1 + 2.22 * Math.log10(lyPerS / 0.005)));
    return `warp ${Math.round(warp)}`;
  }
  const c = lyPerS * 200;
  if (c >= 0.01) return `${c.toFixed(2)}c`;
  const mPerS = lyPerS * M_PER_LY;
  // Cascade through unit tiers, each capped at ~1000 of its unit so
  // no row ever shows more than 3 significant digits before the unit
  // (keeps the readout width predictable; 125361.6 Mm/s used to wrap
  // the HUD label — now reads as 125.4 Gm/s).
  if (mPerS >= 1e9) return `${(mPerS / 1e9).toFixed(1)} Gm/s`;
  if (mPerS >= 1e6) return `${(mPerS / 1e6).toFixed(1)} Mm/s`;
  if (mPerS >= 1e3) return `${(mPerS / 1e3).toFixed(1)} km/s`;
  if (mPerS >= 1) return `${mPerS.toFixed(1)} m/s`;
  if (mPerS >= 0.001) return `${(mPerS * 1000).toFixed(0)} mm/s`;
  return "0 m/s";
}

/** Reticle-readout distance formatter. Compact units that step down
 *  through ly → au → light-minutes as the value shrinks. */
export function formatDistanceShort(ly: number): string {
  if (ly >= 0.1) return `${ly.toFixed(2)} ly`;
  if (ly >= 0.01) return `${ly.toFixed(3)} ly`;
  const au = ly / LY_PER_AU;
  if (au >= 100) return `${au.toFixed(0)} au`;
  if (au >= 10) return `${au.toFixed(1)} au`;
  if (au >= 0.1) return `${au.toFixed(2)} au`;
  const lm = ly * 525949.2;
  return `${lm.toFixed(1)} lmin`;
}
