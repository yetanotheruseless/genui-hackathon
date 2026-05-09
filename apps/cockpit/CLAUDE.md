# cockpit · handoff notes

WIP feature on `feat/cockpit`. Custom MCP Apps host that mounts the three
`star-systems-demo` iframes (cockpit / compendium / bridge) in a fixed
4-pane game layout, plus a native React captain chat that drives an agent
loop. Preserves the Generative UI thesis: the agent decides what UI
mounts; the host just provides slots.

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
npm run build:panes               # bundles cockpit/compendium/bridge HTML into dist/
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

Open <http://localhost:5174>. The captain pane auto-bootstraps:
`start_starship` → `open_compendium` → `open_bridge`. All three iframes
should mount in their slots.

## Architecture

```
browser (Vite :5174)
  │   POST /tool/:name    → backend forwards to MCP, enriches with _meta.ui
  │   GET  /ui?uri=...    → backend reads MCP resource, returns HTML
  │   WS   /ws            → backend pushes state diffs + captain stream
  │   MCP host bridge     → AppBridge per iframe via PostMessageTransport
  ▼
cockpit-backend (:4040)
  - one persistent MCP session shared by all browser tabs
  - state.ts polls get_state per (gameId, playerId), broadcasts diffs
  - agent.ts: Vercel AI SDK + MCP tools; auto-injects gameId/playerId
  ▼
star-systems server (:3030)
  - 13 MCP tools, each with _meta.ui = { resourceUri, slot }
  - SLOT mapping in server.ts: cockpit→viewport, compendium→side, bridge→bottom
```

## File map

```
apps/cockpit/
├── backend/src/
│   ├── main.ts          env loader + Hono routes (/health, /tool/:name, /ui, /ws)
│   ├── mcp-client.ts    persistent MCP client; toolUiMeta cache from tools/list
│   ├── state.ts         per-session get_state polling + WS broadcast
│   └── agent.ts         captain agent loop (streamText + tool() wrappers)
└── frontend/src/
    ├── main.tsx         StrictMode is OFF — see "Known issues"
    ├── App.tsx          4-slot CSS grid (viewport / side / bottom / captain)
    ├── components/
    │   ├── Slot.tsx     reads store.slots[name], renders McpAppFrame or fallback
    │   ├── McpAppFrame.tsx   iframe + AppBridge + sendToolResult
    │   ├── CaptainChat.tsx   native chat; auto-bootstraps; streams tokens
    │   └── ui/                shadcn primitives (button, card, input, scroll-area, tabs)
    └── lib/
        ├── store.ts     Zustand: session, gameId, playerId, gameState, slots
        ├── ws.ts        /ws client; re-bind on hello; listener fan-out for captain stream
        ├── tool-call.ts POST /tool/:name; auto-mounts slot from response _meta.ui
        ├── mcp-host.ts  shared MCP Client + AppBridge factory
        └── utils.ts     shadcn cn()
```

## Current state — what's verified working

When everything lines up: all 3 iframes are populated (cockpit shows
ship name, nearest stars, 3D scene with Sol's ring; compendium shows the
Mind list and planet-type counts; bridge shows the Mind's welcome
message in character). Captain accepts `tell me about Proxima Centauri`
and chains `list_objects → observe`, streaming the result back with the
Mind's narration.

That state is real but **racy** — see Known issues #1.

## Known issues — open

1. **Iframe init is racy.** On reload, sometimes only 1/3 iframes get
   their `sendToolResult` init payload through. The host-side
   "Parsed message" debug log appears 1× instead of 3×.
   - StrictMode is disabled in `main.tsx` because its double-invoke
     races with `McpAppFrame`'s async setup. Re-enabling needs the
     setup to be idempotent under double-invoke.
   - Three concurrent `AppBridge.connect()` calls share one MCP Client.
     Each calls `client.setNotificationHandler(...)`, which overwrites
     the previous bridge's handler (only the last bridge wins). This is
     for forwarding server→app notifications, but the symptom timing
     suggests it's related.
   - Bootstrap is currently sequential (see `CaptainChat.tsx`), but the
     issue persists. So the race is downstream of bootstrap order.
   - Possible fix: serialize bridge attaches in `mcp-host.ts` (one
     in-flight `attachAppBridge` at a time, queued).

2. **`sync_state` clobbers `targetId`.** Cockpit iframe pushes its local
   state every 200ms (including null `targetId`). Server's
   `Object.assign(player, args.state)` overwrites server-set values, so
   the captain's `warp_to` is wiped by the iframe's next sync. Fix:
   server-side `sync_state` should skip null/undefined values.
   File: `apps/star-systems-demo/server/server.ts`, the `sync_state`
   tool registration.

3. **Abort-listener leak in cockpit-backend.** After ~150 polls,
   `MaxListenersExceededWarning` fires. Probably `client.callTool`
   leaving AbortSignal listeners around in `state.ts`'s poll loop.
   Doesn't break functionality immediately; memory grows.

4. **Demo galaxy state accumulates.** Every reload spawns a fresh
   player in `gameId: "demo"`. Server keeps players in memory, so
   "OTHER MINDS IN THIS VOLUME" grows. Workaround: change CaptainChat's
   hardcoded `gameId: "demo"` to a fresh value, or restart the
   star-systems server.

5. **Captain LLM occasionally uses wrong object ids.** System prompt
   tells it to call `list_objects` first and use the snake_case ids
   ("proxima_centauri" not "proxima"), but the model still guesses
   sometimes. Mostly mitigated by the prompt; would harden by injecting
   the catalog ids into the system prompt at session start.

## Next steps, priority order

1. Serialize iframe bridge attaches; verify all 3 iframes init reliably.
2. Server-side `sync_state` null-skip (one-line fix).
3. Re-enable StrictMode after `McpAppFrame` is idempotent.
4. Decide the architectural answer to "who owns `targetId`" — iframe,
   server, or both with a clear protocol.
5. Fix the abort-listener leak in `state.ts`.
6. Polish: README, sci-fi styling, two-tab multiplayer smoke test.

## Patches landed in `star-systems-demo/server`

These are independent of the cockpit but needed to make it work:
- `main.ts`: load `<repo-root>/.env` via inline parser.
- `server.ts`: every tool's `_meta.ui` now includes a `slot` hint.
- `server.ts`: `import.meta.dirname` → `path.dirname(fileURLToPath(...))`
  (Node 20.9 compat).
- `src/shared.ts`: iframe init resolves on `data.gameId` (Culture
  Contact field) in addition to `data.worldId` (legacy dungeon field).

If you rebuild the iframe HTMLs (`npm run build:panes`), the
`shared.ts` change is what makes the cockpit's `sendToolResult` actually
populate the panes.
