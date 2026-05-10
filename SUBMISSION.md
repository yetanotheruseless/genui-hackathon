# Culture Contact · MCP Apps submission

> AI Tinkerers Generative UI Global Hackathon · May 2026
>
> A 1P/multiplayer starship-exploration game in which a Mind from Iain
> M. Banks's *Culture* universe drives a real spacecraft over real
> astronomical data. The playable surface is built entirely on the
> **MCP Apps** protocol extension — and pushed it places it wasn't
> originally shaped for.

---

## What you're looking at

The agent (the ship's Mind, an LLM with a curated persona) talks to you
through an iframe pane. You ask it to find a kind of star you've never
heard of; it queries a 109k-star catalog, pins its choice, plots a
warp, narrates the trip, and after arrival files a builder's notes
under the Orbital it constructed for you on the planet's L1. Three
panes — viewport / compendium / bridge — are real MCP App resources
served from one MCP server. They share state through that server and
stay in sync as the player moves through the galaxy.

The point of the hackathon was *generative* UI. We wanted to show MCP
Apps doing things it can do that other generative UI protocols (AG-UI,
A2UI, ACP) can't, and to be honest about the places we had to add
glue.

```
┌────────────────────────────────────────────────────────┐
│  cockpit host  (browser, Vite/React/shadcn :5174)      │
│  ┌──────────────────────┐  ┌─────────────────────┐    │
│  │ viewport             │  │ side                │    │
│  │  cockpit.html        │  │  compendium.html    │    │
│  │  (Three.js scene,    │  │  (manifest + chat   │    │
│  │   warp/impulse,      │  │   + orbital build,  │    │
│  │   bloom, planets)    │  │   public channel)   │    │
│  └──────────────────────┘  └─────────────────────┘    │
│  ┌─────────────────────────────────────────────────┐   │
│  │ bottom · bridge.html (chat with your Mind)       │   │
│  └─────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────┘
                          ▲
                          │  AppBridge per iframe (PostMessage)
                          ▼
        cockpit-backend  Hono + WS  :4040
                          │  persistent MCP session
                          ▼
        star-systems server  :3030  (16 MCP tools, in-memory state,
                                     109k-star catalog, LLM Mind agent)
```

---

## What we **leveraged** in MCP Apps as designed

These are uses of the protocol that are right down the middle of what
the extension is for, and that worked beautifully:

1. **Server ships its own UI.** Three iframe HTMLs are registered as
   MCP resources via `registerAppResource`. They're pre-bundled (Vite
   single-file), so a host that knows nothing about Three.js or our
   game just renders them in a sandbox. The server's
   `apps/star-systems-demo/server/` is fully self-describing — a
   different host can drop it in tomorrow and get the same surface.

2. **`_meta.ui.resourceUri` for tool→pane mounts.** When the user runs
   `start_starship`, the tool result carries `_meta.ui.resourceUri =
   "ui://stars/cockpit.html"`. The host pulls the resource and mounts
   it. No imperative "now show this UI" call — the agent's tool result
   *is* the UI mount. Same pattern for `open_compendium` /
   `open_bridge`.

3. **`AppBridge` PostMessageTransport.** Each iframe runs the MCP Apps
   client SDK and calls server tools (`get_state`, `sync_state`,
   `talk_to_mind`, etc.) via the bridge. The host doesn't see, route,
   or interpret these calls — they go straight server-side over the
   shared MCP session.

4. **Cross-host portability.** The same server runs in **Goose
   Desktop** (where the iframes mount inline in the chat) and in our
   **custom cockpit host** (where they mount into a fixed game
   layout). Zero server changes between them; the host swap is just
   swapping the runtime.

5. **No client SDK on the host side for the UI.** Our cockpit host
   knows literally nothing about stars, ships, Minds, or warp drives —
   it's a generic 3-pane shell with `<Slot name="viewport"/>` etc.
   that consumes whatever MCP App resources the agent decides to
   mount. That's the Generative UI thesis fully realized.

