#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PORT="${DTOKEN_PROVIDER_CONSOLE_PORT:-8792}"
HOST="${DTOKEN_PROVIDER_CONSOLE_HOST:-127.0.0.1}"
BASE_URL="${DTOKEN_PROVIDER_CONSOLE_PUBLIC_BASE_URL:-http://${HOST}:${PORT}}"
DATA_DIR="${DTOKEN_PROVIDER_CONSOLE_DATA:-$HOME/Library/Application Support/dToken Provider Chrome/server}"
PID_FILE="$DATA_DIR/provider-console.pid"
LOG_FILE="$DATA_DIR/provider-console.log"
DEPLOY_DIR="$ROOT_DIR/deploy"

mkdir -p "$DATA_DIR"

find_python() {
  if [[ -n "${DTOKEN_PYTHON_BIN:-}" && -x "${DTOKEN_PYTHON_BIN:-}" ]]; then
    printf '%s\n' "$DTOKEN_PYTHON_BIN"
    return 0
  fi
  for candidate in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  command -v python3 2>/dev/null || return 1
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

is_server_ready() {
  curl -fsS --max-time 1 "${BASE_URL%/}/" >/dev/null 2>&1
}

start_server() {
  if is_server_ready; then
    SERVER_PID=""
    return 0
  fi

  local python_bin
  python_bin="$(find_python)" || {
    echo "python3 was not found. Install Python 3 first." >&2
    exit 1
  }

  if [[ ! -f "$DEPLOY_DIR/index.html" ]]; then
    echo "Provider Console asset not found: $DEPLOY_DIR/index.html" >&2
    exit 1
  fi

  if [[ "${DTOKEN_DETACH:-0}" == "1" ]]; then
    nohup "$python_bin" -m http.server "$PORT" --bind "$HOST" --directory "$DEPLOY_DIR" </dev/null >>"$LOG_FILE" 2>&1 &
  else
    "$python_bin" -m http.server "$PORT" --bind "$HOST" --directory "$DEPLOY_DIR" >>"$LOG_FILE" 2>&1 &
  fi
  SERVER_PID="$!"
  if [[ "${DTOKEN_DETACH:-0}" == "1" ]]; then
    disown "$SERVER_PID" 2>/dev/null || true
  fi
  echo "$SERVER_PID" > "$PID_FILE"

  for _ in {1..60}; do
    if is_server_ready; then
      return 0
    fi
    sleep 0.2
  done

  echo "Provider Console did not become ready. See log: $LOG_FILE" >&2
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

start_server
open_chrome_app

echo "dToken Provider Console is running at ${BASE_URL%/}/"
echo "Server log: $LOG_FILE"

if [[ -n "${SERVER_PID:-}" && "${DTOKEN_DETACH:-0}" != "1" ]]; then
  trap 'kill "$SERVER_PID" 2>/dev/null || true; rm -f "$PID_FILE"' INT TERM EXIT
  wait "$SERVER_PID"
fi
