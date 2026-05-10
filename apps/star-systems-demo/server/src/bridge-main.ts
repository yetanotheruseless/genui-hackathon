/**
 * Bridge pane — chat with the ship's Mind.
 *
 * Polls `get_state` at 800ms cadence to surface Mind-narrated observations
 * AND chat replies. The user's own messages are echoed locally for snap,
 * then de-duped against the server log when it arrives.
 */
import { callTool, poll, setupPaneApp } from "./shared.js";

type LogLine = { id: string; kind: string; voice: string; text: string; ts: number };

const shipNameEl = document.getElementById("ship-name") as HTMLElement;
const shipClassEl = document.getElementById("ship-class") as HTMLElement;
const taglineEl = document.getElementById("tagline") as HTMLElement;
const logEl = document.getElementById("log") as HTMLDivElement;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send") as HTMLButtonElement;
const typingEl = document.getElementById("typing") as HTMLDivElement;
const dockedBanner = document.getElementById("docked-banner") as HTMLDivElement;
const dockedNameEl = document.getElementById("docked-name") as HTMLElement;
const dockedBuilderEl = document.getElementById("docked-builder") as HTMLElement;
const dockedDescEl = document.getElementById("docked-desc") as HTMLElement;
const dockedOccupantsEl = document.getElementById("docked-occupants") as HTMLElement;

const pane = setupPaneApp("Culture Bridge");
let gameId = "";
let playerId = "";
const seen = new Set<string>();

pane.initial.then((init) => {
  gameId = init.gameId;
  playerId = init.playerId;
  if (init.ship) {
    shipNameEl.textContent = init.ship.name;
    shipClassEl.textContent = init.ship.class;
  }
  if (init.mind?.tagline) {
    taglineEl.textContent = init.mind.tagline;
  }
  sendBtn.disabled = false;
});

sendBtn.addEventListener("click", () => sendMessage());
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    sendMessage();
  }
});

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || !gameId || !playerId) return;
  inputEl.value = "";
  sendBtn.disabled = true;
  typingEl.classList.remove("hidden");
  // Optimistic echo — server will write the same line, will de-dupe.
  const optimisticId = `optimistic-${Date.now()}`;
  seen.add(optimisticId);
  appendTurn({ id: optimisticId, kind: "user", voice: "You", text, ts: Date.now() });
  try {
    await callTool(pane.app, "talk_to_mind", { gameId, playerId, message: text });
  } catch (e) {
    appendTurn({
      id: `error-${Date.now()}`,
      kind: "system",
      voice: "[error]",
      text: `Mind link failed: ${e}`,
      ts: Date.now(),
    });
  } finally {
    sendBtn.disabled = false;
    typingEl.classList.add("hidden");
    inputEl.focus();
  }
}

function appendTurn(line: LogLine) {
  const div = document.createElement("div");
  div.className = `turn ${line.kind}`;
  if (line.kind !== "user") {
    const voice = document.createElement("div");
    voice.className = "voice";
    voice.textContent = line.voice;
    div.appendChild(voice);
  }
  const text = document.createElement("div");
  text.className = "text";
  text.textContent = line.text;
  div.appendChild(text);
  if (line.kind === "user") {
    const voice = document.createElement("div");
    voice.className = "voice";
    voice.textContent = "you";
    div.insertBefore(voice, text);
  }
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

poll(800, async () => {
  if (!gameId || !playerId) return;
  const state = await callTool<any>(pane.app, "get_state", { gameId, playerId });
  if (!state?.log) return;
  // De-dupe by id; also avoid re-rendering the optimistic user line.
  for (const line of state.log) {
    if (seen.has(line.id)) continue;
    // If a user line came in that matches our last optimistic echo, skip it.
    if (line.kind === "user" && Array.from(seen).some((s) => s.startsWith("optimistic-")) && state.log.indexOf(line) >= state.log.length - 2) {
      seen.add(line.id);
      continue;
    }
    seen.add(line.id);
    appendTurn(line);
  }
  renderDockedBanner(state.dockedOrbitalId, state.galaxy?.orbitals || []);
});

function renderDockedBanner(dockedOrbitalId: string | null | undefined, orbitals: any[]) {
  if (!dockedOrbitalId) {
    dockedBanner.classList.remove("visible");
    return;
  }
  const orbital = orbitals.find((o) => o.id === dockedOrbitalId);
  if (!orbital) {
    // We're nominally docked but the orbital is no longer in the
    // shared list (deletion / new game). Hide rather than show stale.
    dockedBanner.classList.remove("visible");
    return;
  }
  dockedBanner.classList.add("visible");
  dockedNameEl.textContent = orbital.name;
  dockedBuilderEl.textContent = ` — built by ${orbital.builderShipName}`;
  const desc = (orbital.description ?? "").trim();
  if (desc) {
    dockedDescEl.textContent = desc;
    dockedDescEl.classList.remove("empty");
  } else {
    dockedDescEl.textContent = "— builder left no notes —";
    dockedDescEl.classList.add("empty");
  }
  const occupants = orbital.dockedPlayerIds?.length ?? 0;
  dockedOccupantsEl.textContent = occupants > 1
    ? `${occupants} Minds aboard`
    : occupants === 1 ? "alone aboard" : "";
}
