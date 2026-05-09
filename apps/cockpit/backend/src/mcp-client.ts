import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const STAR_SYSTEMS_URL = process.env.STAR_SYSTEMS_URL ?? "http://localhost:3030/mcp";

export type ToolContent = { type: string; text?: string; [k: string]: unknown };

export type ToolCallResult = {
  content: ToolContent[];
  isError?: boolean;
  _meta?: { ui?: { resourceUri?: string; slot?: string } };
};

let clientPromise: Promise<Client> | null = null;

export function getMcpClient(): Promise<Client> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const client = new Client({ name: "cockpit-backend", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(STAR_SYSTEMS_URL));
    await client.connect(transport);
    console.log(`[mcp] connected to ${STAR_SYSTEMS_URL}`);
    return client;
  })();
  return clientPromise;
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const client = await getMcpClient();
  const result = await client.callTool({ name, arguments: args });
  return result as unknown as ToolCallResult;
}

export async function readResourceText(uri: string): Promise<string> {
  const client = await getMcpClient();
  const result = await client.readResource({ uri });
  const first = result.contents?.[0];
  const text = first && "text" in first ? first.text : undefined;
  if (typeof text !== "string") {
    throw new Error(`resource ${uri} has no text content`);
  }
  return text;
}

export function parseToolText<T = unknown>(result: ToolCallResult): T | null {
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// MCP Apps put the UI resource URI + slot hint on the tool *definition*,
// not on call results. We cache the listing once and attach the relevant
// _meta.ui block onto each /tool/:name response.
type ToolUiMeta = { resourceUri?: string; slot?: string };
let toolUiCache: Map<string, ToolUiMeta> | null = null;

export async function getToolUiMeta(name: string): Promise<ToolUiMeta | undefined> {
  if (!toolUiCache) {
    const client = await getMcpClient();
    const list = await client.listTools();
    toolUiCache = new Map();
    for (const tool of list.tools) {
      const meta = (tool as { _meta?: { ui?: ToolUiMeta } })._meta;
      if (meta?.ui) toolUiCache.set(tool.name, meta.ui);
    }
  }
  return toolUiCache.get(name);
}
