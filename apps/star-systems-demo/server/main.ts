/**
 * Transport entry.
 *  - Streamable HTTP (default, $PORT or 3030) for basic-host etc.
 *  - stdio (--stdio) for Goose desktop, Claude Desktop, VS Code extensions.
 */
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import type { Request, Response } from "express";
import * as path from "node:path";
import { createServer } from "./server.js";

async function startHttp(create: () => McpServer): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3030", 10);
  const app = createMcpExpressApp({ host: "0.0.0.0" });
  app.use(cors());

  // Static planetary imagery + the prototype HTML page. Textures are
  // fetched via `npx tsx scripts/fetch-planet-textures.ts` (CC BY 4.0
  // from Solar System Scope); the page is built into `dist/` by vite.
  // Both routes are no-ops if the corresponding files don't exist yet.
  const dataDir = path.resolve(import.meta.dirname, "data");
  const distDir = path.resolve(import.meta.dirname, "dist");
  app.use("/textures", express.static(path.join(dataDir, "textures"), { maxAge: "1h" }));
  app.get("/textures.json", (_req, res) => res.sendFile(path.join(dataDir, "textures.json")));
  app.get("/planet-prototype", (_req, res) => res.sendFile(path.join(distDir, "planet-prototype.html")));

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
    console.log(`Planet-imagery prototype at         http://localhost:${port}/planet-prototype`);
  });
  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function startStdio(create: () => McpServer): Promise<void> {
  await create().connect(new StdioServerTransport());
}

const useStdio = process.argv.includes("--stdio");
(useStdio ? startStdio : startHttp)(createServer).catch((e) => {
  console.error(e);
  process.exit(1);
});
