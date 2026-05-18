#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-.}"

if [[ ! -e "$TARGET" ]]; then
  echo "Target does not exist: $TARGET" >&2
  exit 2
fi

if ! command -v rg >/dev/null 2>&1; then
  echo "ripgrep (rg) is required for this scan." >&2
  exit 2
fi

echo "Scanning for likely dToken secrets in: $TARGET"

PATTERN='(sk-[A-Za-z0-9_.-]{24,}|sk-sp-[A-Za-z0-9_.-]{24,}|privateKey[[:space:]]*[:=][[:space:]]*["'\'']?0x[0-9a-fA-F]{64}|(PRIVATE_KEY|DTOKEN_PROVIDER_PRIVATE_KEY|DTOKEN_SERVICE_SIGNER_KEY|DTOKEN_UPSTREAM_[A-Z0-9_]+_KEY)[[:space:]]*=[[:space:]]*(0x[0-9a-fA-F]{64}|sk-[A-Za-z0-9_.-]{24,}|sk-sp-[A-Za-z0-9_.-]{24,})|mnemonic[[:space:]]*[:=][[:space:]]*["'\'']?[a-z]+([[:space:]]+[a-z]+){11,}|password[[:space:]]*[:=][[:space:]]*["'\'']?[^<[:space:]]{8,}|Bearer[[:space:]]+[A-Za-z0-9_.-]{24,})'

set +e
rg -n --hidden \
  --glob '!**/node_modules/**' \
  --glob '!**/*.app/**' \
  --glob '!**/vendor/**' \
  --glob '!**/package-lock.json' \
  --glob '!**/mainnet-dtoken-v0.json' \
  --glob '!**/.git/**' \
  "$PATTERN" "$TARGET"
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  echo
  echo "Potential secrets found. Review every match before publishing." >&2
  exit 1
fi

if [[ "$STATUS" -eq 1 ]]; then
  echo "No likely secrets found by this scan."
  exit 0
fi

echo "Secret scan failed with status $STATUS." >&2
exit "$STATUS"
