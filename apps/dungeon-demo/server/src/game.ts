/**
 * Pure game state + procedural chunk generation.
 *
 * Walls are deterministic (seeded per-chunk), so the maze stays stable
 * across LLM calls. Lore (theme/narrative/decorations) is requested
 * separately from the MCP server and overlaid on the chunk when it
 * arrives — wall walking never blocks on the network.
 */

export const CHUNK = 8;          // cells per chunk side
export const CELL = 1.0;         // world units per cell
export const DOOR_AT = 4;        // door cell index on each chunk edge

export type Cell = 0 | 1;        // 0 floor, 1 wall

export type Decoration = {
  x: number;           // local cell coord 0..CHUNK-1
  y: number;
  kind: string;        // "chest" | "altar" | "statue" | ...
  label?: string;
};

export type Chunk = {
  cx: number;
  cy: number;
  cells: Cell[][];     // [y][x]
  theme?: string;
  narrative?: string;
  decorations: Decoration[];
  loreLoaded: boolean;
};

export type Player = {
  wx: number;          // world coords (continuous)
  wy: number;
  angle: number;       // radians, 0 = +x, π/2 = +y (compass: +y is north)
};

export type InventoryItem = { id: string; kind: string; label: string };

export type GameState = {
  seed: number;
  chunks: Map<string, Chunk>;
  player: Player;
  inventory: InventoryItem[];
  hp: number;
  hpMax: number;
  steps: number;
  recent: { cx: number; cy: number; theme: string }[]; // for lore continuity
};

// --- deterministic seeded RNG --------------------------------------------
// Mulberry32 — small + fast, good enough for chunk layouts.
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chunkSeed(globalSeed: number, cx: number, cy: number): number {
  return (globalSeed * 73856093) ^ (cx * 19349663) ^ (cy * 83492791);
}

/**
 * Procedurally lay out walls for a chunk.
 *
 * - Perimeter is walls except at door cells (midpoint of each edge), which
 *   guarantees neighbor chunks always connect.
 * - 0–2 short interior wall segments add some shape to the room.
 */
export function generateChunkCells(seed: number, cx: number, cy: number): Cell[][] {
  const r = rng(chunkSeed(seed, cx, cy));
  const cells: Cell[][] = [];
  for (let y = 0; y < CHUNK; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < CHUNK; x++) {
      const isPerimeter = x === 0 || y === 0 || x === CHUNK - 1 || y === CHUNK - 1;
      row.push(isPerimeter ? 1 : 0);
    }
    cells.push(row);
  }
  // Carve doors at edge midpoints.
  cells[0][DOOR_AT] = 0;
  cells[CHUNK - 1][DOOR_AT] = 0;
  cells[DOOR_AT][0] = 0;
  cells[DOOR_AT][CHUNK - 1] = 0;

  // Interior obstacles.
  const blobs = (r() < 0.7 ? 1 : 0) + (r() < 0.4 ? 1 : 0);
  for (let i = 0; i < blobs; i++) {
    const len = 2 + Math.floor(r() * 3); // 2..4
    const horiz = r() < 0.5;
    const sx = 2 + Math.floor(r() * (CHUNK - 4));
    const sy = 2 + Math.floor(r() * (CHUNK - 4));
    for (let k = 0; k < len; k++) {
      const x = horiz ? sx + k : sx;
      const y = horiz ? sy : sy + k;
      if (x > 0 && x < CHUNK - 1 && y > 0 && y < CHUNK - 1) {
        // Don't block the line between opposite doors entirely.
        if (!((x === DOOR_AT && y === 1) || (x === DOOR_AT && y === CHUNK - 2)
              || (x === 1 && y === DOOR_AT) || (x === CHUNK - 2 && y === DOOR_AT))) {
          cells[y][x] = 1;
        }
      }
    }
  }
  return cells;
}

export function chunkKey(cx: number, cy: number): string { return `${cx},${cy}`; }

export function ensureChunk(state: GameState, cx: number, cy: number): Chunk {
  const key = chunkKey(cx, cy);
  let chunk = state.chunks.get(key);
  if (!chunk) {
    chunk = {
      cx,
      cy,
      cells: generateChunkCells(state.seed, cx, cy),
      decorations: [],
      loreLoaded: false,
    };
    state.chunks.set(key, chunk);
  }
  return chunk;
}

export function worldToChunk(wx: number, wy: number): { cx: number; cy: number; lx: number; ly: number } {
  const cx = Math.floor(wx / CHUNK);
  const cy = Math.floor(wy / CHUNK);
  const lx = wx - cx * CHUNK;
  const ly = wy - cy * CHUNK;
  return { cx, cy, lx, ly };
}

export function isWallAt(state: GameState, wx: number, wy: number): boolean {
  const { cx, cy, lx, ly } = worldToChunk(wx, wy);
  const chunk = ensureChunk(state, cx, cy);
  const ix = Math.floor(lx);
  const iy = Math.floor(ly);
  if (ix < 0 || iy < 0 || ix >= CHUNK || iy >= CHUNK) return true;
  return chunk.cells[iy][ix] === 1;
}

export function freshGame(seed: number): GameState {
  const state: GameState = {
    seed,
    chunks: new Map(),
    // Spawn near door at the south edge of (0,0) chunk, facing north.
    player: { wx: DOOR_AT + 0.5, wy: 1.5, angle: Math.PI / 2 },
    inventory: [],
    hp: 12,
    hpMax: 12,
    steps: 0,
    recent: [],
  };
  ensureChunk(state, 0, 0);
  return state;
}

/**
 * Returns chunk coordinates within `radius` chunks of the player whose
 * lore hasn't been loaded yet — these are candidates for the iframe to
 * fetch via app.callServerTool('explore_chunk', ...).
 *
 * We trigger lore fetch only when the player gets within 2 cells of the
 * chunk boundary, which gives the LLM call (~300–800 ms) time to return
 * before the player actually crosses into the new chunk.
 */
export function chunksNeedingLore(state: GameState): Array<{ cx: number; cy: number }> {
  const here = worldToChunk(state.player.wx, state.player.wy);
  const candidates: Array<{ cx: number; cy: number; near: boolean }> = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const cx = here.cx + dx;
      const cy = here.cy + dy;
      if (dx === 0 && dy === 0) {
        candidates.push({ cx, cy, near: true });
        continue;
      }
      const key = chunkKey(cx, cy);
      const chunk = state.chunks.get(key);
      if (chunk?.loreLoaded) continue;
      // Distance from player to chunk's nearest edge.
      const minX = cx * CHUNK;
      const maxX = minX + CHUNK;
      const minY = cy * CHUNK;
      const maxY = minY + CHUNK;
      const dxToBox = Math.max(minX - state.player.wx, 0, state.player.wx - maxX);
      const dyToBox = Math.max(minY - state.player.wy, 0, state.player.wy - maxY);
      const dist = Math.hypot(dxToBox, dyToBox);
      if (dist <= 2.0) candidates.push({ cx, cy, near: true });
    }
  }
  return candidates
    .filter((c) => {
      const chunk = state.chunks.get(chunkKey(c.cx, c.cy));
      return !chunk?.loreLoaded;
    })
    .map(({ cx, cy }) => ({ cx, cy }));
}
