import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useCockpit } from "@/lib/store";
import { callTool, parseToolText } from "@/lib/tool-call";
import { bindWsPlayer, onWsMessage, sendCaptainMessage } from "@/lib/ws";

type ToolMark = { name: string; isError?: boolean };
type Turn =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string; tools: ToolMark[] }
  | { id: string; kind: "error"; text: string };

export function CaptainChat() {
  const sessionId = useCockpit((s) => s.sessionId);
  const playerId = useCockpit((s) => s.playerId);
  const gameId = useCockpit((s) => s.gameId);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-bootstrap once the WS is connected.
  useEffect(() => {
    if (!sessionId || playerId) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await callTool("start_starship", { seed: 42, gameId: "demo" });
        const init = parseToolText<{ gameId: string; playerId: string }>(result);
        if (cancelled || !init) return;
        bindWsPlayer(init.gameId, init.playerId);
        // Sequential, not Promise.all — three concurrent AppBridge.connect
        // calls on the same shared MCP Client race on shared notification
        // handler state. Sequencing dodges that.
        await callTool("open_compendium", { gameId: init.gameId, playerId: init.playerId });
        await callTool("open_bridge",     { gameId: init.gameId, playerId: init.playerId });
      } catch (e) {
        if (!cancelled) setBootstrapError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, playerId]);

  // Subscribe to captain stream events.
  useEffect(() => {
    return onWsMessage((msg) => {
      if (msg.type === "captain-token") {
        setTurns((prev) => appendAssistantToken(prev, msg.text));
      } else if (msg.type === "captain-tool") {
        setTurns((prev) => appendAssistantTool(prev, { name: msg.name }));
      } else if (msg.type === "captain-error") {
        setTurns((prev) => [...prev, { id: cryptoId(), kind: "error", text: msg.error }]);
        setBusy(false);
      } else if (msg.type === "captain-done") {
        setBusy(false);
      }
    });
  }, []);

  // Autoscroll on new content.
  useEffect(() => {
    const el = scrollRef.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy || !playerId) return;
    setTurns((prev) => [...prev, { id: cryptoId(), kind: "user", text }]);
    setInput("");
    setBusy(true);
    sendCaptainMessage(text);
  };

  if (!sessionId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        connecting…
      </div>
    );
  }
  if (!playerId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {bootstrapError ? (
          <span className="text-destructive">{bootstrapError}</span>
        ) : (
          "spawning vessel…"
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
        game · {gameId} · player · {playerId.slice(0, 8)}
      </div>

      <ScrollArea className="flex-1">
        <div ref={scrollRef} className="flex flex-col gap-2 p-3 text-sm">
          {turns.length === 0 && !busy ? (
            <div className="text-muted-foreground/60">
              orders for the captain — try "warp to Sirius" or "list the stars within 10 light-years".
            </div>
          ) : null}
          {turns.map((t) => (
            <TurnView key={t.id} turn={t} />
          ))}
          {busy ? (
            <div className="text-xs text-muted-foreground/60">captain thinking…</div>
          ) : null}
        </div>
      </ScrollArea>

      <form onSubmit={handleSubmit} className="flex gap-2 border-t p-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="orders, captain…"
          disabled={busy}
          autoFocus
        />
        <Button type="submit" disabled={busy || !input.trim()}>
          send
        </Button>
      </form>
    </div>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  if (turn.kind === "user") {
    return (
      <div className="self-end max-w-[90%] rounded bg-primary/10 px-3 py-1.5 text-primary">
        {turn.text}
      </div>
    );
  }
  if (turn.kind === "error") {
    return (
      <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
        {turn.text}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {turn.tools.length ? (
        <div className="flex flex-wrap gap-1">
          {turn.tools.map((t, i) => (
            <span
              key={i}
              className="rounded bg-accent/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              ▶ {t.name}
            </span>
          ))}
        </div>
      ) : null}
      {turn.text ? <div>{turn.text}</div> : null}
    </div>
  );
}

function appendAssistantToken(prev: Turn[], delta: string): Turn[] {
  const last = prev[prev.length - 1];
  if (last && last.kind === "assistant") {
    return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
  }
  return [...prev, { id: cryptoId(), kind: "assistant", text: delta, tools: [] }];
}

function appendAssistantTool(prev: Turn[], mark: ToolMark): Turn[] {
  const last = prev[prev.length - 1];
  if (last && last.kind === "assistant") {
    return [...prev.slice(0, -1), { ...last, tools: [...last.tools, mark] }];
  }
  return [...prev, { id: cryptoId(), kind: "assistant", text: "", tools: [mark] }];
}

function cryptoId() {
  return Math.random().toString(36).slice(2, 10);
}
