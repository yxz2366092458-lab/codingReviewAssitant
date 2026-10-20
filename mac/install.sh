#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/mac/代码评审.app"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:$PATH"

osascript -e 'tell application "代码评审" to quit' >/dev/null 2>&1 || true
for _ in $(seq 1 25); do
  if ! pgrep -f "/代码评审.app/Contents/MacOS/panel" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

swiftc -framework Cocoa -framework WebKit -o "$SRC/Contents/MacOS/panel" "$ROOT/apps/mac/Panel.swift"
chmod +x "$SRC/Contents/MacOS/launch" "$SRC/Contents/MacOS/panel"

DEST_DIR="/Applications"
if [[ ! -w "$DEST_DIR" ]]; then
  DEST_DIR="$HOME/Applications"
  mkdir -p "$DEST_DIR"
fi
DEST="$DEST_DIR/代码评审.app"
rm -rf "$DEST"
ditto "$SRC" "$DEST"
mkdir -p "$DEST/Contents/Resources"
printf '%s\n' "$ROOT" > "$DEST/Contents/Resources/repo-root"
chmod +x "$DEST/Contents/MacOS/launch" "$DEST/Contents/MacOS/panel"
echo "$DEST"
