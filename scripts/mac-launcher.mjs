/** Finder and launchd can reach the same bundle through different filesystem aliases. */
export function macLauncher() {
  return `#!/bin/bash
set -euo pipefail
umask 077
MACOS="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$MACOS/../.." && pwd)"
RESOURCES="$MACOS/../Resources"
TARGET="$HOME/Applications/Prentice.app"
LOGDIR="$HOME/.prentice/logs"
mkdir -p "$LOGDIR"
printf '%s source=%s target=%s\\n' "$(date -u +%FT%TZ)" "$APP" "$TARGET" >> "$LOGDIR/launcher-install.log"
if [ ! "$APP" -ef "$TARGET" ]; then
  mkdir -p "$HOME/Applications"
  STAGING="$(mktemp -d "$HOME/Applications/.prentice-install.XXXXXX")"
  cleanup() {
    result=$?
    if [ -d "$STAGING/previous.app" ] && [ ! -e "$TARGET" ]; then
      mv "$STAGING/previous.app" "$TARGET"
    fi
    rm -rf "$STAGING"
    return "$result"
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # Copy and verify before touching the current app, even when source is an alias.
  ditto "$APP" "$STAGING/new.app"
  chmod -R u+rwX "$STAGING/new.app"
  codesign --verify --deep --strict "$STAGING/new.app"
  if [ -e "$TARGET" ]; then mv "$TARGET" "$STAGING/previous.app"; fi
  mv "$STAGING/new.app" "$TARGET"
  rm -rf "$STAGING"
  trap - EXIT INT TERM
  # Continue with the canonical installed path instead of another LaunchServices
  # activation, which can select a still-running older app with the same bundle ID.
  exec "$TARGET/Contents/MacOS/Prentice"
fi
export PRENTICE_PACKAGED=1
export PRENTICE_APP_PATH="$APP"
export PRENTICE_CONFIG="$RESOURCES/prentice.config.json"
export NODE_OPTIONS="--experimental-sqlite"
exec "$RESOURCES/node" "$RESOURCES/connector.mjs"
`;
}
