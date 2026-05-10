/**
 * Route shell. Three routes:
 *
 *   /              GameLobby — list of active galaxies (entry point on
 *                  refresh). Picking a row navigates to /game/:gameId.
 *
 *   /new           NewGameScreen — Mind picker for a fresh galaxy. The
 *                  server allocates the gameId; on spawn we navigate
 *                  to /game/:spawnedGameId.
 *
 *   /game/:gameId  GameView — three-pane layout. If localStorage has a
 *                  cached playerId for this gameId we reattach; if not,
 *                  GameView falls back to <SetupScreen> for in-galaxy
 *                  Mind selection.
 *
 * The single WebSocket-to-cockpit-backend connection is started here so
 * it lives across navigations. Tools are proxied via /tool/:name; UI
 * resources stream in over the WS as `mountSlot` notifications.
 */
import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { GameLobby } from "@/components/GameLobby";
import { GameView } from "@/components/GameView";
import { NewGameScreen } from "@/components/NewGameScreen";
import { startWs } from "@/lib/ws";

export default function App() {
  useEffect(() => { startWs(); }, []);

  return (
    <Routes>
      <Route path="/" element={<GameLobby />} />
      <Route path="/new" element={<NewGameScreen />} />
      <Route path="/game/:gameId" element={<GameView />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
