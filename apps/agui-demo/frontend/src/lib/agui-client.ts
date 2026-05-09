import type { AGUIEvent } from "./types";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_AGUI_BACKEND_URL ?? "http://localhost:8765";

export interface RunOptions {
  threadId: string;
  runId: string;
  userMessage: string;
  signal?: AbortSignal;
}

/**
 * POST a single user turn to the AG-UI backend and yield typed events as
 * they stream in. Pure SSE parsing — no client SDK required, which is exactly
 * the point of AG-UI being a wire protocol rather than a library.
 */
export async function* runAgent(opts: RunOptions): AsyncGenerator<AGUIEvent> {
  const body = {
    threadId: opts.threadId,
    runId: opts.runId,
    state: {},
    messages: [
      { id: crypto.randomUUID(), role: "user", content: opts.userMessage },
    ],
    tools: [],
    context: [],
    forwardedProps: {},
  };

  const res = await fetch(`${BACKEND_URL}/agent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`agent request failed: ${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // SSE frames are separated by blank lines. Each frame may have multiple
    // `field: value` lines. We only care about `data: ...` from this server.
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) {
          const json = line.slice("data: ".length);
          try {
            yield JSON.parse(json) as AGUIEvent;
          } catch (e) {
            console.warn("agui-client: bad SSE frame", json, e);
          }
        }
      }
    }
  }
}
