/**
 * /new route — pick a Mind for a fresh galaxy. The gameId is allocated
 * by the server in start_starship; on spawn we navigate to
 * /game/<spawnedGameId> where GameView's reattach effect will see the
 * just-stored localStorage entry and skip straight into the panes.
 */
import { useNavigate } from "react-router-dom";
import { SetupScreen } from "@/components/SetupScreen";

export function NewGameScreen() {
  const navigate = useNavigate();
  return (
    <SetupScreen
      onSpawned={(gameId) => {
        navigate(`/game/${encodeURIComponent(gameId)}`, { replace: true });
      }}
    />
  );
}
