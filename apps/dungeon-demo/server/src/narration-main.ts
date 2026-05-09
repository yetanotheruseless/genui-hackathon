/**
 * Narration pane — polls the server's narration log and renders lines.
 *
 * The log is populated by the viewport pane calling `narrate(...)`. This
 * pane is read-only; it just paints what's there.
 */
import { callTool, poll, setupPaneApp, type WorldStateView } from "./shared.js";

const logEl = document.getElementById("log") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;

const pane = setupPaneApp("Dungeon Narration");

let worldId = "";
let lastTs = 0;
const seen = new Set<string>();

pane.worldId.then((id) => { worldId = id; statusEl.textContent = `world ${id.slice(0, 8)}…`; });

poll(500, async () => {
  if (!worldId) return;
  const state = await callTool<{ kind: string } & WorldStateView>(pane.app, "get_state", {
    worldId,
    since_ts: lastTs,
  });
  if (!state || !state.narrationLog) return;
  for (const line of state.narrationLog) {
    const key = `${line.ts}::${line.voice}::${line.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    appendLine(line);
    if (line.ts > lastTs) lastTs = line.ts;
  }
});

function appendLine(line: { voice: string; text: string; ts: number }) {
  const div = document.createElement("div");
  div.className = "line";
  const v = document.createElement("span");
  v.className = `voice ${line.voice}`;
  v.textContent = `${line.voice}:`;
  div.appendChild(v);
  div.appendChild(document.createTextNode(" " + line.text));
  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = formatTime(line.ts);
  div.appendChild(ts);
  logEl.appendChild(div);
  while (logEl.children.length > 80) logEl.removeChild(logEl.firstChild!);
  logEl.scrollTop = logEl.scrollHeight;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return ` ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
}
