/**
 * Three-pane game layout. The Captain pane is gone: the Mind is the
 * agent now and lives in the bridge pane (bottom). On first load (or
 * after "switch vessel"), shows SetupScreen for Mind selection. On
 * subsequent loads, reattaches to the player whose id we cached in
 * localStorage. The side area is tabbed (Overview / Compendium) — see
 * SideArea.
 */
import { useEffect, useState } from "react";
import { SetupScreen } from "@/components/SetupScreen";
import { SideArea } from "@/components/SideArea";
import { Slot } from "@/components/Slot";
import { Button } from "@/components/ui/button";
import { useCockpit } from "@/lib/store";
import { callTool, parseToolText } from "@/lib/tool-call";
import { bindWsPlayer, startWs } from "@/lib/ws";

const GAME_ID = "demo";

export default function App() {
  const sessionId = useCockpit((s) => s.sessionId);
  const playerId = useCockpit((s) => s.playerId);
  const [reattaching, setReattaching] = useState(true);

  useEffect(() => { startWs(); }, []);

  // After WS hello, try to reattach using the cached playerId. If there
  // isn't one (or the call fails), fall through to the SetupScreen so
  // the user can pick a Mind and spawn fresh.
  useEffect(() => {
    if (!sessionId || playerId) {
      setReattaching(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const lsKey = `cockpit-player-id:${GAME_ID}`;
      const stored = localStorage.getItem(lsKey);
      if (!stored) {
        if (!cancelled) setReattaching(false);
        return;
      }
      try {
        const result = await callTool("start_starship", {
          seed: 42, gameId: GAME_ID, playerId: stored,
        });
        const init = parseToolText<{ gameId: string; playerId: string }>(result);
        if (cancelled || !init?.playerId) {
          if (!cancelled) setReattaching(false);
          return;
        }
        localStorage.setItem(lsKey, init.playerId);
        bindWsPlayer(init.gameId, init.playerId);
        // Sequential, not Promise.all — concurrent AppBridge.connect
        // calls on the same shared MCP Client race on its notification
        // handler state.
        await callTool("open_overview",    { gameId: init.gameId, playerId: init.playerId });
        await callTool("open_target_info", { gameId: init.gameId, playerId: init.playerId });
        await callTool("open_compendium",  { gameId: init.gameId, playerId: init.playerId });
        await callTool("open_bridge",      { gameId: init.gameId, playerId: init.playerId });
      } catch (e) {
        console.warn("[reattach] failed:", e);
      } finally {
        if (!cancelled) setReattaching(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, playerId]);

  if (!sessionId || reattaching) {
    return (
      <div className="grid h-screen place-items-center bg-background text-sm text-muted-foreground">
        connecting…
      </div>
    );
  }

  if (!playerId) {
    return <SetupScreen gameId={GAME_ID} />;
  }

  return (
    <div className="relative grid h-screen grid-cols-[1fr_418px] grid-rows-[1fr_320px] gap-2 p-2">
      <Slot name="viewport" hint="cockpit · 3D viewport"       className="col-start-1 row-start-1" />
      {/* Bridge no longer spans both columns — right column belongs to
          the target info card + SideArea (overview/compendium tabs). */}
      <Slot name="bottom"   hint="bridge · chat with the Mind" className="col-start-1 row-start-2" />
      {/* Right column container spanning both rows. Target pane on top
          (auto-height card), SideArea filling the rest. */}
      <div className="col-start-2 row-start-1 row-end-3 flex flex-col gap-2 min-h-0">
        <Slot name="target" hint="locked target details" className="flex-shrink-0 h-[224px]" />
        <SideArea                                        className="flex-1 min-h-0" />
      </div>
      <SwitchVesselButton />
    </div>
  );
}

function SwitchVesselButton() {
  const reset = () => {
    if (!confirm("Abandon this Mind and pick a new vessel?")) return;
    const lsKey = `cockpit-player-id:${GAME_ID}`;
    localStorage.removeItem(lsKey);
    location.reload();
  };
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={reset}
      className="absolute top-3 right-[433px] h-6 px-2 text-[10px] font-mono uppercase tracking-widest text-muted-foreground hover:text-foreground"
      title="Clear the cached playerId and return to the Mind picker"
    >
      switch vessel
    </Button>
  );
}
