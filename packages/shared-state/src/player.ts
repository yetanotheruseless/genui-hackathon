/**
 * Player schema for the StarRoom. Owns the continuous ship state that
 * needs to flow on every tick — position, orientation, throttle. Fields
 * that change rarely or expensively (targetId, dockedOrbitalId) live
 * outside the schema and travel via `room.send()` one-shots; see
 * ENGINE_ARCHITECTURE.md "Schema design optimizations."
 *
 * Field type choices:
 *   posX/Y/Z   "number" (float64) — position in light-years; need full
 *               precision near a star (1 AU ≈ 1.6e-5 ly).
 *   yaw/pitch  "float32"          — radians; 7 decimal digits is plenty.
 *   throttle   "float32"          — 0..1; same.
 *   systemId   "string"           — placeholder for future per-system
 *               sharding (today every player has the same `gameId`-
 *               derived value). Carrying it now lets sharding land
 *               without a schema migration.
 *
 * Uses `defineTypes()` instead of @type() decorators. The decorator
 * form trips on tsx's TC39 decorator emission (esbuild passes
 * `(value, context)` to TC39-style decorators while @colyseus/schema's
 * legacy decorator expects `(target, key)`); defineTypes sidesteps the
 * issue entirely.
 */
import { defineTypes, Schema } from "@colyseus/schema";

export class Player extends Schema {
  /** Our stable cross-room identity (mirrors the cached
   *  `cockpit-player-id:${gameId}` localStorage key). */
  playerId = "";

  /** Display fields — written once on join, rarely change. */
  shipName = "";
  shipClass = "";

  /** Future sharding seam — one Room per active star system. */
  systemId = "";

  /** Position in light-years. */
  posX = 0;
  posY = 0;
  posZ = 0;

  /** Orientation in radians. yaw=0 looks down -Z. */
  yaw = 0;
  pitch = 0;

  /** Throttle in [0..1]. speed = throttle³ × WARP_MAX_LY_PER_S. */
  throttle = 0;

  /** Warp autopilot engaged toward `targetId` (NOT in schema — see
   *  "Schema design optimizations" in the ADR; sent via room.send). */
  warpEngaged = false;
}

defineTypes(Player, {
  playerId: "string",
  shipName: "string",
  shipClass: "string",
  systemId: "string",
  posX: "number",
  posY: "number",
  posZ: "number",
  yaw: "float32",
  pitch: "float32",
  throttle: "float32",
  warpEngaged: "boolean",
});
