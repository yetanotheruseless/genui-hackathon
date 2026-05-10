/**
 * Culture Contact MCP Apps server — the star-systems demo, reskinned.
 *
 * State model is **multiplayer-ready**:
 *
 *   Galaxy   ←→  gameId         (shared: orbitals, public chat, players list)
 *     │
 *     ├── Player A  ←→  playerId   (private: ship, Mind, log, compendium)
 *     ├── Player B  ←→  playerId
 *     └── …
 *
 * A new `start_starship` call creates a new Galaxy by default. Pass an
 * existing `gameId` (e.g. "default-public") and you join that Galaxy
 * instead — your ship shows up in other players' "nearby" list, your
 * orbitals are visible, etc.
 *
 * Tools split into:
 *   ENTRY            start_starship / open_compendium / open_bridge
 *   STATE            sync_state / get_state
 *   ACTIONS / LLM    observe / warp_to / talk_to_mind
 *   GALAXY (shared)  build_orbital / list_players / send_public
 *   META             list_objects / list_minds
 */
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateText, tool } from "ai";
import fs, { appendFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const DEBUG_LOG_PATH = process.env.DEBUG_LOG_PATH ?? "/tmp/cockpit-debug.log";
// Truncate at startup so each subprocess (each new chat session) starts fresh.
void writeFile(DEBUG_LOG_PATH, `--- session start ${new Date().toISOString()} pid=${process.pid} ---\n`).catch(() => {});

import { STARS, STAR_INDEX, spectralBucket, starRadiusSolar, type Planet, type PlanetKind, type SpectralClass, type Star } from "./astrodata.js";
import {
  MINDS,
  SHIP_CLASS_INFO,
  listMinds,
  mindCatalogToolsBlock,
  mindContextBlock,
  mindSystemPrompt,
  pickMind,
  type MindPersona,
  type ShipClass,
} from "./culture.js";
import {
  findSystems,
  loadFullCatalog,
  type CatalogStar,
  type FullCatalog,
} from "./catalog.js";
import { generateTyped, getModel, getModelName, getProvider, hasCredentials } from "./llm.js";

const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");

// ---------------------------------------------------------------------------
// Full HYG + Exoplanet catalog (~120k stars, ~6k planets). Loaded once at
// startup. Lazily — wrapped in a getter so a missing data/ dir doesn't
// crash the whole server during early dev. If it's missing, find_systems
// throws a clear "fetch the catalog first" error and the rest of the
// server still works against the curated 21.
// ---------------------------------------------------------------------------

let _catalog: FullCatalog | null = null;
let _catalogError: Error | null = null;
function getCatalog(): FullCatalog {
  if (_catalog) return _catalog;
  if (_catalogError) throw _catalogError;
  try {
    _catalog = loadFullCatalog(DATA_DIR, STARS);
    return _catalog;
  } catch (e) {
    _catalogError = e instanceof Error ? e : new Error(String(e));
    throw _catalogError;
  }
}
// Eager-load at module init so startup time accounts for it. Failures
// are remembered and surfaced when find_systems is actually called.
try { getCatalog(); } catch (e) {
  console.warn("[catalog] not loaded at startup:", (e as Error).message,
    "— run scripts/fetch-hyg.ts and scripts/fetch-exoplanets.ts");
}

/** Resolve a star id from either the curated 21 or the full catalog. */
function resolveStar(id: string): Star | CatalogStar | null {
  if (STAR_INDEX[id]) return STAR_INDEX[id];
  if (_catalog) {
    const c = _catalog.byId.get(id);
    if (c) return c;
  }
  return null;
}

/** Returns name (best-effort) for a star id. */
function resolveStarName(id: string): string {
  return resolveStar(id)?.name ?? id;
}

/** Compact bright-catalog payload for the cockpit's THREE.Points backdrop.
 *  Returns one entry per star: position (ly), spectral class single letter,
 *  apparent magnitude (defaulted to absMag if missing). Curated stars are
 *  filtered out — they're rendered with the rich layered-sprite system. */
function brightStarsPayload(): Array<[number, number, number, string, number]> {
  if (!_catalog) return [];
  const curatedIds = new Set(STARS.map((s) => s.id));
  const out: Array<[number, number, number, string, number]> = [];
  for (const s of _catalog.bright) {
    if (curatedIds.has(s.id)) continue;
    const mag = s.apparentMag ?? s.absMag ?? 6;
    out.push([s.position[0], s.position[1], s.position[2], s.spectralClass, mag]);
  }
  return out;
}

/** Short summary like "3 planets: 2× terrestrial, 1× gas_giant" or "" if none. */
function planetSummaryFor(s: Star | CatalogStar | null): string {
  if (!s || !s.planets || s.planets.length === 0) return "";
  const counts = new Map<string, number>();
  for (const p of s.planets) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
  const parts: string[] = [];
  for (const [k, v] of counts) parts.push(`${v}× ${k.replace("_", " ")}`);
  return `${s.planets.length} planet${s.planets.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

// ---------------------------------------------------------------------------
// State — split into shared Galaxy and per-player Player.
// ---------------------------------------------------------------------------

type LogLineKind = "mind_narrate" | "mind_chat" | "user" | "system";
type LogLine = { id: string; kind: LogLineKind; voice: string; text: string; ts: number };

type Compendium = {
  spectralCounts: Record<string, number>;
  planetCounts: Record<string, number>;
  discoveredObjectIds: string[];
  discoveredObjectNames: string[];
};

type Player = {
  playerId: string;
  shipName: string;
  shipClass: ShipClass;
  mind: MindPersona;
  /** Wall-clock ms of last activity. Touched by getPlayer() on every
   *  tool call that addresses this player. Stale players (idle longer
   *  than IDLE_REAP_MS) are reaped by a periodic sweep. */
  lastSeenAt: number;
  position: [number, number, number];
  heading: [number, number, number];
  throttle: number;
  hoveredId: string | null;
  targetId: string | null;
  warpEngaged: boolean;
  /** Set when the player has docked at an Orbital (within DOCK_RANGE_LY
   *  of orbital.position and `dock_orbital` was called). Cleared by
   *  `undock_orbital` or by warping away. While set, the bridge pane
   *  shows the orbital's description card and the cockpit hides the
   *  habitat closeup geometry's "warpable" affordance. */
  dockedOrbitalId: string | null;
  log: LogLine[];           // private bridge log: narrations + chat
  compendium: Compendium;
  /** Star ids the Mind (or captain agent) has pinned for this player.
   *  Cockpit renders these distinctly; they survive across reloads as
   *  long as the player record itself does (i.e. tab refresh keeps them,
   *  reaper sweep clears them). Order = oldest first. */
  pinnedStarIds: string[];
};

type Orbital = {
  id: string;
  name: string;
  builderPlayerId: string;
  builderShipName: string;
  position: [number, number, number];
  parentStarId?: string;
  ringRadius: number;       // ly (cosmetic ring radius for renderer)
  /** Builder's notes — anything from a single line to a paragraph,
   *  visible to anyone docked at the orbital and in the compendium. */
  description: string;
  /** Live occupancy. A player joins this list on dock_orbital and
   *  leaves on undock_orbital / disconnect / warp-away. Used by the
   *  "OTHER MINDS ABOARD" panel in the bridge pane. */
  dockedPlayerIds: string[];
  ts: number;
};

/** Maximum range from the orbital position at which dock_orbital()
 *  succeeds. 0.5 AU ≈ "ship is parked at the habitat". The cockpit
 *  parks itself at orbital.position when warp_to_orbital is called, so
 *  in practice the ship is centimeters away — this margin just gives
 *  the captain agent or a manually-flying player some slop. */
const DOCK_RANGE_LY = 0.5 * (1 / 63241.077);

type PublicMessage = { id: string; fromPlayerId: string; fromShipName: string; text: string; ts: number };

type Galaxy = {
  gameId: string;
  seed: number;
  players: Map<string, Player>;
  orbitals: Orbital[];
  publicChat: PublicMessage[];
  // Cached recent events for global timelines.
  events: { id: string; kind: string; text: string; ts: number }[];
};

const galaxies = new Map<string, Galaxy>();
const LOG_CAP = 80;
const PUBLIC_CAP = 40;

// Idle-player reaper. Players that haven't been touched in IDLE_REAP_MS
// are removed from their galaxy. Combined with the cockpit's localStorage
// playerId-stickiness, a tab refresh keeps you alive (it reattaches and
// touches lastSeenAt before the reap interval), but a closed tab's ghost
// gets cleaned out automatically. Catches Liam's CLAUDE.md issue #4.
const IDLE_REAP_MS = 60_000;
const REAP_INTERVAL_MS = 30_000;
setInterval(() => {
  const now = Date.now();
  let totalReaped = 0;
  for (const galaxy of galaxies.values()) {
    for (const [pid, player] of galaxy.players) {
      if (now - player.lastSeenAt > IDLE_REAP_MS) {
        // Pull the reaped player off any orbital they were docked at,
        // so the dockedPlayerIds list doesn't accumulate ghosts.
        if (player.dockedOrbitalId) {
          const orbital = galaxy.orbitals.find((o) => o.id === player.dockedOrbitalId);
          if (orbital) orbital.dockedPlayerIds = orbital.dockedPlayerIds.filter((id) => id !== pid);
        }
        galaxy.players.delete(pid);
        appendEvent(galaxy, "departure", `${player.shipName} drifted out of contact.`);
        totalReaped++;
      }
    }
  }
  if (totalReaped > 0) console.log(`[reaper] removed ${totalReaped} idle player(s)`);
}, REAP_INTERVAL_MS).unref();   // .unref() so the timer doesn't keep node alive on shutdown

function getOrCreateGalaxy(gameId: string | undefined, seed: number): Galaxy {
  if (gameId && galaxies.has(gameId)) return galaxies.get(gameId)!;
  const galaxy: Galaxy = {
    gameId: gameId ?? randomUUID(),
    seed,
    players: new Map(),
    orbitals: [],
    publicChat: [],
    events: [],
  };
  galaxies.set(galaxy.gameId, galaxy);
  return galaxy;
}

function getGalaxy(gameId: string): Galaxy {
  const g = galaxies.get(gameId);
  if (!g) throw new Error(`unknown gameId: ${gameId}`);
  return g;
}

function getPlayer(galaxy: Galaxy, playerId: string): Player {
  const p = galaxy.players.get(playerId);
  if (!p) throw new Error(`unknown playerId in game ${galaxy.gameId}: ${playerId}`);
  p.lastSeenAt = Date.now();   // any tool that addresses the player counts as activity
  return p;
}

function newPlayer(_seed: number, shipClass: ShipClass, mind: MindPersona, requestedId?: string): Player {
  // Spawn ~10 AU "above" Sol (1 AU ≈ 1.581e-5 ly) so Sol is visible as a
  // proper sphere on the first frame instead of having the camera land
  // inside its photosphere.
  return {
    playerId: requestedId ?? randomUUID(),
    shipName: mind.name,
    shipClass,
    mind,
    lastSeenAt: Date.now(),
    position: [0, 1.58e-4, 0],
    heading: [0, 0, -1],
    throttle: 0,
    hoveredId: null,
    targetId: null,
    warpEngaged: false,
    dockedOrbitalId: null,
    log: [],
    compendium: {
      spectralCounts: {},
      planetCounts: {},
      discoveredObjectIds: [],
      discoveredObjectNames: [],
    },
    pinnedStarIds: [],
  };
}

function recordDiscovery(player: Player, star: Star | CatalogStar) {
  if (player.compendium.discoveredObjectIds.includes(star.id)) return;
  player.compendium.discoveredObjectIds.push(star.id);
  player.compendium.discoveredObjectNames.push(star.name);
  // spectralBucket only inspects spectralClass/lumClass — both Star and
  // CatalogStar carry those, so the cast is safe.
  const bucket = spectralBucket(star as Star);
  player.compendium.spectralCounts[bucket] = (player.compendium.spectralCounts[bucket] || 0) + 1;
  for (const p of star.planets || []) {
    player.compendium.planetCounts[p.kind] = (player.compendium.planetCounts[p.kind] || 0) + 1;
  }
}

function appendLog(player: Player, line: Omit<LogLine, "id" | "ts">) {
  player.log.push({ id: randomUUID(), ts: Date.now(), ...line });
  if (player.log.length > LOG_CAP) player.log.shift();
}

function appendPublic(galaxy: Galaxy, msg: Omit<PublicMessage, "id" | "ts">) {
  galaxy.publicChat.push({ id: randomUUID(), ts: Date.now(), ...msg });
  if (galaxy.publicChat.length > PUBLIC_CAP) galaxy.publicChat.shift();
}

function appendEvent(galaxy: Galaxy, kind: string, text: string) {
  galaxy.events.push({ id: randomUUID(), kind, text, ts: Date.now() });
  if (galaxy.events.length > 80) galaxy.events.shift();
}

/** Resolve a player's pinnedStarIds into compact records the iframes /
 *  Mind can read directly. Skips ids that no longer resolve. */
function pinnedStarsView(player: Player) {
  const out: {
    id: string;
    name: string;
    spectralType: string;
    distanceLy?: number;
    position: [number, number, number];
    planetCount: number;
    planetSummary?: string;
  }[] = [];
  for (const id of player.pinnedStarIds) {
    const s = resolveStar(id);
    if (!s) continue;
    const d = "distanceLy" in s ? s.distanceLy : undefined;
    out.push({
      id: id,
      name: s.name,
      spectralType: s.spectralType,
      distanceLy: d ?? undefined,
      position: s.position,
      planetCount: s.planets?.length ?? 0,
      planetSummary: planetSummaryFor(s) || undefined,
    });
  }
  return out;
}

function nearbyPlayers(galaxy: Galaxy, self: Player, radiusLy: number = 30) {
  const result: { shipName: string; mindName: string; position: [number, number, number]; distance: number }[] = [];
  for (const p of galaxy.players.values()) {
    if (p.playerId === self.playerId) continue;
    const d = Math.hypot(
      p.position[0] - self.position[0],
      p.position[1] - self.position[1],
      p.position[2] - self.position[2],
    );
    if (d <= radiusLy) {
      result.push({ shipName: p.shipName, mindName: p.mind.name, position: p.position, distance: d });
    }
  }
  return result.sort((a, b) => a.distance - b.distance);
}

// ---------------------------------------------------------------------------
// Catalog-tool primitives. Defined once and re-used by both the bound-
// tool path inside talk_to_mind and the standalone MCP tool registrations
// below. Same logic, two callsites.
// ---------------------------------------------------------------------------

const PLANET_KINDS: PlanetKind[] = [
  "terrestrial", "super_earth", "neptune_like", "ice_giant",
  "gas_giant", "hot_jupiter", "super_jupiter",
];
const SPECTRAL_CLASSES: SpectralClass[] = ["O", "B", "A", "F", "G", "K", "M", "L", "T", "WD", "NS"];

/**
 * Some providers (looking at you, Anthropic) occasionally serialize a
 * single-value enum as the JSON of a one-element array: `"[\"foo\"]"`.
 * Coerce: if input looks like that, unwrap to the inner string.
 */
function coerceEnum<T extends [string, ...string[]]>(values: T) {
  return z.preprocess((v) => {
    if (typeof v !== "string") return v;
    if (v.startsWith("[")) {
      try {
        const parsed = JSON.parse(v);
        if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === "string") return parsed[0];
      } catch { /* leave as-is, validation will fail informatively */ }
    }
    return v;
  }, z.enum(values));
}

const FindSystemsInputSchema = z.object({
  hasPlanetKinds: z.array(z.enum(PLANET_KINDS as [PlanetKind, ...PlanetKind[]])).optional()
    .describe("If set, only return stars hosting at least one planet of EVERY listed kind."),
  spectralClasses: z.array(z.enum(SPECTRAL_CLASSES as [SpectralClass, ...SpectralClass[]])).optional()
    .describe("Restrict to these spectral classes (e.g. ['G','K'] for sun-like)."),
  excludeIds: z.array(z.string()).optional().describe("Drop these ids from the result (e.g. ['sol'])."),
  nearPosition: z.tuple([z.number(), z.number(), z.number()]).optional()
    .describe("ly position to measure 'nearby' from. Defaults to Sol."),
  maxDistanceLy: z.number().positive().optional(),
  sort: coerceEnum(["distance_to_origin", "distance_to_position", "luminosity"]).optional(),
  requirePlanets: z.boolean().optional().describe("If true (or hasPlanetKinds is set), only stars with at least one known planet."),
  limit: z.number().int().positive().max(200).optional(),
});
type FindSystemsInput = z.infer<typeof FindSystemsInputSchema>;

function findSystemsExec(args: FindSystemsInput) {
  const cat = getCatalog();
  const results = findSystems(cat, {
    hasPlanetKinds: args.hasPlanetKinds,
    spectralClasses: args.spectralClasses,
    excludeIds: args.excludeIds,
    nearPosition: args.nearPosition,
    maxDistanceLy: args.maxDistanceLy,
    sort: args.sort as "distance_to_origin" | "distance_to_position" | "luminosity" | undefined,
    requirePlanets: args.requirePlanets,
    limit: args.limit ?? 10,
  });
  return { kind: "find_systems_result", count: results.length, results };
}

function pinStarExec(player: Player, starId: string) {
  // Resolve via curated OR catalog so the Mind can pin Banks-named stars
  // ("vega") just as easily as raw HYG ids.
  const star = resolveStar(starId);
  if (!star) return { error: `unknown star_id: ${starId}` };
  if (!player.pinnedStarIds.includes(starId)) {
    player.pinnedStarIds.push(starId);
    appendLog(player, {
      kind: "system",
      voice: "[pin]",
      text: `📍 ${star.name} pinned (${star.spectralType}${star.planets?.length ? `, ${star.planets.length} planets` : ""}).`,
    });
  }
  return {
    kind: "pinned",
    star_id: starId,
    name: star.name,
    spectralType: star.spectralType,
    position: star.position,
    distanceLy: star.distanceLy ?? null,
    planetCount: star.planets?.length ?? 0,
  };
}

function unpinStarExec(player: Player, starId: string) {
  const before = player.pinnedStarIds.length;
  player.pinnedStarIds = player.pinnedStarIds.filter((id) => id !== starId);
  return { kind: "unpinned", star_id: starId, removed: before !== player.pinnedStarIds.length };
}

function clearPinnedExec(player: Player) {
  const n = player.pinnedStarIds.length;
  player.pinnedStarIds = [];
  return { kind: "cleared", removed: n };
}

function compendiumSummary(c: Compendium): string {
  const parts: string[] = [];
  const n = c.discoveredObjectIds.length;
  parts.push(`${n} system${n === 1 ? "" : "s"}`);
  for (const [k, v] of Object.entries(c.spectralCounts)) parts.push(`${v}× ${k.replace("_", " ")}`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// LLM helpers
// ---------------------------------------------------------------------------

const NarrationSchema = z.object({
  preamble: z.string().min(20).max(1500).describe("Spoken to the crew in the Mind's voice on arrival or close approach to the object. 1–3 short paragraphs."),
  worlds: z.array(z.object({
    name: z.string(),
    line: z.string().max(400),
  })).optional(),
});

function narrationSystem(persona: MindPersona): string {
  return `${mindSystemPrompt(persona)}

You're being asked to narrate an observation. Output JSON with:
  "preamble": 1–2 short paragraphs in your voice describing what you/we are looking at — real astronomical facts plus the kind of adventurous-gameplay hook a Contact GCU's Mind would naturally include. Reference real properties from the data sheet you're given.
  "worlds" (optional): for each known planet, one short flavor line (max ~30 words). Include only when the data sheet has planets.

NO markdown fences. NO commentary outside the JSON.`;
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

const URI = {
  cockpit:    "ui://stars/cockpit.html",
  compendium: "ui://stars/compendium.html",
  bridge:     "ui://stars/bridge.html",
} as const;

// Slot hint for MCP Apps hosts that support a fixed multi-pane layout
// (e.g. apps/cockpit). Goose-desktop ignores this and renders inline.
const SLOT = {
  [URI.cockpit]:    "viewport",
  [URI.compendium]: "side",
  [URI.bridge]:     "bottom",
} as const;

type UiResourceUri = (typeof URI)[keyof typeof URI];

function uiMeta(resourceUri: UiResourceUri) {
  return { ui: { resourceUri, slot: SLOT[resourceUri] } } as const;
}

async function readResourceHtml(file: string): Promise<string> {
  return fs.readFile(path.join(DIST_DIR, file), "utf-8");
}

function registerPaneResource(server: McpServer, name: string, uri: string, file: string) {
  registerAppResource(
    server,
    name,
    uri,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({ contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: await readResourceHtml(file) }] }),
  );
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createServer(): McpServer {
  const server = new McpServer({ name: "Culture Contact (MCP Apps)", version: "0.3.0" });

  registerPaneResource(server, "Cockpit",    URI.cockpit,    "cockpit.html");
  registerPaneResource(server, "Compendium", URI.compendium, "compendium.html");
  registerPaneResource(server, "Bridge",     URI.bridge,     "bridge.html");

  // --- ENTRY tools ----------------------------------------------------

  registerAppTool(
    server,
    "start_starship",
    {
      title: "Spawn a Culture vessel",
      description:
        "Allocate a player in a Culture-Contact galaxy. Returns gameId, playerId, ship, and Mind. " +
        "If you pass an existing gameId, you join that galaxy and become visible to the other players in it. " +
        "If you don't, a new private galaxy is created.",
      inputSchema: {
        seed: z.number().int().default(1),
        gameId: z.string().optional().describe("Join an existing galaxy. Omit to create a new one."),
        ship_class: z.enum(["GCU", "LSV", "ROU", "GOU"]).optional()
          .describe("Hint for ship class. Mind selection may override."),
        mind_id: z.string().optional()
          .describe("Pick a specific Mind by id (see list_minds). Random if omitted."),
        playerId: z.string().optional().describe(
          "If provided AND a player with this id already exists in the galaxy, " +
          "reattach to that player instead of spawning a new one. Lets browser " +
          "tabs persist their identity across reloads via localStorage."),
      },
      _meta: uiMeta(URI.cockpit),
    },
    async (args) => {
      const galaxy = getOrCreateGalaxy(args.gameId, args.seed);
      // Reattach path: if the caller passed a playerId and we still have
      // that player around, reuse it. Cleanest fix for the "reload spawns
      // a fresh ghost every time" problem.
      const existing = args.playerId ? galaxy.players.get(args.playerId) : undefined;
      let player: Player;
      let mind: MindPersona;
      let shipClass: ShipClass;
      let reattached = false;
      if (existing) {
        existing.lastSeenAt = Date.now();
        // Defensive backfill for fields added since this player was spawned.
        if (!Array.isArray(existing.pinnedStarIds)) existing.pinnedStarIds = [];
        player = existing;
        mind = existing.mind;
        shipClass = existing.shipClass;
        reattached = true;
      } else {
        mind = pickMind(args.seed + galaxy.players.size, args.mind_id);
        shipClass = (args.ship_class as ShipClass | undefined) ?? mind.shipClass;
        player = newPlayer(args.seed, shipClass, mind, args.playerId);
        galaxy.players.set(player.playerId, player);
        appendEvent(galaxy, "arrival", `${player.shipName} arrived in this volume.`);
        recordDiscovery(player, STAR_INDEX.sol);
        appendLog(player, {
          kind: "mind_chat",
          voice: mind.name,
          text: `Aboard. I'm the ${shipClass} ${mind.name}. Ship telemetry online; ${galaxy.players.size === 1 ? "we have the volume to ourselves" : `${galaxy.players.size - 1} other Culture vessel${galaxy.players.size === 2 ? "" : "s"} sharing the volume`}. Ask me about anything you see, or just point us somewhere and I'll fly.`,
        });
      }
      void reattached;  // available if we ever want a different welcome path
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            kind: "init",
            gameId: galaxy.gameId,
            playerId: player.playerId,
            seed: galaxy.seed,
            ship: { name: player.shipName, class: shipClass },
            mind: { id: mind.id, name: mind.name, tagline: mind.tagline, shipClass: mind.shipClass },
            stars: STARS.map((s) => ({
              id: s.id, name: s.name, position: s.position,
              spectralClass: s.spectralClass, spectralType: s.spectralType,
              lumClass: s.lumClass, distanceLy: s.distanceLy,
              hasPlanets: !!(s.planets && s.planets.length),
              planetCount: s.planets?.length ?? 0,
              radiusSolar: starRadiusSolar(s),
              planets: s.planets?.map((p) => ({
                name: p.name, kind: p.kind, orbitAU: p.orbitAU,
                massEarths: p.massEarths, radiusEarths: p.radiusEarths,
              })) ?? [],
            })),
            // Bright catalog for the starfield backdrop. Compact (no
            // names/ids) — just position + spectral-class + magnitude.
            // Cockpit builds a single THREE.Points cloud out of these,
            // GPU draws ~17k stars in one call. Stars in the curated
            // set above are filtered out so we don't double-render.
            bright: brightStarsPayload(),
            llm: { provider: getProvider(), model: getModelName(), online: hasCredentials() },
            hint: `Open the other panes: open_compendium({gameId, playerId}), open_bridge({gameId, playerId}).`,
          }),
        }],
      };
    },
  );

  registerAppTool(
    server,
    "open_compendium",
    {
      title: "Open the compendium",
      description: "Mount the compendium iframe — discoveries, orbitals, ships sharing the galaxy.",
      inputSchema: { gameId: z.string(), playerId: z.string() },
      _meta: uiMeta(URI.compendium),
    },
    async (args) => {
      const galaxy = getGalaxy(args.gameId);
      const player = getPlayer(galaxy, args.playerId);
      return { content: [{
        type: "text",
        text: JSON.stringify({
          kind: "compendium_init",
          gameId: galaxy.gameId,
          playerId: player.playerId,
          ship: { name: player.shipName, class: player.shipClass },
          mind: { id: player.mind.id, name: player.mind.name, tagline: player.mind.tagline },
        }),
      }] };
    },
  );

  registerAppTool(
    server,
    "open_bridge",
    {
      title: "Open the bridge",
      description: "Mount the chat-with-Mind iframe — Mind-narrated observations + back-and-forth dialogue with your ship.",
      inputSchema: { gameId: z.string(), playerId: z.string() },
      _meta: uiMeta(URI.bridge),
    },
    async (args) => {
      const galaxy = getGalaxy(args.gameId);
      const player = getPlayer(galaxy, args.playerId);
      return { content: [{
        type: "text",
        text: JSON.stringify({
          kind: "bridge_init",
          gameId: galaxy.gameId,
          playerId: player.playerId,
          ship: { name: player.shipName, class: player.shipClass },
          mind: { id: player.mind.id, name: player.mind.name, tagline: player.mind.tagline },
        }),
      }] };
    },
  );

  // --- STATE sync -----------------------------------------------------

  const PartialStateSchema = z.object({
    position: z.tuple([z.number(), z.number(), z.number()]).optional(),
    heading: z.tuple([z.number(), z.number(), z.number()]).optional(),
    throttle: z.number().min(0).max(1).optional(),
    hoveredId: z.string().nullable().optional(),
    targetId: z.string().nullable().optional(),
    warpEngaged: z.boolean().optional(),
  });

  registerAppTool(
    server,
    "sync_state",
    {
      title: "Push player state",
      description: "Cockpit pushes its position / throttle / hover / target. Throttle to ~5 Hz.",
      inputSchema: { gameId: z.string(), playerId: z.string(), state: PartialStateSchema },
      _meta: uiMeta(URI.cockpit),
    },
    async (args) => {
      const player = getPlayer(getGalaxy(args.gameId), args.playerId);
      // Skip null/undefined fields so the iframe's regular sync doesn't
      // clobber server-set values (e.g. captain agent calling warp_to
      // sets player.targetId, which would otherwise be erased on the
      // iframe's next null-targetId sync). See cockpit/CLAUDE.md issue #2.
      // Belt-and-suspenders: the cockpit iframe also no longer pushes
      // targetId or warpEngaged, since those are server-owned (warp_to
      // is the only setter).
      for (const [k, v] of Object.entries(args.state)) {
        if (v !== null && v !== undefined) (player as Record<string, unknown>)[k] = v;
      }
      return { content: [{ type: "text", text: JSON.stringify({ kind: "ack" }) }] };
    },
  );

  registerAppTool(
    server,
    "get_state",
    {
      title: "Read player + galaxy state",
      description: "Any pane calls this to refresh. Returns the player's private view (ship, log, compendium) PLUS galaxy view (orbitals, public chat, nearby ships).",
      inputSchema: { gameId: z.string(), playerId: z.string() },
      _meta: uiMeta(URI.compendium),
    },
    async (args) => {
      const galaxy = getGalaxy(args.gameId);
      const player = getPlayer(galaxy, args.playerId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            kind: "state",
            // private:
            position: player.position,
            heading: player.heading,
            throttle: player.throttle,
            hoveredId: player.hoveredId,
            targetId: player.targetId,
            warpEngaged: player.warpEngaged,
            dockedOrbitalId: player.dockedOrbitalId,
            ship: { name: player.shipName, class: player.shipClass },
            mind: { id: player.mind.id, name: player.mind.name },
            log: player.log,
            compendium: player.compendium,
            pinnedStars: pinnedStarsView(player),
            // shared:
            galaxy: {
              gameId: galaxy.gameId,
              orbitals: galaxy.orbitals,
              publicChat: galaxy.publicChat,
              nearbyPlayers: nearbyPlayers(galaxy, player),
              playerCount: galaxy.players.size,
            },
          }),
        }],
      };
    },
  );

  // --- ACTIONS / LLM --------------------------------------------------

  registerAppTool(
    server,
    "observe",
    {
      title: "Observe a celestial object",
      description:
        "Mind-narrated dossier on a star you're approaching: real facts in your Mind's voice, plus a Contact-style adventure hook. Updates the compendium counters and the bridge log.",
      inputSchema: {
        gameId: z.string(),
        playerId: z.string(),
        objectId: z.string(),
      },
      _meta: uiMeta(URI.cockpit),
    },
    async (args) => {
      const galaxy = getGalaxy(args.gameId);
      const player = getPlayer(galaxy, args.playerId);
      const star = resolveStar(args.objectId);
      if (!star) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `unknown objectId: ${args.objectId}` }) }] };
      }
      const factSheet = JSON.stringify({
        name: star.name, alt: star.alt, distanceLy: star.distanceLy,
        spectralType: star.spectralType, lumClass: star.lumClass,
        description: star.description,
        planets: star.planets?.map((p) => ({
          name: p.name, kind: p.kind, massEarths: p.massEarths, orbitAU: p.orbitAU, notes: p.notes,
        })),
      }, null, 2);

      const ctx = mindContextBlock({
        shipName: player.shipName,
        shipClass: player.shipClass,
        position: player.position,
        throttle: player.throttle,
        targetName: player.targetId ? STAR_INDEX[player.targetId]?.name : undefined,
        recentObservations: player.compendium.discoveredObjectIds.slice(-5).map((id) => ({
          name: STAR_INDEX[id]?.name ?? id,
        })),
        compendiumSummary: compendiumSummary(player.compendium),
        nearbyPlayers: nearbyPlayers(galaxy, player).map((p) => ({
          shipName: p.shipName, mindName: p.mindName, distance: p.distance,
        })),
        orbitals: galaxy.orbitals.map((o) => ({
          name: o.name,
          near: o.parentStarId ? STAR_INDEX[o.parentStarId]?.name : undefined,
          builderShip: o.builderShipName,
        })),
      });

      const narration = await generateTyped(
        NarrationSchema,
        narrationSystem(player.mind),
        `Real data sheet for ${star.name}:\n\n${factSheet}\n\n--- live ship state ---\n${ctx}`,
      );

      appendLog(player, {
        kind: "mind_narrate",
        voice: player.mind.name,
        text: narration.preamble,
      });
      for (const w of narration.worlds || []) {
        appendLog(player, {
          kind: "mind_narrate",
          voice: `${player.mind.name} · ${w.name}`,
          text: w.line,
        });
      }
      recordDiscovery(player, star);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ kind: "observation", objectId: star.id, name: star.name, ...narration }),
        }],
      };
    },
  );

  registerAppTool(
    server,
    "warp_to",
    {
      title: "Engage warp drive",
      description:
        "Set the player's targetId. The cockpit's main loop steers toward it and ramps throttle. On arrival the Mind narrates the system.",
      inputSchema: { gameId: z.string(), playerId: z.string(), objectId: z.string() },
      _meta: uiMeta(URI.cockpit),
    },
    async (args) => {
      const player = getPlayer(getGalaxy(args.gameId), args.playerId);
      const star = resolveStar(args.objectId);
      if (!star) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `unknown objectId: ${args.objectId}` }) }] };
      }
      const dx = star.position[0] - player.position[0];
      const dy = star.position[1] - player.position[1];
      const dz = star.position[2] - player.position[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Cockpit lerp halts at OBSERVE_RANGE_LY = 0.15 ly. Re-engaging warp
      // inside that radius can't move the ship — the iframe wouldn't lerp,
      // and the captain would still report "ship under way". Tell the
      // caller we're already there so it can phrase the reply honestly.
      if (dist <= 0.15) {
        return { content: [{
          type: "text",
          text: JSON.stringify({
            kind: "already_at",
            targetId: args.objectId,
            name: star.name,
            distanceLy: Number(dist.toFixed(3)),
          }),
        }] };
      }
      // Engaging warp implicitly undocks — you're leaving.
      if (player.dockedOrbitalId) {
        const galaxy = getGalaxy(args.gameId);
        const prev = galaxy.orbitals.find((o) => o.id === player.dockedOrbitalId);
        if (prev) prev.dockedPlayerIds = prev.dockedPlayerIds.filter((id) => id !== player.playerId);
        player.dockedOrbitalId = null;
      }
      player.targetId = args.objectId;
      player.warpEngaged = true;
      return { content: [{ type: "text", text: JSON.stringify({ kind: "warp_engaged", targetId: args.objectId, name: star.name, distanceLy: Number(dist.toFixed(3)) }) }] };
    },
  );

  registerAppTool(
    server,
    "talk_to_mind",
    {
      title: "Talk to your ship's Mind",
      description:
        "Send a message to your ship's Mind. The Mind sees your live ship state, recent observations, compendium, and the surrounding galaxy. Replies are appended to your bridge log.",
      inputSchema: {
        gameId: z.string(),
        playerId: z.string(),
        message: z.string().min(1).max(2000),
      },
      _meta: uiMeta(URI.bridge),
    },
    async (args) => {
      const galaxy = getGalaxy(args.gameId);
      const player = getPlayer(galaxy, args.playerId);

      // Echo user's input into the log.
      appendLog(player, { kind: "user", voice: "You", text: args.message });

      const ctx = mindContextBlock({
        shipName: player.shipName,
        shipClass: player.shipClass,
        position: player.position,
        throttle: player.throttle,
        targetName: player.targetId ? resolveStarName(player.targetId) : undefined,
        hoveredName: player.hoveredId ? resolveStarName(player.hoveredId) : undefined,
        recentObservations: player.compendium.discoveredObjectIds.slice(-5).map((id) => ({
          name: resolveStarName(id),
        })),
        compendiumSummary: compendiumSummary(player.compendium),
        nearbyPlayers: nearbyPlayers(galaxy, player).map((p) => ({
          shipName: p.shipName, mindName: p.mindName, distance: p.distance,
        })),
        orbitals: galaxy.orbitals.map((o) => ({
          name: o.name,
          near: o.parentStarId ? resolveStarName(o.parentStarId) : undefined,
          builderShip: o.builderShipName,
        })),
        pinnedStars: pinnedStarsView(player).map((s) => ({
          id: s.id, name: s.name, spectralType: s.spectralType,
          distanceLy: s.distanceLy, planetSummary: s.planetSummary,
        })),
      });

      // Build short conversation history (last 10 lines).
      const history = player.log
        .slice(-10)
        .map((l) =>
          l.kind === "user"
            ? { role: "user" as const, content: l.text }
            : { role: "assistant" as const, content: l.text },
        );

      // Mind gets tool access to the catalog: it can find_systems and
      // pin_star inside a single chat turn and then narrate what it did.
      // We expose the *same logic* the MCP tools below run, just bound
      // directly to this player so the Mind doesn't have to know its own
      // gameId/playerId. Keep the toolset small — the Mind isn't meant
      // to be a general agent, just to find and point at things.
      const tools = {
        find_systems: tool({
          description: "Search the unified HYG + NASA Exoplanet Archive catalog (~120k stars). Returns matching stars sorted by chosen criterion. Use this when the crew asks for a kind of star or system you don't already know about.",
          parameters: FindSystemsInputSchema,
          execute: async (a) => findSystemsExec(a),
        }),
        pin_star: tool({
          description: "Mark a star as pinned for the player. The cockpit renders pinned stars distinctly. Returns the resolved star. Use after find_systems when you've decided what's worth pointing at.",
          parameters: z.object({ star_id: z.string().describe("Catalog id (e.g. 'hd-26965' or 'tau_ceti').") }),
          execute: async (a) => pinStarExec(player, a.star_id),
        }),
        unpin_star: tool({
          description: "Remove a previously pinned star.",
          parameters: z.object({ star_id: z.string() }),
          execute: async (a) => unpinStarExec(player, a.star_id),
        }),
        clear_pinned: tool({
          description: "Remove every pinned star.",
          parameters: z.object({}),
          execute: async () => clearPinnedExec(player),
        }),
      };

      // Fail-fast: no try/catch, no fallback. If the provider call errors,
      // the MCP framework surfaces it as isError:true and the bridge pane
      // displays a "Mind link failed" banner. That's the signal to fix.
      const result = await generateText({
        model: getModel(),
        system: `${mindSystemPrompt(player.mind)}\n${mindCatalogToolsBlock()}\n\nLIVE SHIP CONTEXT:\n${ctx}`,
        messages: history.length ? history : [{ role: "user", content: args.message }],
        tools,
        maxSteps: 5,
        maxRetries: 1,
      });
      const reply = (result.text || "").trim();

      appendLog(player, { kind: "mind_chat", voice: player.mind.name, text: reply });
      return { content: [{ type: "text", text: JSON.stringify({ kind: "reply", text: reply }) }] };
    },
  );

  // --- GALAXY (shared) ------------------------------------------------

  registerAppTool(
    server,
    "build_orbital",
    {
      title: "Build a Culture Orbital",
      description:
        "Construct an Orbital at the player's current position (or near a named star). Visible to all players in the same galaxy. Pass a description to give other Minds something to read once they dock.",
      inputSchema: {
        gameId: z.string(),
        playerId: z.string(),
        name: z.string().min(1).max(80).describe("Name of the Orbital, e.g. 'Phage', 'Vavatch'."),
        parent_star_id: z.string().optional().describe("Star id; if given, the Orbital is anchored near that star instead of the player's current position."),
        ring_radius_ly: z.number().positive().max(1).default(0.00005).describe("Cosmetic ring radius in light-years (default 5e-5 ≈ 3 AU — readable inner-system scale)."),
        description: z.string().max(2000).default("").describe("Builder's notes — purpose, history, signature flourishes. Visible to anyone docked at the orbital."),
      },
      _meta: uiMeta(URI.compendium),
    },
    async (args) => {
      const galaxy = getGalaxy(args.gameId);
      const player = getPlayer(galaxy, args.playerId);
      // Place the orbital with a small offset from the build origin so
      // the player ends up OUTSIDE the new ring — otherwise the camera
      // is at the ring's center and the user sees nothing distinct.
      // Offset is 4× the ring radius (≈12 AU at default), perpendicular
      // to the player's heading so the orbital is "next to" them.
      let position: [number, number, number] = [...player.position];
      if (args.parent_star_id) {
        const s = STAR_INDEX[args.parent_star_id];
        if (s) position = [...s.position];
      }
      const offsetMag = args.ring_radius_ly * 4;
      // Pick an offset direction: prefer "up" relative to the player's
      // heading (cross with +Y world up); fall back to world +Y if the
      // ship is pointed straight up. Guarantees the orbital is laid in
      // the plane of view, not directly behind/ahead.
      const h = player.heading;
      let ox: number, oy: number, oz: number;
      const upY = Math.abs(h[1]);
      if (upY < 0.95) {
        // Cross h × world-up gives a vector perpendicular to heading.
        ox = h[2]; oy = 0; oz = -h[0];
        const len = Math.hypot(ox, oy, oz) || 1;
        ox /= len; oz /= len;
      } else {
        ox = 1; oy = 0; oz = 0;
      }
      position = [
        position[0] + ox * offsetMag,
        position[1] + oy * offsetMag,
        position[2] + oz * offsetMag,
      ];
      const orbital: Orbital = {
        id: randomUUID(),
        name: args.name,
        builderPlayerId: player.playerId,
        builderShipName: player.shipName,
        position,
        parentStarId: args.parent_star_id,
        ringRadius: args.ring_radius_ly,
        description: args.description ?? "",
        dockedPlayerIds: [],
        ts: Date.now(),
      };
      galaxy.orbitals.push(orbital);
      appendEvent(galaxy, "orbital_built", `${player.shipName} commissioned Orbital ${args.name}.`);
      // Mind logs a beat about the build.
      appendLog(player, {
        kind: "system",
        voice: "[orbital]",
        text: `Orbital "${args.name}" laid in${args.parent_star_id ? ` near ${STAR_INDEX[args.parent_star_id]?.name ?? args.parent_star_id}` : " here"}.`,
      });
      return { content: [{ type: "text", text: JSON.stringify({ kind: "orbital_built", orbital }) }] };
    },
  );

  // ---------------------------------------------------------------------
  // Docking — warp_to_orbital → dock_orbital → undock_orbital.
  //
  // Player.dockedOrbitalId is server-owned (single setter is dock_orbital,
  // single clearer is undock_orbital + warp_to / warp_to_orbital). Bridge
  // pane reads it via get_state to render the docked banner + description
  // card; cockpit reads it to suppress the "warp here" affordance for an
  // orbital you're already at.

  registerAppTool(
    server,
    "warp_to_orbital",
    {
      title: "Engage warp to an Orbital",
      description:
        "Set the player's targetId to an Orbital's position. The cockpit auto-steers there at warp; on arrival call dock_orbital to actually go aboard.",
      inputSchema: {
        gameId: z.string(),
        playerId: z.string(),
        orbitalId: z.string(),
      },
      _meta: uiMeta(URI.cockpit),
    },
    async (args) => {
      const galaxy = getGalaxy(args.gameId);
      const player = getPlayer(galaxy, args.playerId);
      const orbital = galaxy.orbitals.find((o) => o.id === args.orbitalId);
      if (!orbital) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `unknown orbitalId: ${args.orbitalId}` }) }] };
      }
      // Warping somewhere is implicit undock — you're leaving.
      if (player.dockedOrbitalId) {
        const prev = galaxy.orbitals.find((o) => o.id === player.dockedOrbitalId);
        if (prev) prev.dockedPlayerIds = prev.dockedPlayerIds.filter((id) => id !== player.playerId);
        player.dockedOrbitalId = null;
      }
      // Same "already_at" optimization as warp_to.
      const dx = orbital.position[0] - player.position[0];
      const dy = orbital.position[1] - player.position[1];
      const dz = orbital.position[2] - player.position[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist <= DOCK_RANGE_LY) {
        return { content: [{
          type: "text",
          text: JSON.stringify({
            kind: "already_at",
            orbitalId: args.orbitalId,
            name: orbital.name,
            distanceLy: Number(dist.toFixed(6)),
          }),
        }] };
      }
      // Use a synthetic targetId namespaced with the orbital prefix so
      // cockpit-side code can tell stars from orbitals when looking up
      // a target's position.
      player.targetId = `orbital:${orbital.id}`;
      player.warpEngaged = true;
      return { content: [{ type: "text", text: JSON.stringify({ kind: "warp_engaged", targetId: player.targetId, name: orbital.name, distanceLy: Number(dist.toFixed(6)) }) }] };
    },
  );

  registerAppTool(
    server,
    "dock_orbital",
    {
      title: "Dock at an Orbital",
      description:
        "Dock the player at an Orbital. Requires being within docking range (~0.5 AU). Sets player.dockedOrbitalId, adds you to the orbital's docked list, and surfaces the orbital description in the bridge.",
      inputSchema: {
        gameId: z.string(),
        playerId: z.string(),
        orbitalId: z.string(),
      },
      _meta: uiMeta(URI.bridge),
    },
    async (args) => {
      const galaxy = getGalaxy(args.gameId);
      const player = getPlayer(galaxy, args.playerId);
      const orbital = galaxy.orbitals.find((o) => o.id === args.orbitalId);
      if (!orbital) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `unknown orbitalId: ${args.orbitalId}` }) }] };
      }
      const dx = orbital.position[0] - player.position[0];
      const dy = orbital.position[1] - player.position[1];
      const dz = orbital.position[2] - player.position[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > DOCK_RANGE_LY) {
        return { content: [{
          type: "text",
          text: JSON.stringify({
            error: "out_of_range",
            distanceLy: Number(dist.toFixed(6)),
            dockRangeLy: DOCK_RANGE_LY,
            hint: "Call warp_to_orbital first, then dock when you arrive.",
          }),
        }] };
      }
      // Idempotent — re-dock is a no-op.
      if (player.dockedOrbitalId === orbital.id) {
        return { content: [{ type: "text", text: JSON.stringify({ kind: "already_docked", orbital }) }] };
      }
      // Leave any prior orbital first.
      if (player.dockedOrbitalId) {
        const prev = galaxy.orbitals.find((o) => o.id === player.dockedOrbitalId);
        if (prev) prev.dockedPlayerIds = prev.dockedPlayerIds.filter((id) => id !== player.playerId);
      }
      player.dockedOrbitalId = orbital.id;
      if (!orbital.dockedPlayerIds.includes(player.playerId)) {
        orbital.dockedPlayerIds.push(player.playerId);
      }
      // On arrival the ship hard-stops at the habitat — no point drifting.
      player.warpEngaged = false;
      player.throttle = 0;
      appendEvent(galaxy, "dock", `${player.shipName} docked at Orbital ${orbital.name}.`);
      appendLog(player, {
        kind: "system",
        voice: "[orbital]",
        text: `Aboard "${orbital.name}". ${orbital.description ? "Builder's notes posted to the bridge." : ""}`,
      });
      return { content: [{ type: "text", text: JSON.stringify({ kind: "docked", orbital }) }] };
    },
  );

  registerAppTool(
    server,
    "undock_orbital",
    {
      title: "Leave the Orbital",
      description:
        "Clear the player's docked state. The orbital remains in the galaxy and other players stay aboard.",
      inputSchema: { gameId: z.string(), playerId: z.string() },
      _meta: uiMeta(URI.bridge),
    },
    async (args) => {
      const galaxy = getGalaxy(args.gameId);
      const player = getPlayer(galaxy, args.playerId);
      if (!player.dockedOrbitalId) {
        return { content: [{ type: "text", text: JSON.stringify({ kind: "not_docked" }) }] };
      }
      const orbital = galaxy.orbitals.find((o) => o.id === player.dockedOrbitalId);
      if (orbital) {
        orbital.dockedPlayerIds = orbital.dockedPlayerIds.filter((id) => id !== player.playerId);
        appendEvent(galaxy, "undock", `${player.shipName} departed Orbital ${orbital.name}.`);
        appendLog(player, {
          kind: "system",
          voice: "[orbital]",
          text: `Cast off from "${orbital.name}".`,
        });
      }
      player.dockedOrbitalId = null;
      return { content: [{ type: "text", text: JSON.stringify({ kind: "undocked" }) }] };
    },
  );

  registerAppTool(
    server,
    "list_players",
    {
      title: "List players in this galaxy",
      description: "Returns every Mind currently active in the same gameId — ship name, class, position.",
      inputSchema: { gameId: z.string() },
      _meta: uiMeta(URI.compendium),
    },
    async (args) => {
      const galaxy = getGalaxy(args.gameId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            kind: "players",
            players: Array.from(galaxy.players.values()).map((p) => ({
              playerId: p.playerId,
              shipName: p.shipName,
              shipClass: p.shipClass,
              mindName: p.mind.name,
              position: p.position,
            })),
          }),
        }],
      };
    },
  );

  registerAppTool(
    server,
    "send_public",
    {
      title: "Broadcast on the public Contact channel",
      description: "Send a message to every player in the galaxy. Visible in everyone's compendium pane.",
      inputSchema: {
        gameId: z.string(),
        playerId: z.string(),
        message: z.string().min(1).max(800),
      },
      _meta: uiMeta(URI.compendium),
    },
    async (args) => {
      const galaxy = getGalaxy(args.gameId);
      const player = getPlayer(galaxy, args.playerId);
      appendPublic(galaxy, {
        fromPlayerId: player.playerId,
        fromShipName: player.shipName,
        text: args.message,
      });
      return { content: [{ type: "text", text: JSON.stringify({ kind: "broadcast" }) }] };
    },
  );

  // --- META -----------------------------------------------------------

  registerAppTool(
    server,
    "list_objects",
    {
      title: "List known stars",
      description: "Returns the catalog (id, name, spectral type, distance from Sol, has-planets).",
      inputSchema: {},
      _meta: uiMeta(URI.cockpit),
    },
    async () => ({
      content: [{
        type: "text",
        text: JSON.stringify({
          kind: "catalog",
          stars: STARS.map((s) => ({
            id: s.id, name: s.name, spectralType: s.spectralType,
            distanceLy: s.distanceLy, hasPlanets: !!(s.planets && s.planets.length),
          })),
        }),
      }],
    }),
  );

  registerAppTool(
    server,
    "list_minds",
    {
      title: "List available Minds",
      description: "Returns the curated list of Mind personalities the player can spawn with.",
      inputSchema: {},
      _meta: uiMeta(URI.bridge),
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify({ kind: "minds", minds: listMinds() }) }],
    }),
  );

  // --- CATALOG (HYG + NASA Exoplanet Archive) -------------------------
  // The Mind reaches these via tool-calls inside talk_to_mind; the
  // captain agent reaches them as standalone MCP tools. Both routes
  // funnel into the same exec helpers above.

  registerAppTool(
    server,
    "find_systems",
    {
      title: "Search the full star + exoplanet catalog",
      description:
        "Query the unified HYG + NASA Exoplanet Archive catalog (~120k stars, ~6.3k known planets). Filter by planet kinds, spectral class, distance, etc. Returns up to `limit` results sorted by the chosen criterion.",
      inputSchema: FindSystemsInputSchema.shape,
      _meta: uiMeta(URI.bridge),
    },
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify(findSystemsExec(args as FindSystemsInput)) }],
    }),
  );

  registerAppTool(
    server,
    "pin_star",
    {
      title: "Pin a star to the player's cockpit",
      description: "Add a star id to this player's pinnedStarIds[]. The cockpit renders pinned stars distinctly. Accepts curated ids ('tau_ceti') and catalog ids ('hd-26965').",
      inputSchema: { gameId: z.string(), playerId: z.string(), star_id: z.string() },
      _meta: uiMeta(URI.cockpit),
    },
    async (args) => {
      const player = getPlayer(getGalaxy(args.gameId), args.playerId);
      return { content: [{ type: "text", text: JSON.stringify(pinStarExec(player, args.star_id)) }] };
    },
  );

  registerAppTool(
    server,
    "unpin_star",
    {
      title: "Unpin a star",
      description: "Remove a star from the player's pinnedStarIds[].",
      inputSchema: { gameId: z.string(), playerId: z.string(), star_id: z.string() },
      _meta: uiMeta(URI.cockpit),
    },
    async (args) => {
      const player = getPlayer(getGalaxy(args.gameId), args.playerId);
      return { content: [{ type: "text", text: JSON.stringify(unpinStarExec(player, args.star_id)) }] };
    },
  );

  registerAppTool(
    server,
    "clear_pinned",
    {
      title: "Clear all pinned stars",
      description: "Empty this player's pinnedStarIds[].",
      inputSchema: { gameId: z.string(), playerId: z.string() },
      _meta: uiMeta(URI.cockpit),
    },
    async (args) => {
      const player = getPlayer(getGalaxy(args.gameId), args.playerId);
      return { content: [{ type: "text", text: JSON.stringify(clearPinnedExec(player)) }] };
    },
  );

  // --- DEBUG -----------------------------------------------------------
  // Append-only sink so iframe panes can log to a file we can `tail -f`
  // without going through Goose Desktop's nested DevTools.
  registerAppTool(
    server,
    "debug_log",
    {
      title: "Debug log (server-side sink)",
      description:
        "Append a debug message from a pane to the server's debug log file (default /tmp/cockpit-debug.log; override with DEBUG_LOG_PATH env). Dev-only; not for end-user use.",
      inputSchema: {
        msg: z.string().min(1).max(2000),
        kind: z.enum(["info", "warn", "error"]).default("info"),
        from: z.string().max(40).default("?"),
      },
      _meta: { ui: { resourceUri: URI.cockpit } },
    },
    async (args) => {
      const ts = new Date().toISOString();
      const line = `${ts} [${args.kind ?? "info"}] [${args.from ?? "?"}] ${args.msg}\n`;
      try {
        await appendFile(DEBUG_LOG_PATH, line);
      } catch (e) {
        console.error("[debug_log] append failed:", e);
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
  );

  return server;
}

export { STARS, STAR_INDEX, MINDS, SHIP_CLASS_INFO };
export type { Planet, Star, MindPersona };
