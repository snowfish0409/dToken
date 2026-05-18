#!/usr/bin/env bash
set -euo pipefail

PORT="${DTOKEN_AGENT_GATEWAY_PORT:-8789}"
DATA_DIR="${DTOKEN_AGENT_GATEWAY_DATA:-$HOME/Library/Application Support/dToken User Chrome/gateway}"
PID_FILE="$DATA_DIR/gateway.pid"

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    sleep 0.5
  fi
  rm -f "$PID_FILE"
fi

for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
  kill "$pid" 2>/dev/null || true
done

for pid in $(ps -axo pid,command | awk '/user-chrome-app-next\\/scripts\\/start-chrome-app.sh|user-chrome-app-next\\/apps\\/dtoken-agent-gateway\\/src\\/server.js/ {print $1}' 2>/dev/null || true); do
  kill "$pid" 2>/dev/null || true
done

echo "dToken User gateway stopped."
