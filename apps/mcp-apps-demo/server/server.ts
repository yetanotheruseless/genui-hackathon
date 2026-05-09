/**
 * MCP Apps server: physics-research tools whose results are rendered by an
 * **interactive HTML resource** that runs inside a sandboxed iframe in the host.
 *
 * What's novel: each tool is annotated with `_meta.ui.resourceUri` — the host
 * uses that URI to fetch the bundled UI and mount it. The UI then has a
 * bidirectional `postMessage` JSON-RPC channel back to this server, so the
 * iframe can re-call tools (`app.callServerTool(...)`) and live-update without
 * any agent involvement. The user moves the β slider; the lattice MC re-runs
 * server-side; the chart updates. The model is not in this loop.
 */
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const DIST_DIR = path.join(import.meta.dirname, "dist");
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

/**
 * Run an `agent_core` tool by shelling out to the workspace Python env.
 *
 * Trade-off: subprocess per call is slow-ish but trivially correct, and the
 * MCP server gets to be plain TS — exactly the official ext-apps shape.
 * Swap to a long-lived Python service if you ever care about latency.
 */
async function callAgentCoreTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ blocks: unknown[] }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "uv",
      [
        "run",
        "--directory",
        REPO_ROOT,
        "python",
        "-c",
        `
import json, sys
from agent_core.tools import call_tool
name = sys.argv[1]
args = json.loads(sys.argv[2])
blocks = call_tool(name, args)
print(json.dumps({"blocks": [b.model_dump() for b in blocks]}))
        `,
        name,
        JSON.stringify(args),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (err += c));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`agent_core(${name}) exit=${code}: ${err}`));
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() ?? "{}"));
      } catch {
        reject(new Error(`agent_core(${name}) bad JSON: ${out}\n${err}`));
      }
    });
  });
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "Physics Research Tools (MCP Apps)",
    version: "0.1.0",
  });

  // ---- lattice_simulate: tool + interactive UI -------------------------
  const latticeUri = "ui://physics/lattice.html";

  registerAppTool(
    server,
    "lattice_simulate",
    {
      title: "Lattice Monte-Carlo",
      description:
        "Run a lattice MC simulation and render an interactive trace. The UI lets the user adjust β and re-run from the iframe.",
      inputSchema: {
        model: z.string().default("ising_2d"),
        beta: z.number().default(0.44),
        steps: z.number().int().default(200),
      },
      _meta: { ui: { resourceUri: latticeUri } },
    },
    async (args) => {
      const result = await callAgentCoreTool("lattice_simulate", args);
      // The host parses the text content as JSON; the iframe receives it via
      // `app.ontoolresult`. The render-block dialect is shared with every
      // other demo in this repo.
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  registerAppResource(
    server,
    "Lattice MC View",
    latticeUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => {
      const html = await fs.readFile(path.join(DIST_DIR, "mcp-app.html"), "utf-8");
      return {
        contents: [{ uri: latticeUri, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    },
  );

  return server;
}
