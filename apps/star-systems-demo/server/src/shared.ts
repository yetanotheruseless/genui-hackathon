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
      // Contact extension uses gameId+playerId; legacy worlds use worldId
      const id = data.worldId ?? data.gameId;
      if (typeof id === "string") {
        resolveWorld(id);
        resolveInit(data);
      }
    } catch (e) {
      console.warn("[pane] bad init payload", e);
    }
  };
  app.connect();
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
