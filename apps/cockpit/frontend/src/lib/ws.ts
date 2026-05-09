import { useCockpit, type SlotName } from "./store";

export type ServerMsg =
  | { type: "hello"; sessionId: string }
  | { type: "state"; state: unknown }
  | { type: "mount"; slot: SlotName; resourceUri: string; toolResult?: unknown }
  | { type: "captain-token"; text: string }
  | { type: "captain-tool"; name: string; args: unknown; result: unknown }
  | { type: "captain-done" }
  | { type: "captain-error"; error: string };

const WS_URL = (() => {
  const fromEnv = import.meta.env.VITE_WS_URL;
  if (fromEnv) return fromEnv;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
})();

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;

export function startWs() {
  if (ws) return;
  connect();
}

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onmessage = (e) => {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(String(e.data)) as ServerMsg;
    } catch {
      return;
    }
    dispatch(msg);
  };
  ws.onclose = () => {
    ws = null;
    if (reconnectTimer != null) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1000);
  };
  ws.onerror = (e) => console.warn("[ws] error:", e);
}

type Listener = (msg: ServerMsg) => void;
const listeners = new Set<Listener>();

export function onWsMessage(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function dispatch(msg: ServerMsg) {
  const store = useCockpit.getState();
  switch (msg.type) {
    case "hello":
      store.setSession(msg.sessionId);
      // Backend restarted or first connect — if we already have a player,
      // re-bind so the new session resumes pushing state.
      if (store.gameId && store.playerId) {
        send({ type: "bind", gameId: store.gameId, playerId: store.playerId });
      }
      break;
    case "state":
      store.setGameState(msg.state);
      break;
    case "mount":
      store.mountSlot(msg.slot, msg.resourceUri, msg.toolResult);
      break;
    case "captain-token":
    case "captain-tool":
    case "captain-done":
    case "captain-error":
      break;
  }
  for (const fn of listeners) fn(msg);
}

export function send(msg: unknown) {
  ws?.send(JSON.stringify(msg));
}

export function bindWsPlayer(gameId: string, playerId: string) {
  send({ type: "bind", gameId, playerId });
  useCockpit.getState().bindPlayer(gameId, playerId);
}

export function sendCaptainMessage(message: string) {
  send({ type: "captain", message });
}
