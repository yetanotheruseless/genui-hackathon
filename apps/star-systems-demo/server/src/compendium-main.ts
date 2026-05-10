/**
 * Compendium pane — the player's catalog AND the shared galaxy view.
 *
 * Per-player: discoveries, spectral counts, planet counts.
 * Shared:     orbitals, other ships, public Contact channel.
 *
 * Also has small action affordances:
 *   - "build here" creates an Orbital at the player's current position
 *   - public chat input broadcasts on the galaxy-wide channel
 */
import { callTool, poll, setupPaneApp } from "./shared.js";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const shipNameEl = $("ship-name");
const status = $("game-status");
const spectralList = $("spectral-list") as HTMLDListElement;
const planetList = $("planet-list") as HTMLDListElement;
const discList = $("disc") as HTMLUListElement;
const orbitalsList = $("orbitals") as HTMLUListElement;
const othersList = $("others") as HTMLUListElement;
const chatList = $("chat") as HTMLUListElement;
const orbitalNameInput = $("orbital-name") as HTMLInputElement;
const orbitalDescInput = $("orbital-description") as HTMLTextAreaElement;
const buildBtn = $("build-btn") as HTMLButtonElement;
const publicInput = $("public-input") as HTMLInputElement;
const publicBtn = $("public-btn") as HTMLButtonElement;

// Collapsible "Stellar bodies / Planet types" header. Hidden state
// persisted per-browser so the player's preferred layout sticks across
// reloads — these counters are useful at session start, less so once
// the Discovered Systems / Orbitals lists have grown long.
{
  const toggle = $("counts-toggle");
  const section = $("counts-section");
  const STORAGE_KEY = "compendium.countsCollapsed";
  const apply = (collapsed: boolean) => {
    toggle.classList.toggle("collapsed", collapsed);
    section.classList.toggle("collapsed", collapsed);
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  };
  apply(localStorage.getItem(STORAGE_KEY) === "1");
  const flip = () => {
    const next = !toggle.classList.contains("collapsed");
    localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    apply(next);
  };
  toggle.addEventListener("click", flip);
  toggle.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") { e.preventDefault(); flip(); }
  });
}

// Last-known docked orbital id from get_state polling. Drives the
// per-row "leave" button + the "docked" highlight class.
let dockedOrbitalId: string | null = null;

const SPECTRAL_LABELS: Record<string, string> = {
  o_dwarf: "O dwarfs", b_dwarf: "B-type", a_dwarf: "A main-seq",
  f_dwarf: "F main-seq", g_dwarf: "G dwarfs", k_dwarf: "K dwarfs",
  m_dwarf: "M dwarfs", l_dwarf: "L brown dwarfs", t_dwarf: "T brown dwarfs",
  white_dwarf: "white dwarfs", neutron_star: "neutron stars",
  giant: "giants", red_supergiant: "red supergiants", blue_supergiant: "blue supergiants",
};
const SPECTRAL_ORDER = [
  "blue_supergiant", "red_supergiant", "giant",
  "o_dwarf", "b_dwarf", "a_dwarf", "f_dwarf", "g_dwarf", "k_dwarf", "m_dwarf",
  "l_dwarf", "t_dwarf", "white_dwarf", "neutron_star",
];
const PLANET_LABELS: Record<string, string> = {
  terrestrial: "terrestrial", super_earth: "super-Earth",
  neptune_like: "Neptune-like", ice_giant: "ice giants",
  gas_giant: "gas giants", hot_jupiter: "hot Jupiters",
  super_jupiter: "super-Jupiters",
};
const PLANET_ORDER = ["terrestrial", "super_earth", "neptune_like", "ice_giant", "gas_giant", "hot_jupiter", "super_jupiter"];

const pane = setupPaneApp("Culture Compendium");
let gameId = "";
let playerId = "";

pane.initial.then((init) => {
  gameId = init.gameId;
  playerId = init.playerId;
  if (init.ship) shipNameEl.textContent = init.ship.name;
  status.textContent = `game ${init.gameId.slice(0, 8)}…`;
  buildBtn.disabled = false;
  publicBtn.disabled = false;
});

buildBtn.addEventListener("click", async () => {
  if (!gameId || !playerId) return;
  const name = orbitalNameInput.value.trim();
  if (!name) { orbitalNameInput.focus(); return; }
  const description = orbitalDescInput.value.trim();
  buildBtn.disabled = true;
  try {
    await callTool(pane.app, "build_orbital", { gameId, playerId, name, description });
    orbitalNameInput.value = "";
    orbitalDescInput.value = "";
  } finally {
    buildBtn.disabled = false;
  }
});

