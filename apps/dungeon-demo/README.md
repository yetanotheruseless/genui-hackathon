# Dungeon demo · Goose desktop + MCP Apps + Three.js

> Spec-correct multi-iframe MCP Apps. Four entry tools, four iframes, one
> shared `worldId` on the server. Goose desktop hosts. The user explores a
> wireframe dungeon with WASD; chunks and party banter are LLM-narrated on
> demand; controls and stats live in their own iframes that poll the
> server for state.

## TL;DR

```
Goose desktop chat
    │
    ├── tools/call start_dungeon       ──▶ MCP server allocates worldId, returns viewport iframe
    ├── tools/call open_narration_pane ──▶ MCP server returns narration iframe (same worldId)
    ├── tools/call open_stats_pane     ──▶ stats iframe
    └── tools/call open_controls_pane  ──▶ controls iframe
                          │
   ┌──────────────────────┴──────────────────────┐
   │                       │                     │
viewport   ◀ sync_state ─▶  server's WorldState   ◀── controls (enqueue_action)
   │                       │                     │
   │                       ├── narrationLog      │
   │                       ├── chunkLore         │
   │                       └── pendingActions    │
   │                                             │
   └──── dequeue_actions every ~200 ms ──────────┘

   narration / stats panes  ──── poll get_state every 500 ms ──▶ server
```

The viewport pane owns Three.js, input, collision, and the per-frame loop.
It pushes summary state to the server and drains pending click-actions
from the controls pane. The narration and stats panes are read-only
pollers. The controls pane is write-only.

The LLM is **provider-agnostic** via the Vercel AI SDK — set `LLM_PROVIDER`
∈ `{anthropic, openai, gemini}` and `LLM_MODEL`. **Fail-fast**: missing
keys / provider errors / schema mismatches throw with a clear message;
no silent canned-content fallback masks a misconfiguration.

## Quickstart (tested)

**1. Build all four iframe bundles:**

```bash
cd apps/dungeon-demo/server
npm install
npm run build           # produces dist/{viewport,narration,stats,controls}.html
```

**2. Run the server (HTTP for basic-host, stdio for Goose):**

```bash
# HTTP (basic-host):
ANTHROPIC_API_KEY=sk-ant-... PORT=3020 npm start

# stdio (Goose desktop, Claude Desktop, VS Code):
ANTHROPIC_API_KEY=sk-ant-... npm run start:stdio
```

**3. Smoke-test (no host):**

```bash
# allocate a world
WORLD=$(curl -s -X POST http://localhost:3020/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"start_dungeon","arguments":{"seed":7,"starting_theme":"silver bell mausoleum"}}}')
WORLDID=$(echo "$WORLD" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
echo "worldId: $WORLDID"

# narrate something
curl -s -X POST http://localhost:3020/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"narrate\",\"arguments\":{\"worldId\":\"$WORLDID\",\"events\":[{\"kind\":\"enter_chunk\",\"theme\":\"echoing chapel\"}]}}}"
```

