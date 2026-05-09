# agent_core

Shared agent loop + mock physics-research tools for the four protocol demos.

## TL;DR

```python
from agent_core import loop

async for event in loop.run("Plot the Coleman-De Luccia bubble profile."):
    print(event)
```

Yields a stream of protocol-neutral events: `run_started`, `text_delta`,
`tool_call_start`, `tool_call_result`, `run_finished`. Each protocol adapter
translates these into its native wire format.

## Provider switching

Routes through LiteLLM, so any provider with tool-use semantics works.
Set:

```bash
export LLM_PROVIDER=anthropic   # or: openai, gemini, vertex_ai, ...
export LLM_MODEL=claude-haiku-4-5-20251001   # provider-specific model name
```

Or use a fully-qualified `LLM_MODEL=openai/gpt-5.5` and `LLM_PROVIDER` is
ignored. API keys come from the provider's standard env var
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`).

## Tools

| Tool             | What it does                                              | Returns               |
| ---------------- | --------------------------------------------------------- | --------------------- |
| `wolfram_query`  | Symbolic / numeric eval (canned + fallback)               | `Latex` + `Card`      |
| `solve_pde_2d`   | Toy 2D PDE solve on a square grid                         | `Markdown` + `PlotSpec(heatmap)` |
| `lattice_simulate` | Mock MC trace of a lattice observable                   | `PlotSpec(line)` + `Card` |
| `plot_fn`        | Real numpy-backed function plot                           | `PlotSpec(line)`      |
| `render_diagram` | Mermaid-source diagrams (bubble nucleation, phase, etc.)  | `DiagramSpec`         |

All tools return `list[RenderBlock]`. See `agent_core/render.py` for the
primitive shapes (`Markdown`, `Latex`, `PlotSpec`, `DiagramSpec`, `Card`,
`Table`).

## Files

- `tools.py` — tool registry + `@tool` decorator + Anthropic-format export
- `render.py` — Pydantic models for renderable output
- `events.py` — protocol-neutral event stream types
- `loop.py` — Claude tool-use loop, yields events asynchronously

## Smoke test

```bash
cd packages/agent_core
uv run python -c "from agent_core.tools import call_tool; \
print(call_tool('plot_fn', {'expression': 'gaussian'})[0].title)"
```
