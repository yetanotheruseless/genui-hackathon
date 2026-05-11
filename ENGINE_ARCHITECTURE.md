# Engine architecture · decision record

Captures the engine/library decision made on `feat/engine-eval`
(branched from `feat/cockpit` at `d0ae5b1` on 2026-05-10). Supersedes
the engine-related sections of [ARCHITECTURE.md](./ARCHITECTURE.md) once
the migration in [Passes 1–4](#passes) lands.

## Status

**Decided.** Two research batches complete (8 agents, surveying
state-sync frameworks, physics, integration patterns, scaling). Pass 1
ready to start.

## Context

The current "engine" is a state bag + ad-hoc client physics:

- Server (`apps/star-systems-demo/server/server.ts`) holds galaxies in
  memory, persists to SQLite, exposes MCP tools (`warp_to`,
  `set_target`, `face_target`, `stop_engines`, `dock_orbital`,
  `build_orbital`, `sync_state`, …). **No tick loop.**
- Cockpit iframe (`src/cockpit-main.ts`) runs the simulation per
  `requestAnimationFrame`: integrates position from
  `throttle³ × WARP_MAX_LY_PER_S × dt`, runs Phase 1/2 warp alignment,
  autobrake-on-approach, distance-based arrival. Pushes via
  `sync_state` ~5 Hz; pulls via `get_state` ~5 Hz.
- Three.js renderer with hand-rolled sprite stacks (21 curated stars),
  a `THREE.Points` cloud (109 388-star HYG backdrop), close-range
  meshes for in-system bodies, `EffectComposer` + `UnrealBloomPass`.

The model breaks down on four axes — all real, all worth fixing:

1. **Simulation correctness.** Per-client tick means two tabs of the
   same player race through `sync_state`. No deterministic replay.
2. **Entity scaffolding.** Adding a new entity kind (asteroid, NPC
   ship, projectile) means hand-wiring serialization, picker, render
   path. No ECS.
3. **Rendering ambition.** Current Three.js setup is tuned but every
   new effect (volumetric warp, nebulae, particles) is hand-rolled.
4. **Physics.** Collision is a distance check; rotation is an Euler
   lerp. Anything beyond "autobrake + autopilot" needs invention.

A hard constraint sits over all of this: **the Generative UI thesis
must survive.** The agent ships UI as MCP App resources mounted into
named slots. Anything that would replace the host shell with a
single-canvas engine is out of scope. Engine work goes *inside* the
cockpit iframe; other panes stay agent-shipped iframes.

## Decision

```
Server (Node 20+, TS):    Colyseus 0.17                 — state sync (rooms, schema, delta)
                        + hono + MCP SDK                — tool surface, LLM (ask_mind)
                        + @dimforge/rapier3d-          — server-only physics
                          deterministic-compat
                        + better-sqlite3 (WAL)          — persistence (rate-limited)

Client (cockpit iframe):  Three.js                       — render
                        + colyseus.js                    — receive state, send input intents
                        + hono fetch                     — MCP tool calls (warp_to, etc.)
                        + single-snapshot lerp(0.2)      — visual smoothing
                        — NO client-side physics

Shared (TS workspace):    packages/star-sim              — pure physics functions
                        + packages/shared-state          — @colyseus/schema classes
```

Tick: **20 Hz server-authoritative**, ~60 Hz client interpolation
between snapshots. Stock Colyseus `setSimulationInterval` is *not*
drift-corrected (issue #324, expect 5–20 ms jitter); acceptable for
our space-sim, swap to a custom `setTimeout + Date.now()` ticker if
precision ever matters.

Input model: **hybrid**. Discrete actions (warp_to, set_target,
fire_weapon, dock_orbital) stay as MCP tool calls over the existing
hono surface. Continuous controls (throttle, yaw, pitch) stream to
the server via `room.send("input", ...)` Colyseus messages, throttled
to "emit on change ≥ ε" — never state-per-frame. Server samples the
latest intent before each tick.

## Why these picks

### Colyseus 0.17 (state sync)

- Node-native, TS-first (95% TS), MIT, active (v0.17 Feb 2026).
- `@colyseus/schema` does binary delta encoding over WS automatically
  — only changed fields go on the wire (~25–30 B per ship per tick
  for our struct after float32 optimization).
- Room model maps cleanly to a galaxy/sector instance; future
  per-star-system sharding is the documented growth path.
- Coexists with our hono + MCP surface via the default
  `WebSocketTransport({ server })` accepting any `http.Server`. The
  http.Server captured from `@hono/node-server`'s `serve()` is shared;
  Colyseus owns its WS upgrade prefix, hono owns everything else.
  uWebSocketsTransport has no hono adapter — stay on default ws.
- Plan B if framework ergonomics fight us: adopt **only**
  `@colyseus/schema` standalone for delta encoding, keep our hono WS.
- Caveat that shapes code: state authority lives on the Room. MCP
  tool handlers must mutate via the Room (`matchMaker.getLocalRoomById`
  + call public method on the Room subclass), not by writing fields
  directly. Mutate, never reassign — `setState()` resets the delta.

### Rapier (server-only physics)

- **Specifically `@dimforge/rapier3d-deterministic-compat`.** The
  plain `@dimforge/rapier3d` has open bugs (#348/#368/#369) that break
  Node ESM imports today; only the `-compat` variants reliably load.
  The `-deterministic` flavor uses the `enhanced-determinism` Cargo
  feature (~10–15% perf cost) for IEEE-754 reproducibility.
- WASM is base64-embedded inside the JS file; no `import.meta.url`
  dance. Idempotent `await RAPIER.init()` (PR #159).
- Works with `tsx main.ts` natively. May need `global.self ??= {}`
  shim under Node.
- ~8.3 MB unpacked server-side, ~30–80 ms cold init. SIMD/threads
  are off — irrelevant at our 20 Hz tick.
- Iframe uses `import type` only — zero runtime bytes since physics
  runs server-side only.

### Why client-side prediction is OFF the table

Research found Rapier's cross-platform determinism is shallower than
the docs imply:

- `Math.sin/cos` (and other transcendentals) break determinism;
  IEEE-754 doesn't pin them. Must be avoided or substituted.
- Default Rapier isn't even *locally* deterministic; the
  `enhanced-determinism` build is required and contradicts the
  "locally deterministic by default" docs. (rapier #868)
- Open bug: `BroadPhaseBvh.rebuild_frame_index` is skipped during
  serialize, so rollback netcode that snapshot/restores diverges.
  (rapier #910)
- No public test suite verifies bit-identical Node↔browser parity at
  scale. Node is "less-exercised than the browser" per the maintainer.

Lockstep client-side physics is too brittle for a hackathon. The
fallback is **server-authoritative + cheap client smoothing**:
single-snapshot `THREE.MathUtils.lerp(group.position.x, targetX, 0.2)`
per render frame (the `colyseus/realtime-tanks-demo` pattern; not the
two-snapshot interpolation buffer I originally proposed). For the
local player, skip applying server fields the player controls
(throttle slider feedback, drag-to-look) to avoid snap-back — that's
"client prediction lite" without running physics.

### Why not SpacetimeDB

The user asked. The answer is skip — for two reasons that compound:

1. **Architecture mismatch with our LLM surface.** SpacetimeDB
   reducers can't make outbound HTTP calls. v2.0 introduced beta
   `Procedures` that can, but routing Anthropic streaming through a
   beta primitive inside a database process during a hackathon is bad
   odds. The realistic shape is **two servers** — SpacetimeDB for
   state, Node for MCP/AI SDK — paying SpacetimeDB's deployment +
   license complexity for state sync that Colyseus delivers without
   it. No architectural simplification.
2. **License uncertainty.** BSL 1.1 with a single-instance-in-
   production restriction + no-database-service-for-third-parties
   clause. AGPL conversion not until 2031-04-29. Terms have already
   been edited mid-flight (the original 5-year BSL change date
   violated BSL 1.1's 4-year max). Not OSI-approved today.

TS module support is real (v2.0, Feb 2026, ~100k tx/s) — that
objection no longer holds. But the architecture mismatch and license
uncertainty do.

**Revisit only if state-sync becomes the bottleneck *and* we're
willing to accept BSL terms.**

### Why not other state-sync options

- **PartyKit** — Cloudflare Workers runtime, not Node. Wrong shape
  for our hono+sqlite server.
- **Hathora** — shut down 2026-05-05 (acquired by Fireworks AI,
  customers offboarded to Nitrado).
- **PlayroomKit** — vendor-managed SaaS, not server-authoritative
  the way we need.
- **Rune** — designed for the Rune mobile shell; quiet ~20 mo.
- **Liveblocks / Yjs / Croquet** — CRDT/synced-VM semantics are
  wrong for a 20 Hz authoritative tick.
- **Geckos.io** — UDP overkill for space-sim pace; node-datachannel
  native dep complicates deploy.

### Why not other physics options

- **cannon-es** — explicitly non-deterministic (issue #209), dormant
  since Aug 2022.
- **OimoPhysics** — dormant since Oct 2022.
- **Ammo.js** — heavy, non-deterministic, weak ergonomics.
- **Jolt Physics** — credible AAA-grade plan B if Rapier fails us;
  heavier API, larger bundle. Holding in reserve.

## Auth + reconnection

**Trust now, JWT later — additive migration.**

For the hackathon: skip `onAuth` (returns `true` by default), read
`playerId` from `joinOptions`. The `cockpit-player-id:${gameId}`
localStorage key remains the stable cross-room identity.
`@colyseus/auth` is the *wrong tool* for our anon-stable-id case —
it always mints fresh `anonymousId`s server-side.

Per-join, Colyseus issues a fresh `room.reconnectionToken` that the
client caches under a *parallel* localStorage key:
`cockpit-recon-token:${gameId}:${roomId}`. On tab refresh:

1. Try `client.reconnect(reconnectionToken)` first.
2. Fall back to `client.joinOrCreate(roomName, { playerId, gameId })`
   on token expiry / room gone / `allowReconnection` window passed.

Server side, `Room.onLeave` calls
`await this.allowReconnection(client, "manual" | <seconds>)`. The
returned room is a *new* instance — reattach all listeners.

When tamper-resistance matters (post-hackathon), add a hono
`POST /auth/anon` route that signs `{ playerId }` with a server
secret and returns a JWT. Implement `static onAuth(token)` to verify
and return `{ playerId }`. Keep accepting unsigned `playerId` from
`joinOptions` behind a `TRUST_CLIENT_ID=true` env flag for one
release. Clean cutover, no breaking change.

## Bundle impact + schema sharing

Adding `colyseus.js` + `@colyseus/schema` to the cockpit iframe is
**~35–45 KB gzipped** (~200 KB → ~240 KB). The official
`colyseus.js/environments/vite/` example is the reference;
`vite-plugin-singlefile` swallows it cleanly (no workers, no WASM,
no asset URLs in colyseus.js).

**Schema classes go in `packages/shared-state`** as a TS workspace
package, imported by both the server `Room` and the cockpit iframe.
Skip `schema-codegen` — it's for C#/Unity/C++/Haxe; TS doesn't need
it. **Field order MUST match between server and client builds**;
single-source enforces this. The shared `tsconfig.json` needs
`experimentalDecorators` (or TC39 decorators with schema 3+).

**Schema design optimizations** (verified by delta-size research):

- Use `@type("float32")` for `yaw`/`pitch`/`throttle` — float64
  precision is wasted on these. Saves ~30%.
- **Move rarely-changed strings out of Schema** — `targetId`,
  `dockedOrbitalId` go via `room.send()` one-shots on change rather
  than in the schema (where strings are length-prefixed UTF-8 and
  expensive to delta).
- StateView (Colyseus 0.16+) is the AoI mechanism but the docs warn
  it's "not optimized for big datasets." Skip it day-1; revisit at
  100+ ships per room.

**Bandwidth verdict**: safe for ≤ 50 ships per room without AoI.
50 ships × 20 Hz × ~30 B = ~30 KB/s downlink per client (~240 kbps).
Hackathon scope is well under that.

## Tick + persistence pattern

**Tick.** Stock Colyseus `setSimulationInterval(50)` is fine for
v1 — issue #324 documents 5–20 ms jitter (worse under GC), but our
space-sim isn't twitch-sensitive. If precision ever matters, swap to
the timetocode pattern (`setTimeout + setImmediate` with a `Date.now`
deadline) — well-documented community recipe.

**Persistence.** No Colyseus team persists per-tick. Pattern:

- **Motion state**: dirty-flag + `setInterval(persist, 1000)` flush.
  All position/yaw/pitch/throttle changes go into a per-galaxy
  dirty bitmap; the 1 Hz flusher writes whatever's dirty.
- **Discrete events** (warp engage, dock, build, undock,
  start_starship, allowReconnection timeout): synchronous write at
  the event boundary inside the relevant tool/Room handler. These
  are infrequent and must not be lost on crash.

SQLite settings: `journal_mode=WAL`, `synchronous=NORMAL`,
`db.transaction(...)` wrap on the per-second flush so it's a single
fsync (<5 ms typical). `wal_checkpoint(RESTART)` every ~30 s to
bound WAL size. better-sqlite3 can sustain ~80k inserts/s per
phiresky's tuning notes — comfortably over our budget.

**Crash-recovery acceptance window**: ≤1 s of motion state is fine
to lose (clients re-sync on reconnect). Discrete events must not be
lost. Switch to Postgres only when we have multiple writer processes
or sustained >1k writes/s — which is the multi-process Colyseus
threshold below.

## Multi-room scaling: build the seams now

The most important architectural finding from research: **don't
build sharding now, but design Pass 2/3 so sharding is a config
change later.**

The future shape: **one Room per active star system**, lazily spawned
via `matchMaker`. Players warping between systems do
`leaveRoom(A) → joinOrCreate(B)`. Multi-process Colyseus + Redis
Presence/Driver kicks in when we need >1 hot system simultaneously
(~150 CCU+). At that point: NGINX → N Node processes → shared Redis
Presence; PM2 fork mode, not cluster. Path to ~10k CCU per Colyseus's
own scalability docs.

A **Galaxy registry** built on Redis Presence pub/sub gives
cross-room awareness: each system room publishes a 1–2 Hz roster
heartbeat (`{systemId, ships:[{id,coarsePos}]}`); clients subscribe
to neighboring systems' channels for "distant ships as dots" with
500 ms–2 s staleness budget (invisible at warp scale).

**Persistent universe state** (Orbitals, ownership, public chat)
lives **out of Room**: Postgres = truth, Redis = live cache, Room =
ephemeral simulation. On `Room.onCreate(options)` hydrate from disk;
on `Room.onDispose` flush dirty state. **Never trust the Room as
durable.**

Concrete implications for our **upcoming Pass 2/3 code**:

- The `gameId → roomId` mapping (Pass 3 needs it for tool→Room
  routing) is the early seam — today it's 1:1, but the lookup table
  is the natural place where future `(systemId → roomId)` lives.
- `Player` schema carries `systemId` even with one room today. When
  sharding lands, the field already exists.
- Persistence writes go through repository functions, not scattered
  `db.exec()` — a future Postgres swap or Redis cache layer doesn't
  require touching call sites.
- `Room.onCreate(options)` knows how to hydrate from disk. The room
  is born from persistent state, not the other way around.

**When Colyseus stops being right**: at roughly a few thousand CCU,
or any single system needing >1 CPU. Exit ramps:

- **Cloudflare Durable Objects / PartyKit** — one DO per system,
  globally addressable, free persistence; trades Schema sync for
  cheap horizontal scale.
- **Hadean / SpatialOS-style** spatial workers — only worth it at
  EVE-Aether-Wars scale (14k ships in one fight).
- **Custom Bevy/Rust authoritative server** — heaviest lift,
  highest ceiling.

**For us**, the honest threshold: under ~2k concurrent and no
fleet-battle systems → Colyseus + sharding wins comfortably.

## Reference implementations

These are the codebases to study before/during implementation:

- **`colyseus/realtime-tanks-demo/web-threejs`** — canonical
  Three.js + Colyseus integration (`Game.ts`, `Tank.ts`, `Network.ts`).
  Entity-per-Schema pattern, `THREE.Group` per entity,
  `Callbacks.get(room)` API, lerp(0.2), local-player skip.
- **`colyseus-examples/src/app.config.ts`** — REST routes mounted
  via `defineServer({ rooms, express: (app) => {...} })` pattern.
- **`endel/colyseus-pixijs-boilerplate`** — minimal `http.createServer
  → WebSocketTransport` setup that ports cleanly to hono.
- **`damian-pastorini/reldens`** — open-source MMORPG, Colyseus +
  Express + MySQL persistence, multi-zone room transitions.
- **`orion3dgames/t5c`** — Babylon (not Three) but the cleanest
  "real RPG" Colyseus reference for Schema layout + zone sharding.
- **`colyseus.js/environments/vite/`** — official Vite example for
  the client.

## Passes

| Pass | Concrete deliverables |
|---|---|
| **1. Extract physics** | New `packages/star-sim` workspace pkg. Pure functions: `stepShip(ship, dt, world, intent)`, `autopilotTargetThrottle`, `speedCapThrottleByLy`, Phase 1/2 alignment, arrival, `formatSpeedShort`, `formatDistanceShort`. Constants (`WARP_MAX_LY_PER_S`, `LY_PER_AU`, `BRAKE_RANGE_LY`, `ALIGN_TOLERANCE`, `AUTOPILOT_ARRIVAL_LY`, `ORBITAL_DOCK_RANGE_LY`, `OBSERVE_RANGE_LY`). Both `server.ts` and `cockpit-main.ts` re-import. Tsconfig with `experimentalDecorators`. No behavior change. |
| **2. Colyseus alongside hono** | `@hono/node-server` `serve({ fetch })` → captured `http.Server` → `new WebSocketTransport({ server })` → `Server({ transport })`. New `packages/shared-state` workspace pkg with `Player`/`World` Schema (float32 for yaw/pitch/throttle; **no string fields for targetId/dockedOrbitalId** — those go via `room.send()` one-shots; `systemId` field present even though we have one Room today). Single Room class `StarRoom` running 20 Hz tick using `packages/star-sim`. `simulationInterval: 50, patchRate: 50`. Persistence: dirty-flag + 1 Hz flush (WAL + transaction-wrapped) + sync writes on events. Iframe still works through old MCP path. Repository abstraction over SQLite for forward-compat. |
| **3. Refactor MCP tools to mutate via Room + flip iframe to render-only** | `gameId → roomId` repository in SQLite. Tool handlers: `matchMaker.getLocalRoomById(roomId)` → call public Room methods (e.g. `room.handleWarpTo(playerId, target)`); mutate state, never reassign. Iframe: import `colyseus.js` (~40 KB gz delta accepted). Use `Callbacks.get(room)` API (Colyseus 0.16+); `THREE.Group` per Schema entity with `targetX/Y/Z/yaw/pitch` fields + per-frame `lerp(0.2)`; **local player skips applying server fields it controls** (anti snap-back). Input intents via `room.send("input", ...)` throttled (emit on change ≥ ε). Reconnection token cached in `cockpit-recon-token:${gameId}:${roomId}`; reconnect-first / joinOrCreate-fallback flow on tab refresh. |
| **4. Add Rapier server-side** | `@dimforge/rapier3d-deterministic-compat` + `global.self ??= {}` shim. Replace distance-check arrival with shape queries. Adds the foundation for future entities (asteroids, projectiles, ship-vs-ship interactions) without changing the client. Iframe stays `import type` only — zero runtime bytes. |

What was previously Pass 4 (Rapier on client) is dead per the
determinism research.

## References

### Colyseus
- [Colyseus](https://colyseus.io) · [0.17 release notes](https://colyseus.io/blog/colyseus-017-is-here/)
- [State Sync Callbacks (`Callbacks.get(room)`)](https://docs.colyseus.io/sdk/state-sync-callbacks)
- [State View (AoI / filtering)](https://docs.colyseus.io/state/view)
- [WebSocket transport — `{ server }` hook](https://github.com/colyseus/colyseus/blob/master/packages/transport/ws-transport/src/WebSocketTransport.ts)
- [Match-maker (`getLocalRoomById`, `remoteRoomCall`)](https://docs.colyseus.io/server/matchmaker)
- [Presence (Local vs Redis)](https://docs.colyseus.io/server/presence)
- [Scalability docs](https://docs.colyseus.io/scalability)
- [Reconnection (`allowReconnection`, `reconnectionToken`)](https://docs.colyseus.io/sdk)
- [Auth modules](https://docs.colyseus.io/auth/module) · [Room auth](https://docs.colyseus.io/auth/room)
- Issues: [#324 simulationInterval drift](https://github.com/colyseus/colyseus/issues/324) · [#341 persist room state](https://github.com/colyseus/colyseus/issues/341) · [#354 reconnectionToken vs sessionId](https://github.com/colyseus/colyseus/issues/354) · [#594 database access](https://github.com/colyseus/colyseus/issues/594) · [#657 onAuth introduction](https://github.com/colyseus/colyseus/pull/657)
- [colyseus/realtime-tanks-demo](https://github.com/colyseus/realtime-tanks-demo) · [colyseus-pixijs-boilerplate](https://github.com/endel/colyseus-pixijs-boilerplate) · [reldens](https://github.com/damian-pastorini/reldens) · [t5c](https://github.com/orion3dgames/t5c)

### Rapier
- [Rapier.rs](https://rapier.rs) · [JS determinism docs](https://rapier.rs/docs/user_guides/javascript/determinism/) · [JS getting-started](https://rapier.rs/docs/user_guides/javascript/getting_started_js/)
- npm: [`rapier3d-deterministic-compat`](https://www.npmjs.com/package/@dimforge/rapier3d-deterministic-compat) · [`rapier3d-compat`](https://www.npmjs.com/package/@dimforge/rapier3d-compat)
- Issues: [#41 raw.d.ts](https://github.com/dimforge/rapier.js/issues/41) · [#49 Vite + WASM](https://github.com/dimforge/rapier.js/issues/49) · [#151 Math.sin/cos](https://github.com/dimforge/rapier.js/issues/151) · [#159 idempotent init](https://github.com/dimforge/rapier.js/pull/159) · [#317 Node first-handle bug](https://github.com/dimforge/rapier.js/issues/317) · [#348 ESM incompatibility](https://github.com/dimforge/rapier.js/issues/348) · [#368 import paths](https://github.com/dimforge/rapier.js/issues/368) · [#369 NodeNext incompatibility](https://github.com/dimforge/rapier.js/issues/369) · [rapier #868 non-determinism example](https://github.com/dimforge/rapier/issues/868) · [rapier #910 BroadPhase rollback](https://github.com/dimforge/rapier/issues/910)
- [AutomatonSystems/rapier-node — Node shim](https://github.com/AutomatonSystems/rapier-node)

### SpacetimeDB (rejected)
- [SpacetimeDB LICENSE](https://github.com/clockworklabs/SpacetimeDB/blob/master/LICENSE.txt)
- [Issue #215 — BSL terms](https://github.com/clockworklabs/SpacetimeDB/issues/215)
- [HN discussion](https://news.ycombinator.com/item?id=43492653)
- [BitCraft press](https://clockwork-labs.medium.com/press-release-march-4-2025-cbfdae7aa65c)

### Other rejected / dead
- [Hathora shutdown coverage](https://gamesbeat.com/hathora-acquired-will-exit-game-infrastructure-biz-and-hand-over-customers-to-nitrado/)
- [Cloudflare acquires PartyKit](https://blog.cloudflare.com/cloudflare-acquires-partykit/)

### Persistence + tooling
- [better-sqlite3 performance docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md) · [worker_threads docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/threads.md)
- [phiresky — SQLite tuning (80k inserts/s)](https://phiresky.github.io/blog/2020/sqlite-performance-tuning/)
- [hono websocket helper](https://hono.dev/docs/helpers/websocket) · [@hono/node-server](https://github.com/honojs/node-server)
- [timetocode — accurate Node game loop](https://timetocode.tumblr.com/post/71512510386/an-accurate-nodejs-game-loop-inbetween-settimeout)
- [nodejs/node #21822 — setInterval drift](https://github.com/nodejs/node/issues/21822)

### Multi-room scaling references
- [EVE Online architecture](https://highscalability.com/eve-online-architecture/) · [EVE single-shard nuts and bolts](https://www.engadget.com/2010-08-10-a-look-into-the-nuts-and-bolts-of-eve-onlines-single-shard-arch.html)
- [PRDeving: MMO Area-Based Sharding (2025)](https://prdeving.wordpress.com/2025/05/12/mmo-architecture-area-based-sharding-shared-state-and-the-art-of-herding-digital-cats/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Dynetis: Interest management for MOGs](https://www.dynetisgames.com/2017/04/05/interest-management-mog/)
- [VentureBeat: 14,274 ships in EVE / Hadean](https://venturebeat.com/2019/03/25/why-ccp-games-crammed-14274-spaceships-into-an-eve-online-battle/)

### Gamedev fundamentals
- [Gabriel Gambetta — Client-side prediction & server reconciliation](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html)
- [Valve — Source Multiplayer Networking (snapshot vs tick)](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking)
