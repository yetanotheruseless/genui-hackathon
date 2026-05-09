import { callTool, parseToolText } from "./mcp-client.js";

export type SessionId = string;

export type SessionState = {
  id: SessionId;
  gameId: string;
  playerId: string;
  /** Last init payload from start_starship. */
  init: unknown | null;
  /** Last get_state payload. */
  state: unknown | null;
};

type Listener = (s: SessionState) => void;

type SessionInternal = SessionState & {
  listeners: Set<Listener>;
  /** JSON of last broadcast state, used for cheap diffing. */
  lastJson: string;
};

const sessions = new Map<SessionId, SessionInternal>();

export function createSession(id: SessionId): SessionState {
  const s: SessionInternal = {
    id,
    gameId: "",
    playerId: "",
    init: null,
    state: null,
    listeners: new Set(),
    lastJson: "",
  };
  sessions.set(id, s);
  return snapshot(s);
}

export function destroySession(id: SessionId): void {
  sessions.delete(id);
}

export function bindSessionPlayer(
  id: SessionId,
  gameId: string,
  playerId: string,
  init: unknown | null,
): void {
  const s = sessions.get(id);
  if (!s) return;
  s.gameId = gameId;
  s.playerId = playerId;
  if (init) s.init = init;
}

export function listSessionIds(): SessionId[] {
  return [...sessions.keys()];
}

export function getSession(id: SessionId): SessionState | undefined {
  const s = sessions.get(id);
  return s ? snapshot(s) : undefined;
}

export function subscribe(id: SessionId, fn: Listener): () => void {
  const s = sessions.get(id);
  if (!s) throw new Error(`unknown session: ${id}`);
  s.listeners.add(fn);
  // Fire once with current state so subscribers don't wait for the next diff.
  fn(snapshot(s));
  return () => {
    s.listeners.delete(fn);
  };
}

function snapshot(s: SessionInternal): SessionState {
  return {
    id: s.id,
    gameId: s.gameId,
    playerId: s.playerId,
    init: s.init,
    state: s.state,
  };
}

function broadcastIfChanged(s: SessionInternal, nextState: unknown): void {
  const json = JSON.stringify(nextState);
  if (json === s.lastJson) return;
  s.state = nextState;
  s.lastJson = json;
  const snap = snapshot(s);
  for (const fn of s.listeners) fn(snap);
}

/**
 * Single tick that polls get_state for every bound session and broadcasts
 * to subscribers when state changed. Coalesces by (gameId,playerId) so
 * multiple tabs viewing the same player don't multiply the load.
 */
async function pollOnce(): Promise<void> {
  type Key = string;
  const groups = new Map<Key, SessionInternal[]>();
  for (const s of sessions.values()) {
    if (!s.gameId || !s.playerId) continue;
    const key = `${s.gameId}::${s.playerId}`;
    const group = groups.get(key) ?? [];
    group.push(s);
    groups.set(key, group);
  }

  await Promise.all(
    [...groups.entries()].map(async ([, group]) => {
      const head = group[0];
      try {
        const result = await callTool("get_state", {
          gameId: head.gameId,
          playerId: head.playerId,
        });
        const parsed = parseToolText(result);
        if (parsed === null) return;
        for (const s of group) broadcastIfChanged(s, parsed);
      } catch (e) {
        console.warn(`[state] poll failed for ${head.gameId}/${head.playerId}:`, e);
      }
    }),
  );
}

let pollTimer: NodeJS.Timeout | null = null;

export function startPolling(intervalMs: number = 500): void {
  if (pollTimer) return;
  const tick = () => {
    pollOnce().finally(() => {
      pollTimer = setTimeout(tick, intervalMs);
    });
  };
  pollTimer = setTimeout(tick, intervalMs);
}

export function stopPolling(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}
