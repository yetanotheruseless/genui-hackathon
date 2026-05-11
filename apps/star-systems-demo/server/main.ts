/**
 * Transport entry.
 *  - Streamable HTTP (default, $PORT or 3030) for basic-host etc.
 *  - stdio (--stdio) for Goose desktop, Claude Desktop, VS Code extensions.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load repo-root .env. Inline parser because process.loadEnvFile only
// exists on Node 20.12+ and this repo runs on 20.9.
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoEnv = path.resolve(here, "../../../.env");
  if (fs.existsSync(repoEnv)) {
    const raw = fs.readFileSync(repoEnv, "utf-8");
    let count = 0;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = val;
        count++;
      }
    }
    console.log(`[env] loaded ${count} vars from ${repoEnv}`);
  }
}

// Rapier needs a tiny shim before importing — it expects browser globals.
// Node 20.20+ has performance/atob natively; just `self` is missing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).self ??= globalThis;

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server as ColyseusServer } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import cors from "cors";
import type { Request, Response } from "express";
import RAPIER from "@dimforge/rapier3d-deterministic-compat";
import { createServer, getGalaxies, hydrateGalaxy } from "./server.js";
import { closePersistence, loadAllGalaxies, openPersistence, persistenceEnabled, snapshotAll } from "./persistence.js";
import { StarRoom } from "./src/room.js";

// Opt-in persistence: only active when PERSIST_DB env var is set.
// Hydrate must complete before any transport accepts a request, or a
// freshly-started server could overwrite a saved galaxy with an empty
// one on its first snapshot.
const SNAPSHOT_INTERVAL_MS = 5_000;
let snapshotTimer: NodeJS.Timeout | null = null;
function initPersistence(): void {
  if (!persistenceEnabled()) return;
  openPersistence();
  // Disk JSON is `unknown`-typed; hydrateGalaxy trusts the shape (we
  // wrote it ourselves on the previous run).
  for (const snap of loadAllGalaxies()) hydrateGalaxy(snap as Parameters<typeof hydrateGalaxy>[0]);
  snapshotTimer = setInterval(() => {
    try { snapshotAll(getGalaxies()); }
    catch (e) { console.error("[persistence] snapshot failed:", e); }
  }, SNAPSHOT_INTERVAL_MS);
  snapshotTimer.unref();
}
function flushPersistence(): void {
  if (!persistenceEnabled()) return;
  if (snapshotTimer) clearInterval(snapshotTimer);
  try { snapshotAll(getGalaxies()); } catch (e) { console.error("[persistence] final snapshot failed:", e); }
  closePersistence();
}

async function startHttp(create: () => McpServer): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3030", 10);
  const app = createMcpExpressApp({ host: "0.0.0.0" });
  app.use(cors());

  // Pass 2 smoke-test page — opens a Colyseus client connection,
  // shows the authoritative state, lets you send input intents and
  // engage warp without involving the cockpit iframe. Available at
  // http://localhost:3030/smoke.
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  app.get("/smoke", (_req: Request, res: Response) => {
    res.sendFile(path.join(HERE, "smoke.html"));
  });

  app.all("/mcp", async (req: Request, res: Response) => {
    const server = create();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("MCP error:", e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });
  const httpServer = app.listen(port, () => {
    console.log(`Star-Systems MCP Apps server listening on http://localhost:${port}/mcp`);
  });

  // Pass 2: Colyseus runs on its own port (default 2567 via
  // COLYSEUS_PORT). The ADR's single-port plan (sharing the Express
  // listener) is fiddly with our existing @modelcontextprotocol/sdk
  // server.on('request') chain — easier to use two ports for the MV
  // and revisit consolidation later. Clients hit
  // ws://localhost:${COLYSEUS_PORT} for state sync + input intents;
  // MCP HTTP traffic continues on ${port}.
  const colyseusPort = parseInt(process.env.COLYSEUS_PORT ?? "2567", 10);

  // Pass 4: Rapier server-side. The WASM is base64-embedded in the
  // -compat build; init is idempotent and resolves once the module
  // is ready. Must complete before StarRoom.onCreate runs, since the
  // Room constructs a RAPIER.World there.
  await RAPIER.init();
  console.log("[rapier] deterministic build initialized");

  const colyseus = new ColyseusServer({ transport: new WebSocketTransport() });
  colyseus.define("star", StarRoom);
  await colyseus.listen(colyseusPort);
  console.log(`[colyseus] StarRoom listening on ws://localhost:${colyseusPort}`);

  const shutdown = () => {
    flushPersistence();
    void colyseus.gracefullyShutdown(false).catch(() => {});
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function startStdio(create: () => McpServer): Promise<void> {
  const shutdown = () => { flushPersistence(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await create().connect(new StdioServerTransport());
}

initPersistence();
const useStdio = process.argv.includes("--stdio");
(useStdio ? startStdio : startHttp)(createServer).catch((e) => {
  console.error(e);
  process.exit(1);
});
