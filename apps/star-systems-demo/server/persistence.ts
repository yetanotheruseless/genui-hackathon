/**
 * SQLite persistence — opt-in via PERSIST_DB env var.
 *
 * When PERSIST_DB is set, the server hydrates the in-memory `galaxies`
 * Map from disk at startup and snapshots it back on a fixed interval
 * (and on SIGINT/SIGTERM via main.ts).
 *
 * Strategy: whole-galaxy JSON blob per row, keyed by gameId. Cheap,
 * resilient to schema drift (the Galaxy/Player types own their own
 * shape), and matches the "periodic snapshot" model — there's no
 * per-mutation hot path here. Map<> values round-trip via
 * Object.entries / new Map(...).
 *
 * When PERSIST_DB is unset, every export here no-ops, so the running
 * server is byte-for-byte identical to the pre-persistence build.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

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
  return !!process.env.PERSIST_DB;
}

export function openPersistence(): void {
  if (!persistenceEnabled() || db) return;
  const dbPath = process.env.PERSIST_DB!;
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS galaxies (
      game_id    TEXT PRIMARY KEY,
      json       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  console.log(`[persistence] opened ${dbPath}`);
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
