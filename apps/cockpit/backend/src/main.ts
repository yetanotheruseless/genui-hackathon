import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { callTool, getToolUiMeta, readResourceText } from "./mcp-client.js";
import {
  bindSessionPlayer,
  createSession,
  destroySession,
  startPolling,
  subscribe,
} from "./state.js";

type ClientMessage =
  | { type: "bind"; gameId: string; playerId: string }
  | { type: "captain"; message: string };

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true, service: "cockpit-backend" }));

// Tool-call passthrough. The MCP Apps host bridge in the browser POSTs
// here whenever an iframe (or app code) calls a tool. Body shape:
//   { args: { ... } }
// Returns the raw MCP CallToolResult, including _meta.ui so the frontend
// can decide whether to mount/swap an iframe in a slot.
app.post("/tool/:name", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json().catch(() => ({}));
  const args = (body as { args?: Record<string, unknown> }).args ?? {};
  try {
    const result = await callTool(name, args);
    const ui = await getToolUiMeta(name);
    if (ui) {
      result._meta = { ...(result._meta ?? {}), ui };
    }
    return c.json(result);
  } catch (e) {
    console.error(`[tool] ${name} failed:`, e);
    return c.json({ error: String(e), name }, 500);
  }
});

// Resource fetch. Hosts the iframe HTML by URI so the frontend can mount
//   <iframe srcdoc={fetched}>  (or  src="/ui?uri=..."  if we let the
// browser fetch it directly).
app.get("/ui", async (c) => {
  const uri = c.req.query("uri");
  if (!uri) return c.text("missing ?uri=", 400);
  try {
    const html = await readResourceText(uri);
    return c.body(html, 200, { "content-type": "text/html; charset=utf-8" });
  } catch (e) {
    console.error(`[ui] read ${uri} failed:`, e);
    return c.text(String(e), 500);
  }
});

// WebSocket: state push + captain stream. One WS = one session = one
// browser tab.
app.get(
  "/ws",
  upgradeWebSocket(() => {
    let sessionId = "";
    let unsubscribe: (() => void) | null = null;

    return {
      onOpen: (_e, ws) => {
        sessionId = randomUUID();
        createSession(sessionId);
        ws.send(JSON.stringify({ type: "hello", sessionId }));
      },
      onMessage: (e, ws) => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(e.data)) as ClientMessage;
        } catch {
          return;
        }
        if (msg.type === "bind") {
          bindSessionPlayer(sessionId, msg.gameId, msg.playerId, null);
          unsubscribe?.();
          unsubscribe = subscribe(sessionId, (s) => {
            ws.send(JSON.stringify({ type: "state", state: s.state }));
          });
        } else if (msg.type === "captain") {
          // Captain agent loop wired up in task #8. Acknowledge for now.
          ws.send(JSON.stringify({
            type: "captain-token",
            text: "[captain not yet implemented]",
          }));
          ws.send(JSON.stringify({ type: "captain-done" }));
        }
      },
      onClose: () => {
        unsubscribe?.();
        if (sessionId) destroySession(sessionId);
      },
    };
  }),
);

const port = parseInt(process.env.PORT ?? "4040", 10);
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Cockpit backend listening on http://localhost:${info.port}`);
});
injectWebSocket(server);
startPolling(500);
