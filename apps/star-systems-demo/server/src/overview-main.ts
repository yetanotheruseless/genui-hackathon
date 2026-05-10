/**
 * Overview pane — Eve Online-inspired filterable, distance-sorted table
 * of stars, planets, orbitals, and other ships. Replaces the inline
 * "nearest stars / planets" list that used to live in the cockpit HUD.
 *
 * Data sources:
 *   - init payload (open_overview tool) — curated 21 stars + their
 *     planets (from astrodata.ts).
 *   - get_state poll (700ms) — player position, galaxy.orbitals,
 *     galaxy.nearbyPlayers.
 *
 * Click handlers:
 *   - star → warp_to(starId)
 *   - orbital → warp_to_orbital(orbitalId)
 *   - planet/ship → no-op for now (informational rows)
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
  distanceLy?: number | null;
  planets: PlanetLite[];
};

type OverviewInit = {
  kind: "overview_init";
  gameId: string;
  playerId: string;
  ship: { name: string; class: string };
  stars: StarLite[];
};

type FilterKey = "all" | "star" | "planet" | "orbital" | "ship";
type SortKey = "name" | "kind" | "parent" | "distance";

type Row = {
  id: string;            // unique key
  kind: "star" | "planet" | "orbital" | "ship";
  icon: string;
  name: string;
  type: string;          // spectral type, planet kind, orbital descriptor, ship class
  parent?: string;       // parent star name for planets, builder for orbitals
  position: [number, number, number];
  distanceLy: number;    // computed each render from player position
  // Click action — server tool name + arguments. null for info-only rows.
  action: { tool: string; args: Record<string, unknown> } | null;
};

const shipNameEl = document.getElementById("ship-name") as HTMLElement;
const hudPosEl = document.getElementById("hud-pos") as HTMLElement;
const rowsEl = document.getElementById("rows") as HTMLTableSectionElement;
const filterEls = document.querySelectorAll<HTMLButtonElement>("[data-filter]");
const sortEls = document.querySelectorAll<HTMLTableCellElement>("[data-sort]");

const pane = setupPaneApp("Culture Overview");
let gameId = "";
let playerId = "";
let stars: StarLite[] = [];
let playerPos: [number, number, number] = [0, 0, 0];
let orbitals: Array<{
  id: string;
  name: string;
  builderShipName: string;
  position: [number, number, number];
  describedAs?: string;
}> = [];
let nearbyPlayers: Array<{
  shipName: string;
  mindName: string;
  position: [number, number, number];
  distance: number;
}> = [];

let filter: FilterKey = "all";
let sortKey: SortKey = "distance";
let sortAsc: boolean = true;

filterEls.forEach((b) => {
  b.addEventListener("click", () => {
    filter = (b.dataset.filter as FilterKey) ?? "all";
    filterEls.forEach((x) => x.classList.toggle("active", x === b));
    render();
  });
});

sortEls.forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort as SortKey;
    if (sortKey === key) {
      sortAsc = !sortAsc;
    } else {
      sortKey = key;
      sortAsc = key === "distance";    // distance defaults asc, name defaults asc, etc.
    }
    sortEls.forEach((x) => {
      x.classList.toggle("sort-active", x.dataset.sort === sortKey);
      x.classList.toggle("asc", x.dataset.sort === sortKey && sortAsc);
    });
    render();
  });
});

pane.initial.then((init) => {
  const data = init as unknown as OverviewInit;
  gameId = data.gameId;
  playerId = data.playerId;
  stars = data.stars ?? [];
  if (data.ship?.name) shipNameEl.textContent = data.ship.name;
  render();
});

// Poll get_state for live position + orbitals + nearby ships.
poll(700, async () => {
  if (!gameId || !playerId) return;
  const state = await callTool<{
    position?: [number, number, number];
    galaxy?: {
      orbitals?: typeof orbitals;
      nearbyPlayers?: typeof nearbyPlayers;
    };
  }>(pane.app, "get_state", { gameId, playerId });
  if (!state) return;
  if (state.position) playerPos = state.position;
  if (state.galaxy?.orbitals) orbitals = state.galaxy.orbitals;
  if (state.galaxy?.nearbyPlayers) nearbyPlayers = state.galaxy.nearbyPlayers;
  render();
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

function buildRows(): Row[] {
  const rows: Row[] = [];

  // Stars + their planets.
  for (const s of stars) {
    const sd = distLy(s.position);
    rows.push({
      id: `star:${s.id}`,
      kind: "star",
      icon: "★",
      name: s.name,
      type: s.spectralType,
      distanceLy: sd,
      position: s.position,
      action: { tool: "warp_to", args: { gameId, playerId, objectId: s.id } },
    });
    // Planet rows — distance approximated by the star's distance (planets
    // sit within ~tens of AU of their star, dwarfed by interstellar
    // distances). Click locks the cockpit reticle on the planet via
    // set_target (no warp — planets aren't valid warp_to destinations).
    for (const p of s.planets ?? []) {
      const orbitInfo = p.orbitAU ? ` · ${p.orbitAU.toFixed(2)} AU` : "";
      const planetTargetId = `planet:${s.id}::${p.name}`;
      rows.push({
        id: planetTargetId,
        kind: "planet",
        icon: "◯",
        name: p.name,
        type: `${p.kind.replace(/_/g, "-")}${orbitInfo}`,
        parent: s.name,
        distanceLy: sd,
        position: s.position,
        action: { tool: "set_target", args: { gameId, playerId, targetId: planetTargetId } },
      });
    }
  }

  // Orbitals.
  for (const o of orbitals) {
    rows.push({
      id: `orbital:${o.id}`,
      kind: "orbital",
      icon: "⊙",
      name: o.name,
      type: "orbital",
      parent: o.builderShipName,
      position: o.position,
      distanceLy: distLy(o.position),
      action: { tool: "warp_to_orbital", args: { gameId, playerId, orbitalId: o.id } },
    });
  }

  // Other ships (read-only — can't warp to a moving target via a snapshot id).
  for (const p of nearbyPlayers) {
    rows.push({
      id: `ship:${p.shipName}`,
      kind: "ship",
      icon: "▶",
      name: p.shipName,
      type: `Mind: ${p.mindName}`,
      position: p.position,
      distanceLy: p.distance,
      action: null,
    });
  }

  return rows;
}

function sortRows(rows: Row[]): Row[] {
  const dir = sortAsc ? 1 : -1;
  const cmp = (a: Row, b: Row): number => {
    switch (sortKey) {
      case "name":     return a.name.localeCompare(b.name) * dir;
      case "kind":     return a.kind.localeCompare(b.kind) * dir
                            || a.type.localeCompare(b.type) * dir;
      case "parent":   return (a.parent ?? "").localeCompare(b.parent ?? "") * dir;
      case "distance": return (a.distanceLy - b.distanceLy) * dir;
    }
  };
  return [...rows].sort(cmp);
}

function render() {
  hudPosEl.textContent = playerPos[0] === 0 && playerPos[1] === 0 && playerPos[2] === 0
    ? "—"
    : `${formatDistance(Math.hypot(...playerPos))} from Sol`;

  const all = buildRows();
  const filtered = filter === "all" ? all : all.filter((r) => r.kind === filter);
  const sorted = sortRows(filtered);

  if (sorted.length === 0) {
    rowsEl.innerHTML = `<tr><td colspan="5" class="empty-row">— nothing in range —</td></tr>`;
    return;
  }

  // Reuse rows where possible to avoid layout thrash on every poll.
  let html = "";
  for (const r of sorted) {
    const parent = r.parent ?? "";
    html += `<tr class="kind-${r.kind}" data-id="${escapeAttr(r.id)}">`
      + `<td class="icon">${r.icon}</td>`
      + `<td class="name">${escapeHtml(r.name)}</td>`
      + `<td class="kind">${escapeHtml(r.type)}</td>`
      + `<td class="parent">${escapeHtml(parent)}</td>`
      + `<td class="dist">${formatDistance(r.distanceLy)}</td>`
      + `</tr>`;
  }
  rowsEl.innerHTML = html;
}

rowsEl.addEventListener("click", (e) => {
  const tr = (e.target as HTMLElement).closest("tr");
  if (!tr) return;
  const id = tr.getAttribute("data-id");
  if (!id) return;
  const row = buildRows().find((r) => r.id === id);
  if (!row?.action) return;
  void callTool(pane.app, row.action.tool, row.action.args).catch((err) => {
    console.warn(`[overview] ${row.action!.tool} failed:`, err);
  });
});

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!
  ));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
