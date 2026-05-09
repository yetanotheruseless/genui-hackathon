# Goose demo

> Goose is the *agent runtime* in the four-protocol comparison: it brings
> the brain (its own loop, its own model abstraction, its own UIs — CLI /
> desktop / `goose serve` HTTP API). Our role is to expose `agent_core`
> tools as a stdio MCP server and let Goose drive them.

## TL;DR

```
[ user ] ──goose run / desktop / serve──▶ Goose's agent loop
                                           │
                                           └─ (MCP stdio)
                                                │
                                                ▼
                                       agent_core_mcp/server.py
                                          (FastMCP wrappers around
                                           agent_core.tools)
```

Same five tools as every other demo (`wolfram_query`, `solve_pde_2d`,
`lattice_simulate`, `plot_fn`, `render_diagram`). Different surface — Goose
chats in the terminal, in its desktop chat window, or via `goose serve` over
HTTP/WebSocket. Same brain orchestrating, same physics tools answering.

## Quickstart (tested)

**Step 1 — install Goose** (Apache-2.0, [aaif-goose/goose](https://github.com/aaif-goose/goose)):

```bash
# macOS / Linux
curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash
goose --version  # should print 1.32.0 or newer
```

**Step 2 — sync this repo's Python env** (gives you the `agent-core-mcp` entrypoint):

```bash
# Repo root.
export ANTHROPIC_API_KEY=sk-ant-...
uv sync
```

**Step 3 — drive Goose against our extension, headless:**

```bash
REPO=$(pwd)   # repo root
GOOSE_PROVIDER=anthropic GOOSE_MODEL=claude-sonnet-4-6 goose run --no-session --quiet \
  --with-extension "uv run --directory $REPO agent-core-mcp" \
  --text "Use plot_fn to plot a gaussian from -2 to 2. After, in one sentence say what plot_type was returned."
```

Expected output:
```
  ▸ plot_fn
    expression: gaussian
    x_min: -2
    x_max: 2

Here's the Gaussian plotted from -2 to 2, ...
The returned `plot_type` was **"line"**.
```

**Step 4 — interactive session** (drop the `--no-session` and `--text`, add `-i`):

```bash
GOOSE_PROVIDER=anthropic GOOSE_MODEL=claude-sonnet-4-6 goose session start \
  --with-extension "uv run --directory $REPO agent-core-mcp"
```

You're now in the Goose TUI; ask anything that exercises the physics tools.

**Step 5 — register persistently:** to attach the extension to every Goose
session without `--with-extension`, edit `~/.config/goose/config.yaml`:

```yaml
extensions:
  agent_core:
    enabled: true
    type: stdio
    name: agent_core
    description: "Mock physics-research tools (wolfram, PDE, lattice MC, plots, diagrams)."
    cmd: uv
    args: ["run", "--directory", "/abs/path/to/genui-hackathon", "agent-core-mcp"]
    envs: {}
```

Then `goose configure` shows it under "extensions" and you can toggle it.

## What's novel here

- **Goose is the only entrant in this repo that ships a runtime AND a UI.**
  The other three demos (AG-UI, MCP Apps, A2UI) are protocols — they tell
  you *how* the agent talks to a UI, but you bring the agent. Goose
  inverts that: you bring the tools, Goose brings the agent.
- **MCP is the lingua franca.** The same Python file
  ([`agent_core_mcp/server.py`](agent_core_mcp/agent_core_mcp/server.py)) plugs into
  Goose, Claude Desktop, Claude Code, VS Code, Postman, and MCPJam without
  modification.
- **Headless `goose run` for scripts; `goose serve` for HTTP/WebSocket.**
  See `goose serve --help` for an ACP-compatible HTTP server. That's the
  path to embedding Goose-as-runtime behind your own UI — including any of
  the protocol UIs in the sibling demos.

## Walkthrough

### The MCP server — [`agent_core_mcp/server.py`](agent_core_mcp/agent_core_mcp/server.py)

About 60 lines:
- `FastMCP("agent_core")` from `mcp.server.fastmcp` (the official Python SDK).
- One typed wrapper per `agent_core` tool. Pydantic `Annotated[..., Field(...)]`
  hints become the JSON Schema that Goose presents to the model.
- Each wrapper returns a JSON string with `{"blocks": [...]}` — the same
  render-block dialect every other demo uses. Goose's loop reads the blocks
  as text and decides what to say about them.

### The entrypoint

`pyproject.toml` declares:

```toml
[project.scripts]
agent-core-mcp = "agent_core_mcp.server:main"
```

After `uv sync`, `uv run agent-core-mcp` starts the stdio MCP server.

### Optional: combine with the MCP Apps server

The TS server in `apps/mcp-apps-demo/server` *also* speaks stdio:

```bash
cd apps/mcp-apps-demo/server
npx tsx main.ts --stdio   # or `npm run start:stdio`
```

If the Goose desktop app's MCP-Apps support is enabled (built-in `apps`
extension), pointing it at the mcp-apps-demo server will render the
`lattice_simulate` UI inline in Goose's chat. That's the *combined* demo:
Goose's agent loop → MCP Apps tool → live UI in Goose's chat window.

## Files

```
apps/goose-demo/
├── README.md
└── agent_core_mcp/
    ├── pyproject.toml                 # mcp + agent_core; entrypoint agent-core-mcp
    └── agent_core_mcp/
        ├── __init__.py
        └── server.py                  # FastMCP wrappers, ~60 lines
```

## Caveats

- **Goose authentication is per-provider.** OAuth providers (chatgpt_codex,
  Gemini OAuth) hold a system-wide lock during sign-in; if Goose is already
  using one in another window, switch to a key-based provider for this demo
  (e.g., `GOOSE_PROVIDER=anthropic`).
- **Goose's built-in `apps` MCP extension is separate from `modelcontextprotocol/ext-apps`** —
  the names collide unfortunately, but they target the same spec.