---

## Where we **extended** the protocol (the honest hacks)

These are spots where MCP Apps doesn't (yet) say what to do, and we
made it up. Each one is a small, isolated extension that a host can
ignore and still work; documenting them here in case any are worth
upstreaming.

### 1. `_meta.ui.slot` for fixed-layout hosts

The spec defines `_meta.ui.resourceUri` but says nothing about *where*
on screen a host should place the resource. Goose mounts everything
inline-in-chat, which is fine for utility apps but kills game feel
when you have three panes that need fixed positions.

We added a sibling field:

```typescript
_meta: { ui: { resourceUri: "ui://stars/cockpit.html", slot: "viewport" } }
```

Hosts that don't know about `slot` ignore it (Goose still mounts
inline). Our cockpit host uses it to route into a CSS grid:
`viewport` → top-left big pane, `side` → top-right, `bottom` →
full-width bottom. New tools that ship UI just declare a slot and
they appear; no host code changes.

### 2. Two-way pane-ready ↔ host-ready handshake

The spec assumes the host attaches the AppBridge transport before the
iframe's script runs, so the iframe's first `ui/initialize` lands in a
ready listener. In a Vite/React host, the iframe's bundled JS often
starts before React has finished mounting `<McpAppFrame>`, so the
initialize gets dropped and `app.connect()` hangs forever.

We added a beacon:

- Iframe sends `{ type: "mcp-app-pane-ready" }` to its parent
  every 100ms until the host responds.
- Host sends `{ type: "mcp-app-host-ready" }` once its bridge
  transport is wired.
- Iframe stops beaconing, calls `app.connect()`.
- Fallback: if no host responds in 1.5s, connect anyway (Goose-style
  hosts that attach before iframe load still work).

Both sides degrade gracefully. The MCP Apps spec could absorb this
verbatim.

### 3. Server-authoritative shared state across panes

MCP Apps doesn't really speak to "three panes that need to see the
same world." We invented a simple convention: the server keeps
`Map<gameId, Galaxy>` with `Map<playerId, Player>`, every tool takes
`{gameId, playerId}` (or auto-injects them), and panes call `get_state`
to refresh on a 700ms poll. The cockpit pushes its physics
(`position / heading / throttle`) via `sync_state` at ~5Hz; everyone
else reads it.

This made multiplayer essentially free: open a second tab, point it at
the same `gameId`, you see the other ship in your bridge log and your
compendium's "other Minds in this volume" list. Building an Orbital
shows up in everyone's compendium. Public chat works.

### 4. The Mind tool inside an MCP tool

`talk_to_mind` is a regular MCP tool from the host's perspective —
single call in, single text result out. Inside it, we run a full
Vercel AI SDK `generateText` with a bound toolset (`find_systems`,
`pin_star`, `warp_to`, `build_orbital`, `dock_orbital`, etc.) and
`maxSteps: 5`. So one tool call from the bridge iframe drives a
multi-step agent loop server-side: query the catalog, decide a target,
warp the ship, narrate the result — all within one MCP tool execution.

The host doesn't need to know it just kicked off an agent. It just
sees a tool that took 3 seconds to return text. The Mind *is* the
agent now (we removed our separate Captain pane mid-hackathon when we
realized this composition works); the chat surface is the agent
surface.

### 5. Sticky `playerId` across tab refresh + idle reaper

We persist `playerId` in the iframe's `localStorage` so a refresh
reattaches to the same server-side player. The server runs an idle
reaper (60s timeout) so closed tabs don't ghost. `start_starship`
accepts an optional `playerId` and reattaches if present. Together
this gives a passable session model on top of MCP App's stateless tool
calls.

### 6. Domain extension via `_meta.ui` carrying our `slot` + private resource scheme

`ui://stars/cockpit.html` is our own URI scheme — registered with the
server's resource handler, never resolved over HTTP. The host fetches
via the MCP `resources/read` call. This is normal MCP, but it's worth
noting: shipping iframe HTML *as resources* (rather than statically at
some web origin) lets us ship the entire game (server + UI) as one
self-contained `npm` package.

