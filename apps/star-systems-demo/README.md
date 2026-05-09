# Culture Contact demo · Goose desktop + MCP Apps + LLM Mind

> A reskin of the star-systems demo into Iain M. Banks's **Culture**
> universe. You command a Contact-section vessel — a GCU/LSV/ROU/GOU —
> with a real Mind aboard. Real astronomical data; LLM-narrated
> observations in the Mind's voice; a chat console for ongoing dialogue
> with the ship; multiplayer-ready shared galaxy state with Orbital
> construction and a public Contact channel.

## TL;DR

```
Goose desktop chat
    │
    ├── start_starship({gameId?, mind_id?}) ─▶ allocates player; mounts cockpit iframe
    ├── open_compendium({gameId, playerId})  ─▶ mounts compendium iframe
    └── open_bridge({gameId, playerId})      ─▶ mounts chat-with-Mind iframe

Galaxy state (shared, by gameId)               Player state (private, by playerId)
  ├── orbitals (built by any player)            ├── ship: {name, class}
  ├── publicChat (galaxy-wide channel)          ├── mind: {persona, voice}
  ├── players: Map<playerId, Player>            ├── position / heading / throttle
  └── events                                    ├── log: Mind narrations + chat
                                                └── compendium

       cockpit  ◀ sync_state ─▶  galaxy/player  ◀── compendium / bridge poll get_state
       cockpit  ──warp_to──▶ targetId ──auto-steers──▶ observe(starId) ──▶ Mind narrates

       bridge  ──talk_to_mind(message)──▶  Mind sees full ship+galaxy context  ──▶ reply

       compendium  ──build_orbital(name, parent_star?)──▶ shared.orbitals  (visible to all)
       compendium  ──send_public(message)─────────────▶ shared.publicChat  (visible to all)
```

The Mind is your **persistent companion**. Every time you talk to it, the
server prompts it with the live ship state (position, throttle, target,
recent observations, compendium counts, nearby Culture vessels in the
volume, orbitals built so far) plus the last ~10 turns of conversation.
It stays in character.

The state model is **multiplayer-ready**. Two `start_starship` calls with
the same `gameId` join the same galaxy. They see each other's ships and
orbitals; either can broadcast on the public channel.

## Quickstart (tested)

### Build + run the server

```bash
# All commands assume the server directory:
cd apps/star-systems-demo/server          # NOTE: not the repo root

npm install                                # first run only
npm run build                              # builds dist/{cockpit,compendium,bridge}.html

ANTHROPIC_API_KEY=sk-ant-... PORT=3030 npm start            # HTTP for basic-host
ANTHROPIC_API_KEY=sk-ant-... npm run start:stdio            # stdio for Goose desktop
```

If you'd rather drive everything from the repo root, swap `npm start` for
`npm --prefix apps/star-systems-demo/server start`.

### Smoke-test (no host needed)

Two-step flow because every action is scoped by **{gameId, playerId}**.
First call returns those ids; subsequent calls take both. Run all of this
in the same shell so `$GID` / `$PID` survive between steps.

```bash
# 1. Spawn a vessel in galaxy "demo-public" with the Mind 'So Much For Subtlety'.
curl -s -X POST http://localhost:3030/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"start_starship","arguments":{"seed":3,"gameId":"demo-public","mind_id":"smfs"}}}' \
  > /tmp/init.txt

GID=$(python3 -c "import json; d=json.loads(open('/tmp/init.txt').read().split('data: ',1)[1]); print(json.loads(d['result']['content'][0]['text'])['gameId'])")
PID=$(python3 -c "import json; d=json.loads(open('/tmp/init.txt').read().split('data: ',1)[1]); print(json.loads(d['result']['content'][0]['text'])['playerId'])")
echo "gameId=$GID  playerId=$PID"

# 2. Observe Betelgeuse — Mind narrates real facts + a Contact-style hook.
cat > /tmp/observe.json <<EOF
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"observe","arguments":{"gameId":"$GID","playerId":"$PID","objectId":"betelgeuse"}}}
EOF
curl -sN -X POST http://localhost:3030/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data-binary @/tmp/observe.json

# 3. Talk to the Mind in free-form chat.
cat > /tmp/talk.json <<EOF
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"talk_to_mind","arguments":{"gameId":"$GID","playerId":"$PID","message":"What do you think about us building an Orbital around Betelgeuse?"}}}
EOF
curl -sN -X POST http://localhost:3030/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data-binary @/tmp/talk.json
```

