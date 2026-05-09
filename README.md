# genui-hackathon

> AI Tinkerers **Generative UI Global Hackathon** prep — May 9, 2026.
> One agent, four protocols, six demos.

## TL;DR

A single Python agent (`packages/agent_core`) with five mock physics-research
tools. Four frontends consume it through four different generative-UI
protocols. Two more demos use Goose desktop as host with multi-iframe MCP
Apps for fully playable experiences. The architectural axiom: **shared
tools, shared agent loop, independent frontends**. The LLM is
provider-agnostic across all of it (`LLM_PROVIDER` ∈
`{anthropic, openai, gemini}` + `LLM_MODEL`).

| Demo | Protocol | What's distinctive | Frontend stack | Default ports |
|---|---|---|---|---|
| [`apps/agui-demo`](apps/agui-demo) | **AG-UI** | Streaming SSE events; render-block JSON inside `TOOL_CALL_RESULT.content`; no client SDK needed | Next.js 16 + Tailwind + recharts/mermaid/KaTeX | be `8765`, fe `3000` |
| [`apps/mcp-apps-demo`](apps/mcp-apps-demo) | **MCP Apps** | Tool result + bundled HTML resource; iframe `postMessage` bridge lets the UI re-call tools without the agent | TS server + vite single-file HTML | server `3010` |
| [`apps/a2ui-demo`](apps/a2ui-demo) | **A2UI** | Declarative flat-component-graph from a fixed catalog; no HTML, no script — safe by construction | Lit + `@a2ui/web_core/v0_9` + vite | be `8766`, fe `5173` |
| [`apps/goose-demo`](apps/goose-demo) | **Goose** | Agent runtime, not a UI protocol. Same `agent_core` tools surfaced as a stdio MCP extension | Goose CLI / desktop / `goose serve` | none (stdio) |
| [`apps/dungeon-demo`](apps/dungeon-demo) | **Goose + MCP Apps × 4** | 4 separate MCP Apps tools, 4 iframes (viewport / narration / stats / controls), shared `worldId` server state. Three.js wireframe dungeon, LLM-narrated chunks + party banter | TS server + Three.js + vite × 4 | server `3020` |
| [`apps/star-systems-demo`](apps/star-systems-demo) | **Goose + MCP Apps × 3 + real astro data + Culture reskin** | 3 iframes (cockpit / compendium / bridge). 21 real nearby stars with real distances + spectral types + known exoplanets. Warp/impulse FTL ship; **chat with your ship's Mind** in Iain Banks Culture style; multiplayer-ready (shared `gameId`, build Orbitals, public Contact channel) | TS server + Three.js + vite × 3 | server `3030` |

Each demo's README has a **tested copy-paste Quickstart** and a deeper
walkthrough of what's novel about that protocol.

## Repo-wide quickstart

```bash
# One-time setup
export ANTHROPIC_API_KEY=sk-ant-...
uv sync                                   # installs agent_core + all four backends

# Smoke-test the shared tools
uv run python -c "from agent_core.tools import call_tool; \
  print(call_tool('plot_fn', {'expression':'gaussian'})[0].title)"
# → y = gaussian(x)

# Pick a demo
cat apps/agui-demo/README.md      # → recharts/mermaid frontend, full chat
cat apps/mcp-apps-demo/README.md  # → iframe-with-slider, basic-host renderer
cat apps/a2ui-demo/README.md      # → declarative surfaces, Lit renderer
cat apps/goose-demo/README.md     # → Goose CLI / desktop drives the same tools
```

## What I'm leaning into for the hackathon

The four protocols answer *"how does an agent drive UI?"* with deeply
different philosophies. The interesting demo isn't *one* protocol, it's
the **comparison**: same brain, four surfaces.

- **AG-UI** says: stream typed events, the frontend already has React
  components ready, the agent decides which to call.
  → optimal for *agentic feedback loops* (steering UIs).
