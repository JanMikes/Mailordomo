#!/usr/bin/env bash
# Wrapper run by launchd (ops/com.mailordomo.backend.plist). It sources the repo's gitignored `.env`
# (so credentials/config live THERE or in the macOS Keychain — NEVER in the committed plist; golden
# rule #4), forces the background daemon ON, then execs the bundled backend server (loopback API + the
# poll -> triage -> ... -> draft daemon; it NEVER sends). Run a plain `npm start` instead for a foreground
# dev run with the daemon left off.
set -euo pipefail

# Resolve the repo root from this script's location (ops/ -> repo root).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Load local config + secrets if a .env is present (gitignored). `set -a` exports each assignment so the
# Node process inherits them. This is the ONLY place secrets enter the service env — never the plist.
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

# The launchd service runs the daemon by default; .env may override.
export MAILORDOMO_DAEMON="${MAILORDOMO_DAEMON:-on}"

exec node "$REPO_ROOT/packages/backend/dist/api/server.js"
