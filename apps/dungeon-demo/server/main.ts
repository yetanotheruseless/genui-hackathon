/**
 * Transport entry. Same pattern as the physics MCP Apps server:
 *  - Streamable HTTP (default, $PORT or 3020) for basic-host or any HTTP-capable host.
 *  - stdio (--stdio) for Goose desktop, Claude Desktop, VS Code extensions, etc.
 */
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import type { Request, Response } from "express";
import { createServer } from "./server.js";

async function startHttp(create: () => McpServer): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3020", 10);
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
    console.log(`Dungeon MCP Apps server listening on http://localhost:${port}/mcp`);
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
