#!/bin/bash
set -euo pipefail

ROOT="${UCLAW_PORTABLE_ROOT:-$(cd "$(dirname "$0")" && pwd)}"
if [ ! -d "$ROOT/app" ] && [ -d "$ROOT/../app" ]; then
  ROOT="$(cd "$ROOT/.." && pwd)"
fi

wait_before_exit() {
  read -r -p "按回车退出..." || true
}

HOST_ARCH="$(uname -m)"
if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  MAC_ARCH="arm64"
elif [ "$HOST_ARCH" = "x86_64" ]; then
  MAC_ARCH="x64"
else
  echo "[Bavi-box] Unsupported Mac architecture: $HOST_ARCH"
  wait_before_exit
  exit 1
fi

CLIENT_SOURCE="$ROOT/app/scripts/hard-update-client.js"
CLIENT_LIB_SOURCE="$ROOT/app/scripts/lib"
LAUNCH_AFTER="$ROOT/Bavi-box.app"
RUNTIME_ARCHIVE="$ROOT/app/update-runtime/node-darwin-$MAC_ARCH.tar.gz"
UPDATER_CACHE="${TMPDIR:-/tmp}/bavi-box-updater-$MAC_ARCH"
RUNTIME_CACHE="$UPDATER_CACHE/node"
CLIENT_CACHE="$UPDATER_CACHE/client"
NODE="$RUNTIME_CACHE/bin/node"
CLIENT="$CLIENT_CACHE/hard-update-client.js"
PRODUCTION_URL="${UCLAW_UPDATE_PRODUCTION_URL:-https://oss-download.yiyong.me/bavi-box/releases/production.json}"

echo "[Bavi-box] USB root: $ROOT"
echo "[Bavi-box] Mac architecture: $MAC_ARCH"
echo "[Bavi-box] Checking updater runtime..."

if [ ! -f "$RUNTIME_ARCHIVE" ]; then
  echo "[Bavi-box] Missing updater Node runtime:"
  echo "$RUNTIME_ARCHIVE"
  wait_before_exit
  exit 1
fi

if [ ! -f "$CLIENT_SOURCE" ]; then
  echo "[Bavi-box] Missing updater client:"
  echo "$CLIENT_SOURCE"
  wait_before_exit
  exit 1
fi
if [ ! -d "$CLIENT_LIB_SOURCE" ]; then
  echo "[Bavi-box] Missing updater client lib:"
  echo "$CLIENT_LIB_SOURCE"
  wait_before_exit
  exit 1
fi

echo "[Bavi-box] Preparing local updater runtime..."
rm -rf "$UPDATER_CACHE.tmp"
mkdir -p "$(dirname "$UPDATER_CACHE")" "$UPDATER_CACHE.tmp/node" "$UPDATER_CACHE.tmp/client"
tar -xzf "$RUNTIME_ARCHIVE" -C "$UPDATER_CACHE.tmp/node"
cp "$CLIENT_SOURCE" "$UPDATER_CACHE.tmp/client/hard-update-client.js"
cp -R "$CLIENT_LIB_SOURCE" "$UPDATER_CACHE.tmp/client/lib"
rm -rf "$UPDATER_CACHE"
mv "$UPDATER_CACHE.tmp" "$UPDATER_CACHE"

echo "[Bavi-box] Starting independent update..."

set +e
"$NODE" "$CLIENT" independent-update \
  --usb "$ROOT" \
  --platform "darwin-$MAC_ARCH" \
  --production-url "$PRODUCTION_URL" \
  --launch-after "$LAUNCH_AFTER"
STATUS=$?
set -e

if [ "$STATUS" -eq 0 ]; then
  echo "[Bavi-box] Update finished."
else
  echo "[Bavi-box] Update failed with status $STATUS."
fi
wait_before_exit
exit "$STATUS"
