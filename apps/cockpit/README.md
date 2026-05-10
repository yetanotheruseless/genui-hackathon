# cockpit · MCP Apps host shell

Custom MCP Apps host that mounts the `star-systems-demo` panes
(`cockpit.html` / `overview.html` / `target-info.html` /
`compendium.html` / `bridge.html`) in a fixed game-style layout instead
of inline-in-Goose-chat. Demonstrates the same Generative UI thesis
(agent decides what UI mounts) with a host shell purpose-built for
playable interaction.

## Architecture

```
browser (Vite :5174)
    │   WS /ws        (state diffs)
    │   POST /tool/:name  (passthrough; auto-mount slot from _meta.ui)
    │   GET  /ui?uri=...  (cached HTML resource)
    ▼
cockpit-backend (Hono :4040)
    │   one persistent MCP session shared across all browser tabs
    ▼
star-systems-demo server (HTTP :3030)
```

The backend holds **one** MCP session shared across all browser tabs;
state diffs fan out to every connected tab. The frontend is a
slot-based shell — each `_meta.ui.slot` from the server maps to a
named `<Slot>` in the layout. The five slots are
`viewport` / `overview` / `target` / `side` / `bottom`. New tools
that ship UI just declare a slot and they appear without a UI deploy.

The Mind chat is a **server-side** LLM tool (`ask_mind`) — the cockpit
backend doesn't host an agent loop; it's purely an MCP-session +
WebSocket relay. The bridge iframe is the chat UI, the server is the
chat brain.

## Layout

```
┌──────────────────────────────────────┬──────────────────────────────┐
│                                      │   target  (h-[224px])        │
│   viewport (col 1, row 1; flex)      ├──────────────────────────────┤
│   cockpit.html — 3D scene, planets,  │   side (tabbed; flex-1)      │
│   reticle, throttle controls         │   overview / compendium      │
│                                      │   (both stay mounted on tab  │
├──────────────────────────────────────┤    switch — AppBridges       │
│   bottom (h-[320px])                 │    don't tear down)          │
│   bridge.html — Mind chat            │                              │
└──────────────────────────────────────┴──────────────────────────────┘
```

Single-click on a body in viewport or overview row → target only.
Double-click → align (rotate to face, no warp). Right-click an
overview row → context menu with Target / Align / Warp. Warp is only
ever engaged via the Warp action (overview context menu, target-info
button, or the captain's `warp_to` tool call) — never as a side
effect of clicking. Warp itself is 2-phase: rotate-to-face first
(throttle = 0), then snap-track + ramp throttle. Planets are clickable
in the 3D viewport and warpable from any surface.

## Dev

```bash
# Terminal A — star-systems MCP server
cd apps/star-systems-demo/server && npm install
npm run build:panes                                                # one-time bundle
PORT=3030 npx tsx main.ts                                          # :3030

# Terminal B — cockpit backend
cd apps/cockpit/backend && npm install && npm run dev              # :4040

# Terminal C — cockpit frontend
cd apps/cockpit/frontend && npm install && npm run dev             # :5174
```

Then open <http://localhost:5174>. First load shows a Mind picker;
subsequent loads reattach via the cached `playerId` in localStorage
and bootstrap all four secondary panes sequentially.

`ANTHROPIC_API_KEY` is read from the **repo-root** `.env` by both
servers (Node 20.9 doesn't have `process.loadEnvFile` so each loads
it via an inline parser).

## Status

Playable. Race conditions and state-clobber issues from the early
scaffold are resolved (see `CLAUDE.md` "Resolved issues" for the
specific fixes). Open caveats: StrictMode still off in dev,
simulation tick is per-client (no two-tab same-`playerId`),
`tools/list` is cached on the backend so new server tools need a
backend restart.
