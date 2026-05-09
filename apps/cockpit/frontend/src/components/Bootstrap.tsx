import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useCockpit } from "@/lib/store";
import { callTool, parseToolText } from "@/lib/tool-call";
import { bindWsPlayer } from "@/lib/ws";

/**
 * v1 bootstrap UI. Used in the `captain` slot until task #9 replaces it
 * with a real captain chat. One click spawns a vessel and opens all three
 * panes; the slot system handles the iframe mounts.
 */
export function Bootstrap() {
  const sessionId = useCockpit((s) => s.sessionId);
  const playerId = useCockpit((s) => s.playerId);
  const gameId = useCockpit((s) => s.gameId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSpawn = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await callTool("start_starship", { seed: 42, gameId: "demo" });
      const init = parseToolText<{ gameId: string; playerId: string }>(result);
      if (!init) throw new Error("start_starship returned no init payload");
      bindWsPlayer(init.gameId, init.playerId);
      await Promise.all([
        callTool("open_compendium", { gameId: init.gameId, playerId: init.playerId }),
        callTool("open_bridge",     { gameId: init.gameId, playerId: init.playerId }),
      ]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (playerId) {
    return (
      <div className="flex h-full flex-col gap-1 p-3 font-mono text-xs text-muted-foreground">
        <div>game · {gameId}</div>
        <div>player · {playerId.slice(0, 8)}</div>
        <div className="text-muted-foreground/60">captain v1 — task #9 replaces this</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-3">
      <Button onClick={handleSpawn} disabled={!sessionId || busy}>
        {busy ? "spawning…" : sessionId ? "spawn vessel" : "connecting…"}
      </Button>
      {error ? <div className="text-xs text-destructive">{error}</div> : null}
    </div>
  );
}
