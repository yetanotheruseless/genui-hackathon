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
import { generateText } from "ai";
import fs, { appendFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const DEBUG_LOG_PATH = process.env.DEBUG_LOG_PATH ?? "/tmp/cockpit-debug.log";
// Truncate at startup so each subprocess (each new chat session) starts fresh.
void writeFile(DEBUG_LOG_PATH, `--- session start ${new Date().toISOString()} pid=${process.pid} ---\n`).catch(() => {});

import { STARS, STAR_INDEX, spectralBucket, starRadiusSolar, type Planet, type Star } from "./astrodata.js";
import {
  MINDS,
  SHIP_CLASS_INFO,
  listMinds,
  mindContextBlock,
  mindSystemPrompt,
  pickMind,
  type MindPersona,
  type ShipClass,
} from "./culture.js";
import { generateTyped, getModel, getModelName, getProvider, hasCredentials } from "./llm.js";

const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");

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
  position: [number, number, number];
  heading: [number, number, number];
  throttle: number;
  hoveredId: string | null;
  targetId: string | null;
  warpEngaged: boolean;
  log: LogLine[];           // private bridge log: narrations + chat
  compendium: Compendium;
};

type Orbital = {
  id: string;
  name: string;
  builderPlayerId: string;
  builderShipName: string;
  position: [number, number, number];
  parentStarId?: string;
  ringRadius: number;       // ly (cosmetic)
  describedAs?: string;
  ts: number;
};

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
  return p;
}

function newPlayer(_seed: number, shipClass: ShipClass, mind: MindPersona): Player {
  // Spawn ~10 AU "above" Sol (1 AU ≈ 1.581e-5 ly) so Sol is visible as a
  // proper sphere on the first frame instead of having the camera land
  // inside its photosphere.
  return {
    playerId: randomUUID(),
    shipName: mind.name,
    shipClass,
    mind,
    position: [0, 1.58e-4, 0],
    heading: [0, 0, -1],
    throttle: 0,
    hoveredId: null,
    targetId: null,
    warpEngaged: false,
    log: [],
    compendium: {
      spectralCounts: {},
      planetCounts: {},
      discoveredObjectIds: [],
      discoveredObjectNames: [],
    },
  };
}

function recordDiscovery(player: Player, star: Star) {
  if (player.compendium.discoveredObjectIds.includes(star.id)) return;
  player.compendium.discoveredObjectIds.push(star.id);
  player.compendium.discoveredObjectNames.push(star.name);
  const bucket = spectralBucket(star);
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
      },
      _meta: uiMeta(URI.cockpit),
    },
    async (args) => {
      const galaxy = getOrCreateGalaxy(args.gameId, args.seed);
      const mind = pickMind(args.seed + galaxy.players.size, args.mind_id);
      const shipClass = (args.ship_class as ShipClass | undefined) ?? mind.shipClass;
      const player = newPlayer(args.seed, shipClass, mind);
      galaxy.players.set(player.playerId, player);
      appendEvent(galaxy, "arrival", `${player.shipName} arrived in this volume.`);
      // Auto-discover Sol.
      recordDiscovery(player, STAR_INDEX.sol);
      // Welcome line from the Mind.
      appendLog(player, {
        kind: "mind_chat",
        voice: mind.name,
        text: `Aboard. I'm the ${shipClass} ${mind.name}. Ship telemetry online; ${galaxy.players.size === 1 ? "we have the volume to ourselves" : `${galaxy.players.size - 1} other Culture vessel${galaxy.players.size === 2 ? "" : "s"} sharing the volume`}. Ask me about anything you see, or just point us somewhere and I'll fly.`,
      });
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
                name: p.name, kind: p.kind, orbitAU: p.orbitAU, massEarths: p.massEarths,
              })) ?? [],
            })),
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
      for (const [k, v] of Object.entries(args.state)) {
        if (v !== null && v !== undefined) (player as any)[k] = v;
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
            ship: { name: player.shipName, class: player.shipClass },
            mind: { id: player.mind.id, name: player.mind.name },
            log: player.log,
            compendium: player.compendium,
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
      const star = STAR_INDEX[args.objectId];
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
      if (!STAR_INDEX[args.objectId]) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `unknown objectId: ${args.objectId}` }) }] };
      }
      player.targetId = args.objectId;
      player.warpEngaged = true;
      return { content: [{ type: "text", text: JSON.stringify({ kind: "warp_engaged", targetId: args.objectId }) }] };
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
        targetName: player.targetId ? STAR_INDEX[player.targetId]?.name : undefined,
        hoveredName: player.hoveredId ? STAR_INDEX[player.hoveredId]?.name : undefined,
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

      // Build short conversation history (last 10 lines).
      const history = player.log
        .slice(-10)
        .map((l) =>
          l.kind === "user"
            ? { role: "user" as const, content: l.text }
            : { role: "assistant" as const, content: l.text },
        );

      // Fail-fast: no try/catch, no fallback. If the provider call errors,
      // the MCP framework surfaces it as isError:true and the bridge pane
      // displays a "Mind link failed" banner. That's the signal to fix.
      const result = await generateText({
        model: getModel(),
        system: `${mindSystemPrompt(player.mind)}\n\nLIVE SHIP CONTEXT:\n${ctx}`,
        messages: history.length ? history : [{ role: "user", content: args.message }],
        maxRetries: 1,
      });
      const reply = result.text.trim();

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
        "Construct an Orbital at the player's current position (or near a named star). Visible to all players in the same galaxy.",
      inputSchema: {
        gameId: z.string(),
        playerId: z.string(),
        name: z.string().min(1).max(80).describe("Name of the Orbital, e.g. 'Phage', 'Vavatch'."),
        parent_star_id: z.string().optional().describe("Star id; if given, the Orbital is anchored near that star instead of the player's current position."),
        ring_radius_ly: z.number().positive().max(1).default(0.001).describe("Cosmetic ring radius in light-years (default 0.001 ≈ 95 AU)."),
      },
      _meta: uiMeta(URI.compendium),
    },
    async (args) => {
      const galaxy = getGalaxy(args.gameId);
      const player = getPlayer(galaxy, args.playerId);
      let position: [number, number, number] = [...player.position];
      if (args.parent_star_id) {
        const s = STAR_INDEX[args.parent_star_id];
        if (s) position = [...s.position];
      }
      const orbital: Orbital = {
        id: randomUUID(),
        name: args.name,
        builderPlayerId: player.playerId,
        builderShipName: player.shipName,
        position,
        parentStarId: args.parent_star_id,
        ringRadius: args.ring_radius_ly,
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
