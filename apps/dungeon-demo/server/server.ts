/**
 * Dungeon-crawler MCP Apps server, four-pane edition.
 *
 * Spec-correct multi-iframe pattern: every "pane" is its own MCP Apps tool
 * returning its own `_meta.ui.resourceUri`. Goose desktop mounts each
 * iframe inline in chat. The four panes share a `worldId` allocated by
 * the first tool call (`start_dungeon`); subsequent open_*_pane tools
 * take the same id.
 *
 * Tools split into three groups:
 *
 *   ENTRY  — each mounts a different iframe.
 *     start_dungeon(seed?, theme?)         → viewport iframe + worldId
 *     open_narration_pane(worldId)         → narration iframe
 *     open_stats_pane(worldId)             → stats iframe
 *     open_controls_pane(worldId)          → controls iframe
 *
 *   STATE  — viewport pushes; everyone else pulls.
 *     sync_state(worldId, partial)         → viewport posts position/inventory
 *     get_state(worldId)                   → any pane reads full state
 *
 *   ACTIONS / NARRATION
 *     enqueue_action(worldId, kind)        → controls posts; viewport drains
 *     dequeue_actions(worldId)             → viewport polls each tick
 *     narrate(worldId, events)             → LLM-generated party banter
 *     explore_chunk(worldId, cx, cy)       → LLM-generated chunk lore
 *
 * The LLM is provider-agnostic: see ./llm.ts. Set LLM_PROVIDER and LLM_MODEL.
 */
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { generateTyped, getModelName, getProvider, hasCredentials } from "./llm.js";

const DIST_DIR = path.join(import.meta.dirname, "dist");

// ---------------------------------------------------------------------------
// World state — shared across the four iframes. In-memory; survives only as
// long as the server process. Sufficient for a hackathon demo.
// ---------------------------------------------------------------------------

type DecorationKind =
  | "chest" | "altar" | "statue" | "glyph" | "crystal"
  | "bones" | "book" | "goblin" | "slime" | "wisp";

type Decoration = { x: number; y: number; kind: DecorationKind; label?: string };

type ChunkLore = {
  cx: number;
  cy: number;
  theme: string;
  narrative: string;
  decorations: Decoration[];
};

type NarrationLine = { voice: "Narrator" | "Wren" | "Brokk" | "Lyra"; text: string; ts: number };

type WorldState = {
  worldId: string;
  seed: number;
  player: { wx: number; wy: number; angle: number };
  hp: number;
  hpMax: number;
  steps: number;
  currentChunk: { cx: number; cy: number; theme?: string };
  inventory: { id: string; kind: string; label: string }[];
  nearbyDecoration: { kind: string; label?: string } | null;
  chunkLore: Record<string, ChunkLore>;     // key: "cx,cy"
  narrationLog: NarrationLine[];            // append-only, capped
  pendingActions: { id: string; kind: string; ts: number }[];
  startingTheme: string;
};

const worlds = new Map<string, WorldState>();
const NARRATION_CAP = 60;

function newWorld(seed: number, startingTheme: string): WorldState {
  return {
    worldId: randomUUID(),
    seed,
    player: { wx: 4.5, wy: 1.5, angle: Math.PI / 2 },
    hp: 12, hpMax: 12, steps: 0,
    currentChunk: { cx: 0, cy: 0 },
    inventory: [],
    nearbyDecoration: null,
    chunkLore: {},
    narrationLog: [],
    pendingActions: [],
    startingTheme,
  };
}

function getWorld(worldId: string): WorldState {
  const w = worlds.get(worldId);
  if (!w) throw new Error(`unknown worldId: ${worldId}`);
  return w;
}

// ---------------------------------------------------------------------------
// LLM schemas + prompts
// ---------------------------------------------------------------------------

const DECO_KINDS = [
  "chest","altar","statue","glyph","crystal","bones","book","goblin","slime","wisp",
] as const;

const DecorationSchema = z.object({
  x: z.number().int().min(1).max(6),
  y: z.number().int().min(1).max(6),
  kind: z.enum(DECO_KINDS),
  label: z.string().max(40).optional(),
});