You should see the narrator + party voices in character ("Pray the gods aren't
listening. They hate company down here.").

**4. Add to Goose desktop** — `~/.config/goose/config.yaml`:

```yaml
extensions:
  dungeon:
    enabled: true
    type: stdio
    name: dungeon
    description: "Wireframe dungeon-crawler with LLM-narrated chunks. 4 panes."
    cmd: npx
    args: ["tsx", "/abs/path/to/genui-hackathon/apps/dungeon-demo/server/main.ts", "--stdio"]
    envs:
      ANTHROPIC_API_KEY: "sk-ant-..."
      LLM_PROVIDER: "anthropic"
      LLM_MODEL: "claude-haiku-4-5-20251001"
```

In Goose: `"Start the wireframe dungeon (theme: silver bell mausoleum), then open the narration, stats, and controls panes."` Goose calls all four entry tools in sequence; four iframes mount inline in chat.

## Provider switching

| LLM_PROVIDER | LLM_MODEL example          | Required env key |
| ------------ | -------------------------- | ---------------- |
| `anthropic`  | `claude-haiku-4-5-20251001` | `ANTHROPIC_API_KEY` |
| `anthropic`  | `claude-sonnet-4-6`        | `ANTHROPIC_API_KEY` |
| `openai`     | `gpt-5.5-mini`             | `OPENAI_API_KEY` |
| `gemini`     | `gemini-2.5-flash`         | `GEMINI_API_KEY` (or `GOOGLE_GENERATIVE_AI_API_KEY`) |

If no key is set for the chosen provider, the tool call throws with the
expected env var name; the iframe shows an error banner instead of
silent canned content.

## What's novel here

The single-iframe version (which would have just CSS-gridded four panels in
one iframe) is what you'd build if you didn't think about it. The
multi-iframe version exercises what's actually new about MCP Apps:

1. **Each tool owns its UI.** Four tools, four `_meta.ui.resourceUri`
   values, four different vite-bundled HTML resources. The host treats
   them independently.
2. **Server-side world state shared by `worldId`.** Stateless MCP requests,
   but a module-scoped `Map<worldId, WorldState>` survives. The four
   iframes coordinate without ever talking to each other directly — they
   talk through the server.
3. **Action queue plumbing.** The controls pane never knows about Three.js
   or the player position. It posts to a pending-action queue; the
   viewport drains it on each tick. Loose coupling at the protocol level.
4. **Polling > pushing in MCP Apps.** There's no "subscribe to other tool
   results" primitive in the spec. The narration and stats panes just
   `get_state` at 2 Hz. That's the workaround; calling it out is half the
   demo.

## File map

```
apps/dungeon-demo/server/
├── package.json                  # ai SDK + ext-apps + three + zod
├── tsconfig.json / .server.json
├── vite.config.ts                # vite-plugin-singlefile, INPUT-driven
├── main.ts                       # HTTP / stdio transports
├── server.ts                     # 10 MCP tools (4 entry, 2 state, 2 action, 2 LLM)
├── llm.ts                        # provider-agnostic generateObject wrapper
├── viewport.html                 # Three.js viewport iframe
├── narration.html                # narration log iframe
├── stats.html                    # stats + inventory iframe
├── controls.html                 # action buttons iframe
└── src/
    ├── shared.ts                 # MCP App bridge + polling helper + types
    ├── viewport-main.ts          # game loop, input, sync, drain, narrate
    ├── narration-main.ts         # poll get_state, render lines
    ├── stats-main.ts             # poll get_state, render dl + inventory
    ├── controls-main.ts          # buttons → enqueue_action
    ├── game.ts                   # procedural chunks + state types
    └── render.ts                 # Three.js scene (InstancedMesh walls, decorations)
```

## Tools

| Tool                  | Caller                  | Purpose                                                             |
| --------------------- | ----------------------- | ------------------------------------------------------------------- |
| `start_dungeon`       | the host (via the agent) | Allocate `worldId`, mount viewport iframe, generate spawn lore     |
| `open_narration_pane` | the host                | Mount narration iframe (read-only log)                              |
| `open_stats_pane`     | the host                | Mount stats + inventory iframe (read-only)                          |
| `open_controls_pane`  | the host                | Mount control-button iframe (write-only)                            |
| `sync_state`          | viewport iframe         | Push player position / chunk / inventory                            |
| `get_state`           | narration & stats iframes | Pull full world state                                             |
| `enqueue_action`      | controls iframe         | Post a button press to the pending queue                            |
| `dequeue_actions`     | viewport iframe         | Drain pending actions on each tick                                  |
| `narrate`             | viewport iframe         | LLM call → 1–4 voiced lines, appended to log                        |
| `explore_chunk`       | viewport iframe         | LLM call → chunk theme + decorations, cached on the world           |

## Stretch / next moves

- **Cross-iframe `postMessage` bridge.** The current architecture talks
  through the server only. With a custom host extension you could do
  iframe-to-iframe `postMessage` for sub-50ms updates.
- **`goose serve` for state persistence.** Move `worlds` Map into a real
  store (sqlite?) so closing & re-opening Goose desktop keeps your
  dungeon.
- **Hostile decorations.** `goblin` / `slime` / `wisp` already render as
  wireframes. Add HP loss on contact and you've got a roguelike.

## Caveats

- **Stateless transport, stateful module.** MCP requests don't share
  sessions, but the `worlds` Map is at module scope, so all requests in
  the same server process see it. If you scale horizontally, externalise
  the store.
- **Provider tiers matter.** Haiku 4.5 produces Haiku-quality lore — fast
  and short. Sonnet 4.6 gives richer narratives at higher latency. Gemini
  2.5 Flash is comparable to Haiku in speed and quality.
- **Build is multi-pass.** `npm run build` runs vite four times (one per
  pane) sequentially; `npm start` runs four watchers in parallel. Each
  output goes into `dist/` with `emptyOutDir: false`.
