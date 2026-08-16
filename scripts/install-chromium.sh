#!/usr/bin/env bash
set -euo pipefail

VERSION="${CHROME_VERSION:-152.0.7977.42}"
DEST="${CHROMIUM_INSTALL_DIR:-/opt/chrome-headless-shell}"
URL="https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/linux64/chrome-headless-shell-linux64.zip"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$URL" -o "$tmp/headless-shell.zip"
if command -v unzip >/dev/null 2>&1; then
  unzip -q "$tmp/headless-shell.zip" -d "$tmp"
elif command -v python3 >/dev/null 2>&1; then
  python3 -m zipfile -e "$tmp/headless-shell.zip" "$tmp"
else
  echo 'Either unzip or python3 is required to extract Chrome Headless Shell.' >&2
  exit 3
fi
install -d "$DEST"
cp -a "$tmp/chrome-headless-shell-linux64/." "$DEST/"
chmod 0755 "$DEST/chrome-headless-shell"
if [[ -f "$DEST/chrome_crashpad_handler" ]]; then
  chmod 0755 "$DEST/chrome_crashpad_handler"
fi
"$DEST/chrome-headless-shell" --version