const ChunkLoreSchema = z.object({
  theme: z.string().max(80),
  narrative: z.string().max(280),
  decorations: z.array(DecorationSchema).min(2).max(6),
});

const NarrationLineSchema = z.object({
  voice: z.enum(["Narrator", "Wren", "Brokk", "Lyra"]),
  text: z.string().max(200),
});
const NarrationSchema = z.object({
  lines: z.array(NarrationLineSchema).min(1).max(4),
});

const VOICE_SYSTEM = `You write short, atmospheric, second-person dungeon-crawl flavor text.
Each line is at most ~25 words. No fluff, no purple prose. Avoid clichés.

Voices:
- Narrator (omniscient, dry, terse)
- Wren (rogue scout, curious, cracks small jokes)
- Brokk (dwarf warrior, gruff, short sentences, practical)
- Lyra (cleric/scholar, observant, often catches lore details)

1–4 lines per call. Mix voices when appropriate.`;

const CHUNK_LORE_SYSTEM = `You design rooms for a small wireframe dungeon-crawler.
Given a chunk coordinate and recently-visited chunks, produce:
  - a short theme tag (e.g. "flooded crypt", "mushroom hollow")
  - a 1–2 sentence second-person narrative
  - 3–6 decorations placed at integer cells (x,y) in [1..6]
    avoiding the edges (which may be walls)

Honor continuity with neighbors when given.`;

function pushNarration(world: WorldState, lines: { voice: NarrationLine["voice"]; text: string }[]) {
  const ts = Date.now();
  for (const l of lines) {
    world.narrationLog.push({ voice: l.voice, text: l.text, ts });
    if (world.narrationLog.length > NARRATION_CAP) world.narrationLog.shift();
  }
}

// ---------------------------------------------------------------------------
// Resource helpers — load each pane's bundled HTML on demand.
// ---------------------------------------------------------------------------

async function readResourceHtml(file: string): Promise<string> {
  return fs.readFile(path.join(DIST_DIR, file), "utf-8");
}

const URI = {
  viewport: "ui://dungeon/viewport.html",
  narration: "ui://dungeon/narration.html",
  stats: "ui://dungeon/stats.html",
  controls: "ui://dungeon/controls.html",
} as const;

function registerPaneResource(server: McpServer, name: string, uri: string, file: string) {
  registerAppResource(
    server,
    name,
    uri,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: await readResourceHtml(file) }],
    }),
  );
}

// ---------------------------------------------------------------------------
// The MCP server
// ---------------------------------------------------------------------------