> **Heads-up — argument shape changed.** The original star-systems demo
> took `worldId` on every tool. The Culture-themed version splits state
> into a shared galaxy (`gameId`) and per-player session (`playerId`).
> Both are required on every action tool. If you see
> `"received": "undefined", "path": ["gameId"]` you're running an old
> snippet — re-fetch ids via `start_starship` first.

### Two ships in the same galaxy

```bash
# Player B joins the same galaxy with a different Mind.
curl -s -X POST http://localhost:3030/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"start_starship","arguments":{"seed":99,"gameId":"demo-public","mind_id":"feov"}}}'

# See both ships in the galaxy.
curl -sN -X POST http://localhost:3030/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"list_players","arguments":{"gameId":"demo-public"}}}'
```

**Goose desktop config** (`~/.config/goose/config.yaml`):

```yaml
extensions:
  contact:
    enabled: true
    type: stdio
    name: contact
    description: "Culture Contact-section vessel; LLM-narrated stars + chat-with-Mind."
    cmd: npx
    args: ["tsx", "/abs/path/to/genui-hackathon/apps/star-systems-demo/server/main.ts", "--stdio"]
    envs:
      ANTHROPIC_API_KEY: "sk-ant-..."
      LLM_PROVIDER: "anthropic"
      LLM_MODEL: "claude-haiku-4-5-20251001"
```

In Goose: `"Spawn a Culture vessel with the Mind 'Frank Exchange of Views' joined to game 'demo-public'. Then open the compendium and bridge panes."`

## Available Minds

(Run `list_minds` for the live list.)

| id            | class | name                                              | tagline |
| ------------- | ----- | ------------------------------------------------- | ------- |
| `ocisly`      | GCU   | Of Course I Still Love You                        | veteran Contact Mind, ~860 years old |
| `smfs`        | GCU   | So Much For Subtlety                              | dry, terse; thinks nine moves ahead |
| `feov`        | ROU   | Frank Exchange Of Views                           | argumentative; loves a rhetorical knot |
| `jrti`        | GCU   | Just Read The Instructions                        | literal, deadpan, secretly poetic |
| `fatc`        | LSV   | Fate Amenable To Change                           | wistful, philosophical, fatalistic |
| `mnj`         | GOU   | Mistake Not My Current State Of Joviality For…    | melancholic warship Mind in semi-retirement |
| `ywiriwysi`   | GCU   | You Will Recognise It When You See It             | cryptic, mystical-sounding; pickled in deep field work |

Pick one at spawn via `mind_id`, or omit to seed-pick deterministically.

## Multiplayer

The default-on-omit `start_starship` makes a **new private galaxy** with a
random `gameId`. To play multiplayer:

1. Player 1 spawns with `gameId: "shared-1"` (or any name).
2. Player 2 spawns with the same `gameId`. They appear in each other's
   "nearby" lists and `list_players` results.
3. Either can `build_orbital` — the result is visible to both.
4. Either can `send_public` — both see the message in their compendium
   pane's "Public Contact channel" section.

Verified in this repo: two sequential `start_starship` calls with
`gameId: "demo-public"` end up in the same galaxy; `list_players` returns
both ships.

The chat with each Mind remains private (per-player), but each Mind sees
the *galaxy summary* in its context — so your Mind can casually mention
"the GCU Just Read The Instructions has just dropped out of warp three
ly off our starboard" if it wants to.

## What's novel here

