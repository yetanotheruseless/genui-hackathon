/**
 * Entry-point lobby. Lists every active galaxy from list_galaxies and
 * lets the user click into one (-> /game/:gameId) or start a fresh
 * galaxy (-> /new).
 *
 * Refresh always lands here when the URL is "/", which is the whole
 * point of routing the lobby separately — refresh in the cockpit lands
 * back in the cockpit, refresh on "/" lands in the lobby.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { callTool, parseToolText } from "@/lib/tool-call";

type GalaxySummary = {
  gameId: string;
  createdAt: number;
  seed: number;
  playerCount: number;
  orbitalCount: number;
  players: { shipName: string; shipClass: string; mindId: string; mindName: string }[];
};

function relTime(ts: number): string {
  const dt = Date.now() - ts;
  if (dt < 60_000) return "just now";
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)}h ago`;
  return `${Math.round(dt / 86_400_000)}d ago`;
}

export function GameLobby() {
  const navigate = useNavigate();
  const [galaxies, setGalaxies] = useState<GalaxySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const refresh = async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await callTool("list_galaxies", {});
      const init = parseToolText<{ galaxies: GalaxySummary[] }>(r);
      setGalaxies(init?.galaxies ?? []);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return galaxies;
    return galaxies.filter((g) =>
      g.gameId.toLowerCase().includes(q)
      || g.players.some((p) =>
        p.shipName.toLowerCase().includes(q)
        || p.mindName.toLowerCase().includes(q)
      ),
    );
  }, [galaxies, filter]);

  return (
    <div className="grid h-screen place-items-center bg-background p-6 overflow-auto">
      <Card className="w-full max-w-3xl">
        <CardHeader>
          <CardTitle className="font-mono text-sm uppercase tracking-widest text-muted-foreground">
            Culture Contact · pick a galaxy
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter by gameId, ship name, or Mind…"
              className="flex-1 rounded border border-border bg-input px-3 py-2 text-sm"
              autoComplete="off"
            />
            <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
              {loading ? "…" : "refresh"}
            </Button>
          </div>

          {err ? (
            <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {err}
            </div>
          ) : null}

          <div className="grid gap-2">
            {loading ? (
              <div className="text-sm text-muted-foreground/60">loading galaxies…</div>
            ) : filtered.length === 0 ? (
              <div className="text-sm italic text-muted-foreground/60">
                {galaxies.length === 0 ? "no galaxies yet — start one below." : "no matches."}
              </div>
            ) : filtered.map((g) => {
              // Show a "+ new vessel" affordance when localStorage has a
              // cached playerId for this gameId — otherwise the row's
              // default click auto-reattaches and there's no path to
              // join the galaxy with a fresh Mind. The "+" button
              // navigates with ?join=new which GameView interprets as
              // "skip reattach, show SetupScreen."
              const hasCached = !!localStorage.getItem(`cockpit-player-id:${g.gameId}`);
              return (
                <div
                  key={g.gameId}
                  className="group flex items-stretch rounded border border-border transition hover:border-primary"
                >
                  <button
                    onClick={() => navigate(`/game/${encodeURIComponent(g.gameId)}`)}
                    className="flex-1 px-3 py-2 text-left hover:bg-accent/30 rounded-l"
                    title={hasCached
                      ? "Resume as your cached Mind in this galaxy"
                      : "Join this galaxy — pick a Mind"}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-sm font-semibold text-primary break-all">{g.gameId}</span>
                      <span className="ml-auto text-[10px] font-mono text-muted-foreground/70 whitespace-nowrap">
                        {g.playerCount} player{g.playerCount === 1 ? "" : "s"} · {g.orbitalCount} orb · {relTime(g.createdAt)}
                      </span>
                    </div>
                    {g.players.length ? (
                      <div className="mt-1 text-[11px] text-muted-foreground/85">
                        {g.players.map((p) => `${p.shipClass} ${p.shipName}`).join(" · ")}
                      </div>
                    ) : null}
                  </button>
                  {hasCached ? (
                    <button
                      onClick={() => navigate(`/game/${encodeURIComponent(g.gameId)}?join=new`)}
                      className="border-l border-border px-3 text-[10px] font-mono uppercase tracking-widest text-muted-foreground/70 hover:bg-accent/30 hover:text-foreground rounded-r"
                      title="Join this galaxy with a NEW Mind (ignore cached vessel)"
                    >
                      + new vessel
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between border-t border-border/40 pt-3">
            <div className="text-[10px] font-mono text-muted-foreground/60">
              {galaxies.length} galaxy{galaxies.length === 1 ? "" : "ies"} on this server
            </div>
            <Button onClick={() => navigate("/new")}>start new galaxy</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
