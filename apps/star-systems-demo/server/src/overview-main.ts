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

/** Compact catalog tuple matching the server's brightStarsPayload:
 *  [id, x, y, z, spectralClass, mag, radiusSolar]. Used for the
 *  nearest-N catalog rows so the overview can target/warp to any of
 *  the 109k HYG stars without building 109k rows in the DOM. */
type CatalogStar = [string, number, number, number, string, number, number];

type OverviewInit = {
  kind: "overview_init";
  gameId: string;
  playerId: string;
  ship: { name: string; class: string };
  stars: StarLite[];
  catalogStars?: CatalogStar[];
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
  /** Star ID for expansion control (set on expandable star rows so the
   *  caret-click handler knows which star to toggle in expandedStarIds).
   *  Undefined on rows that don't have planets. */
  expandableStarId?: string;
  expanded?: boolean;
  /** Visual indent flag for planet rows nested under their star. */
  indent?: boolean;
  /** Parent star id on planet rows — used by render() to gate
   *  visibility against expandedStarIds (only in the ALL filter; the
   *  PLANET filter shows every planet regardless). */
  parentStarId?: string;
};

const shipNameEl = document.getElementById("ship-name") as HTMLElement;
const hudPosEl = document.getElementById("hud-pos") as HTMLElement;
const rowsEl = document.getElementById("rows") as HTMLTableSectionElement;
const filterEls = document.querySelectorAll<HTMLButtonElement>("[data-filter]");
const sortEls = document.querySelectorAll<HTMLTableCellElement>("[data-sort]");

const pane = setupPaneApp("Culture Overview");
let gameId = "";
let playerId = "";
/** How many nearest catalog (non-curated) stars to surface as rows.
 *  Cap exists so the DOM doesn't get 109k <tr>s. Adjust if needed. */
const CATALOG_MAX_ROWS = 60;
/** Star ids whose planet rows are currently expanded under them.
 *  Default = collapsed; clicking the ▶ caret on a star row toggles
 *  membership and re-renders. Only stars with planets get a caret. */
const expandedStarIds = new Set<string>();
let stars: StarLite[] = [];
let catalogStars: CatalogStar[] = [];
/** Curated star ids — to skip from the catalog rows (curated have their
 *  own full-fidelity rows with planets). */
const curatedIds = new Set<string>();
let playerPos: [number, number, number] = [0, 0, 0];
let orbitals: Array<{
  id: string;
  name: string;
  builderShipName: string;
  position: [number, number, number];
  describedAs?: string;
}> = [];
let nearbyPlayers: Array<{
  playerId: string;
  shipName: string;
  mindName: string;
  position: [number, number, number];
  distance: number;
}> = [];

/** The currently locked target on the server, fed by the get_state
 *  poll. Used to highlight the matching row in the overview table. */
let currentTargetId: string | null = null;

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
  catalogStars = data.catalogStars ?? [];
  curatedIds.clear();
  for (const s of stars) curatedIds.add(s.id);
  if (data.ship?.name) shipNameEl.textContent = data.ship.name;
  render();
});

