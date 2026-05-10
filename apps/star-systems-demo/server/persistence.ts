/**
 * SQLite persistence — on by default, opt-out with PERSIST_DB=off.
 *
 * Default path: ./data/game.sqlite (relative to server module dir).
 * Override with PERSIST_DB=/some/path/to.db. Disable entirely with
 * PERSIST_DB=off (handy for ephemeral runs or hostile filesystems).
 *
 * Strategy: whole-galaxy JSON blob per row, keyed by gameId. Cheap,
 * resilient to schema drift (the Galaxy/Player types own their own
 * shape), and matches the "periodic snapshot" model — there's no
 * per-mutation hot path here. Map<> values round-trip via
 * Object.entries / new Map(...).
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.resolve(HERE, "data", "game.sqlite");

type GalaxyLike = {
  gameId: string;
  seed: number;
  createdAt: number;
  players: Map<string, unknown>;
  orbitals: unknown[];
  publicChat: unknown[];
  events: unknown[];
};

let db: Database.Database | null = null;

export function persistenceEnabled(): boolean {
  return process.env.PERSIST_DB?.toLowerCase() !== "off";
}

function dbPath(): string {
  const v = process.env.PERSIST_DB;
  if (!v || v.toLowerCase() === "off") return DEFAULT_DB_PATH;
  return path.resolve(v);
}

export function openPersistence(): void {
  if (!persistenceEnabled() || db) return;
  const p = dbPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS galaxies (
      game_id    TEXT PRIMARY KEY,
      json       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  console.log(`[persistence] opened ${p}`);
}

/** Returns parsed galaxy snapshots ready to be reconstituted into the
 *  in-memory Map. The caller is responsible for converting `players`
 *  back to a Map (we can't do it here without importing the Galaxy
 *  type and dragging server.ts into a circular import). */
export function loadAllGalaxies(): Array<{
  gameId: string;
  seed: number;
  createdAt?: number;
  players: Record<string, unknown>;
  orbitals: unknown[];
  publicChat: unknown[];
  events: unknown[];
}> {
  if (!db) return [];
  const rows = db.prepare("SELECT json FROM galaxies").all() as { json: string }[];
  const out: ReturnType<typeof loadAllGalaxies> = [];
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.json));
    } catch (e) {
      console.error("[persistence] skipping corrupt row:", e);
    }
  }
  console.log(`[persistence] hydrated ${out.length} galaxies`);
  return out;
}

export function snapshotAll(galaxies: Map<string, GalaxyLike>): void {
  if (!db) return;
  const stmt = db.prepare(
    "INSERT INTO galaxies (game_id, json, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(game_id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at"
  );
  const now = Date.now();
  const tx = db.transaction((entries: [string, GalaxyLike][]) => {
    for (const [gameId, g] of entries) {
      const serializable = {
        gameId: g.gameId,
        seed: g.seed,
        createdAt: g.createdAt,
        players: Object.fromEntries(g.players),
        orbitals: g.orbitals,
        publicChat: g.publicChat,
        events: g.events,
      };
      stmt.run(gameId, JSON.stringify(serializable), now);
    }
  });
  tx([...galaxies.entries()]);
}

export function closePersistence(): void {
  if (!db) return;
  try { db.close(); } catch { /* ignore */ }
  db = null;
}
