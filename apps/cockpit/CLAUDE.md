# cockpit · handoff notes

WIP feature on `feat/cockpit`. Custom MCP Apps host that mounts the
`star-systems-demo` iframes (cockpit / overview / target-info /
compendium / bridge) in a fixed 5-slot game layout. Preserves the
Generative UI thesis: the agent decides what UI mounts; the host just
provides slots. The cockpit-backend is a thin passthrough — it holds the
shared MCP session and broadcasts state diffs over WebSocket — but does
**not** host an agent loop. The Mind chat lives on the server as the
`ask_mind` tool, surfaced in the bridge iframe.

## Setup

`ANTHROPIC_API_KEY` is read from the **repo-root** `.env`. Both servers
load it via an inline parser at startup (Node 20.9 doesn't have
`process.loadEnvFile`).

```
# /<repo-root>/.env
ANTHROPIC_API_KEY="sk-ant-..."
```

Three terminals:

```bash
# T1 — star-systems MCP server (:3030)
cd apps/star-systems-demo/server
npm install                       # first run only
npm run build:panes               # bundles the 6 HTML panes into dist/
PORT=3030 npx tsx main.ts

# T2 — cockpit backend (:4040, Hono + WS)
cd apps/cockpit/backend
npm install                       # first run only
PORT=4040 npm run dev             # tsx watch — auto-reloads on src/ changes

# T3 — cockpit frontend (:5174, Vite + React + shadcn)
cd apps/cockpit/frontend
npm install                       # first run only
npm run dev
```

Open <http://localhost:5174>. First load shows the SetupScreen (pick a
Mind); subsequent loads reattach via the cached playerId in
localStorage and bootstrap the four secondary panes
(`open_overview` → `open_target` → `open_compendium` →
`open_bridge`) sequentially. All five slots should populate.

## Architecture

```
browser (Vite :5174)
  │   POST /tool/:name    → backend forwards to MCP, enriches with _meta.ui
  │   GET  /ui?uri=...    → backend reads MCP resource, returns HTML
  │   WS   /ws            → backend pushes state diffs
  │   MCP host bridge     → AppBridge per iframe via PostMessageTransport
  ▼                          (attaches serialized via attachQueue)
cockpit-backend (:4040)
  - one persistent MCP session shared by all browser tabs
  - state.ts polls get_state per (gameId, playerId), broadcasts diffs
  - NO agent loop — Mind chat is server-side via ask_mind tool
  ▼
star-systems server (:3030)
  - MCP tools, each with _meta.ui = { resourceUri, slot }
  - SLOT mapping in server.ts:
      cockpit→viewport,  overview→overview,  target-info→target,
      compendium→side,   bridge→bottom
  - ask_mind: server-side LLM tool (AI SDK + Anthropic) with the full
    catalog injected into the system prompt. Bridge pane is its UI.
  - Idle-player reaper sweeps stale players every IDLE_REAP_MS.
```

## Layout

```
┌──────────────────────────────────────┬──────────────────────────────┐
│                                      │   target  (h-[224px])   │
│                                      │   target-info.html           │
│   viewport (col 1, row 1; flex)      ├──────────────────────────────┤
│   cockpit.html                       │                              │
│   3D scene + planets + reticle       │   side (tabbed; flex-1)      │
│                                      │   overview / compendium      │
│                                      │   (both stay mounted —       │
├──────────────────────────────────────┤    visibility:hidden when    │
│   bottom (h-[320px])                 │    inactive so AppBridges    │
│   bridge.html (Mind chat)            │    don't tear down)          │
└──────────────────────────────────────┴──────────────────────────────┘
```

Right column is `[1fr 418px]`; bottom row is `320px`. The "switch
vessel" affordance in the top-right resets the cached playerId.

## File map

```
apps/cockpit/
├── backend/src/
│   ├── main.ts          env loader + Hono routes (/health, /tool/:name, /ui, /ws)
│   ├── mcp-client.ts    persistent MCP client; toolUiMeta cache from tools/list
│   └── state.ts         per-session get_state polling + WS broadcast
└── frontend/src/
    ├── main.tsx         StrictMode is OFF — see "Open issues"
    ├── App.tsx          5-slot CSS grid; reattach effect bootstraps secondary panes
    ├── components/
    │   ├── Slot.tsx          renders McpAppFrame for store.slots[name]
    │   ├── McpAppFrame.tsx   iframe + AppBridge + sendToolResult
    │   ├── SideArea.tsx      Tabs for overview / compendium (both stay mounted)
    │   └── SetupScreen.tsx   first-load Mind picker → start_starship
    └── lib/
        ├── store.ts     Zustand: session, gameId, playerId, gameState, slots
        ├── ws.ts        /ws client; re-bind on hello
        ├── tool-call.ts POST /tool/:name; auto-mounts slot from response _meta.ui
        ├── mcp-host.ts  shared MCP Client + serialized AppBridge factory
        └── utils.ts     shadcn cn()
```