// Delegated click handler for orbital row actions (warp / leave). Each
// button carries its orbitalId in data-orbital-id and its action in
// data-action, so we don't have to bind per-row listeners and the
// list can be rebuilt every poll without losing handlers.
orbitalsList.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  const btn = t.closest("button[data-action]") as HTMLButtonElement | null;
  if (!btn || !gameId || !playerId) return;
  const orbitalId = btn.dataset.orbitalId;
  if (!orbitalId) return;
  const action = btn.dataset.action;
  btn.disabled = true;
  try {
    if (action === "warp") {
      await callTool(pane.app, "warp_to_orbital", { gameId, playerId, orbitalId });
    } else if (action === "leave") {
      await callTool(pane.app, "undock_orbital", { gameId, playerId });
    }
  } finally {
    // Re-enable on next render (poll runs at 700ms, so this is short).
    setTimeout(() => { btn.disabled = false; }, 600);
  }
});

publicBtn.addEventListener("click", async () => {
  if (!gameId || !playerId) return;
  const message = publicInput.value.trim();
  if (!message) return;
  publicBtn.disabled = true;
  try {
    await callTool(pane.app, "send_public", { gameId, playerId, message });
    publicInput.value = "";
  } finally {
    publicBtn.disabled = false;
  }
});

poll(700, async () => {
  if (!gameId || !playerId) return;
  const s = await callTool<any>(pane.app, "get_state", { gameId, playerId });
  if (!s?.compendium) return;

  dockedOrbitalId = s.dockedOrbitalId ?? null;
  renderCounts(spectralList, s.compendium.spectralCounts || {}, SPECTRAL_ORDER, SPECTRAL_LABELS);
  renderCounts(planetList, s.compendium.planetCounts || {}, PLANET_ORDER, PLANET_LABELS);
  renderDiscovered(s.compendium.discoveredObjectNames || []);
  renderOrbitals(s.galaxy?.orbitals || []);
  renderOthers(s.galaxy?.nearbyPlayers || []);
  renderChat(s.galaxy?.publicChat || []);
});

function renderCounts(target: HTMLDListElement, counts: Record<string, number>, order: string[], labels: Record<string, string>) {
  target.innerHTML = "";
  for (const key of order) {
    const c = counts[key] || 0;
    const dt = document.createElement("dt");
    dt.textContent = labels[key] ?? key;
    const dd = document.createElement("dd");
    dd.textContent = String(c);
    if (!c) dd.classList.add("empty");
    const row = document.createElement("div");
    row.className = "row";
    row.appendChild(dt); row.appendChild(dd);
    target.appendChild(row);
  }
}

function renderDiscovered(names: string[]) {
  discList.innerHTML = "";
  if (!names.length) { discList.innerHTML = '<li class="empty-tag">— none yet —</li>'; return; }
  for (const n of names) {
    const li = document.createElement("li");
    li.textContent = n;
    discList.appendChild(li);
  }
}

function renderOrbitals(orbitals: any[]) {
  orbitalsList.innerHTML = "";
  if (!orbitals.length) { orbitalsList.innerHTML = '<li class="empty-tag">— none built yet —</li>'; return; }
  for (const o of orbitals) {
    const li = document.createElement("li");
    const isDocked = dockedOrbitalId === o.id;
    if (isDocked) li.classList.add("docked");
    const occupants = (o.dockedPlayerIds?.length ?? 0);
    const occBadge = occupants ? `<span class="occupants">${occupants} aboard</span>` : "";
    const dockedTag = isDocked ? '<span class="occupants">▶ aboard</span>' : "";
    const desc = (o.description ?? "").trim();
    const descHtml = desc ? `<div class="desc">${escapeHtml(desc)}</div>` : "";
    const actions = isDocked
      ? `<button class="leave" data-action="leave" data-orbital-id="${escapeHtml(o.id)}">leave</button>`
      : `<button data-action="warp" data-orbital-id="${escapeHtml(o.id)}">warp</button>`;
    li.innerHTML = `
      <div class="row1">
        <span class="name">${escapeHtml(o.name)}</span>
        <span class="builder">— ${escapeHtml(o.builderShipName)}</span>
        ${dockedTag || occBadge}
      </div>
      ${descHtml}
      <div class="actions">${actions}</div>
    `;
    orbitalsList.appendChild(li);
  }
}

function renderOthers(others: any[]) {
  othersList.innerHTML = "";
  if (!others.length) { othersList.innerHTML = '<li class="empty-tag">— alone in this volume —</li>'; return; }
  for (const o of others) {
    const li = document.createElement("li");
    li.innerHTML = `${escapeHtml(o.shipName)}<span class="dist">${o.distance.toFixed(2)} ly · Mind: ${escapeHtml(o.mindName)}</span>`;
    othersList.appendChild(li);
  }
}

function renderChat(chat: any[]) {
  chatList.innerHTML = "";
  if (!chat.length) { chatList.innerHTML = '<li class="empty-tag">— silent —</li>'; return; }
  for (const m of chat.slice(-12)) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="from">${escapeHtml(m.fromShipName)}:</span>${escapeHtml(m.text)}`;
    chatList.appendChild(li);
  }
}

function escapeHtml(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
