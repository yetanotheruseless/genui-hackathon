/**
 * Controls pane — buttons that enqueue actions for the viewport pane to drain.
 *
 * No state of its own; doesn't poll. Just fires `enqueue_action` per click.
 */
import { callTool, setupPaneApp } from "./shared.js";

const status = document.getElementById("status") as HTMLSpanElement;
const buttons = document.querySelectorAll<HTMLButtonElement>("button.btn");

const pane = setupPaneApp("Dungeon Controls");
let worldId = "";

pane.worldId.then((id) => {
  worldId = id;
  status.textContent = `world ${id.slice(0, 8)}…`;
  for (const b of buttons) b.disabled = false;
});

for (const b of buttons) {
  b.disabled = true;
  b.addEventListener("click", async () => {
    if (!worldId) return;
    const action = b.getAttribute("data-action");
    if (!action) return;
    b.disabled = true;
    try {
      await callTool(pane.app, "enqueue_action", { worldId, kind: action });
    } finally {
      setTimeout(() => (b.disabled = false), 80); // small debounce
    }
  });
}
