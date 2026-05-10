/**
 * Lobby pane — the entry-point picker.
 *
 * Lists existing galaxies (from `list_galaxies`), supports a filter,
 * and lets the player pick a ship class + Mind. On submit, the lobby
 * uses `app.sendMessage` to ask the LLM (in the player's voice) to
 * call `start_starship` with the chosen parameters. The LLM's tool
 * call returns the cockpit pane, which the host swaps in.
 *
 * We deliberately don't call start_starship from the pane: the result
 * comes back to the pane's ontoolresult and won't trigger the host's
 * cockpit-mounting flow. Routing through the LLM is what makes the
 * pane-swap "natural" from the host's perspective.
 */
import { callTool, setupPaneApp } from "./shared.js";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const searchInput = $("search") as HTMLInputElement;
const gamesList = $("games") as HTMLUListElement;
const gameIdInput = $("game-id") as HTMLInputElement;
const shipClassSel = $("ship-class") as HTMLSelectElement;
const mindSel = $("mind-id") as HTMLSelectElement;
const mindTagline = $("mind-tagline");
const joinBtn = $("join-btn") as HTMLButtonElement;
const refreshBtn = $("refresh-btn") as HTMLButtonElement;
const statusEl = $("status");

type GalaxySummary = {
  gameId: string;
  createdAt: number;
  seed: number;
  playerCount: number;
  orbitalCount: number;
  players: { shipName: string; shipClass: string; mindId: string; mindName: string }[];
};
type MindLite = { id: string; name: string; shipClass: string; tagline: string };

// Ship classes are a stable enum on the server side; hardcoding here
// avoids a redundant tool call. If the catalog ever grows, swap to a
// `list_ship_classes` tool.
const SHIP_CLASSES: { id: string; label: string; blurb: string }[] = [
  { id: "GCU", label: "GCU — General Contact Unit",   blurb: "Standard Contact Section explorer. Curious, talkative." },
  { id: "LSV", label: "LSV — Limited Systems Vehicle", blurb: "Smaller; older Minds with strong opinions." },
  { id: "ROU", label: "ROU — Rapid Offensive Unit",    blurb: "Fast warship. Bored, dangerous, mostly retired Minds." },
  { id: "GOU", label: "GOU — General Offensive Unit",  blurb: "Bigger warship. Contact-attached. Watchful." },
];

let galaxies: GalaxySummary[] = [];
let minds: MindLite[] = [];

const { app } = setupPaneApp("starship-lobby");

async function refresh(): Promise<void> {
  statusEl.textContent = "loading…";
  const res = await callTool<{ galaxies: GalaxySummary[] }>(app, "list_galaxies", {});
  galaxies = res?.galaxies ?? [];
  renderGames();
  statusEl.textContent = galaxies.length ? `${galaxies.length} galaxy(ies) found.` : "No galaxies yet — start one below.";
}

async function loadMinds(): Promise<void> {
  const res = await callTool<{ minds: MindLite[] }>(app, "list_minds", {});
  minds = res?.minds ?? [];
  for (const sc of SHIP_CLASSES) {
    const opt = document.createElement("option");
    opt.value = sc.id;
    opt.textContent = sc.label;
    opt.title = sc.blurb;
    shipClassSel.appendChild(opt);
  }
  // First option = "Mind chooses" (random pick on the server).
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "(let the galaxy choose)";
  mindSel.appendChild(noneOpt);
  for (const m of minds) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = `${m.shipClass} · ${m.name}`;
    mindSel.appendChild(opt);
  }
  updateTagline();
}

function updateTagline(): void {
  const m = minds.find((x) => x.id === mindSel.value);
  mindTagline.textContent = m ? m.tagline : "";
  // Auto-fill ship class to match the chosen Mind's canonical class.
  if (m) shipClassSel.value = m.shipClass;
}

function relTime(ts: number): string {
  const dt = Date.now() - ts;
  if (dt < 60_000) return "just now";
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)}h ago`;
  return `${Math.round(dt / 86_400_000)}d ago`;
}

function renderGames(): void {
  const q = searchInput.value.trim().toLowerCase();
  const filter = (g: GalaxySummary) =>
    !q
    || g.gameId.toLowerCase().includes(q)
    || g.players.some((p) => p.shipName.toLowerCase().includes(q) || p.mindName.toLowerCase().includes(q));
  const visible = galaxies.filter(filter);
  gamesList.innerHTML = "";
  if (!visible.length) {
    const li = document.createElement("li");
    li.className = "galaxy empty";
    li.textContent = q ? "no matches." : "no galaxies yet.";
    gamesList.appendChild(li);
    return;
  }
  for (const g of visible) {
    const li = document.createElement("li");
    li.className = "galaxy";
    li.dataset.gameId = g.gameId;
    li.tabIndex = 0;
    if (g.gameId === gameIdInput.value) li.classList.add("selected");
    const row1 = document.createElement("div");
    row1.className = "row1";
    const gid = document.createElement("span");
    gid.className = "gid";
    gid.textContent = g.gameId;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${g.playerCount} player${g.playerCount === 1 ? "" : "s"} · ${g.orbitalCount} orb · ${relTime(g.createdAt)}`;
    row1.appendChild(gid);
    row1.appendChild(meta);
    li.appendChild(row1);
    if (g.players.length) {
      const ships = document.createElement("div");
      ships.className = "ships";
      ships.textContent = g.players.map((p) => `${p.shipClass} ${p.shipName}`).join(" · ");
      li.appendChild(ships);
    }
    li.addEventListener("click", () => {
      gameIdInput.value = g.gameId;
      // Highlight; refresh selection class on every li.
      for (const el of gamesList.querySelectorAll(".galaxy")) el.classList.remove("selected");
      li.classList.add("selected");
      statusEl.textContent = `Selected ${g.gameId}. Pick a Mind/ship below and hit "join / launch".`;
    });
    gamesList.appendChild(li);
  }
}

function buildLaunchMessage(): string {
  const gameId = gameIdInput.value.trim();
  const shipClass = shipClassSel.value || undefined;
  const mindId = mindSel.value || undefined;
  // Plain English so any Mind can read it; explicit JSON args because
  // the LLM should pass them through to start_starship verbatim.
  const args: Record<string, string> = {};
  if (gameId) args.gameId = gameId;
  if (shipClass) args.ship_class = shipClass;
  if (mindId) args.mind_id = mindId;
  const argsBlob = JSON.stringify(args);
  const verb = gameId ? `Join galaxy \`${gameId}\`` : "Start a fresh galaxy";
  return `${verb}: please call \`start_starship\` with arguments ${argsBlob}, then continue from the cockpit.`;
}

async function launch(): Promise<void> {
  joinBtn.disabled = true;
  statusEl.textContent = "asking the Mind to launch…";
  try {
    await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: buildLaunchMessage() }],
    });
    statusEl.textContent = "launch requested. The cockpit should mount in a moment.";
  } catch (e) {
    statusEl.textContent = `failed to send launch message: ${(e as Error).message}`;
    joinBtn.disabled = false;
  }
}

mindSel.addEventListener("change", updateTagline);
searchInput.addEventListener("input", renderGames);
refreshBtn.addEventListener("click", () => void refresh());
joinBtn.addEventListener("click", () => void launch());

void (async () => {
  await loadMinds();
  await refresh();
})();