// Poll get_state for live position + orbitals + nearby ships.
poll(700, async () => {
  if (!gameId || !playerId) return;
  const state = await callTool<{
    position?: [number, number, number];
    targetId?: string | null;
    galaxy?: {
      orbitals?: typeof orbitals;
      nearbyPlayers?: typeof nearbyPlayers;
    };
  }>(pane.app, "get_state", { gameId, playerId });
  if (!state) return;
  if (state.position) playerPos = state.position;
  if (state.galaxy?.orbitals) orbitals = state.galaxy.orbitals;
  if (state.galaxy?.nearbyPlayers) nearbyPlayers = state.galaxy.nearbyPlayers;
  currentTargetId = state.targetId ?? null;
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

  // Stars + their planets. Planets nest under their parent star and
  // are gated by expandedStarIds — collapsed by default to keep the
  // ALL view compact; the user clicks the ▶ caret on a star row to
  // reveal its planets indented beneath.
  for (const s of stars) {
    const sd = distLy(s.position);
    const hasPlanets = (s.planets?.length ?? 0) > 0;
    const expanded = hasPlanets && expandedStarIds.has(s.id);
    rows.push({
      id: `star:${s.id}`,
      kind: "star",
      icon: "★",
      name: s.name,
      type: s.spectralType,
      distanceLy: sd,
      position: s.position,
      action: { tool: "warp_to", args: { gameId, playerId, objectId: s.id } },
      expandableStarId: hasPlanets ? s.id : undefined,
      expanded,
    });
    // Emit planet rows unconditionally; render() hides them under a
    // collapsed parent for the ALL filter, but the "PLANETS" filter
    // always shows every planet regardless of expansion. Distance is
    // approximated by the parent star's distance (planets sit within
    // ~tens of AU of their star, dwarfed by interstellar distances).
    // Single-click sets the cockpit reticle on the planet via
    // set_target — planets aren't valid warp_to destinations.
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
        indent: true,
        parentStarId: s.id,
      });
    }
  }

  // Catalog (HYG) stars — nearest N by distance from the ship.
  // We don't dump all 109k into the table; instead we take the closest
  // CATALOG_MAX_ROWS so the user can target/warp to any nearby HYG
  // star without making the list unusable. As the ship moves, the
  // nearest-N set updates automatically via the get_state poll.
  if (catalogStars.length) {
    const distances = new Array<{ idx: number; d: number }>(catalogStars.length);
    let k = 0;
    for (let i = 0; i < catalogStars.length; i++) {
      const e = catalogStars[i];
      if (curatedIds.has(e[0])) continue; // curated already have richer rows above
      const dx = e[1] - playerPos[0];
      const dy = e[2] - playerPos[1];
      const dz = e[3] - playerPos[2];
      distances[k++] = { idx: i, d: Math.hypot(dx, dy, dz) };
    }
    distances.length = k;
    distances.sort((a, b) => a.d - b.d);
    const cap = Math.min(CATALOG_MAX_ROWS, distances.length);
    for (let j = 0; j < cap; j++) {
      const { idx, d } = distances[j];
      const e = catalogStars[idx];
      rows.push({
        id: `star:${e[0]}`,
        kind: "star",
        icon: "·",
        name: e[0],
        type: `${e[4]} · mag ${e[5].toFixed(1)}`,
        distanceLy: d,
        position: [e[1], e[2], e[3]],
        action: { tool: "warp_to", args: { gameId, playerId, objectId: e[0] } },
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

  // Other ships — keyed by playerId so target/warp resolves via live
  // player position rather than a stale snapshot. shipName is just for
  // display (and may not be unique within a galaxy if two players pick
  // the same Mind).
  for (const p of nearbyPlayers) {
    rows.push({
      id: `ship:${p.playerId}`,
      kind: "ship",
      icon: "▶",
      name: p.shipName,
      type: `Mind: ${p.mindName}`,
      position: p.position,
      distanceLy: p.distance,
      action: { tool: "warp_to", args: { gameId, playerId, objectId: `ship:${p.playerId}` } },
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
  // Filter pipeline:
  //   1. Kind filter (all/star/planet/orbital/ship).
  //   2. Expansion gate (only in ALL): planet rows hidden unless their
  //      parent star is in expandedStarIds. The PLANET filter shows
  //      every planet regardless.
  const filtered = all.filter((r) => {
    if (filter !== "all" && r.kind !== filter) return false;
    if (filter === "all" && r.kind === "planet" && r.parentStarId) {
      return expandedStarIds.has(r.parentStarId);
    }
    return true;
  });
  const sorted = sortRows(filtered);

  if (sorted.length === 0) {
    rowsEl.innerHTML = `<tr><td colspan="5" class="empty-row">— nothing in range —</td></tr>`;
    return;
  }

  // Reuse rows where possible to avoid layout thrash on every poll.
  // The currently-locked target row gets a .target class for the
  // amber highlight — server stores targetId without the "star:"
  // prefix for stars (other kinds keep their prefix), so we strip
  // it from the row id before comparing.
  let html = "";
  for (const r of sorted) {
    const parent = r.parent ?? "";
    const normalizedId = r.id.startsWith("star:") ? r.id.slice("star:".length) : r.id;
    const isTarget = currentTargetId != null && normalizedId === currentTargetId;
    // Indent planet rows only on the ALL filter (where nesting under
    // a star carries information). PLANETS filter shows planets flat
    // since there's no hierarchy to convey — indenting there just
    // makes them all start in the same shifted column for no reason.
    const indentNow = r.indent && filter === "all";
    const klass = `kind-${r.kind}${isTarget ? " target" : ""}${indentNow ? " indent" : ""}`;
    // Caret on expandable star rows. data-expand-star carries the id
    // so the click handler can toggle expandedStarIds without
    // triggering the row's normal target action (stopPropagation in
    // the handler). Use +/− glyphs rather than ▶/▼ — the right-
    // pointing triangle is already the ship icon in the icon column,
    // so a triangle caret next to the name would be confusing.
    const caret = r.expandableStarId
      ? `<span class="caret" data-expand-star="${escapeAttr(r.expandableStarId)}">${r.expanded ? "−" : "+"}</span>`
      : "";
    // Planet rows just get padding-left via .indent — no leading
    // glyph. The previous └ bullet was visually noisy and also
    // appeared confusingly in the PLANETS filter view.
    const nameCell = `${caret}${escapeHtml(r.name)}`;
    html += `<tr class="${klass}" data-id="${escapeAttr(r.id)}">`
      + `<td class="icon">${r.icon}</td>`
      + `<td class="name">${nameCell}</td>`
      + `<td class="kind">${escapeHtml(r.type)}</td>`
      + `<td class="parent">${escapeHtml(parent)}</td>`
      + `<td class="dist">${formatDistance(r.distanceLy)}</td>`
      + `</tr>`;
  }
  rowsEl.innerHTML = html;
}

// --- Row interactions ----------------------------------------------------
//
// Single click   → set_target only (lock the cockpit reticle, no warp).
// Double click   → align (set_target + face_target).
// Right click    → context menu with explicit Target / Align / Warp options.
//
// Warp is only triggered explicitly via the right-click menu or the
// target-info pane's Warp button — never as a side effect of a click.
//
// The single-click action is deferred by ~250 ms so a follow-up dblclick
// can preempt it.

const DBLCLICK_GUARD_MS = 250;
let pendingClickTimer: number | null = null;

function rowIdFromEvent(e: Event): string | null {
  const tr = (e.target as HTMLElement).closest("tr");
  return tr?.getAttribute("data-id") ?? null;
}

function isStarRow(id: string): boolean { return id.startsWith("star:"); }
function isOrbitalRow(id: string): boolean { return id.startsWith("orbital:"); }
function isPlanetRow(id: string): boolean { return id.startsWith("planet:"); }
// Planets are warpable — the cockpit resolves "planet:starId::name" to a
// live orbital position and the server's warp_to passes planet ids through
// untouched.
function isWarpable(id: string): boolean {
  return isStarRow(id) || isOrbitalRow(id) || isPlanetRow(id);
}

async function actionTarget(rowId: string) {
  // set_target accepts the cockpit-side targetId format directly:
  //   star    → bare star id (no prefix)
  //   planet  → "planet:starId::name"
  //   orbital → "orbital:<uuid>"
  const targetId = isStarRow(rowId) ? rowId.slice("star:".length) : rowId;
  await callTool(pane.app, "set_target", { gameId, playerId, targetId });
}

async function actionWarp(rowId: string) {
  if (isOrbitalRow(rowId)) {
    await callTool(pane.app, "warp_to_orbital", {
      gameId, playerId, orbitalId: rowId.slice("orbital:".length),
    });
  } else if (isStarRow(rowId)) {
    await callTool(pane.app, "warp_to", {
      gameId, playerId, objectId: rowId.slice("star:".length),
    });
  } else if (isPlanetRow(rowId)) {
    // server.warp_to passes "planet:..." ids through; cockpit steers
    // toward the live orbital position.
    await callTool(pane.app, "warp_to", { gameId, playerId, objectId: rowId });
  } else {
    // Ships aren't warpable — degrade to a target lock.
    await actionTarget(rowId);
  }
}

async function actionAlign(rowId: string) {
  await actionTarget(rowId);
  await callTool(pane.app, "face_target", { gameId, playerId });
}

rowsEl.addEventListener("click", (e) => {
  // Caret click — toggle expansion of the parent star and re-render.
  // We don't let this fall through to the row-target action because
  // the user is operating the disclosure widget, not picking a target.
  const target = e.target as HTMLElement;
  const expandStarId = target.dataset?.expandStar || target.closest<HTMLElement>("[data-expand-star]")?.dataset.expandStar;
  if (expandStarId) {
    e.stopPropagation();
    if (expandedStarIds.has(expandStarId)) expandedStarIds.delete(expandStarId);
    else expandedStarIds.add(expandStarId);
    render();
    return;
  }
  const id = rowIdFromEvent(e);
  if (!id) return;
  if (pendingClickTimer != null) {
    window.clearTimeout(pendingClickTimer);
    pendingClickTimer = null;
  }
  pendingClickTimer = window.setTimeout(() => {
    pendingClickTimer = null;
    void actionTarget(id).catch((err) => console.warn("[overview] set_target failed:", err));
  }, DBLCLICK_GUARD_MS);
});

rowsEl.addEventListener("dblclick", (e) => {
  const id = rowIdFromEvent(e);
  if (!id) return;
  if (pendingClickTimer != null) {
    window.clearTimeout(pendingClickTimer);
    pendingClickTimer = null;
  }
  void actionAlign(id).catch((err) => console.warn("[overview] align failed:", err));
});

rowsEl.addEventListener("contextmenu", (e) => {
  const id = rowIdFromEvent(e);
  if (!id) return;
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, id);
});

// --- Context menu --------------------------------------------------------

const ctxMenu = document.getElementById("ctx-menu") as HTMLDivElement;

function showContextMenu(x: number, y: number, rowId: string) {
  // Position with a clamp so the menu doesn't overflow the iframe.
  ctxMenu.style.display = "block";
  // First show to measure, then clamp.
  ctxMenu.style.left = "0px";
  ctxMenu.style.top = "0px";
  const w = ctxMenu.offsetWidth || 120;
  const h = ctxMenu.offsetHeight || 80;
  const cw = document.documentElement.clientWidth;
  const ch = document.documentElement.clientHeight;
  ctxMenu.style.left = `${Math.min(x, cw - w - 4)}px`;
  ctxMenu.style.top  = `${Math.min(y, ch - h - 4)}px`;
  ctxMenu.dataset.rowId = rowId;
  // Disable "Warp" for non-warpable kinds (planets, ships).
  const warpItem = ctxMenu.querySelector<HTMLButtonElement>("[data-action='warp']")!;
  warpItem.disabled = !isWarpable(rowId);
}
function hideContextMenu() {
  ctxMenu.style.display = "none";
  ctxMenu.dataset.rowId = "";
}

ctxMenu.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("button");
  if (!btn || btn.disabled) return;
  const action = btn.dataset.action;
  const rowId = ctxMenu.dataset.rowId;
  if (!action || !rowId) return;
  hideContextMenu();
  if (action === "target") void actionTarget(rowId).catch((err) => console.warn(err));
  else if (action === "align") void actionAlign(rowId).catch((err) => console.warn(err));
  else if (action === "warp")  void actionWarp(rowId).catch((err) => console.warn(err));
});
window.addEventListener("click", (e) => {
  if (!ctxMenu.contains(e.target as Node)) hideContextMenu();
}, true);
window.addEventListener("scroll", hideContextMenu, true);
window.addEventListener("contextmenu", (e) => {
  // Suppress browser menu OUTSIDE of rows too (cleaner UX inside the
  // pane); our custom handler above takes over for valid row clicks.
  if (!(e.target as HTMLElement).closest("tr")) {
    e.preventDefault();
    hideContextMenu();
  }
});

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!
  ));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
