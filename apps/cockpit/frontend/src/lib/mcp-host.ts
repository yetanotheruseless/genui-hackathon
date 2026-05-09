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

// Serialize bridge attaches. Three concurrent AppBridge.connect() calls share
// one MCP Client; each reaches setNotificationHandler(...) on the client and
// the last one wins. Queueing keeps notification routing per-bridge sane.
let attachQueue: Promise<unknown> = Promise.resolve();

export function attachAppBridge(iframe: HTMLIFrameElement): Promise<AppBridge> {
  const next = attachQueue.then(() => attachAppBridgeInner(iframe));
  attachQueue = next.catch(() => {});
  return next;
}

async function attachAppBridgeInner(iframe: HTMLIFrameElement): Promise<AppBridge> {
  const client = await getMcpClient();
  const win = iframe.contentWindow;
  if (!win) throw new Error("iframe.contentWindow not ready");
  const bridge = new AppBridge(
    client,
    { name: "cockpit-host", version: "0.1.0" },
    {},
  );
  // Wait for the iframe to complete its ui/initialize handshake before
  // returning. Otherwise the caller's sendToolResult notification can race
  // the iframe's transport-listener attach and be silently dropped,
  // leaving the pane stuck on its placeholder.
  const initialized = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`iframe ui/initialize timed out: ${iframe.title}`)),
      5000,
    );
    bridge.addEventListener("initialized", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const transport = new PostMessageTransport(win, win);
  await bridge.connect(transport);
  // The pane's setupPaneApp() in shared.ts beacons "mcp-app-pane-ready" and
  // waits for this reply before calling app.connect(). Without it, the
  // pane's ui/initialize would fire before the bridge transport is ready
  // and be silently dropped, hanging app.connect() forever.
  win.postMessage({ type: "mcp-app-host-ready" }, "*");
  await initialized;
  return bridge;
}

export async function fetchUiHtml(resourceUri: string): Promise<string> {
  const r = await fetch(`/ui?uri=${encodeURIComponent(resourceUri)}`);
  if (!r.ok) throw new Error(`/ui ${resourceUri} -> ${r.status}`);
  return r.text();
}
