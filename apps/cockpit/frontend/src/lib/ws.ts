import { useCockpit, type SlotName } from "./store";

type ServerMsg =
  | { type: "hello"; sessionId: string }
  | { type: "state"; state: unknown }
  | { type: "mount"; slot: SlotName; resourceUri: string }
  | { type: "captain-token"; text: string }
  | { type: "captain-tool"; name: string; args: unknown; result: unknown }
  | { type: "captain-done" };

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

function dispatch(msg: ServerMsg) {
  const store = useCockpit.getState();
  switch (msg.type) {
    case "hello":
      store.setSession(msg.sessionId);
      return;
    case "state":
      store.setGameState(msg.state);
      return;
    case "mount":
      store.mountSlot(msg.slot, msg.resourceUri);
      return;
    case "captain-token":
    case "captain-tool":
    case "captain-done":
      // Handled by CaptainChat (task #9). Ignored at the WS layer.
      return;
  }
}

export function send(msg: unknown) {
  ws?.send(JSON.stringify(msg));
}

export function bindWsPlayer(gameId: string, playerId: string) {
  send({ type: "bind", gameId, playerId });
  useCockpit.getState().bindPlayer(gameId, playerId);
}
