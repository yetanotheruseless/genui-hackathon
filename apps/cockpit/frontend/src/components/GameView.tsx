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
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { SetupScreen } from "@/components/SetupScreen";
import { SideArea } from "@/components/SideArea";
import { Slot } from "@/components/Slot";
import { Button } from "@/components/ui/button";
import { useCockpit } from "@/lib/store";
import { callTool, parseToolText } from "@/lib/tool-call";
import { bindWsPlayer } from "@/lib/ws";

export function GameView() {
  const { gameId } = useParams<{ gameId: string }>();
  const [search, setSearch] = useSearchParams();
  const wantsFreshJoin = search.get("join") === "new";
  const sessionId = useCockpit((s) => s.sessionId);
  const storeGameId = useCockpit((s) => s.gameId);
  const playerId = useCockpit((s) => s.playerId);
  const unbindPlayer = useCockpit((s) => s.unbindPlayer);
  const [reattaching, setReattaching] = useState(true);

  // If the URL gameId doesn't match the store's, we're navigating to a
  // different galaxy — reset playerId/slots so GameView starts fresh.
  // Without this, switching galaxies via the lobby falls straight into
  // the panes layout with stale state (last galaxy's playerId still in
  // the store).
  useEffect(() => {
    if (gameId && storeGameId && storeGameId !== gameId) {
      unbindPlayer();
    }
  }, [gameId, storeGameId, unbindPlayer]);

  // ?join=new forces a fresh Mind picker even if a cached playerId
  // exists for this gameId. Clears localStorage + the store, then
  // strips the param so a refresh/back-nav doesn't keep re-firing.
  useEffect(() => {
    if (!wantsFreshJoin || !gameId) return;
    localStorage.removeItem(`cockpit-player-id:${gameId}`);
    unbindPlayer();
    const next = new URLSearchParams(search);
    next.delete("join");
    setSearch(next, { replace: true });
  }, [wantsFreshJoin, gameId, unbindPlayer, search, setSearch]);

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
    <div className="relative grid h-screen grid-cols-[1fr_418px] grid-rows-[1fr_320px] gap-2 p-2">
      <Slot name="viewport" hint="cockpit · 3D viewport"       className="col-start-1 row-start-1" />
      {/* Bridge no longer spans both columns — right column belongs to
          the target pane + SideArea (overview/compendium tabs). */}
      <Slot name="bottom"   hint="bridge · chat with the Mind" className="col-start-1 row-start-2" />
      {/* Right column container spanning both rows. Target pane on top
          (auto-height card), SideArea filling the rest. */}
      <div className="col-start-2 row-start-1 row-end-3 flex flex-col gap-2 min-h-0">
        <Slot name="target" hint="locked target details" className="flex-shrink-0 h-[224px]" />
        <SideArea                                        className="flex-1 min-h-0" />
      </div>
      <SwitchVesselButton gameId={gameId!} />
    </div>
  );
}

function SwitchVesselButton({ gameId }: { gameId: string }) {
  const navigate = useNavigate();
  const unbindPlayer = useCockpit((s) => s.unbindPlayer);
  const reset = () => {
    if (!confirm("Abandon this Mind and pick a new vessel?")) return;
    localStorage.removeItem(`cockpit-player-id:${gameId}`);
    // Clear the Zustand binding too — without this, navigating to the
    // lobby and clicking ANY galaxy would land in the panes layout
    // with the previous gameId/playerId still in the store, bypassing
    // the Mind picker.
    unbindPlayer();
    navigate("/");
  };
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={reset}
      className="absolute top-3 right-[433px] h-6 px-2 text-[10px] font-mono uppercase tracking-widest text-muted-foreground hover:text-foreground"
      title="Clear the cached playerId and return to the lobby"
    >
      switch vessel
    </Button>
  );
}
