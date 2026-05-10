# Culture Contact · architecture

A 1P starship-exploration game where the playable surface is a custom **MCP Apps host** running in the browser. The agent decides what UI mounts; the host provides slots; the iframes are real MCP App resources served from a separate process. The Mind voice and the Captain agent are two different LLM calls with different system prompts, both feeding into the same shared world state.

## Process topology

```
browser (Vite :5174)
    │   POST /tool/:name      forward to MCP, enrich with _meta.ui
    │   GET  /ui?uri=...      read MCP resource, return HTML
    │   WS   /ws              push state diffs + captain stream
    │   MCP host bridge       AppBridge per iframe via PostMessageTransport
    ▼
cockpit-backend  (Hono + WS, :4040)
    │   one persistent MCP session, shared by all browser tabs
    │   state.ts polls get_state per (gameId, playerId), broadcasts diffs
    │   agent.ts runs the captain (Vercel AI SDK + MCP tools)
    ▼
star-systems server  (HTTP :3030)
    │   13 MCP tools, each with _meta.ui = { resourceUri, slot }
    │   in-memory Galaxy/Player state, idle-reaper
    │   iframe HTML resources read from dist/ (vite-built single files)
    │   talk_to_mind / observe / explore_chunk hit Anthropic via Vercel AI SDK
```

`ANTHROPIC_API_KEY` is loaded from `<repo-root>/.env` by both the MCP server and the cockpit backend (inline parser, Node 20.9-compatible).

## State model

```
Galaxy (server-side, Map<gameId, Galaxy>)
  ├── orbitals[]          — built by any player, visible to all
  ├── publicChat[]        — galaxy-wide channel
  ├── events[]            — recent timeline entries
  └── players Map<playerId, Player>
        └── Player
            ├── shipName, shipClass, mind (persona)
            ├── lastSeenAt                            ← idle reaper
            ├── position / heading / throttle
            ├── hoveredId / targetId / warpEngaged    ← server is authoritative for targetId
            ├── log[]            (Mind narrations + chat)
            └── compendium       (spectral counts, planet counts, discovered ids)
```

**Lifecycle:**
- `start_starship({gameId?, playerId?})` either creates a new player or **reattaches** to an existing one if `playerId` is in the named galaxy.
- Frontend persists `playerId` per `gameId` in `localStorage` (`cockpit-player-id:<gameId>`). Tab refresh ⇒ same identity.
- Server-side **idle reaper** runs every 30s; players whose `lastSeenAt` is more than 60s old are removed (stale tab cleanup).

