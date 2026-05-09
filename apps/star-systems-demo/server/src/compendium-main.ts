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
const buildBtn = $("build-btn") as HTMLButtonElement;
const publicInput = $("public-input") as HTMLInputElement;
const publicBtn = $("public-btn") as HTMLButtonElement;

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
  buildBtn.disabled = true;
  try {
    await callTool(pane.app, "build_orbital", { gameId, playerId, name });
    orbitalNameInput.value = "";
  } finally {
    buildBtn.disabled = false;
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
    li.innerHTML = `${escapeHtml(o.name)}<span class="builder">— ${escapeHtml(o.builderShipName)}</span>`;
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
