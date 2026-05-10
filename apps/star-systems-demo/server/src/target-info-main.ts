/**
 * Target info pane — small upper-right card showing rich details about
 * the locked target (star spectral type / planet kind+mass+radius /
 * orbital builder+description). Reads ship.targetId from get_state and
 * resolves it against the curated stars catalog (from init) and the
 * live galaxy.orbitals (from get_state).
 *
 * Position-tracking the planet's orbital phase isn't reproduced here
 * — for a small info card we only need the distance approximation
 * (planets sit within tens of AU of their parent star, dwarfed by
 * interstellar distances), which we compute from the parent's position.
 */
import { callTool, poll, setupPaneApp } from "./shared.js";

const LY_PER_AU = 1 / 63241.077;

type PlanetLite = {
  name: string;
  kind: string;
  orbitAU?: number;
  massEarths?: number;
  radiusEarths?: number;
};
type StarLite = {
  id: string;
  name: string;
  position: [number, number, number];
  spectralClass: string;
  spectralType: string;
  lumClass: string;
  planets: PlanetLite[];
};
type OrbitalLite = {
  id: string;
  name: string;
  builderShipName: string;
  position: [number, number, number];
  description?: string;
  dockedPlayerIds?: string[];
};

const emptyEl = document.getElementById("empty-state") as HTMLDivElement;
const contentEl = document.getElementById("content") as HTMLDivElement;
const nameEl = document.getElementById("t-name") as HTMLDivElement;
const statusEl = document.getElementById("t-status") as HTMLDivElement;
const pillsEl = document.getElementById("t-pills") as HTMLDivElement;
const descEl = document.getElementById("t-desc") as HTMLDivElement;
const btnAlign = document.getElementById("btn-align") as HTMLButtonElement;
const btnWarp  = document.getElementById("btn-warp") as HTMLButtonElement;
const btnStop  = document.getElementById("btn-stop") as HTMLButtonElement;

const pane = setupPaneApp("Culture Target");
let gameId = "";
let playerId = "";
let stars: StarLite[] = [];
let playerPos: [number, number, number] = [0, 0, 0];
let orbitals: OrbitalLite[] = [];
let targetId: string | null = null;
let warpEngaged = false;
let lastKey = "";

pane.initial.then((init) => {
  const data = init as unknown as { gameId: string; playerId: string; stars?: StarLite[] };
  gameId = data.gameId;
  playerId = data.playerId;
  stars = data.stars ?? [];
});

poll(700, async () => {
  if (!gameId || !playerId) return;
  const state = await callTool<{
    position?: [number, number, number];
    targetId?: string | null;
    warpEngaged?: boolean;
    galaxy?: { orbitals?: OrbitalLite[] };
  }>(pane.app, "get_state", { gameId, playerId });
  if (!state) return;
  if (state.position) playerPos = state.position;
  if (state.galaxy?.orbitals) orbitals = state.galaxy.orbitals;
  targetId = state.targetId ?? null;
  warpEngaged = !!state.warpEngaged;
  render();
});

// One pill = icon + value + tooltip on the icon for the full label.
type Pill = { icon: string; value: string; tip: string };

