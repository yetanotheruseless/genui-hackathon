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

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import type { Request, Response } from "express";
import { createServer, getGalaxies, hydrateGalaxy } from "./server.js";
import { closePersistence, loadAllGalaxies, openPersistence, persistenceEnabled, snapshotAll } from "./persistence.js";

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
  const shutdown = () => {
    flushPersistence();
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
