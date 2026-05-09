import { useEffect, useRef, useState } from "react";
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { attachAppBridge, fetchUiHtml } from "@/lib/mcp-host";

export function McpAppFrame({ resourceUri }: { resourceUri: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

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

  useEffect(() => {
    if (!html || !iframeRef.current) return;
    const iframe = iframeRef.current;
    let bridge: AppBridge | null = null;
    const onLoad = () => {
      attachAppBridge(iframe)
        .then((b) => {
          bridge = b;
        })
        .catch((e) => console.warn("[McpAppFrame] bridge attach failed:", e));
    };
    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      void bridge?.close?.();
    };
  }, [html]);

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