export function createServer(): McpServer {
  const server = new McpServer({
    name: "Wireframe Dungeon (4 panes)",
    version: "0.2.0",
  });

  // --- Resources (one per pane) -----------------------------------------
  registerPaneResource(server, "Dungeon Viewport", URI.viewport, "viewport.html");
  registerPaneResource(server, "Dungeon Narration", URI.narration, "narration.html");
  registerPaneResource(server, "Dungeon Stats", URI.stats, "stats.html");
  registerPaneResource(server, "Dungeon Controls", URI.controls, "controls.html");

  // --- ENTRY tools ------------------------------------------------------

  registerAppTool(
    server,
    "start_dungeon",
    {
      title: "Start the wireframe dungeon (viewport)",
      description:
        "Allocate a new dungeon world and open the first-person 3D viewport iframe. Returns a worldId; pass it to open_*_pane to mount the other three panes.",
      inputSchema: {
        seed: z.number().int().default(1),
        starting_theme: z.string().default("drowned crypt"),
      },
      _meta: { ui: { resourceUri: URI.viewport } },
    },
    async (args) => {
      const world = newWorld(args.seed, args.starting_theme);
      worlds.set(world.worldId, world);
      const lore = await generateTyped(
        ChunkLoreSchema,
        CHUNK_LORE_SYSTEM,
        `Spawn chunk at (0,0). Suggested theme: ${args.starting_theme}. No neighbors yet.`,
      );
      world.chunkLore["0,0"] = { cx: 0, cy: 0, ...lore };
      world.currentChunk.theme = lore.theme;
      pushNarration(world, [{ voice: "Narrator", text: lore.narrative }]);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              kind: "init",
              worldId: world.worldId,
              seed: world.seed,
              spawn: { cx: 0, cy: 0, ...lore },
              llm: { provider: getProvider(), model: getModelName(), online: hasCredentials() },
              hint: `To open the other panes, call: open_narration_pane({worldId: "${world.worldId}"}), open_stats_pane({worldId: "${world.worldId}"}), open_controls_pane({worldId: "${world.worldId}"}).`,
            }),
          },
        ],
      };
    },
  );

  registerAppTool(
    server,
    "open_narration_pane",
    {
      title: "Open the narration pane",
      description: "Mount the party-narration scrolling log iframe for an existing world.",
      inputSchema: { worldId: z.string() },
      _meta: { ui: { resourceUri: URI.narration } },
    },
    async (args) => {
      const w = getWorld(args.worldId);
      return { content: [{ type: "text", text: JSON.stringify({ kind: "narration_init", worldId: w.worldId }) }] };
    },
  );

  registerAppTool(
    server,
    "open_stats_pane",
    {
      title: "Open the stats + inventory pane",
      description: "Mount the stats / inventory / nearby-decoration iframe for an existing world.",
      inputSchema: { worldId: z.string() },
      _meta: { ui: { resourceUri: URI.stats } },
    },
    async (args) => {
      const w = getWorld(args.worldId);
      return { content: [{ type: "text", text: JSON.stringify({ kind: "stats_init", worldId: w.worldId }) }] };
    },
  );

  registerAppTool(
    server,
    "open_controls_pane",
    {
      title: "Open the controls pane",
      description: "Mount the action-button iframe (forward/back/turn, look/rest/interact) for an existing world.",
      inputSchema: { worldId: z.string() },
      _meta: { ui: { resourceUri: URI.controls } },
    },
    async (args) => {
      const w = getWorld(args.worldId);
      return { content: [{ type: "text", text: JSON.stringify({ kind: "controls_init", worldId: w.worldId }) }] };
    },
  );

  // --- STATE sync -------------------------------------------------------
  // The viewport is the source of truth for player position and inventory.
  // It calls sync_state every ~200 ms with the public bits; other panes
  // pull get_state at their own cadence.

  const PartialStateSchema = z.object({
    player: z.object({
      wx: z.number(),
      wy: z.number(),
      angle: z.number(),
    }).optional(),
    hp: z.number().optional(),
    steps: z.number().optional(),
    currentChunk: z.object({
      cx: z.number(),
      cy: z.number(),
      theme: z.string().optional(),
    }).optional(),
    inventory: z.array(z.object({
      id: z.string(),
      kind: z.string(),
      label: z.string(),
    })).optional(),
    nearbyDecoration: z.object({
      kind: z.string(),
      label: z.string().optional(),
    }).nullable().optional(),
  });

  registerAppTool(
    server,
    "sync_state",
    {
      title: "Push viewport state",
      description:
        "Viewport iframe pushes its current player/chunk/inventory state. Throttle to ~5 Hz client-side.",
      inputSchema: {
        worldId: z.string(),
        state: PartialStateSchema,
      },
      _meta: { ui: { resourceUri: URI.viewport } },
    },
    async (args) => {
      const w = getWorld(args.worldId);
      Object.assign(w, args.state);
      return { content: [{ type: "text", text: JSON.stringify({ kind: "ack" }) }] };
    },
  );

  registerAppTool(
    server,
    "get_state",
    {
      title: "Read full world state",
      description:
        "Any pane (especially narration / stats) calls this to refresh its view. Returns player, chunk, inventory, narration log, etc.",
      inputSchema: { worldId: z.string(), since_ts: z.number().optional() },
      _meta: { ui: { resourceUri: URI.narration } },
    },
    async (args) => {
      const w = getWorld(args.worldId);
      const since = args.since_ts ?? 0;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            kind: "state",
            player: w.player,
            hp: w.hp,
            hpMax: w.hpMax,
            steps: w.steps,
            currentChunk: w.currentChunk,
            inventory: w.inventory,
            nearbyDecoration: w.nearbyDecoration,
            narrationLog: w.narrationLog.filter(l => l.ts > since),
            loadedChunkCount: Object.keys(w.chunkLore).length,
          }),
        }],
      };
    },
  );

  // --- ACTION queue -----------------------------------------------------

  const ACTION_KINDS = [
    "forward", "back", "turn-left", "turn-right",
    "look", "listen", "rest", "interact",
  ] as const;

  registerAppTool(
    server,
    "enqueue_action",
    {
      title: "Queue a user action",
      description:
        "Controls pane posts a click action. Viewport drains via dequeue_actions on each tick.",
      inputSchema: {
        worldId: z.string(),
        kind: z.enum(ACTION_KINDS),
      },
      _meta: { ui: { resourceUri: URI.controls } },
    },
    async (args) => {
      const w = getWorld(args.worldId);
      w.pendingActions.push({ id: randomUUID(), kind: args.kind, ts: Date.now() });
      return { content: [{ type: "text", text: JSON.stringify({ kind: "queued" }) }] };
    },
  );

  registerAppTool(
    server,
    "dequeue_actions",
    {
      title: "Drain pending actions",
      description: "Viewport calls this each tick (~5 Hz) to pick up clicks from the controls pane.",
      inputSchema: { worldId: z.string() },
      _meta: { ui: { resourceUri: URI.viewport } },
    },
    async (args) => {
      const w = getWorld(args.worldId);
      const drained = w.pendingActions.splice(0, w.pendingActions.length);
      return { content: [{ type: "text", text: JSON.stringify({ kind: "actions", actions: drained }) }] };
    },
  );

  // --- LLM tools --------------------------------------------------------

  registerAppTool(
    server,
    "narrate",
    {
      title: "Narrate events",
      description:
        "Convert recent in-game events into 1–4 lines of party-voiced flavor text. Lines are appended to the world's narration log AND returned to the caller.",
      inputSchema: {
        worldId: z.string(),
        events: z.array(z.record(z.string(), z.any())),
      },
      _meta: { ui: { resourceUri: URI.viewport } },
    },
    async (args) => {
      const w = getWorld(args.worldId);
      const result = await generateTyped(
        NarrationSchema,
        VOICE_SYSTEM,
        `Recent events:\n${JSON.stringify(args.events, null, 2)}`,
      );
      pushNarration(w, result.lines);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  registerAppTool(
    server,
    "explore_chunk",
    {
      title: "Explore a chunk (LLM lore)",
      description:
        "Generate theme + narrative + decoration placements for a chunk. The viewport calls this when the player nears an unloaded chunk's edge.",
      inputSchema: {
        worldId: z.string(),
        cx: z.number().int(),
        cy: z.number().int(),
      },
      _meta: { ui: { resourceUri: URI.viewport } },
    },
    async (args) => {
      const w = getWorld(args.worldId);
      const key = `${args.cx},${args.cy}`;
      if (w.chunkLore[key]) {
        return { content: [{ type: "text", text: JSON.stringify(w.chunkLore[key]) }] };
      }
      const recents = Object.values(w.chunkLore).slice(-5).map(c => ({ cx: c.cx, cy: c.cy, theme: c.theme }));
      const lore = await generateTyped(
        ChunkLoreSchema,
        CHUNK_LORE_SYSTEM,
        `Chunk (${args.cx}, ${args.cy}). Seed=${w.seed}. ${
          recents.length ? `Recently visited: ${recents.map(r => `(${r.cx},${r.cy})=${r.theme}`).join(", ")}.` : ""
        }`,
      );
      w.chunkLore[key] = { cx: args.cx, cy: args.cy, ...lore };
      return { content: [{ type: "text", text: JSON.stringify(w.chunkLore[key]) }] };
    },
  );

  return server;
}
