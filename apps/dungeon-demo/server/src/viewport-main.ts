/**
 * Viewport pane — the only one with Three.js + game logic + input.
 *
 * Owns local state for performance (per-frame collision shouldn't round-trip
 * to the server). Pushes a *summary* of state to the server every ~200 ms
 * via sync_state; the other panes read it. Drains controls-pane clicks
 * via dequeue_actions on the same cadence.
 */
import { CHUNK as CSZ, callTool, poll, setupPaneApp } from "./shared.js";
import {
  CHUNK,
  ensureChunk,
  freshGame,
  isWallAt,
  chunkKey,
  chunksNeedingLore,
  type Chunk,
  type Decoration,
  type GameState,
  worldToChunk,
} from "./game.js";
import { createScene, nearestDecoration } from "./render.js";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const overlay = document.getElementById("overlay") as HTMLDivElement;
const compass = document.getElementById("compass") as HTMLDivElement;
const hudTheme = document.getElementById("hud-theme") as HTMLElement;
const hudPos = document.getElementById("hud-pos") as HTMLElement;
const hudHp = document.getElementById("hud-hp") as HTMLElement;
const hudLlm = document.getElementById("hud-llm") as HTMLElement;

const pane = setupPaneApp("Dungeon Viewport");

const state: GameState = freshGame(1);
const scene = createScene(canvas);
const inflightLore = new Set<string>();
let worldId = "";
let lastSync = 0;
let lastEdge = 0;
let lastSnapshotKey = "";

pane.initial.then((init) => {
  worldId = init.worldId;
  state.seed = init.seed ?? 1;
  if (init.spawn) applyChunkLore(init.spawn);
  if (init.llm) {
    hudLlm.textContent = `${init.llm.online ? "" : "offline · "}${init.llm.provider}/${init.llm.model}`;
  }
});

function applyChunkLore(lore: any) {
  const chunk = ensureChunk(state, lore.cx, lore.cy);
  chunk.theme = lore.theme;
  chunk.narrative = lore.narrative;
  chunk.decorations = (lore.decorations || []).filter((d: Decoration) =>
    d.x > 0 && d.x < CHUNK - 1 && d.y > 0 && d.y < CHUNK - 1 && chunk.cells[d.y][d.x] === 0,
  );
  chunk.loreLoaded = true;
  inflightLore.delete(chunkKey(chunk.cx, chunk.cy));
}

async function fetchChunkLore(cx: number, cy: number) {
  if (!worldId) return;
  const key = chunkKey(cx, cy);
  if (inflightLore.has(key)) return;
  inflightLore.add(key);
  try {
    const lore = await callTool(pane.app, "explore_chunk", { worldId, cx, cy });
    if (lore) applyChunkLore(lore);
  } finally {
    inflightLore.delete(key);
  }
}

// ---- input ------------------------------------------------------------
const keys = new Set<string>();
let focused = false;
canvas.addEventListener("click", () => { focused = true; overlay.classList.add("hidden"); canvas.focus(); });
canvas.tabIndex = 0;
window.addEventListener("keydown", (e) => {
  if (!focused) return;
  keys.add(e.key.toLowerCase());
  const k = e.key.toLowerCase();
  if (["w","a","s","d","arrowleft","arrowright","arrowup","arrowdown"].includes(k)) e.preventDefault();
});
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener("blur", () => { focused = false; overlay.classList.remove("hidden"); });

// ---- action queue (drained from controls pane) -----------------------
function applyAction(kind: string) {
  if (kind === "forward")     stepBy(1, 0);
  else if (kind === "back")   stepBy(-1, 0);
  else if (kind === "turn-left")  state.player.angle += Math.PI / 6;
  else if (kind === "turn-right") state.player.angle -= Math.PI / 6;
  else if (kind === "look")     pushEvent({ kind: "look" });
  else if (kind === "listen")   pushEvent({ kind: "listen" });
  else if (kind === "rest")     { state.hp = Math.min(state.hpMax, state.hp + 2); pushEvent({ kind: "rest" }); }
  else if (kind === "interact") tryInteract();
}

function stepBy(forward: number, strafe: number) {
  const fx = Math.cos(state.player.angle) * forward + Math.cos(state.player.angle + Math.PI/2) * strafe;
  const fy = Math.sin(state.player.angle) * forward + Math.sin(state.player.angle + Math.PI/2) * strafe;
  const len = Math.hypot(fx, fy) || 1;
  const dx = (fx / len) * 0.6;
  const dy = (fy / len) * 0.6;
  if (!isWallAt(state, state.player.wx + Math.sign(dx) * 0.3, state.player.wy)) state.player.wx += dx;
  if (!isWallAt(state, state.player.wx, state.player.wy + Math.sign(dy) * 0.3)) state.player.wy += dy;
  state.steps += 1;
}

function tryInteract() {
  const near = nearestDecoration(state);
  if (!near) { pushEvent({ kind: "interact_empty" }); return; }
  if (near.deco.kind === "chest" || near.deco.kind === "book" || near.deco.kind === "crystal") {
    state.inventory.push({ id: near.id, kind: near.deco.kind, label: near.deco.label ?? near.deco.kind });
    const chunk = state.chunks.get(chunkKey(near.cx, near.cy))!;
    chunk.decorations = chunk.decorations.filter(d => !(d.x === near.deco.x && d.y === near.deco.y));
    const m = scene.decoMeshes.get(near.id);
    if (m) { m.parent?.remove(m); scene.decoMeshes.delete(near.id); }
    pushEvent({ kind: "pick_up", target: near.deco.kind, label: near.deco.label });
  } else {
    pushEvent({ kind: "interact", target: near.deco.kind, label: near.deco.label });
  }
}

