#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
ARCHIVE="$ROOT/app/desktop-archive/u-claw-app-mac-arm64.tar.gz"
ARCHIVE_SHA_FILE="$ARCHIVE.sha256"
USB_DATA_DIR="$ROOT/data"
CACHE_ROOT="$HOME/Library/Caches/U-Claw"
APP_CACHE_DIR="$CACHE_ROOT/u-claw-app-mac-arm64"
RUN_DATA_DIR="$CACHE_ROOT/usb-portable/data"
APP_BIN="$APP_CACHE_DIR/U-Claw.app/Contents/MacOS/U-Claw"
STAMP_FILE="$APP_CACHE_DIR/.u-claw-archive.sha256"
LOG_DIR="$USB_DATA_DIR/logs"
LOG_FILE="$LOG_DIR/Mac-Start-App.log"

mkdir -p "$LOG_DIR" "$USB_DATA_DIR/.openclaw" "$CACHE_ROOT"
exec > >(tee -a "$LOG_FILE") 2>&1

sync_dir() {
  local from_dir="$1"
  local to_dir="$2"
  mkdir -p "$to_dir"
  rsync -a --delete --exclude '.cache/v8-compile-cache/' "$from_dir"/ "$to_dir"/
}

sync_back() {
  local status=$?
  echo "[U-Claw] Syncing runtime data back to USB..."
  sync_dir "$RUN_DATA_DIR" "$USB_DATA_DIR"
  echo "[U-Claw] Exit status: $status"
  exit "$status"
}

echo "[U-Claw] $(date '+%Y-%m-%d %H:%M:%S')"
echo "[U-Claw] USB root: $ROOT"
echo "[U-Claw] USB data dir: $USB_DATA_DIR"
echo "[U-Claw] Runtime data dir: $RUN_DATA_DIR"

if [ ! -f "$ARCHIVE" ]; then
  echo "[U-Claw] Missing Mac archive:"
  echo "$ARCHIVE"
  read -r -p "Press Enter to exit..."
  exit 1
fi

if [ ! -f "$ARCHIVE_SHA_FILE" ]; then
  echo "[U-Claw] Missing Mac archive manifest:"
  echo "$ARCHIVE_SHA_FILE"
  read -r -p "Press Enter to exit..."
  exit 1
fi

if [ ! -f "$USB_DATA_DIR/.openclaw/openclaw.json" ]; then
  echo "[U-Claw] Missing config:"
  echo "$USB_DATA_DIR/.openclaw/openclaw.json"
  read -r -p "Press Enter to exit..."
  exit 1
fi

echo "[U-Claw] Checking Mac archive..."
CURRENT_STAMP="$(tr -d '[:space:]' < "$ARCHIVE_SHA_FILE")"
CACHED_STAMP=""
if [ -f "$STAMP_FILE" ]; then
  CACHED_STAMP="$(cat "$STAMP_FILE" || true)"
fi

if [ ! -x "$APP_BIN" ] || [ "$CURRENT_STAMP" != "$CACHED_STAMP" ]; then
  TMP_CACHE_DIR="$APP_CACHE_DIR.tmp.$$"
  INSTALL_STARTED_AT="$(date +%s)"
  echo "[U-Claw] Installing updated app cache from archive..."
  echo "[U-Claw] This runs once per package version; later starts reuse the computer cache."
  rm -rf "$TMP_CACHE_DIR"
  mkdir -p "$TMP_CACHE_DIR"
  COPYFILE_DISABLE=1 tar -xzf "$ARCHIVE" -C "$TMP_CACHE_DIR" &
  EXTRACT_PID=$!
  (
    while kill -0 "$EXTRACT_PID" 2>/dev/null; do
      sleep 5
      if kill -0 "$EXTRACT_PID" 2>/dev/null; then
        echo "[U-Claw] Decompressing Mac app... $(($(date +%s) - INSTALL_STARTED_AT))s elapsed."
      fi
    done
  ) &
  PROGRESS_PID=$!
  if wait "$EXTRACT_PID"; then
    kill "$PROGRESS_PID" 2>/dev/null || true
    wait "$PROGRESS_PID" 2>/dev/null || true
  else
    kill "$PROGRESS_PID" 2>/dev/null || true
    wait "$PROGRESS_PID" 2>/dev/null || true
    echo "[U-Claw] Failed to decompress Mac archive."
    rm -rf "$TMP_CACHE_DIR"
    read -r -p "Press Enter to exit..."
    exit 1
  fi
  if [ ! -x "$TMP_CACHE_DIR/U-Claw.app/Contents/MacOS/U-Claw" ]; then
    echo "[U-Claw] Invalid archive: U-Claw.app binary missing."
    rm -rf "$TMP_CACHE_DIR"
    read -r -p "Press Enter to exit..."
    exit 1
  fi
  rm -rf "$APP_CACHE_DIR"
  mv "$TMP_CACHE_DIR" "$APP_CACHE_DIR"
  echo "$CURRENT_STAMP" > "$STAMP_FILE"
  echo "[U-Claw] App cache installed in $(($(date +%s) - INSTALL_STARTED_AT))s."
else
  echo "[U-Claw] Reusing app cache: $APP_CACHE_DIR"
fi

echo "[U-Claw] Syncing USB data to runtime cache..."
sync_dir "$USB_DATA_DIR" "$RUN_DATA_DIR"
trap sync_back EXIT

export UCLAW_PORTABLE_DATA_DIR="$RUN_DATA_DIR"
export OPENCLAW_HOME="$RUN_DATA_DIR"
export OPENCLAW_STATE_DIR="$RUN_DATA_DIR/.openclaw"
export OPENCLAW_CONFIG_PATH="$RUN_DATA_DIR/.openclaw/openclaw.json"
export OPENCLAW_DISABLE_BONJOUR=1
export UCLAW_MEDIA_PREVIEW_ROOTS="$RUN_DATA_DIR/.openclaw/media"

echo "[U-Claw] App binary: $APP_BIN"
echo "[U-Claw] Starting U-Claw..."
"$APP_BIN"
