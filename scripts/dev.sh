#!/usr/bin/env bash
# Launch (or relaunch) the three Culture-Contact dev services in a tmux
# session named `genui`. Idempotent: re-running tears down any existing
# session and starts fresh.
#
#   scripts/dev.sh           — start everything
#   scripts/dev.sh stop      — kill the session and free the ports
#   scripts/dev.sh attach    — attach to the running session
#   scripts/dev.sh status    — show port + window state
#
# After start, open http://localhost:5174 in a browser.

set -euo pipefail

SESSION="genui"
REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_PORT="${MCP_PORT:-3030}"
BACKEND_PORT="${BACKEND_PORT:-4040}"
FRONTEND_PORT="${FRONTEND_PORT:-5174}"

cmd="${1:-start}"

stop() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  for p in "$MCP_PORT" "$BACKEND_PORT" "$FRONTEND_PORT"; do
    pids=$(lsof -ti:"$p" 2>/dev/null || true)
    if [ -n "$pids" ]; then kill -9 $pids 2>/dev/null || true; fi
  done
  echo "stopped."
}

status() {
  echo "tmux session '$SESSION':"
  tmux list-windows -t "$SESSION" 2>/dev/null || echo "  (not running)"
  echo
  for label in "MCP:$MCP_PORT" "backend:$BACKEND_PORT" "frontend:$FRONTEND_PORT"; do
    name="${label%:*}"; port="${label#*:}"
    if lsof -ti:"$port" >/dev/null 2>&1; then
      echo "  $name  :$port  UP"
    else
      echo "  $name  :$port  down"
    fi
  done
}

wait_port() {
  local port="$1" name="$2"
  for _ in {1..30}; do
    if lsof -ti:"$port" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "WARN: $name (:$port) didn't come up within 15s" >&2
  return 1
}

start() {
  if [ ! -f "$REPO/.env" ]; then
    echo "WARN: $REPO/.env missing — neither server will have ANTHROPIC_API_KEY" >&2
    echo "      create it with: echo 'ANTHROPIC_API_KEY=\"sk-ant-...\"' > $REPO/.env" >&2
  fi

  # Tear down any previous run so this is idempotent.
  stop >/dev/null 2>&1 || true

  # `npm start` does the right composite thing: tsx-watch the MCP server
  # AND vite-watch all three iframe panes so edits to cockpit-main.ts
  # (which bundles into dist/cockpit.html) don't get silently stranded.
  tmux new-session -d -s "$SESSION" -n mcp -c "$REPO/apps/star-systems-demo/server"
  tmux send-keys  -t "$SESSION:mcp"      "PORT=$MCP_PORT npm start" C-m

  tmux new-window -t "$SESSION" -n backend  -c "$REPO/apps/cockpit/backend"
  tmux send-keys  -t "$SESSION:backend"  "PORT=$BACKEND_PORT npm run dev" C-m

  tmux new-window -t "$SESSION" -n frontend -c "$REPO/apps/cockpit/frontend"
  tmux send-keys  -t "$SESSION:frontend" "npm run dev" C-m

  echo "starting…"
  wait_port "$MCP_PORT"      "mcp"      || true
  wait_port "$BACKEND_PORT"  "backend"  || true
  wait_port "$FRONTEND_PORT" "frontend" || true
  echo
  status
  echo
  echo "open: http://localhost:$FRONTEND_PORT"
  echo "attach: tmux attach -t $SESSION"
}

attach() {
  tmux attach -t "$SESSION"
}

case "$cmd" in
  start)  start ;;
  stop)   stop ;;
  status) status ;;
  attach) attach ;;
  restart) stop; sleep 1; start ;;
  *)      echo "usage: $0 {start|stop|restart|status|attach}" >&2; exit 2 ;;
esac
