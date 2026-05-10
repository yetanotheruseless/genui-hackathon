/**
 * Three-pane game layout for a specific galaxy. Mounts under
 * /game/:gameId and pulls the gameId from the URL.
 *
 * Reattach flow: on mount we look for `cockpit-player-id:<gameId>` in
 * localStorage and try to reattach via start_starship. If that succeeds
 * we mount the panes; if there's no cached id (or the call fails) we
 * fall through to <SetupScreen> for this gameId so the user can pick a
 * Mind and join. After spawn the SetupScreen unmounts and the panes
 * take over here.
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { SetupScreen } from "@/components/SetupScreen";
import { Slot } from "@/components/Slot";
import { Button } from "@/components/ui/button";
import { useCockpit } from "@/lib/store";
import { callTool, parseToolText } from "@/lib/tool-call";
import { bindWsPlayer } from "@/lib/ws";

export function GameView() {
  const { gameId } = useParams<{ gameId: string }>();
  const sessionId = useCockpit((s) => s.sessionId);
  const playerId = useCockpit((s) => s.playerId);
  const [reattaching, setReattaching] = useState(true);

  useEffect(() => {
    if (!gameId || !sessionId || playerId) {
      setReattaching(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const lsKey = `cockpit-player-id:${gameId}`;
      const stored = localStorage.getItem(lsKey);
      if (!stored) {
        if (!cancelled) setReattaching(false);
        return;
      }
      try {
        const result = await callTool("start_starship", {
          seed: 42, gameId, playerId: stored,
        });
        const init = parseToolText<{ gameId: string; playerId: string }>(result);
        if (cancelled || !init?.playerId) {
          if (!cancelled) setReattaching(false);
          return;
        }
        localStorage.setItem(lsKey, init.playerId);
        bindWsPlayer(init.gameId, init.playerId);
        await callTool("open_compendium", { gameId: init.gameId, playerId: init.playerId });
        await callTool("open_bridge",     { gameId: init.gameId, playerId: init.playerId });
      } catch (e) {
        console.warn("[reattach] failed:", e);
      } finally {
        if (!cancelled) setReattaching(false);
      }
    })();
    return () => { cancelled = true; };
  }, [gameId, sessionId, playerId]);

  if (!sessionId || reattaching) {
    return (
      <div className="grid h-screen place-items-center bg-background text-sm text-muted-foreground">
        connecting…
      </div>
    );
  }

  if (!playerId) {
    // No cached player for this gameId — let the user pick a Mind to
    // join. After spawn SetupScreen sets useCockpit.playerId via
    // bindWsPlayer, which causes this component to re-render into the
    // panes layout.
    return <SetupScreen gameId={gameId} />;
  }

  return (
    <div className="relative grid h-screen grid-cols-[1fr_380px] grid-rows-[1fr_320px] gap-2 p-2">
      <Slot name="viewport" hint="cockpit · 3D viewport"       className="col-start-1 row-start-1" />
      <Slot name="side"     hint="compendium · galaxy + log"   className="col-start-2 row-start-1" />
      {/* Bridge gets the full bottom row now that Captain is gone. */}
      <Slot name="bottom"   hint="bridge · chat with the Mind" className="col-start-1 col-end-3 row-start-2" />
      <SwitchVesselButton gameId={gameId!} />
    </div>
  );
}

function SwitchVesselButton({ gameId }: { gameId: string }) {
  const navigate = useNavigate();
  const reset = () => {
    if (!confirm("Abandon this Mind and pick a new vessel?")) return;
    localStorage.removeItem(`cockpit-player-id:${gameId}`);
    navigate("/");
  };
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={reset}
      className="absolute top-3 right-[395px] h-6 px-2 text-[10px] font-mono uppercase tracking-widest text-muted-foreground hover:text-foreground"
      title="Clear the cached playerId and return to the lobby"
    >
      switch vessel
    </Button>
  );
}
