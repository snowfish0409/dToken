#!/usr/bin/env bash
set -euo pipefail

PORT="${DTOKEN_PROVIDER_CONSOLE_PORT:-8792}"
DATA_DIR="${DTOKEN_PROVIDER_CONSOLE_DATA:-$HOME/Library/Application Support/dToken Provider Chrome/server}"
PID_FILE="$DATA_DIR/provider-console.pid"

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

for pid in $(ps -axo pid,command | awk '/provider-chrome-app-next\/scripts\/start-provider-chrome-app.sh|provider-chrome-app-next\/deploy/ {print $1}' 2>/dev/null || true); do
  kill "$pid" 2>/dev/null || true
done

echo "dToken Provider Console stopped."
