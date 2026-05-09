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
});
