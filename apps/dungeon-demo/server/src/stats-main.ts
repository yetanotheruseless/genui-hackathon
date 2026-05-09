/**
 * Stats + inventory pane — pulls full state every 0.5 s and re-renders.
 */
import { callTool, poll, setupPaneApp, type WorldStateView } from "./shared.js";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const status = $("status");
const elHp = $("stat-hp");
const elBar = $("hp-bar-fill");
const elSteps = $("stat-steps");
const elPos = $("stat-pos");
const elTheme = $("stat-theme");
const elChunks = $("stat-chunks");
const elInv = $("inv-list");
const elNearby = $("nearby-list");

const pane = setupPaneApp("Dungeon Stats");
let worldId = "";

pane.worldId.then((id) => { worldId = id; status.textContent = `world ${id.slice(0, 8)}…`; });

poll(500, async () => {
  if (!worldId) return;
  const s = await callTool<{ kind: string } & WorldStateView>(pane.app, "get_state", { worldId });
  if (!s) return;
  elHp.textContent = `${s.hp} / ${s.hpMax}`;
  elBar.style.width = `${Math.max(0, Math.min(100, (s.hp / s.hpMax) * 100))}%`;
  elSteps.textContent = String(s.steps);
  elPos.textContent = `chunk (${s.currentChunk.cx},${s.currentChunk.cy})`;
  elTheme.textContent = s.currentChunk.theme ?? "(loading…)";
  elChunks.textContent = String(s.loadedChunkCount);

  if (s.inventory.length === 0) {
    elInv.innerHTML = '<li class="empty">— empty —</li>';
  } else {
    elInv.innerHTML = "";
    for (const it of s.inventory) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="kind">${it.kind}</span> · ${it.label}`;
      elInv.appendChild(li);
    }
  }

  if (!s.nearbyDecoration) {
    elNearby.innerHTML = '<li class="empty">—</li>';
  } else {
    elNearby.innerHTML = "";
    const li = document.createElement("li");
    li.innerHTML = `<span class="kind">${s.nearbyDecoration.kind}</span>${s.nearbyDecoration.label ? " · " + s.nearbyDecoration.label : ""}`;
    elNearby.appendChild(li);
  }
});