---

## What we did *not* hack

Some things you might expect to hack but didn't need to:

- **Tool calls from iframe to server** are pure MCP Apps. No custom
  routing.
- **Resource caching / loading** — the host fetches once on mount,
  iframe runs it sandboxed, that's it.
- **Capability advertisement** — every tool's `_meta.ui` is read at
  `tools/list` time and the host caches it. No special discovery.
- **No sidechannel** between the host shell and the iframe except the
  AppBridge. State flow is iframe ↔ server ↔ iframe via tool calls.

---

## What's underneath

Real data, not props:

- **109,409 stars** from the HYG v4.1 catalog, 21 of them hand-curated
  Banks-friendly entries (Sol, Vega, Sirius, Betelgeuse, Rigel, Tau
  Ceti, TRAPPIST-1, Epsilon Eridani, …).
- **6,286 known exoplanets across 4,707 systems** from the NASA
  Exoplanet Archive, joined to HYG via HIPPARCOS / HD numbers.
- **Real distances, real spectral types, real planet kinds.** Earth
  orbits at 1 AU. Proxima b is at 0.0485 AU and it's tidally locked
  and the Mind will tell you so.
- **Three.js scene** with logarithmic depth buffer (1e-7 ly near,
  5000 ly far), physical-scale star spheres, planets at min-pixel
  apparent-size clamp so Earth at 10 AU is findable, ACES tone
  mapping + UnrealBloomPass postprocessing.
- **Provider-agnostic LLM**: defaults to `claude-opus-4-7` but
  `LLM_PROVIDER=openai|gemini|anthropic` + `LLM_MODEL=...` swaps it
  out. (Includes a temperature-scrubber wrapper for Opus 4.7, which
  rejects the AI SDK's default `temperature: 0`.)

---

## Run it

```bash
git clone https://github.com/yetanotheruseless/genui-hackathon
cd genui-hackathon
echo 'ANTHROPIC_API_KEY="sk-ant-..."' > .env
(cd apps/star-systems-demo/server && npm install)
(cd apps/cockpit/backend  && npm install)
(cd apps/cockpit/frontend && npm install)

scripts/dev.sh                # tmux session "genui" with all 3 services
# open http://localhost:5174
```

Pick a Mind on the setup screen ("Frank Exchange of Views" if you want
arguments, "Fate Amenable to Change" if you want elegy), then:

- *"Find me the nearest K-dwarf with a gas giant and pin it."*
- *"Take us to Vega."*
- *"Build an Orbital here called Vavatch with notes about the
  megastructure design."*
- *"What other Minds are sharing this volume?"*

The full feature inventory and tool list is in
[`ARCHITECTURE.md`](./ARCHITECTURE.md). The user-facing tour is in
[`apps/star-systems-demo/README.md`](./apps/star-systems-demo/README.md).
The host-shell internals are in
[`apps/cockpit/README.md`](./apps/cockpit/README.md).

---

## What we'd upstream

If we were proposing additions to MCP Apps based on this experience:

1. **`_meta.ui.slot`** as a standard hint for hosts that have a fixed
   multi-pane layout. Naming `viewport / side / bottom` is too
   opinionated — `_meta.ui.layoutHint` with host-defined keys would
   be more portable.

2. **The pane-ready ↔ host-ready handshake** as a transport
   precondition. Two messages, both optional, makes Vite/React hosts
   work without races and costs nothing on hosts that already attach
   synchronously.

3. **A blessed pattern for shared state across panes.** Servers that
   want to coordinate multiple panes will reinvent gameId/playerId
   schemes; a sketch in the spec would save everyone a day.

The rest of what we did is application-level — agent loops inside
tool calls, multiplayer state, domain catalogs. Those don't need to
be in the protocol; the protocol got out of our way and let us put
them there.
