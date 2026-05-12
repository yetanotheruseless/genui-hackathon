/**
 * Player schema for the StarRoom. Owns the continuous ship state that
 * needs to flow on every tick — position, orientation, throttle. Fields
 * that change rarely or expensively (targetId, dockedOrbitalId) live
 * outside the schema and travel via `room.send()` one-shots; see
 * ENGINE_ARCHITECTURE.md "Schema design optimizations."
 *
 * Field type choices:
 *   posX/Y/Z   "float64"          — position in light-years; need full
 *               precision near a star (1 AU ≈ 1.6e-5 ly). NOTE: must
 *               be explicit "float64", NOT "number". @colyseus/schema's
 *               "number" type is a wire-format heuristic that auto-
 *               downgrades to float32 if `Math.abs(f32roundtrip - v) <
 *               1e-4` (see schema source). At 1–4 ly magnitudes that
 *               heuristic picks float32 and you get ~0.03 AU of
 *               position quantization noise per coord — the reticle
 *               jitters visibly within ~2 AU of any non-Sol star.
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

  /** Warp autopilot engaged toward `targetId`. */
  warpEngaged = false;

  /** Locked target — bare star id (e.g. "sirius_a"),
   *  "planet:<starId>::<name>", or "orbital:<uuid>". Empty string means
   *  no target locked. Changes infrequently (only when player picks a
   *  new target via MCP set_target / warp_to), so the in-schema string
   *  cost is fine — revisit if churn becomes a problem. */
  targetId = "";

  /** Orbital uuid we're docked at, or empty string. Set by the server
   *  on dock_orbital arrival; cleared on undock or warp engage. */
  dockedOrbitalId = "";
}

defineTypes(Player, {
  playerId: "string",
  shipName: "string",
  shipClass: "string",
  systemId: "string",
  posX: "float64",
  posY: "float64",
  posZ: "float64",
  yaw: "float32",
  pitch: "float32",
  throttle: "float32",
  warpEngaged: "boolean",
  targetId: "string",
  dockedOrbitalId: "string",
});
