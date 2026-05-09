import { useEffect, useRef, useState } from "react";
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { attachAppBridge, fetchUiHtml } from "@/lib/mcp-host";

/**
 * MCP Apps host iframe.
 *
 * Two effects, both correct:
 *
 *   - `[html]` (mount): once html is ready, attach the bridge in `onLoad`,
 *     then push the *latest* toolResult (read from a ref) so the iframe's
 *     `ontoolresult` handler fires with its init payload.
 *
 *   - `[toolResult]` (update): for subsequent tool calls in the same slot
 *     (e.g. captain calls warp_to → updated cockpit toolResult), push to
 *     the existing bridge. Never remount — that would discard Three.js
 *     scene / scroll / camera state.
 *
 * Reading toolResult via a ref in the mount effect is the key to avoiding
 * the bug where Effect B early-returned because `readyRef` wasn't set
 * yet, and never re-ran because `toolResult` hadn't changed.
 */
export function McpAppFrame({
  resourceUri,
  toolResult,
}: {
  resourceUri: string;
  toolResult?: unknown;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const toolResultRef = useRef<unknown>(toolResult);
  toolResultRef.current = toolResult;

  // Fetch iframe HTML when resourceUri changes.
  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    fetchUiHtml(resourceUri)
      .then((t) => {
        if (!cancelled) setHtml(t);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [resourceUri]);

  // Mount lifecycle. Attach the bridge once the iframe has loaded, then
  // send the *latest* toolResult as the initial payload.
  useEffect(() => {
    if (!html || !iframeRef.current) return;
    const iframe = iframeRef.current;
    let cancelled = false;

    const setup = async () => {
      const tag = `[McpAppFrame ${resourceUri}]`;
      console.log(`${tag} setup begin`);
      try {
        const bridge = await attachAppBridge(iframe);
        console.log(`${tag} bridge attached`);
        if (cancelled) {
          console.log(`${tag} cancelled after attach`);
          void bridge.close?.();
          return;
        }
        bridgeRef.current = bridge;
        const initial = toolResultRef.current;
        if (initial) {
          await bridge.sendToolResult(
            initial as Parameters<AppBridge["sendToolResult"]>[0],
          );
          console.log(`${tag} sendToolResult ok`);
        } else {
          console.log(`${tag} no toolResult to send`);
        }
      } catch (e) {
        console.warn(`${tag} setup failed:`, e);
      }
    };

    if (iframe.contentDocument?.readyState === "complete") {
      void setup();
    } else {
      iframe.addEventListener("load", () => void setup(), { once: true });
    }

    return () => {
      cancelled = true;
      void bridgeRef.current?.close?.();
      bridgeRef.current = null;
    };
  }, [html]);

  // Subsequent toolResult updates: push to the existing bridge if mounted.
  // If the bridge isn't ready yet, the mount effect will pick up the
  // latest value via toolResultRef.
  useEffect(() => {
    if (!toolResult) return;
    const bridge = bridgeRef.current;
    if (!bridge) return;
    void bridge
      .sendToolResult(toolResult as Parameters<AppBridge["sendToolResult"]>[0])
      .catch((e) => console.warn("[McpAppFrame] sendToolResult failed:", e));
  }, [toolResult]);

  if (error) {
    return <div className="p-3 text-sm text-destructive">{error}</div>;
  }
  if (!html) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        loading {resourceUri}…
      </div>
    );
  }
  return (
    <iframe
      ref={iframeRef}
      srcDoc={html}
      sandbox="allow-scripts allow-forms allow-same-origin"
      className="h-full w-full border-0 bg-black"
      title={resourceUri}
    />
  );
}