// ---- narration triggers ----------------------------------------------
const narrationQueue: any[] = [];
function pushEvent(ev: any) { narrationQueue.push(ev); }

async function flushNarration() {
  if (!worldId || narrationQueue.length === 0) return;
  const events = narrationQueue.splice(0, narrationQueue.length);
  await callTool(pane.app, "narrate", { worldId, events });
}

// ---- main loop --------------------------------------------------------
let last = performance.now();
const trackedChunk = { cx: 0, cy: 0 };

function tick() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (focused) {
    const turnSpeed = 2.4, moveSpeed = 2.5;
    if (keys.has("arrowleft")) state.player.angle += turnSpeed * dt;
    if (keys.has("arrowright")) state.player.angle -= turnSpeed * dt;
    let vx = 0, vy = 0;
    if (keys.has("w")) { vx += Math.cos(state.player.angle); vy += Math.sin(state.player.angle); }
    if (keys.has("s")) { vx -= Math.cos(state.player.angle); vy -= Math.sin(state.player.angle); }
    if (keys.has("a")) { vx += Math.cos(state.player.angle + Math.PI/2); vy += Math.sin(state.player.angle + Math.PI/2); }
    if (keys.has("d")) { vx -= Math.cos(state.player.angle + Math.PI/2); vy -= Math.sin(state.player.angle + Math.PI/2); }
    if (vx || vy) {
      const len = Math.hypot(vx, vy) || 1;
      vx = (vx / len) * moveSpeed * dt;
      vy = (vy / len) * moveSpeed * dt;
      const radius = 0.25;
      if (!isWallAt(state, state.player.wx + Math.sign(vx) * radius, state.player.wy)) state.player.wx += vx;
      if (!isWallAt(state, state.player.wx, state.player.wy + Math.sign(vy) * radius)) state.player.wy += vy;
      state.steps += 1;
    }
  }

  // Detect chunk crossing.
  const here = worldToChunk(state.player.wx, state.player.wy);
  if (here.cx !== trackedChunk.cx || here.cy !== trackedChunk.cy) {
    trackedChunk.cx = here.cx;
    trackedChunk.cy = here.cy;
    const chunk = state.chunks.get(chunkKey(here.cx, here.cy));
    pushEvent({ kind: "enter_chunk", cx: here.cx, cy: here.cy, theme: chunk?.theme });
  }

  scene.render(state);
  updateCompass();
  updateHud();
  requestAnimationFrame(tick);
}

function updateCompass() {
  const a = state.player.angle;
  const headings = [
    { label: "E →", a: 0 },
    { label: "N ↑", a: Math.PI / 2 },
    { label: "W ←", a: Math.PI },
    { label: "S ↓", a: -Math.PI / 2 },
  ];
  let best = headings[0], bestDelta = Infinity;
  for (const h of headings) {
    let d = a - h.a; while (d > Math.PI) d -= 2*Math.PI; while (d < -Math.PI) d += 2*Math.PI;
    if (Math.abs(d) < bestDelta) { bestDelta = Math.abs(d); best = h; }
  }
  compass.textContent = best.label;
}

function updateHud() {
  const here = worldToChunk(state.player.wx, state.player.wy);
  const cur = state.chunks.get(chunkKey(here.cx, here.cy));
  hudTheme.textContent = cur?.theme ?? (cur?.loreLoaded ? "—" : "(loading...)");
  hudPos.textContent = `chunk (${here.cx},${here.cy}) cell (${Math.floor(here.lx)},${Math.floor(here.ly)})`;
  hudHp.textContent = `${state.hp}/${state.hpMax}`;
}

// ---- server polling: sync state, drain actions, fetch lore -----------
async function syncTick() {
  if (!worldId) return;
  // dequeue actions from controls pane
  const drained = await callTool<{ actions: { kind: string }[] }>(pane.app, "dequeue_actions", { worldId });
  if (drained?.actions) for (const a of drained.actions) applyAction(a.kind);

  // push our state
  const here = worldToChunk(state.player.wx, state.player.wy);
  const cur = state.chunks.get(chunkKey(here.cx, here.cy));
  const near = nearestDecoration(state, 1.5);
  await callTool(pane.app, "sync_state", {
    worldId,
    state: {
      player: { wx: state.player.wx, wy: state.player.wy, angle: state.player.angle },
      hp: state.hp,
      steps: state.steps,
      currentChunk: { cx: here.cx, cy: here.cy, theme: cur?.theme },
      inventory: state.inventory,
      nearbyDecoration: near ? { kind: near.deco.kind, label: near.deco.label } : null,
    },
  });

  // chunk lore fetches
  const candidates = chunksNeedingLore(state);
  for (const c of candidates) {
    ensureChunk(state, c.cx, c.cy);
    void fetchChunkLore(c.cx, c.cy);
  }

  // narration flushing
  await flushNarration();
}

window.addEventListener("resize", scene.resize);
scene.resize();
poll(200, syncTick);
requestAnimationFrame(tick);
