/**
 * Pre-game vessel-selection screen. Shown when:
 *  - the user is creating a new galaxy (`/new` route), in which case
 *    `gameId` is undefined and the server allocates a fresh one; or
 *  - the user is joining an existing galaxy (`/game/:gameId` route)
 *    that they don't have a player in yet.
 *
 * Once the player spawns, we persist their playerId in localStorage
 * (per-gameId) so a tab refresh reattaches without showing this screen
 * again. The `onSpawned` callback lets the parent route decide what to
 * do next — `/new` navigates to `/game/<spawnedGameId>`, while
 * `/game/:gameId` just lets the existing reattach effect take over.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { callTool, parseToolText } from "@/lib/tool-call";
import { bindWsPlayer } from "@/lib/ws";

type Mind = { id: string; name: string; shipClass: string; tagline: string };

const SHIP_CLASS_HINT: Record<string, string> = {
  GCU: "General Contact Unit · curious, talkative",
  LSV: "Limited Systems Vehicle · older Minds, strong opinions",
  ROU: "Rapid Offensive Unit · bored, dangerous, retired",
  GOU: "General Offensive Unit · watchful warship",
};

type SetupScreenProps = {
  /** Existing galaxy to join, or undefined to create a fresh one. */
  gameId?: string;
  /** Called after a successful spawn with the (possibly server-allocated) ids. */
  onSpawned?: (gameId: string, playerId: string) => void;
};

export function SetupScreen({ gameId, onSpawned }: SetupScreenProps) {
  const [minds, setMinds] = useState<Mind[]>([]);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);   // null = surprise me
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await callTool("list_minds", {});
        const init = parseToolText<{ minds: Mind[] }>(r);
        if (!cancelled && init?.minds) setMinds(init.minds);
      } catch (e) {
        if (!cancelled) setErr(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const spawn = async () => {
    setBusy(true);
    setErr(null);
    try {
      const result = await callTool("start_starship", {
        seed: Math.floor(Math.random() * 1_000_000),
        // Omit gameId entirely when creating new — server allocates one.
        ...(gameId ? { gameId } : {}),
        ...(picked ? { mind_id: picked } : {}),
      });
      const init = parseToolText<{ gameId: string; playerId: string }>(result);
      if (!init?.playerId || !init.gameId) throw new Error("start_starship returned no ids");
      // Persist per-gameId so multi-game players keep one identity per
      // galaxy without colliding.
      localStorage.setItem(`cockpit-player-id:${init.gameId}`, init.playerId);
      bindWsPlayer(init.gameId, init.playerId);
      // Sequential — three concurrent AppBridge.connect on the same MCP
      // client races on shared notification handler state.
      await callTool("open_compendium", { gameId: init.gameId, playerId: init.playerId });
      await callTool("open_bridge",     { gameId: init.gameId, playerId: init.playerId });
      onSpawned?.(init.gameId, init.playerId);
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
    // Don't unset busy on success — the parent route unmounts this screen.
  };

  return (
    <div className="grid h-screen place-items-center bg-background p-6 overflow-auto">
      <Card className="w-full max-w-3xl">
        <CardHeader>
          <CardTitle className="font-mono text-sm uppercase tracking-widest text-muted-foreground">
            Culture Contact · choose your Mind
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Every Culture vessel runs on a Mind — vastly capable, opinionated, slightly bored. Pick the one you'd like to share a ship with. The Mind is the agent: talk to it in the bridge pane and it'll search catalogs, plot warps, build Orbitals, and so on.
          </p>

          {loading ? (
            <div className="text-sm text-muted-foreground/60">loading personalities…</div>
          ) : (
            <div className="grid gap-2">
              {minds.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setPicked(m.id)}
                  disabled={busy}
                  className={`text-left rounded border px-3 py-2 transition disabled:opacity-50 ${
                    picked === m.id
                      ? "border-primary bg-primary/10"
                      : "border-border hover:bg-accent/30"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest">
                      {m.shipClass}
                    </span>
                    <span className="font-semibold italic">{m.name}</span>
                    <span className="text-[10px] font-mono text-muted-foreground/70">
                      {SHIP_CLASS_HINT[m.shipClass] ?? ""}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{m.tagline}</div>
                </button>
              ))}
              <button
                onClick={() => setPicked(null)}
                disabled={busy}
                className={`text-left rounded border px-3 py-2 transition disabled:opacity-50 ${
                  picked === null
                    ? "border-primary bg-primary/10"
                    : "border-border hover:bg-accent/30"
                }`}
              >
                <div className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                  surprise me — random Mind, deterministic from seed
                </div>
              </button>
            </div>
          )}

          {err ? (
            <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {err}
            </div>
          ) : null}

          <div className="flex items-center justify-between">
            <div className="text-[10px] font-mono text-muted-foreground/60">
              {gameId ? `gameId · ${gameId}` : "new galaxy · server will allocate id"}
            </div>
            <Button onClick={spawn} disabled={busy || loading}>
              {busy ? "spawning…" : "embark"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
