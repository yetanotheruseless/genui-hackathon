/**
 * Compact mono-friendly formatters for the cockpit reticle readout
 * and any other surface that wants the same style.
 */
import { LY_PER_AU, WARP_MAX_LY_PER_S } from "./constants.js";

/** Speed model: speed = throttle³ × WARP_MAX_LY_PER_S.
 *  Sub-warp tier (< 0.005 ly/s) is rendered as a c-fraction (0–1c via
 *  the same 200× factor used in updateHud's "impulse" tier).
 *  Warp tier rounds to nearest integer warp factor (1–9). */
export function formatSpeedShort(throttle: number): string {
  const lyPerS = Math.pow(throttle, 3) * WARP_MAX_LY_PER_S;
  if (lyPerS < 0.005) {
    const c = lyPerS * 200;
    if (c < 0.01) return "0.00c";
    return `${c.toFixed(2)}c`;
  }
  const warp = Math.min(9, Math.max(1, 1 + 2.22 * Math.log10(lyPerS / 0.005)));
  return `warp ${Math.round(warp)}`;
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