- **MCP Apps** says: the server ships its own UI as an HTML bundle; the
  host renders it in a sandbox; the iframe can call tools on its own.
  → optimal for *tool-enabled interfaces* with strong server-side control
  and what-if interactivity.
- **A2UI** says: forget HTML — the agent emits a declarative tree from a
  fixed catalog of safe components.
  → optimal for *dynamic component generation* with security/portability
  constraints.
- **Goose** says: the agent is the platform; UIs (CLI, desktop, headless
  HTTP API) all consume the same MCP-rooted tool graph.
  → optimal for *cross-app workflows* and ship-an-agent-now.

## Architecture

```
                                ┌─────────────────────────────────────┐
                                │  packages/agent_core (shared)       │
                                │  ─────────────────────────────────  │
                                │  tools.py        wolfram_query      │
                                │                  solve_pde_2d       │
                                │                  lattice_simulate   │
                                │                  plot_fn            │
                                │                  render_diagram     │
                                │  render.py       Markdown / Latex / │
                                │                  PlotSpec / Diagram │
                                │                  Card / Table       │
                                │  events.py       protocol-neutral   │
                                │  loop.py         Claude tool-use    │
                                └──────────────────┬──────────────────┘
                                                   │
                  ┌──────────────────┬─────────────┼──────────────┬──────────────────┐
                  ▼                  ▼             ▼              ▼                  ▼
             agui-demo         mcp-apps-demo   a2ui-demo      goose-demo
        (FastAPI + Next.js)   (TS MCP server)  (FastAPI +     (FastMCP stdio
                              + iframe)         Lit)          server, no UI)
```

## Repo layout

```
genui-hackathon/
├── packages/agent_core/              # shared Python: tools + Claude loop
├── apps/
│   ├── agui-demo/
│   │   ├── backend/                  # FastAPI: AG-UI SSE bridge
│   │   └── frontend/                 # Next.js + recharts + mermaid + KaTeX
│   ├── mcp-apps-demo/server/         # TS @modelcontextprotocol/ext-apps + vite
│   ├── a2ui-demo/
│   │   ├── backend/                  # FastAPI: A2UI v0.9 message stream
│   │   └── frontend/                 # Lit + @a2ui/web_core + @a2ui/lit
│   ├── goose-demo/agent_core_mcp/    # FastMCP stdio server
│   ├── dungeon-demo/server/          # Goose-host + MCP Apps × 4 + Three.js wireframe
│   └── star-systems-demo/server/     # Goose-host + MCP Apps × 3 + real astro data
└── pyproject.toml                    # uv workspace
```

## Tomorrow's open questions (decide at 12 PM kickoff)

1. **Pick a vertical.** Physics auto-researcher? Code-review steering?
   Game state visualizer? The agent_core tools are mockable — replace them
   for whatever the chosen vertical needs.
2. **Pick a hero protocol.** Which demo gets the polish budget? My bet is
   AG-UI for time-to-impressive (richest live UI), A2UI for novelty, MCP
   Apps for the slider-feedback wow-factor, Goose for "we shipped".
3. **Combine.** E.g., an AG-UI shell that *also* mounts an MCP Apps iframe
   for one specific tool surface — genuinely heterogeneous UI; could be
   judged as "all four protocols at once".

## Credits

Built on:
- [ag-ui-protocol/ag-ui](https://github.com/ag-ui-protocol/ag-ui) + [CopilotKit](https://github.com/CopilotKit/CopilotKit) (AG-UI / `ag-ui-protocol` PyPI / `@copilotkit/*`)
- [modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps) (MCP Apps)
- [google/A2UI](https://github.com/google/A2UI) (A2UI v0.9 / `@a2ui/lit` / `@a2ui/web_core`)
- [aaif-goose/goose](https://github.com/aaif-goose/goose) (Goose CLI + desktop)
- Shared physics-research mock tools live in [`packages/agent_core`](packages/agent_core).
