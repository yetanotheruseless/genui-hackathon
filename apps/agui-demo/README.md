# AG-UI demo

> AG-UI maps an agent run to a **typed event stream over SSE**. The frontend
> doesn't need a special SDK — it parses `data: {...}` lines and renders.

## TL;DR

```
[ user message ] ─POST/agent─▶ FastAPI (agui_backend)
                                  │
                                  └─ agent_core.loop ──▶ Claude tool-use
                                  │
[ SSE event stream ] ◀─────────── encoder
       │
       ├─ RUN_STARTED
       ├─ TOOL_CALL_START ─ TOOL_CALL_ARGS ─ TOOL_CALL_END
       ├─ TOOL_CALL_RESULT  { blocks: [PlotSpec, ...] }   ◀── render-block JSON
       ├─ TEXT_MESSAGE_START ─ TEXT_MESSAGE_CONTENT*N ─ TEXT_MESSAGE_END
       └─ RUN_FINISHED
```

The frontend renders the protocol-neutral render blocks (`PlotSpec`,
`DiagramSpec`, `Card`, …) inline as the agent calls each tool. A side panel
shows the **raw event stream** so judges can see the protocol in motion.

## Quickstart (tested)

Two terminals, both from the **repo root** (`genui-hackathon/`).

**Terminal 1 — backend (port 8765):**

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # default; or OPENAI_API_KEY / GEMINI_API_KEY
export LLM_PROVIDER=anthropic           # optional: anthropic | openai | gemini
export LLM_MODEL=claude-haiku-4-5-20251001   # optional
uv sync
uv run --package agui_backend uvicorn agui_backend.main:app --port 8765 --reload
```

**Terminal 2 — frontend (port 3000):**

```bash
cd apps/agui-demo/frontend
npm install        # only on first run
npm run dev
```

Then open http://localhost:3000. Click any suggested prompt or type your own.

**Smoke-test the backend without the frontend:**

```bash
curl -sN -X POST http://localhost:8765/agent \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{"threadId":"t","runId":"r","state":{},"messages":[{"id":"m","role":"user","content":"plot a gaussian"}],"tools":[],"context":[],"forwardedProps":{}}' \
  | head
```

You should see `RUN_STARTED`, then `TOOL_CALL_START/ARGS/END/RESULT`, then
text deltas, then `RUN_FINISHED`.

## What's novel here

AG-UI's design choice that pays off the most for hackathon-ish work is that
**there is no proprietary client**: the wire is plain SSE + typed JSON, and
the events are stable. We never instantiate `@ag-ui/client` in this demo —
the React app uses 30 lines of `fetch` + SSE parsing
([`src/lib/agui-client.ts`](frontend/src/lib/agui-client.ts)).

The other thing worth showing off: **render-block-as-tool-result**. AG-UI's
`TOOL_CALL_RESULT.content` is a free-form string, which we use to ship our
own JSON envelope `{"blocks": [{"kind":"plot",...}, ...]}`. The frontend
parses that and dispatches to per-kind React components. This is roughly the
"generative UI" pattern — the agent picked which tool to call, and the
frontend chose the visualisation, with no chat-template involvement.

If you want CopilotKit's higher-level UX (chat header, suggestions,
multi-turn state UI), drop `<CopilotChat>` in and point its runtime at this
backend — the protocol is the same.

## Walkthrough

### Backend bridge — ~120 lines

[`backend/agui_backend/main.py`](backend/agui_backend/main.py) is a FastAPI
endpoint that:

1. Accepts `RunAgentInput` from `ag_ui.core` (Pydantic-validated).
2. Drives `agent_core.loop.run(user_message)` (the same loop every other demo uses).
3. Translates protocol-neutral events into AG-UI events — see the big
   `isinstance` cascade in `_stream`.
4. Encodes via `EventEncoder()` (SSE by default, JSON by content-negotiation).

The translation is mechanical because both event vocabularies talk about the
same things (run lifecycle, text deltas, tool calls). The only interesting
choice is what to put in `TOOL_CALL_RESULT.content` — we serialise the full
`RenderBlock` list so the frontend has everything it needs.

### Frontend — Next.js 16 + Tailwind

- [`src/lib/types.ts`](frontend/src/lib/types.ts) mirrors `agent_core/render.py`.
- [`src/lib/agui-client.ts`](frontend/src/lib/agui-client.ts) is the SSE parser.
- [`src/components/RenderBlocks.tsx`](frontend/src/components/RenderBlocks.tsx) dispatches per-kind:
  - `plot` → recharts `LineChart` (or a hand-rolled SVG heatmap for `plot_type=heatmap`)
  - `diagram` → mermaid.js
  - `latex` → KaTeX via `react-katex`
  - `card`, `table`, `markdown` → plain Tailwind components
- [`src/app/page.tsx`](frontend/src/app/page.tsx) is the chat shell — split-pane
  with the rendered conversation on the left and the raw AG-UI event stream on the
  right. `applyEvent()` is the entire reducer; it is intentionally tiny.

### Multi-turn state

The current demo sends each user message as an independent run (the backend
re-builds history from `RunAgentInput.messages`). To wire up multi-turn
conversation across calls, accumulate assistant + tool messages on the client
and pass the full transcript in `messages` on each run. AG-UI also offers
`STATE_SNAPSHOT` / `STATE_DELTA` events for shared mutable state — useful for
"steerable agent" demos where the user can edit a plan or parameters live.

## Files

```
apps/agui-demo/
├── backend/
│   ├── pyproject.toml             # ag-ui-protocol + fastapi + agent_core
│   └── agui_backend/main.py       # ~120 lines: SSE bridge from agent_core to AG-UI
└── frontend/                      # Next.js 16 + Tailwind 4
    └── src/
        ├── lib/agui-client.ts     # 30-line SSE parser
        ├── lib/types.ts           # mirrors agent_core/render.py
        ├── components/RenderBlocks.tsx
        └── app/page.tsx           # split-pane chat + raw event stream
```
