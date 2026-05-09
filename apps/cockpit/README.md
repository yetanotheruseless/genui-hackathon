# cockpit · MCP Apps host shell

Custom MCP Apps host that mounts the `star-systems-demo` iframes
(`cockpit.html` / `compendium.html` / `bridge.html`) in a fixed game-style
layout instead of inline-in-Goose-chat. Demonstrates the same Generative UI
thesis (agent decides what UI mounts) with a host shell purpose-built for
playable interaction.

## Architecture

```
browser (Vite :5174)
    │   WS /ws (state push, captain stream)
    │   POST /tool/:name (passthrough)
    │   GET  /ui/:uri    (cached HTML resource)
    ▼
cockpit-backend (Hono :4040)
    │   one persistent MCP session
    ▼
star-systems-demo server (HTTP :3030)
```

The backend holds **one** MCP session shared across all browser tabs;
state diffs fan out to every connected tab. The frontend is a slot-based
shell — each `_meta.ui.slot` from the server (`viewport` / `side` /
`bottom`) maps to a named `<Slot>` in the layout. New tools that ship UI
just declare a slot and they appear without a UI deploy.

## Dev

```bash
# Terminal A — star-systems MCP server
cd apps/star-systems-demo/server && npm install && npm start    # :3030

# Terminal B — cockpit backend
cd apps/cockpit/backend && npm install && npm run dev           # :4040

# Terminal C — cockpit frontend
cd apps/cockpit/frontend && npm install && npm run dev          # :5174
```

Then open <http://localhost:5174>.

## Status

Scaffold only — see tasks #1–#10 on the `feat/cockpit` branch.
