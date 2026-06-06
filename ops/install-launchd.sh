#!/usr/bin/env bash
# Install the Mailordomo backend as a per-user macOS launchd service (LaunchAgent): fill the machine
# paths into the plist template and (re)bootstrap it. PURE-LOCAL — this script makes NO network calls;
# it only renders a plist and talks to launchctl. Re-runnable (it re-installs). Uninstall with:
#   launchctl bootout "gui/$(id -u)/com.mailordomo.backend" && rm ~/Library/LaunchAgents/com.mailordomo.backend.plist
set -euo pipefail

LABEL="com.mailordomo.backend"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO_ROOT/ops/$LABEL.plist"
DEST_DIR="$HOME/Library/LaunchAgents"
DEST="$DEST_DIR/$LABEL.plist"
LOG_DIR="$HOME/.mailordomo/logs"

# 1. Preconditions.
[ "$(uname)" = "Darwin" ] || { echo "error: launchd is macOS-only (uname=$(uname))." >&2; exit 1; }
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "error: node not found on PATH — install Node 22+ first." >&2; exit 1; }
NODE_DIR="$(cd "$(dirname "$NODE_BIN")" && pwd)"
[ -f "$REPO_ROOT/packages/backend/dist/api/server.js" ] || {
  echo "error: backend not built — run 'npm run build' first." >&2; exit 1; }
[ -f "$TEMPLATE" ] || { echo "error: missing template $TEMPLATE" >&2; exit 1; }

# 2. Render the plist (substitute machine paths only — no secrets) + ensure dirs.
mkdir -p "$DEST_DIR" "$LOG_DIR"
sed -e "s#__REPO__#${REPO_ROOT}#g" \
    -e "s#__HOME__#${HOME}#g" \
    -e "s#__NODE_DIR__#${NODE_DIR}#g" \
    "$TEMPLATE" > "$DEST"
chmod 0644 "$DEST"
chmod +x "$REPO_ROOT/ops/run-backend.sh"

# 3. (Re)bootstrap the per-user (gui) domain.
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$DEST"
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true

echo "Installed $LABEL -> $DEST"
echo "  node:   $NODE_BIN"
echo "  logs:   $LOG_DIR/backend.{out,err}.log"
echo "  status: launchctl print $DOMAIN/$LABEL | sed -n '1,12p'"
echo "  stop:   launchctl bootout $DOMAIN/$LABEL"
echo "Config + secrets come from $REPO_ROOT/.env (gitignored) and the macOS Keychain — never the plist."
