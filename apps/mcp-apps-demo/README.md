# MCP Apps demo

> An MCP tool whose *result* is an interactive HTML resource. The host mounts
> the resource in a sandboxed iframe and lets it call back into the same MCP
> server over a `postMessage` JSON-RPC bridge — no agent in the loop.

## TL;DR

```
agent ──tools/call lattice_simulate(...)──▶ MCP Apps server
                                              │
                                              ├─ result.content = JSON blocks
                                              └─ _meta.ui.resourceUri = ui://physics/lattice.html
                                                          │
host receives result + UI metadata ◀──────────────────────┘
   │
   ├─ host fetches ui://physics/lattice.html (single-file vite bundle)
   ├─ mounts it in a sandboxed iframe
   └─ iframe gets initial tool result via app.ontoolresult

[ user moves β slider in the iframe ]
       │
       └─ iframe calls app.callServerTool({name:"lattice_simulate", args:{β: 0.62}})
              │
              └─ host roundtrips to MCP server, returns to iframe — no agent involved
```

The *novel* part of MCP Apps versus plain MCP: the iframe can talk back to the
server **autonomously**. The agent calls the tool once; afterwards the user can
re-parameterise and re-run from inside the rendered UI. Great for "what-if"
sliders, what-color-is-this pickers, drill-down filters, etc.

## Quickstart (tested)

You need three things, in three terminals.

**Terminal 1 — Python tool runtime (just an environment, not a server):**

```bash
# Repo root.
export ANTHROPIC_API_KEY=sk-ant-...
uv sync
```

(The MCP server below shells out to `uv run python -c '...'` per tool call —
no daemon required, but `uv sync` must have run once.)

**Terminal 2 — MCP server (port 3010):**

```bash
cd apps/mcp-apps-demo/server
npm install                 # first run only
PORT=3010 npm start         # vite watch + tsx watch concurrently
```

You should see:
```
Warning: Server is binding to 0.0.0.0 without DNS rebinding protection. ...
MCP Apps server listening on http://localhost:3010/mcp
dist/mcp-app.html  XXX kB │ gzip: YY kB
```

**Smoke-test the server (no host yet):**

```bash
# initialize
curl -sN -X POST http://localhost:3010/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}'

# list the lattice_simulate tool with its UI resourceUri
curl -sN -X POST http://localhost:3010/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# actually run the tool — this hits agent_core via subprocess
curl -sN -X POST http://localhost:3010/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"lattice_simulate","arguments":{"model":"ising_2d","beta":0.6,"steps":100}}}'
```

**Terminal 3 — host renderer:**

The reference web host is `examples/basic-host` from
[modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps).
Clone and run alongside this repo:

```bash
git clone https://github.com/modelcontextprotocol/ext-apps.git /tmp/ext-apps
cd /tmp/ext-apps/examples/basic-host
npm install
SERVERS='["http://localhost:3010/mcp"]' npm start
# open http://localhost:8080
```

The host UI lets you call `lattice_simulate`; the result comes back as the
iframe panel, and the slider inside the iframe re-runs the tool against your
local Python.

**Alternative host: Claude Pro/Max/Team or Claude Desktop**

Tunnel the local server (`cloudflared tunnel --url http://localhost:3010`) and
add the resulting URL as a custom connector. Requires a paid plan.

## What's novel here

1. **`_meta.ui.resourceUri`** annotates the tool with a UI it carries with it.
   The host treats the tool result and its UI as a unit.
2. **`registerAppResource(... mimeType: RESOURCE_MIME_TYPE)`** exposes a
   single-file HTML/JS bundle (vite-built with `vite-plugin-singlefile`) under
   a `ui://...` URI. CSP is deny-by-default, so bundling everything inline is
   the path of least resistance.
3. **`app.callServerTool(...)`** in the iframe initiates a tool call without
   round-tripping through the model. The user steers the simulation directly.
4. **Stateless `StreamableHTTPServerTransport`** (`sessionIdGenerator: undefined`)
   — easy to demo, easy to scale; no session bookkeeping. In production you'd
   probably want a session per host connection.

## Walkthrough

### Server: [`server.ts`](server/server.ts) (~115 lines)

- `registerAppTool` registers `lattice_simulate` with a Zod input schema and
  `_meta.ui.resourceUri = "ui://physics/lattice.html"`.
- `registerAppResource` registers the resource. Its `read` callback returns
  the contents of `dist/mcp-app.html` — a vite-built single-file bundle.
- The tool handler shells out to the workspace Python env to call
  `agent_core.tools.call_tool("lattice_simulate", ...)`. The result is
  serialised as JSON and returned as `content[0].text`.

### Iframe UI: [`mcp-app.html`](server/mcp-app.html) + [`src/mcp-app.ts`](server/src/mcp-app.ts)

- Vanilla TS, ~100 lines. No React.
- Imports `App` from `@modelcontextprotocol/ext-apps`. Calls `app.connect()`
  to open the bridge.
- `app.ontoolresult` paints the chart on first mount.
- The β slider's `re-run` button calls `app.callServerTool(...)` and repaints.

### Transport: [`main.ts`](server/main.ts)

Two transports:
- **Streamable HTTP** (default): `npm start` → port 3010. Compatible with
  basic-host, Claude Pro custom connectors, Postman, MCPJam.
- **stdio** (`--stdio`): for Goose / Claude Desktop / VS Code extensions.

## Files

```
apps/mcp-apps-demo/server/
├── package.json                 # @modelcontextprotocol/{sdk,ext-apps} + vite + zod
├── server.ts                    # registerAppTool + registerAppResource + Python bridge
├── main.ts                      # HTTP / stdio transports
├── mcp-app.html                 # iframe shell
├── src/mcp-app.ts               # iframe logic — `App` bridge + slider + SVG chart
└── vite.config.ts               # vite-plugin-singlefile
```

## Caveats

- **No first-party Python server SDK** for the ext-apps extension yet (as of
  May 2026). That's why this server is TS and shells out to Python — the only
  way to satisfy the "shared tools" architectural axis.
- **Vite dev mode is not used** — every UI change forces a rebuild (which
  `npm start` handles automatically via `vite build --watch`).
- **basic-host requires the ext-apps repo cloned** — there's no published
  hosted version. That's the trade-off for a stable spec with a young
  ecosystem.
