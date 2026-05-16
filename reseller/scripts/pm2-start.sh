#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "Missing .env. Copy .env.example to .env and fill it first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

NAME="${DTOKEN_PM2_NAME:-dtoken-reseller}"

if pm2 describe "$NAME" >/dev/null 2>&1; then
  echo "PM2 process '$NAME' already exists. Use npm run pm2:restart to reload .env."
  exit 0
fi

pm2 start npm --name "$NAME" -- run reseller:serve
pm2 save --force
