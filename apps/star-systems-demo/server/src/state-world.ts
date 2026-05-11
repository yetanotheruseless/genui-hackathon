/**
 * World schema — the root state of a StarRoom. Holds the live map of
 * players keyed by Colyseus sessionId. Future fields (Orbitals,
 * public-chat queue, etc.) get added here when we move them out of
 * the old galaxy in-memory record into authoritative-server state.
 *
 * Uses defineTypes() rather than decorators for tsx compatibility —
 * see player.ts for context.
 */
import { defineTypes, MapSchema, Schema } from "@colyseus/schema";
import { Player } from "./state-player.js";

export class World extends Schema {
  /** The `gameId` (galaxy id) this Room represents. Today one Room
   *  per gameId; future sharding may flip to one Room per systemId. */
  gameId = "";

  /** Players in this Room, keyed by Colyseus sessionId. */
  players = new MapSchema<Player>();

  /** Server tick count since onCreate — useful for debugging. */
  tick = 0;
}

defineTypes(World, {
  gameId: "string",
  players: { map: Player },
  tick: "uint32",
});