**Authority for shared fields:**
- `position / heading / throttle / hoveredId` — owned by the cockpit iframe (it's the simulation source of truth), pushed to server every 200 ms via `sync_state`.
- `targetId / warpEngaged` — owned by the **server**. Set by `warp_to`; the iframe does not push these. (Earlier the iframe pushed nulls every tick and clobbered captain-set values; this is fixed.)
- `inventory / compendium / log / orbitals / publicChat` — server-only writes.

## Slot routing (MCP Apps × cockpit host)

Each MCP App tool's `_meta.ui` carries both a `resourceUri` (which iframe HTML to mount) and a `slot` hint (which host pane to mount it in). The cockpit's slot map:

| slot | what mounts there | resource |
|---|---|---|
| `viewport` | 3D scene + throttle + nearest lists | `ui://stars/cockpit.html` |
| `side` | compendium, orbitals, public chat, "other Minds" | `ui://stars/compendium.html` |
| `bottom` | Mind chat + observation log | `ui://stars/bridge.html` |
| `captain` | native React pane; talks to the captain agent | (no iframe — direct React) |

Each browser tab gets one `AppBridge` per iframe, attached via a **two-way handshake** (`mcp-app-pane-ready` ↔ `mcp-app-host-ready`) so the iframe's `app.connect()` doesn't fire before the host's transport is wired. Bridge attaches are serialized on the shared MCP client to avoid `setNotificationHandler` clobber.

Hosts that don't speak the handshake (e.g. Goose Desktop, basic-host) still work — the iframe falls back after a 1.5 s timeout and connects anyway. We support both deployment modes.

## Tools (13)

| Tool | Caller | Purpose |
|---|---|---|
| `start_starship` | host (auto-bootstrap) or agent | spawn / reattach a player; mounts cockpit |
| `open_compendium` | host | mount compendium iframe |
| `open_bridge` | host | mount bridge iframe |
| `sync_state` | cockpit iframe | push position / throttle / hover |
| `get_state` | all iframes (poll) + WS broadcaster | full player + galaxy snapshot |
| `observe` | cockpit (auto on system entry) or agent | LLM Mind narrates a star + plants in the bridge log |
| `warp_to` | captain agent or cockpit | set targetId; cockpit auto-steers; on system entry observe fires. Returns `kind: "already_at"` when within `OBSERVE_RANGE`. |
| `talk_to_mind` | bridge or agent | free-form chat with the Mind, full live context injected |
| `build_orbital` | compendium pane or agent | construct a Culture Orbital; visible to all players in the galaxy |
| `list_players` | compendium / agent | other ships in the galaxy |
| `send_public` | compendium / agent | galaxy-wide broadcast |
| `list_objects` | agent | full star catalog (id, name, spectral type, distance, has-planets) |
| `list_minds` | agent | curated Mind personalities for spawn |
| `debug_log` | iframes (dev only) | append to `/tmp/cockpit-debug.log` for `tail -f` |

## Cockpit iframe (the playable surface)

Three.js scene, slot = `viewport`, file = `apps/star-systems-demo/server/src/cockpit-main.ts`.

**Movement:**
- WASD-equivalents not used; navigation is via:
  - **Drag canvas**: trackball-around-crosshair look (drag-the-sky semantics, both axes consistent).
  - **Throttle slider**: cubic-curve speed (`throttle³ × 0.4 ly/s`); full throttle = warp 9 = 0.4 ly/s.
  - **Click any star sprite or row in Nearest list**: engage warp toward it (or just face it, depending on context).
  - **Captain chat from agent**: `warp_to` engages auto-pilot.
- **Autobrake** within 100 AU of any star: stepped throttle cap (0.10 → 0.025 as you approach inside 5 AU). Disengages warp on system entry; `observe` fires so the Mind narrates.

**Rendering:**
- **Two star sprite groups**, toggled by speed: warp mode = big size-attenuated sprites + CSS shimmer overlay; impulse mode = `sizeAttenuation:false` pixel-stable sprites (1–5 px per spectral class).
- **Closest star inside 100 AU**: real `THREE.Mesh` sphere at proper physical scale (`R☉ × SOL_RADIUS_LY`), clamped to a minimum 4-pixel apparent size so M dwarfs and white dwarfs stay visible.
- **Planets inside 100 AU**: pool of 12 `THREE.Mesh` spheres, positioned at orbital distance with stable phase from `hash(starId, planetName)`, slow Kepler-ish revolution (capped at 0.5 rad/s so TRAPPIST-1 doesn't blur). 200× visual-scale multiplier on the radius + same min-pixel clamp the star uses, so Earth at 10 AU is findable instead of subpixel.
- **Logarithmic depth buffer** is enabled (`logarithmicDepthBuffer: true`) so the camera near plane can be 1e-7 ly while still resolving distant stars at 5000 ly.
- **Other-ship sprites** (multiplayer overlay) are pixel-stable at 8 px regardless of distance, so a swarm of stale demo players doesn't fill the viewport.
- **Halo ring** per planet-bearing star — 0.5 ly torus, color-coded by spectral class. Visible for distant stars (helps spot planet-bearing systems across the catalog), automatically hidden for the **current** star while you're in-system.

**HUD:**
- Top strip: ship name + Mind class · "at Sol" / distance from Sol · target · `provider/model`.
- Bottom strip: throttle slider + speed readout + bearing/elevation + warp button.
- Right-side panel: three sections, each a stable row pool (no DOM churn):
  - **Nearest stars** — top 5 by distance.
  - **With known planets** — top 5 nearest planet-bearing stars; 🪐 N badge.
  - **Nearest planets** (only when in-system) — up to 8 individual planets in the current system, sorted by ship distance, with kind + heading.
- Each row is clickable → camera slerps to face the target's live world position (no warp engagement, no throttle change). Drag interrupts.
- Distances auto-scale: ly → AU → light-minutes depending on magnitude.

## Bridge iframe (Mind chat + log)

Slot = `bottom`. Polls `get_state` and renders `player.log` as a scrolling conversation. Three line kinds:
- `mind_narrate` — Mind voice on observation, italic header.
- `mind_chat` — Mind reply to a chat message.
- `user` — your messages; right-aligned bubble.

Input field calls `talk_to_mind`. The Mind sees the **live ship context** (position, throttle, target, recent observations, compendium summary, nearby vessels, orbitals) plus the last ~10 chat turns each call, and stays in character per the persona system prompt. The Mind is also the **agent** — see the next section for what makes that non-standard.

## Compendium iframe (manifest + galaxy)

Slot = `side`. Polls `get_state` and renders:
- **Stellar bodies** — counts by spectral class.
- **Planet types** — counts by planet kind.
- **Discovered systems** — names from `compendium.discoveredObjectNames`.
- **Orbitals built** — galaxy-wide; name + builder ship.
- **Other Minds in this volume** — `nearbyPlayers`.
- **Public Contact channel** — last 12 messages.

Has two write affordances: build-orbital input + galaxy-broadcast input.

## Information flow: agent-loop-inside-an-MCP-tool

This is the most non-standard pattern in the codebase and worth understanding before editing `talk_to_mind`. There are *two* agent surfaces stacked inside one MCP tool call.

When you type "take us to Vega" into the bridge:

```
[bridge iframe]
   │
   │ pane.app.callServerTool({
   │   name: "talk_to_mind",
   │   arguments: { gameId, playerId, message: "take us to Vega" }
   │ })
   ▼
[MCP Apps PostMessage → AppBridge → cockpit-backend → MCP client → star-systems server]
   │
   ▼
[server.ts talk_to_mind handler]
   1. Reads live ship/galaxy state from the in-memory Map<gameId, Galaxy>.
   2. Builds the Mind's context block (position, throttle, target,
      recent observations, compendium, nearby vessels, orbitals, pinned
      stars).
   3. Builds a `tools` dict whose execute functions are CLOSURES over
      this player's record:
         warp_to:        ({star_id})  => { player.targetId = star_id;
                                           player.warpEngaged = true; … }
         find_systems:   (args)       => findSystemsExec(args)
         pin_star:       ({star_id})  => pinStarExec(player, star_id)
         build_orbital:  …
         dock_orbital:   …
         (etc., 11 tools total)
   4. Calls Vercel AI SDK:
         generateText({ model: opus-4-7, system, messages, tools, maxSteps: 5 })

      ┌─── inside generateText (one MCP call, multiple LLM round-trips) ───┐
      │  Opus sees system + history + user msg + tool descriptions          │
      │  Opus decides: call warp_to(star_id="vega")                         │
      │  AI SDK runs the closure → mutates player.targetId / warpEngaged    │
      │  AI SDK feeds tool_result back to Opus                              │
      │  Opus writes the text reply ("Engines warm, Vega: A0V…")            │
      └──────────────────────────────────────────────────────────────────────┘

   5. Append user message + reply to player.log.
   6. Return reply text via the MCP tool result.
   ▼
[bridge iframe gets reply text → renders it in chat scroll]
```

**Two agent layers stacked:**

1. **Outer (MCP Apps).** From the bridge iframe's perspective, it called *one* tool and got *one* text result back. Pure protocol — the host has no idea anything else happened. This is the contract MCP Apps publishes.
2. **Inner (Vercel AI SDK).** *Inside* `talk_to_mind`'s execute body we run a multi-step LLM loop with tool-calling. `maxSteps: 5` lets Opus chain a few tools (`find_systems → pin_star → warp_to`) and then narrate, all in one MCP call. The MCP layer never sees these inner steps.

**Why warp shows up in the cockpit pane:** the inner-loop tool closures mutate server-side state directly — `player.targetId = "vega"`. The cockpit iframe is a *separate* iframe with its *own* 200 ms `get_state` poll. On its next tick it reads the new `targetId`/`warpEngaged` and its `tick()` animation loop steers toward Vega. There is **no direct iframe-to-iframe channel**; the server's per-player state is the rendezvous.

**Three independent communication clocks** are running concurrently inside the browser:

| Pane | Mode | Cadence |
|---|---|---|
| bridge ↔ server | blocking `talk_to_mind` tool call when you press Send | 3–10 s (mostly the LLM) |
| cockpit ↔ server | `get_state` poll + `sync_state` push | 200 ms poll, ~5 Hz push |
| compendium ↔ server | `get_state` poll | 700 ms |

This is why the cockpit's warp ramp-up appears ~200 ms *after* the Mind's text reply lands in the bridge — they're two different polls reading the same updated server state.

**Implication for editing.** If you're adding a new agent capability ("the Mind can build a chain of Orbitals at every system on a route"), you have two choices:

- Add a new bound tool inside `talk_to_mind`'s tools dict — the Mind gains the capability immediately, no other surface knows or cares.
- Add a new top-level MCP tool via `registerAppTool` — the iframe panes can call it directly, AND you can also expose it to the Mind by listing it inside the `tools` dict.

We do (b) for tools that have UI affordances anyway (`build_orbital`, `pin_star`) and (a) for things that are purely Mind-side decisions.

## Persona system

`apps/star-systems-demo/server/culture.ts` ships seven Mind personas (Of Course I Still Love You, So Much For Subtlety, Frank Exchange of Views, Just Read The Instructions, Fate Amenable to Change, Mistake Not…, You Will Recognise It When You See It). `pickMind(seed)` is deterministic; `start_starship({mind_id})` lets you pin a specific one. `mindSystemPrompt(persona)` + `mindContextBlock(state)` compose the system prompt for every Mind tool call.

## Astrodata

Curated catalog of 21 named stars in `astrodata.ts`, real distances and spectral types, real `radiusSolar` per star, real planet lists per the NASA Exoplanet Archive (Sol's 8, Proxima's 3, Tau Ceti's 4, TRAPPIST-1's 7, etc.). Each Planet record has `name`, `kind` (∈ terrestrial / super_earth / neptune_like / ice_giant / gas_giant / hot_jupiter / super_jupiter), `orbitAU`, `massEarths`.

Helpers in `astrodata.ts`:
- `approxRadiusSolar(spectralClass, lumClass)` — fallback for stars whose radius isn't in the curated list.
- `starRadiusSolar(s)` — returns the curated value or the fallback.
- `spectralBucket(s)` — for compendium counters.

## File map

```
genui-hackathon/
├── ARCHITECTURE.md                                  ← this file
├── apps/
│   ├── cockpit/                                     ← the host
│   │   ├── README.md / CLAUDE.md
│   │   ├── backend/                                 ← Hono :4040
│   │   │   └── src/{main,mcp-client,state,agent}.ts
│   │   └── frontend/                                ← Vite/React :5174
│   │       └── src/
│   │           ├── App.tsx                          ← 4-slot CSS grid
│   │           ├── components/
│   │           │   ├── Slot.tsx                     ← reads store.slots[name]
│   │           │   ├── McpAppFrame.tsx              ← iframe + AppBridge
│   │           │   ├── CaptainChat.tsx              ← native captain UI; bootstrap
│   │           │   └── ui/                          ← shadcn primitives
│   │           └── lib/
│   │               ├── store.ts                     ← Zustand
│   │               ├── ws.ts / tool-call.ts / mcp-host.ts / utils.ts
│   └── star-systems-demo/server/                    ← the MCP server (HTTP :3030)
│       ├── main.ts                                  ← env loader + transports
│       ├── server.ts                                ← 13 tools + state map + reaper
│       ├── llm.ts                                   ← provider switch (Ant/OAI/Gemini)
│       ├── astrodata.ts                             ← 21-star catalog
│       ├── culture.ts                               ← Mind personas + context block
│       ├── data/                                    ← gitignored fetched data:
│       │     hyg.json, exoplanets.json, .hygdata_v41.csv
│       ├── scripts/{fetch-hyg,fetch-exoplanets}.ts
│       ├── src/{shared,cockpit-main}.ts             ← iframe code
│       ├── cockpit.html / compendium.html / bridge.html
│       └── dist/{cockpit,compendium,bridge}.html    ← vite-built single files (gitignored)
└── (other demos: agui-demo, mcp-apps-demo, a2ui-demo, dungeon-demo, goose-demo)
```

## Running it

One-time setup:

```bash
# repo root
echo 'ANTHROPIC_API_KEY="sk-ant-..."' > .env
(cd apps/star-systems-demo/server && npm install && npm run build:panes)
(cd apps/cockpit/backend  && npm install)
(cd apps/cockpit/frontend && npm install)
```

Day-to-day:

```bash
scripts/dev.sh           # boot all three services in a tmux session named "genui"
scripts/dev.sh status    # ports + windows
scripts/dev.sh attach    # attach to the tmux session
scripts/dev.sh restart   # nuke + reboot (use this when something is wedged)
scripts/dev.sh stop      # tear down the session and free the ports
```

Then open `http://localhost:5174`. The captain pane auto-bootstraps `start_starship → open_compendium → open_bridge`; all three iframes mount.

**Bouncing servers:** if you bounce the MCP server, also bounce the cockpit backend — its persistent MCP client doesn't auto-reconnect. `scripts/dev.sh restart` does both.

## LLM provider switch

Both Mind/observe (server-side) and the captain agent (cockpit-backend-side) go through Vercel AI SDK with `@ai-sdk/anthropic` / `@ai-sdk/openai` / `@ai-sdk/google`. Env contract:

```bash
LLM_PROVIDER=anthropic         # or openai, gemini
LLM_MODEL=claude-haiku-4-5-20251001
```

API keys come from the provider's standard env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`). **Fail-fast** policy: missing keys / provider errors / schema mismatches throw with a clear message; no silent canned-content fallback masks misconfiguration.

## Conventions

- **gameId** identifies a galaxy. Multiple players can join the same galaxy by passing the same `gameId`. The default-bootstrap uses `gameId: "demo"`.
- **playerId** identifies a player within a galaxy. Sticky per-tab via `localStorage.cockpit-player-id:<gameId>`.
- **Distances** in the data layer are always **light-years**. UI converts to AU / light-minutes for display.
- **Star ids** are snake_case (`alpha_centauri_a`, `tau_ceti`, `trappist_1`).
- **Planet ids** in the cockpit are `${starId}::${planetName}` (e.g. `sol::Earth`).
- **Tool result content** is `[{type:"text", text:JSON.stringify(payload)}]`. The frontend `parseToolText` extracts the JSON.
- **Slot routing** is opt-in: only tools that mount a UI carry `_meta.ui.slot`. The host ignores tools without it.

## Planned next

1. **HYG + NASA Exoplanet Archive integration.** Server loads `data/hyg.json` (~120k stars) and `data/exoplanets.json` at startup, builds indexes (by id, by spectral class, by planet kind, KD-tree-ish nearest-N), exposes new tools:
   - `find_systems({ has_planet_kinds, exclude_ids, near_position, max_distance_ly, sort, limit })` — Mind-callable query interface.
   - `pin_star({ star_id })`, `unpin_star({ star_id })`, `clear_pinned()` — add a star to the player's `pinnedStarIds[]`, which the cockpit renders in a fourth section of the nearest panel.
   - Goal interaction: ask the Mind *"can you show me the nearest star with both gas giants and terrestrial planets that isn't Sol?"* → it calls `find_systems` then `pin_star` and the result appears in the cockpit list.

2. **Sci-fi styling pass on the host shell.** Slot panel chrome currently uses shadcn defaults; would benefit from monospace + Banks-flavored title bars, status lights, etc.

3. **Two-tab multiplayer smoke test.** Open two browser tabs with the same `gameId`; verify they see each other in `nearbyPlayers`, can `build_orbital` visibly to each other, exchange messages on `send_public`. The infrastructure is there; the test isn't.

4. **`pin_star` extension to anchor the captain's discoveries.** When the user asks the Mind a question whose answer is "go look at X," the Mind should be able to pin X and the captain should accept "warp to the pinned star" as an instruction.

5. **(Stretch)** Real planetary system visualization at extreme close range — once you're under 1 AU of a star, optionally render a top-down system view with orbital ellipses, lit limb rendering on the planets, etc.

## Known issues (open)

- **Cockpit-backend doesn't auto-reconnect** when the MCP server bounces. Manual workaround: bounce the backend too. Fix: add reconnect logic with retry+backoff.
- **Captain LLM occasionally guesses object ids.** System prompt says use `list_objects` first; mostly mitigated, would harden by injecting the catalog ids into the system prompt at session start.
- **Iframe HMR caveat.** Vite HMR doesn't apply to the bundled iframe HTML — that lives in `apps/star-systems-demo/server/dist/`. After a `cockpit-main.ts` edit, run `npm run build:cockpit` then refresh the browser tab.
- **Re-enable React StrictMode** in `apps/cockpit/frontend/src/main.tsx`. Disabled because its double-invoke raced with `McpAppFrame`'s async setup. With Liam's two-way handshake serialized, the underlying race may be gone — worth retesting.
