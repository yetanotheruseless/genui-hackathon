# A2UI demo

> A2UI is a **declarative UI description protocol** with a fixed component
> catalog. The agent emits flat JSON like
> `{"id":"t1","component":"Text","text":{"literalString":"hi"}}`. The renderer
> picks its framework (Lit / React / Angular / Flutter) — no HTML, no script
> tags, no untrusted code crossing the wire.

## TL;DR

```
[ user ] ──POST /a2ui-stream──▶ FastAPI (a2ui_backend)
                                  │
                                  └─ agent_core.loop ──▶ Claude tool-use
                                  │
[ SSE stream of A2UI messages ] ◀ adapter (RenderBlock → flat A2UI)
   │
   ├─ {"version":"v0.9","createSurface":{"surfaceId":"tool_1",...}}
   ├─ {"version":"v0.9","updateComponents":{"surfaceId":"tool_1","components":[...]}}
   └─ ...
        │
        └─ frontend: MessageProcessor.processMessages([...])
                       │
                       └─ <a2ui-surface> Lit element mounts each surface
```

We render the *same* agent into a *fixed catalog* (Text, Card, Column, Row,
Image, Slider, Button, …) defined by `basicCatalog` in `@a2ui/lit/v0_9`.
Plots and diagrams have no primitive in v0.9, so we render them as
captioned Card+Text summaries — that's the trade-off A2UI is making.

## Quickstart (tested)

Three terminals (or use your tool of choice for managing background procs).

**Terminal 1 — Python deps + key:**

```bash
# Repo root.
export ANTHROPIC_API_KEY=sk-ant-...     # default; or OPENAI_API_KEY / GEMINI_API_KEY
export LLM_PROVIDER=anthropic           # optional: anthropic | openai | gemini
export LLM_MODEL=claude-haiku-4-5-20251001   # optional
uv sync
```

**Terminal 2 — backend (port 8766):**

```bash
# Repo root.
uv run uvicorn a2ui_backend.main:app --port 8766 --reload
```

**Terminal 3 — frontend (port 5173):**

```bash
cd apps/a2ui-demo/frontend
npm install     # first run only
npm run dev
```

Open http://localhost:5173. Hit "send" with the suggested prompt or your own.

**Smoke-test the backend without the frontend:**

```bash
curl -sN -X POST http://localhost:8766/a2ui-stream \
  -H 'content-type: application/json' \
  -d '{"message":"Plot the gaussian from -2 to 2."}' | head -10
```

You should see:
```
data: {"meta": "run_started", ...}
data: {"meta": "tool_call", ...}
data: {"version": "v0.9", "createSurface": {...}}
data: {"version": "v0.9", "updateComponents": {...}}
...
data: {"meta": "run_finished"}
```

## What's novel here

A2UI's three big bets, all of which this demo exercises:

1. **Declarative components from a fixed catalog.** The agent never emits
   HTML or JS. It emits a JSON tree of `Text`, `Card`, `Column`, `Row`, ...
   The renderer is pre-approved code — judges can audit it; the agent can't
   sneak past it.
2. **Flat adjacency-list components.** Children reference siblings by `id`
   instead of nesting. Streaming an update is a list of components rather
   than a recursive tree, which is friendlier for incremental painting and
   for LLM token efficiency.
3. **Multi-renderer.** Same wire format, different renderers per platform
   — `@a2ui/lit`, `@a2ui/react`, `@a2ui/angular`, the Flutter GenUI SDK.
   We use the Lit reference renderer; you can swap to React with a few
   lines.

## Walkthrough

### Backend adapter — [`a2ui_backend/adapter.py`](backend/a2ui_backend/adapter.py)

Translates each `agent_core.render.RenderBlock` into a list of A2UI
components in v0.9 wire format:

| RenderBlock        | A2UI components                                              |
| ------------------ | ------------------------------------------------------------ |
| `Markdown`         | `Text`                                                       |
| `Latex`            | `Text` with the LaTeX source (renderer doesn't typeset math) |
| `PlotSpec`         | `Card` → `Text` summary (n, x-range, y-range)                |
| `DiagramSpec`      | `Card` → `Text` with the Mermaid source as code              |
| `Card`             | `Card` → `Column` → `Text` per field                         |
| `Table`            | `Column` → `Text` per row                                    |

Two message types are emitted per tool result:
- `createSurface` (catalog id `basic_catalog`)
- `updateComponents` (the flat component list)

### Backend stream — [`a2ui_backend/main.py`](backend/a2ui_backend/main.py)

FastAPI `/a2ui-stream` endpoint. Drives `agent_core.loop.run` and translates
events:

- `RunStarted` / `RunFinished` → `{"meta": ...}` advisory frames
- `TextDelta` → buffered, flushed as a `Text` surface around tool calls
- `ToolCallStart` → `{"meta": "tool_call", ...}` advisory
- `ToolCallResult` → `createSurface` + `updateComponents`

### Frontend — [`src/main.ts`](frontend/src/main.ts)

About 80 lines of vanilla TS:
- One shared `MessageProcessor([basicCatalog])` from `@a2ui/web_core/v0_9`.
- Subscribes to `processor.onSurfaceCreated`; mounts a Lit
  `<a2ui-surface>` for each new surface and binds its `surface` property to
  the corresponding `SurfaceModel`.
- Splits the SSE stream by frame; passes each `data: {...}` either to the
  processor (if it's an A2UI v0.9 message) or to a small log panel (if it
  has the `meta` advisory key).

The right-hand panel shows the **raw A2UI message stream** so you can see
the wire format at the same time as the rendered surfaces.

## Cross-protocol tie-ins

- **CopilotKit's [`@copilotkit/a2ui-renderer`](https://www.npmjs.com/package/@copilotkit/a2ui-renderer)**
  drops these same v0.9 messages into a CopilotKit React app. Useful if you
  want a single AG-UI shell that *also* renders A2UI surfaces — point its
  renderer at our `/a2ui-stream` and you're done.
- The reference Lit sample agent in [`google/A2UI`](https://github.com/google/A2UI)
  uses Gemini + Google ADK by default. This demo demonstrates that the wire
  format is LLM-agnostic — Claude works just as well, and the ADK isn't
  required.

## Files

```
apps/a2ui-demo/
├── backend/
│   ├── pyproject.toml            # agent_core + a2ui-pydantic + fastapi
│   └── a2ui_backend/
│       ├── adapter.py            # RenderBlock → flat A2UI v0.9 components
│       └── main.py               # FastAPI /a2ui-stream
└── frontend/
    ├── package.json              # @a2ui/lit + @a2ui/web_core + lit + vite
    ├── index.html                # split-pane shell
    └── src/main.ts               # SSE → MessageProcessor → <a2ui-surface>
```

## Caveats

- **No chart primitive in `basicCatalog` v0.9.** Plots collapse to summary
  text. If you want live plots in A2UI, you'd add a custom `Chart`
  component to a custom catalog (the protocol supports per-server
  catalogs).
- **Spec is still moving.** v0.8 → v0.9 broke the wire format
  (`component` is now a string, properties hoisted onto the same object).
  Pin `@a2ui/web_core` and `@a2ui/lit` carefully.
- **`a2ui-pydantic` ships v0.8 wrapper-style types** (e.g.
  `{"component": {"Text": {...}}}`), which don't match the v0.9 renderer
  wire shape. We hand-roll the wire format in the adapter to stay
  compatible with `@a2ui/lit/v0_9`. Track
  [google/A2UI#issues](https://github.com/google/A2UI/issues) for the
  Python ecosystem catching up.
