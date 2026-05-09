"use client";

import { useRef, useState } from "react";
import { runAgent } from "@/lib/agui-client";
import type { AGUIEvent, RenderBlock } from "@/lib/types";
import { RenderBlocks } from "@/components/RenderBlocks";

type AssistantTurn = {
  id: string;
  text: string;
  toolCalls: { id: string; name: string; args: string; blocks?: RenderBlock[] }[];
};

type Turn = { role: "user"; id: string; text: string } | ({ role: "assistant" } & AssistantTurn);

const SUGGESTIONS = [
  "Plot the gaussian from -3 to 3.",
  "Solve a 2D bounce: phi_xx + phi_yy - V'(phi) = 0.",
  "Run a 2D Ising MC at beta=0.6 for 300 steps.",
  "Sketch a Coleman-De Luccia bubble nucleation diagram.",
  "What is the Schwarzschild radius of the sun?",
];

export default function Page() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState(SUGGESTIONS[0]);
  const [running, setRunning] = useState(false);
  const [rawEvents, setRawEvents] = useState<AGUIEvent[]>([]);
  const threadId = useRef(crypto.randomUUID()).current;

  async function send(message: string) {
    if (!message.trim() || running) return;
    setRunning(true);
    setInput("");

    const userTurn: Turn = { role: "user", id: crypto.randomUUID(), text: message };
    const assistantTurn: AssistantTurn = { id: crypto.randomUUID(), text: "", toolCalls: [] };
    setTurns((t) => [...t, userTurn, { role: "assistant", ...assistantTurn }]);

    try {
      for await (const ev of runAgent({
        threadId,
        runId: crypto.randomUUID(),
        userMessage: message,
      })) {
        setRawEvents((r) => [...r, ev]);
        setTurns((t) => applyEvent(t, assistantTurn.id, ev));
      }
    } catch (e) {
      console.error(e);
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="grid grid-cols-1 lg:grid-cols-[1fr_360px] flex-1 min-h-0">
      <section className="flex flex-col border-r border-zinc-200 dark:border-zinc-800 min-h-0">
        <header className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <div className="text-sm font-mono text-zinc-500">apps/agui-demo</div>
          <h1 className="text-lg font-semibold">AG-UI · streaming events + inline render blocks</h1>
        </header>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          {turns.length === 0 && (
            <div className="text-sm text-zinc-500 space-y-2">
              <div>Ask the physics-research agent something. Suggestions:</div>
              <ul className="space-y-1">
                {SUGGESTIONS.map((s) => (
                  <li key={s}>
                    <button onClick={() => send(s)} className="underline hover:text-zinc-200 text-left">
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {turns.map((t) =>
            t.role === "user" ? (
              <div key={t.id} className="flex justify-end">
                <div className="rounded-lg bg-sky-600 text-white px-3 py-2 max-w-[80%] text-sm">{t.text}</div>
              </div>
            ) : (
              <div key={t.id} className="space-y-3">
                {t.toolCalls.map((tc) => (
                  <div key={tc.id} className="space-y-2">
                    <div className="text-xs font-mono text-zinc-500">
                      → tool <span className="text-sky-500">{tc.name}</span>
                      {tc.args && <span className="text-zinc-400"> {tc.args}</span>}
                    </div>
                    {tc.blocks && <RenderBlocks blocks={tc.blocks} />}
                  </div>
                ))}
                {t.text && <div className="text-sm whitespace-pre-wrap">{t.text}</div>}
              </div>
            )
          )}
        </div>

        <form
          className="px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <input
            className="flex-1 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={running}
            placeholder={running ? "thinking..." : "ask the agent..."}
          />
          <button
            type="submit"
            disabled={running}
            className="rounded bg-sky-600 disabled:bg-zinc-400 text-white px-4 py-2 text-sm"
          >
            {running ? "…" : "send"}
          </button>
        </form>
      </section>

      <aside className="hidden lg:flex flex-col bg-zinc-950 text-zinc-100 overflow-hidden min-h-0">
        <div className="px-4 py-3 border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-400">
          raw AG-UI event stream ({rawEvents.length})
        </div>
        <div className="flex-1 overflow-auto px-4 py-3 font-mono text-[11px] space-y-2">
          {rawEvents.map((e, i) => (
            <div key={i}>
              <div className="text-emerald-400">{e.type}</div>
              <pre className="whitespace-pre-wrap break-all text-zinc-400">
                {JSON.stringify(e, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      </aside>
    </main>
  );
}

function applyEvent(turns: Turn[], assistantId: string, ev: AGUIEvent): Turn[] {
  return turns.map((t) => {
    if (t.role !== "assistant" || t.id !== assistantId) return t;
    switch (ev.type) {
      case "TEXT_MESSAGE_CONTENT":
        return { ...t, text: t.text + ev.delta };
      case "TOOL_CALL_START":
        return {
          ...t,
          toolCalls: [...t.toolCalls, { id: ev.toolCallId, name: ev.toolCallName, args: "" }],
        };
      case "TOOL_CALL_ARGS":
        return {
          ...t,
          toolCalls: t.toolCalls.map((tc) =>
            tc.id === ev.toolCallId ? { ...tc, args: tc.args + ev.delta } : tc
          ),
        };
      case "TOOL_CALL_RESULT": {
        try {
          const parsed = JSON.parse(ev.content) as { blocks: RenderBlock[] };
          return {
            ...t,
            toolCalls: t.toolCalls.map((tc) =>
              tc.id === ev.toolCallId ? { ...tc, blocks: parsed.blocks } : tc
            ),
          };
        } catch {
          return t;
        }
      }
      default:
        return t;
    }
  });
}
