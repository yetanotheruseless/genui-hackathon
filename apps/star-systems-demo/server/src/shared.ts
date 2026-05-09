/**
 * Shared client-side helpers used by all four pane iframes.
 *
 * Each pane connects to its own MCP App bridge, extracts the worldId from
 * the initial tool result, and then drives its own polling / pushing
 * cadence against the server. State lives on the server (Map<worldId, ...>),
 * not in the iframe — that's how the four sandboxed iframes stay in sync.
 */
import { App } from "@modelcontextprotocol/ext-apps";

export type Inventory = { id: string; kind: string; label: string };

export type WorldStateView = {
  player: { wx: number; wy: number; angle: number };
  hp: number;
  hpMax: number;
  steps: number;
  currentChunk: { cx: number; cy: number; theme?: string };
  inventory: Inventory[];
  nearbyDecoration: { kind: string; label?: string } | null;
  narrationLog: { voice: string; text: string; ts: number }[];
  loadedChunkCount: number;
};

export type PaneInit = { kind: string; worldId: string } & Record<string, any>;

export type PaneApp = {
  app: App;
  worldId: Promise<string>;
  initial: Promise<PaneInit>;
};

/**
 * Standard pane bootstrap. Returns the MCP App instance plus a promise that
 * resolves to the worldId once the host has delivered the initial tool
 * result. Every pane calls this in its first line of code.
 *
 * Hosts may attach the AppBridge transport AFTER the iframe's script has
 * already run and posted ui/initialize — the request would be silently
 * dropped, app.connect() would hang, and the pane's poll loop would log
 * "App.callServerTool() called before connect() completed" forever. To
 * close that race we beacon "mcp-app-pane-ready" to the parent until it
 * answers with "mcp-app-host-ready", then call app.connect(). Hosts that
 * don't speak this handshake (e.g. Goose) should still work because they
 * attach before the iframe loads, so the first ui/initialize lands.
 */
export function setupPaneApp(name: string): PaneApp {
  const app = new App({ name, version: "0.2.0" });
  let resolveWorld: (id: string) => void = () => {};
  let resolveInit: (init: PaneInit) => void = () => {};
  const worldId = new Promise<string>((r) => (resolveWorld = r));
  const initial = new Promise<PaneInit>((r) => (resolveInit = r));
  app.ontoolresult = (result) => {
    const text = result.content?.find((c) => c.type === "text")?.text;
    if (!text) return;
    try {
      const data = JSON.parse(text) as PaneInit;
      // `worldId` is the legacy dungeon-demo field; `gameId` is the
      // star-systems / Culture Contact field. Either resolves the init.
      const id = data.worldId ?? data.gameId;
      if (typeof id === "string") {
        resolveWorld(id);
        resolveInit(data);
      }
    } catch (e) {
      console.warn("[pane] bad init payload", e);
    }
  };
  let connected = false;
  const onHostReady = (e: MessageEvent) => {
    if (e.source !== window.parent) return;
    if ((e.data as { type?: unknown })?.type !== "mcp-app-host-ready") return;
    if (connected) return;
    connected = true;
    window.removeEventListener("message", onHostReady);
    clearInterval(beacon);
    app.connect();
  };
  window.addEventListener("message", onHostReady);
  const post = () => window.parent.postMessage({ type: "mcp-app-pane-ready" }, "*");
  const beacon = setInterval(() => { if (!connected) post(); }, 100);
  // Fallback: if no host responds in 1.5s, connect anyway (Goose-style host).
  setTimeout(() => {
    if (connected) return;
    connected = true;
    window.removeEventListener("message", onHostReady);
    clearInterval(beacon);
    app.connect();
  }, 1500);
  post();
  return { app, worldId, initial };
}

/**
 * Repeatedly invoke a callback at a target interval. Stops when the
 * callback throws (e.g. host disconnect) and emits a console warning.
 */
export function poll(intervalMs: number, fn: () => Promise<void> | void): () => void {
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        await fn();
      } catch (e) {
        console.warn("[poll] error:", e);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
  return () => {
    stopped = true;
  };
}

/** Helper for `app.callServerTool` that JSON-decodes the text result. */
export async function callTool<T = any>(app: App, name: string, args: Record<string, any>): Promise<T | null> {
  const result = await app.callServerTool({ name, arguments: args });
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    console.warn(`[callTool ${name}] non-JSON result:`, text);
    return null;
  }
}

// Game constants — referenced by viewport + stats + controls.
export const CHUNK = 8;
