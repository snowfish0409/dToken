#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PORT="${DTOKEN_AGENT_GATEWAY_PORT:-8789}"
HOST="${DTOKEN_AGENT_GATEWAY_HOST:-127.0.0.1}"
BASE_URL="${DTOKEN_AGENT_GATEWAY_PUBLIC_BASE_URL:-http://${HOST}:${PORT}}"
DATA_DIR="${DTOKEN_AGENT_GATEWAY_DATA:-$HOME/Library/Application Support/dToken User Chrome/gateway}"
PID_FILE="$DATA_DIR/gateway.pid"
LOG_FILE="$DATA_DIR/gateway.log"

mkdir -p "$DATA_DIR"

find_node() {
  if [[ -n "${DTOKEN_NODE_BIN:-}" && -x "${DTOKEN_NODE_BIN:-}" ]]; then
    printf '%s\n' "$DTOKEN_NODE_BIN"
    return 0
  fi
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  command -v node 2>/dev/null || return 1
}

find_chrome() {
  if [[ -n "${DTOKEN_CHROME_BIN:-}" && -x "${DTOKEN_CHROME_BIN:-}" ]]; then
    printf '%s\n' "$DTOKEN_CHROME_BIN"
    return 0
  fi
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

find_npm() {
  if [[ -n "${DTOKEN_NPM_BIN:-}" && -x "${DTOKEN_NPM_BIN:-}" ]]; then
    printf '%s\n' "$DTOKEN_NPM_BIN"
    return 0
  fi
  for candidate in /opt/homebrew/bin/npm /usr/local/bin/npm /usr/bin/npm; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  command -v npm 2>/dev/null || return 1
}

ensure_node_deps() {
  if [[ -f "$ROOT_DIR/node_modules/ethers/package.json" ]]; then
    return 0
  fi

  local npm_bin
  npm_bin="$(find_npm)" || {
    echo "npm was not found. Run npm install in $ROOT_DIR before starting." >&2
    exit 1
  }

  echo "Installing user app dependencies..." >>"$LOG_FILE"
  (cd "$ROOT_DIR" && "$npm_bin" install --omit=dev) >>"$LOG_FILE" 2>&1
}

is_gateway_ready() {
  curl -fsS --max-time 1 "$BASE_URL/health" >/dev/null 2>&1
}

start_gateway() {
  if is_gateway_ready; then
    GATEWAY_PID=""
    return 0
  fi

  local node_bin
  node_bin="$(find_node)" || {
    echo "Node.js was not found. Install Node.js first." >&2
    exit 1
  }

  export DTOKEN_AGENT_GATEWAY_HOST="$HOST"
  export DTOKEN_AGENT_GATEWAY_PORT="$PORT"
  export DTOKEN_AGENT_GATEWAY_PUBLIC_BASE_URL="$BASE_URL"
  export DTOKEN_AGENT_GATEWAY_DATA="$DATA_DIR"
  export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

  ensure_node_deps

  local gateway_script="$ROOT_DIR/apps/dtoken-agent-gateway/src/server.js"

  if [[ "${DTOKEN_DETACH:-0}" == "1" ]]; then
    nohup "$node_bin" "$gateway_script" </dev/null >>"$LOG_FILE" 2>&1 &
  else
    "$node_bin" "$gateway_script" >>"$LOG_FILE" 2>&1 &
  fi
  GATEWAY_PID="$!"
  if [[ "${DTOKEN_DETACH:-0}" == "1" ]]; then
    disown "$GATEWAY_PID" 2>/dev/null || true
  fi
  echo "$GATEWAY_PID" > "$PID_FILE"

  for _ in {1..60}; do
    if is_gateway_ready; then
      return 0
    fi
    sleep 0.2
  done

  echo "Gateway did not become ready. See log: $LOG_FILE" >&2
  exit 1
}

open_chrome_app() {
  local url="${BASE_URL%/}/"
  if [[ "${DTOKEN_CHROME_MODE:-app}" == "tab" ]]; then
    open -a "Google Chrome" "$url"
    return 0
  fi

  local chrome_bin
  chrome_bin="$(find_chrome)" || {
    echo "Google Chrome was not found. Opening in the default browser instead." >&2
    open "$url"
    return 0
  }

  "$chrome_bin" --app="$url" >/dev/null 2>&1 &
}

start_gateway
open_chrome_app

echo "dToken User is running at ${BASE_URL%/}/"
echo "Gateway log: $LOG_FILE"

if [[ -n "${GATEWAY_PID:-}" && "${DTOKEN_DETACH:-0}" != "1" ]]; then
  trap 'kill "$GATEWAY_PID" 2>/dev/null || true; rm -f "$PID_FILE"' INT TERM EXIT
  wait "$GATEWAY_PID"
fi