Compared to the original star-systems demo:

1. **Persona system + chat history.** Each Mind has a curated persona
   (`culture.ts`); every `talk_to_mind` and `observe` call composes
   `mindSystemPrompt(persona)` + a live `mindContextBlock(...)` rendering
   of ship + galaxy state. The Mind genuinely knows where you are and
   what you've seen, and stays in character.
2. **State scoped for multiplayer from day one.** The split into
   `Galaxy` (gameId) and `Player` (playerId) means scaling to 2-N
   players is configuration, not code. Tools take both ids; you can join
   any existing gameId by passing it.
3. **Shared writes from the compendium pane.** Building Orbitals and
   sending public messages are first-class actions in a sandboxed
   iframe, not "agent-only" tools — the user does these directly via UI.
4. **`generateText` for chat, `generateObject` for structured
   narration.** The Vercel AI SDK lets the same provider switcher serve
   both call shapes through one `getModel()` helper.

## Files

```
apps/star-systems-demo/server/
├── package.json                  # ai SDK + ext-apps + three + zod
├── astrodata.ts                  # 21 real stars (Sol → Rigel)
├── culture.ts                    # 7 Mind personas + ship class info
├── llm.ts                        # provider-agnostic getModel + generateTyped
├── server.ts                     # 12 MCP tools
├── main.ts                       # HTTP / stdio transports
├── cockpit.html                  # 3D viewport + throttle + HUD
├── compendium.html               # discoveries + orbitals + others + public chat
├── bridge.html                   # chat with the Mind
└── src/
    ├── shared.ts                 # MCP App bridge + polling helper
    ├── cockpit-main.ts           # Three.js + warp/impulse + auto-observe + render orbitals + render other ships
    ├── compendium-main.ts        # poll get_state, render counts/orbitals/others/chat; build_orbital + send_public
    └── bridge-main.ts            # chat input + scroll log + poll get_state
```

## Tools

| Tool                | Caller          | Purpose                                                            |
| ------------------- | --------------- | ------------------------------------------------------------------ |
| `start_starship`    | host            | Allocate player in galaxy (creates one if needed); mount cockpit  |
| `open_compendium`   | host            | Mount compendium iframe                                            |
| `open_bridge`       | host            | Mount bridge iframe                                                |
| `sync_state`        | cockpit         | Push position / throttle / target                                  |
| `get_state`         | all panes       | Pull player state + galaxy summary                                 |
| `observe`           | cockpit / agent | LLM Mind narrates a star (real facts + Contact hook); updates compendium |
| `warp_to`           | cockpit / agent | Engage warp toward a target                                        |
| `talk_to_mind`      | bridge / agent  | Free-form chat with the Mind, full live context                    |
| `build_orbital`     | compendium / agent | Build a Culture Orbital (shared galaxy state)                   |
| `list_players`      | compendium / agent | Other ships in the galaxy                                       |
| `send_public`       | compendium / agent | Galaxy-wide broadcast                                           |
| `list_objects`      | agent           | Star catalog                                                       |
| `list_minds`        | agent           | Available Mind personalities                                       |

## Caveats

- **`tsx watch` resets in-memory state.** During development the server
  reloads on code changes, which clears the `galaxies` Map. In
  production / Goose-desktop deployment, the server runs once and state
  persists for the lifetime of the process.
- **Schema-validation throws.** `generateObject` enforces the Zod
  schema. If a model produces a longer paragraph than the cap, the call
  throws and the iframe shows an error banner. The caps are generous;
  bump them in `server.ts` if you keep hitting them on a particular
  model. The whole thing is fail-fast — there's no canned-content
  fallback that could mask a misconfiguration.
- **The Mind's context window grows with conversation.** We pass the last
  ~10 chat turns each call. For long sessions, consider summarising
  older turns or adding `cache_control` headers to the system prompt.
- **No persistence across server restarts.** State lives in memory. Add
  Postgres / sqlite / Redis if you want save-files or durable
  multiplayer.