## Click & warp semantics (current behavior)

- **Single-click** in viewport / overview row → `set_target` only.
  Locks the reticle, no warp, no rotation.
- **Double-click** in viewport / overview row → align (`set_target` +
  `face_target`). Rotates to face the target without engaging warp.
- **Right-click** an overview row → context menu (Target / Align / Warp).
  Warp is the only path that engages warp by default.
- **Viewport picker** considers stars, orbital icons, **and planet
  meshes** (`pickBodyUnderClick` in `cockpit-main.ts`). Planet picks
  resolve to ids of the form `planet:<starId>::<name>`.
- **Warp execution** in the cockpit iframe is a 2-phase tick:
  - Phase 1 (off-axis): rotate-only, throttle pinned to 0, until
    angular error < `ALIGN_TOLERANCE` (~2.3°).
  - Phase 2 (on-axis): snap-track + autobrake throttle ramp.
  - Avoids the prior "fly in circles" behavior caused by camera
    smoothing fighting throttle motion.
- **Planet warp** is supported end-to-end. Server's `warp_to`
  short-circuits on `planet:` ids (sets `targetId` + `warpEngaged`,
  no STAR_INDEX lookup); the cockpit resolves the live orbital phase
  and steers there.

## Resolved issues — what changed since the early scaffold

1. **Iframe init race** — `mcp-host.ts:24` serializes
   `attachAppBridge` calls via `attachQueue`. `attachAppBridgeInner`
   waits for the bridge's `initialized` event with a 5 s timeout, and
   the pane↔host two-way handshake (`mcp-app-pane-ready` /
   `mcp-app-host-ready`) ensures the host's first `sendToolResult`
   doesn't race the pane's transport listener. All five iframes
   reliably init.
2. **`sync_state` clobber** — `server.ts:993` skips null/undefined
   fields when merging the iframe's pushed state, so the iframe's
   regular sync no longer erases server-set `targetId`/`warpEngaged`.
   Belt-and-suspenders: the cockpit no longer pushes those fields at
   all — server is the sole owner.
3. **Abort-listener leak** — `mcp-client.ts:29` calls
   `setMaxListeners(0, sig)` on the transport's shared abort signal.
   The undici-side fetch listeners still aren't removed, but the
   warning is silenced and the payload is small. Acceptable trade-off.
4. **Demo galaxy state accumulates** — `server.ts:264` runs an idle
   reaper that prunes players whose `lastSeenAt` is older than
   `IDLE_REAP_MS` and detaches them from any orbital they were docked
   at. Long-lived dev sessions stay clean.
5. **Captain LLM uses wrong ids** — superseded. The captain agent in
   cockpit-backend was removed entirely. Chat is now the server-side
   `ask_mind` tool (`server.ts:1439`), which builds its system prompt
   from `mindSystemPrompt(persona)` + `mindCatalogToolsBlock()` (full
   tool reference with snake_case ids) + live ship context. Tools are
   wired via the AI SDK's `tool()` wrappers, so the model can't
   guess — it picks from the typed catalog.

## Open issues / known caveats

1. **StrictMode still off** in `main.tsx`. The double-invoke would
   need `McpAppFrame`'s async setup to be fully idempotent (the
   serialized `attachQueue` covers most of it, but cleanup paths
   haven't been audited). Re-enabling is a small task; doing it would
   surface any remaining races.
2. **Per-client game loop.** The simulation tick lives in
   `apps/star-systems-demo/server/src/cockpit-main.ts` (inside the
   cockpit iframe), not on the server. Consequence: opening the same
   player in two browser tabs means two simulations race through
   `sync_state`. Multiplayer with distinct `playerId`s is fine; the
   same `playerId` in two tabs is not.
3. **`tools/list` cache.** Cockpit-backend caches `_meta.ui` from
   `tools/list` once at first call (`mcp-client.ts:70`). Adding new
   server tools requires a backend restart.
4. **Captain stream WS event types** in `lib/ws.ts` (`captain-token`,
   `captain-tool`, `captain-done`, `captain-error`) are dead — the
   captain agent is gone. Safe to delete next pass.