function render() {
  if (!targetId) {
    if (contentEl.style.display !== "none") contentEl.style.display = "none";
    if (emptyEl.style.display === "none") emptyEl.style.display = "";
    lastKey = "";
    return;
  }
  if (emptyEl.style.display !== "none") emptyEl.style.display = "none";
  if (contentEl.style.display === "none") contentEl.style.display = "";

  // Resolve target → kind-specific info + pill list.
  let kind: "star" | "planet" | "orbital" | null = null;
  let name = "?";
  let pos: [number, number, number] | null = null;
  let canWarp = false;
  const pills: Pill[] = [];
  let desc = "";

  if (targetId.startsWith("orbital:")) {
    const oid = targetId.slice("orbital:".length);
    const o = orbitals.find((x) => x.id === oid);
    if (o) {
      kind = "orbital";
      name = o.name;
      pos = o.position;
      canWarp = true;
      pills.push({ icon: "⊙", value: "orbital", tip: "Type" });
      pills.push({ icon: "⚒", value: o.builderShipName, tip: "Built by" });
      const docked = o.dockedPlayerIds?.length ?? 0;
      if (docked > 0) pills.push({ icon: "👥", value: String(docked), tip: "Aboard" });
      desc = o.description ?? "";
    }
  } else if (targetId.startsWith("planet:")) {
    const rest = targetId.slice("planet:".length);
    const sep = rest.indexOf("::");
    if (sep >= 0) {
      const starId = rest.slice(0, sep);
      const planetName = rest.slice(sep + 2);
      const s = stars.find((x) => x.id === starId);
      const p = s?.planets?.find((pp) => pp.name === planetName);
      if (s && p) {
        kind = "planet";
        name = p.name;
        pos = s.position;
        canWarp = true;         // server.warp_to forwards "planet:..." ids; cockpit steers
        pills.push({ icon: "◯", value: p.kind.replace(/_/g, " "), tip: "Kind" });
        pills.push({ icon: "↺", value: s.name, tip: "Orbits" });
        if (p.orbitAU != null) pills.push({ icon: "⌒", value: `${p.orbitAU.toFixed(2)} AU`, tip: "Orbital distance" });
        if (p.radiusEarths != null) pills.push({ icon: "⌀", value: `${p.radiusEarths.toFixed(2)} R⊕`, tip: "Radius (Earth radii)" });
        if (p.massEarths != null) pills.push({ icon: "⚖", value: `${p.massEarths.toFixed(2)} M⊕`, tip: "Mass (Earth masses)" });
      }
    }
  } else {
    const s = stars.find((x) => x.id === targetId);
    if (s) {
      kind = "star";
      name = s.name;
      pos = s.position;
      canWarp = true;
      pills.push({ icon: "✦", value: s.spectralType, tip: "Spectral class" });
    }
  }

  if (!kind || !pos) {
    nameEl.textContent = "?";
    nameEl.className = "name";
    pillsEl.innerHTML = `<span class="pill"><i class="icon">?</i>${escapeHtml(targetId)}</span>`;
    descEl.style.display = "none";
    btnWarp.disabled = true;
    btnAlign.disabled = true;
    return;
  }

  // Distance always last in the pill list.
  const d = distLy(pos);
  pills.push({ icon: "↔", value: formatDistance(d), tip: "Distance from ship" });

  // Cache key — only rewrite the DOM on actual change. Status badge
  // toggles independently below, no need to put it in the key.
  const key = `${targetId}|${kind}|${pills.map((p) => `${p.icon}${p.value}`).join("|")}`;
  const wantStatus = warpEngaged;
  if (key === lastKey) {
    btnWarp.disabled = !canWarp;
    btnStop.disabled = !warpEngaged;
    statusEl.classList.toggle("hidden", !wantStatus);
    return;
  }
  lastKey = key;

  nameEl.textContent = name;
  nameEl.className = `name kind-${kind}`;
  statusEl.classList.toggle("hidden", !wantStatus);
  pillsEl.innerHTML = pills.map((p) =>
    `<span class="pill" data-tip="${escapeHtml(p.tip)}">`
    + `<i class="icon">${p.icon}</i>${escapeHtml(p.value)}</span>`,
  ).join("");
  if (desc.trim()) {
    descEl.textContent = desc;
    descEl.style.display = "";
  } else {
    descEl.style.display = "none";
  }
  btnWarp.disabled = !canWarp;
  btnAlign.disabled = false;
  btnStop.disabled = !warpEngaged;
}

// --- Action buttons ------------------------------------------------------

btnWarp.addEventListener("click", async () => {
  if (!targetId) return;
  try {
    if (targetId.startsWith("orbital:")) {
      await callTool(pane.app, "warp_to_orbital", {
        gameId, playerId, orbitalId: targetId.slice("orbital:".length),
      });
    } else {
      // Star id OR "planet:starId::name" — server's warp_to handles
      // both (planet ids are passed through; cockpit resolves the
      // live orbital position).
      await callTool(pane.app, "warp_to", { gameId, playerId, objectId: targetId });
    }
  } catch (e) {
    console.warn("[target-info] warp failed:", e);
  }
});

btnAlign.addEventListener("click", async () => {
  if (!targetId) return;
  try {
    // face_target sets a server-side faceRequestTs that the cockpit
    // polls; on each new ts, it lerps the camera to face the target
    // without engaging warp.
    await callTool(pane.app, "face_target", { gameId, playerId });
  } catch (e) {
    console.warn("[target-info] face_target failed:", e);
  }
});

btnStop.addEventListener("click", async () => {
  try {
    await callTool(pane.app, "stop_engines", { gameId, playerId });
  } catch (e) {
    console.warn("[target-info] stop_engines failed:", e);
  }
});

function distLy(p: [number, number, number]): number {
  const dx = p[0] - playerPos[0];
  const dy = p[1] - playerPos[1];
  const dz = p[2] - playerPos[2];
  return Math.hypot(dx, dy, dz);
}

function formatDistance(ly: number): string {
  if (ly >= 0.1) return `${ly.toFixed(2)} ly`;
  if (ly >= 0.01) return `${ly.toFixed(3)} ly`;
  const au = ly / LY_PER_AU;
  if (au >= 100) return `${au.toFixed(0)} AU`;
  if (au >= 10) return `${au.toFixed(1)} AU`;
  if (au >= 0.1) return `${au.toFixed(2)} AU`;
  const lm = ly * 525949.2;
  return `${lm.toFixed(1)} l-min`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!
  ));
}
