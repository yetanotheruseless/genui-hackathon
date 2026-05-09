import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const STAR_SYSTEMS_URL =
  import.meta.env.VITE_STAR_SYSTEMS_URL ?? "http://localhost:3030/mcp";

let clientPromise: Promise<Client> | null = null;

export function getMcpClient(): Promise<Client> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const client = new Client({ name: "cockpit-host", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(STAR_SYSTEMS_URL));
    await client.connect(transport);
    return client;
  })();
  return clientPromise;
}

export async function attachAppBridge(iframe: HTMLIFrameElement): Promise<AppBridge> {
  const client = await getMcpClient();
  const win = iframe.contentWindow;
  if (!win) throw new Error("iframe.contentWindow not ready");
  const bridge = new AppBridge(
    client,
    { name: "cockpit-host", version: "0.1.0" },
    {},
  );
  const transport = new PostMessageTransport(win, win);
  await bridge.connect(transport);
  return bridge;
}

export async function fetchUiHtml(resourceUri: string): Promise<string> {
  const r = await fetch(`/ui?uri=${encodeURIComponent(resourceUri)}`);
  if (!r.ok) throw new Error(`/ui ${resourceUri} -> ${r.status}`);
  return r.text();
}
