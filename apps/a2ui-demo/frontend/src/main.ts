/**
 * A2UI v0.9 demo frontend.
 *
 * Pipeline:
 *   1. POST a user message to the FastAPI backend at :8766/a2ui-stream
 *   2. Parse SSE — each `data: {...}` is either a meta event or an
 *      A2UI v0.9 message (`createSurface` / `updateComponents` / ...).
 *   3. Feed each A2UI message into a shared MessageProcessor.
 *   4. The processor materialises SurfaceModels; we mount one
 *      `<a2ui-surface>` Lit element per surface as it appears.
 *
 * The renderer (`@a2ui/lit/v0_9`) handles all painting from the basic
 * catalog (Text, Card, Column, Row, etc.). We just hand it surfaces.
 */
import { MessageProcessor } from "@a2ui/web_core/v0_9";
import { basicCatalog, A2uiSurface } from "@a2ui/lit/v0_9";

// Side-effect import: registers the <a2ui-surface> custom element.
void A2uiSurface;

const BACKEND_URL =
  (import.meta as any).env?.VITE_A2UI_BACKEND_URL ?? "http://localhost:8766";

const surfacesEl = document.getElementById("surfaces") as HTMLElement;
const logEl = document.getElementById("log-body") as HTMLElement;
const promptEl = document.getElementById("prompt") as HTMLInputElement;
const sendEl = document.getElementById("send") as HTMLButtonElement;

const processor = new MessageProcessor([basicCatalog]);

// Mount a <a2ui-surface> as soon as the processor reports a new surface.
processor.onSurfaceCreated((surface) => {
  const el = document.createElement("a2ui-surface") as A2uiSurface;
  el.surface = surface;
  el.setAttribute("data-surface-id", surface.id);
  surfacesEl.appendChild(el);
  surfacesEl.scrollTop = surfacesEl.scrollHeight;
});

processor.onSurfaceDeleted((id) => {
  surfacesEl.querySelectorAll(`[data-surface-id="${id}"]`).forEach((n) => n.remove());
});

sendEl.addEventListener("click", () => send(promptEl.value));
promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") send(promptEl.value);
});

async function send(message: string) {
  if (!message.trim()) return;
  surfacesEl.replaceChildren();
  logEl.replaceChildren();
  sendEl.disabled = true;
  try {
    const res = await fetch(`${BACKEND_URL}/a2ui-stream`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok || !res.body) throw new Error(`backend: ${res.status} ${res.statusText}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (line.startsWith("data: ")) {
            try {
              handle(JSON.parse(line.slice(6)));
            } catch (e) {
              console.warn("bad SSE frame", line, e);
            }
          }
        }
      }
    }
  } catch (e) {
    appendLog("error", String(e));
  } finally {
    sendEl.disabled = false;
  }
}

function handle(payload: any) {
  if ("meta" in payload) {
    const note = payload.meta === "tool_call"
      ? `→ tool ${payload.name}(${payload.args ?? ""})`
      : payload.meta;
    appendLog("meta", note);
    if (payload.meta === "tool_call") {
      const div = document.createElement("div");
      div.className = "toolcall";
      div.textContent = `→ ${payload.name}(${payload.args ?? ""})`;
      surfacesEl.appendChild(div);
    }
    return;
  }
  // A2UI v0.9 wire message — hand to the processor.
  appendLog("a2ui", JSON.stringify(payload));
  try {
    processor.processMessages([payload]);
  } catch (e) {
    appendLog("error", `processor.processMessages: ${e}`);
  }
}

function appendLog(kind: string, msg: string) {
  const pre = document.createElement("pre");
  pre.innerHTML = `<span class="badge">${kind}</span>  ${escapeHtml(msg)}`;
  logEl.appendChild(pre);
  logEl.scrollTop = logEl.scrollHeight;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}
