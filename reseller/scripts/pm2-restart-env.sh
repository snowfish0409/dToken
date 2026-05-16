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

pm2 restart "$NAME" --update-env
pm2 save --force
