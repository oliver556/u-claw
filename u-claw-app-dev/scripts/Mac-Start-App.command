#!/bin/bash
set -euo pipefail

ROOT="${UCLAW_PORTABLE_ROOT:-$(cd "$(dirname "$0")" && pwd)}"

wait_before_exit() {
  if [ "${UCLAW_LAUNCHER_GUI:-0}" = "1" ]; then
    return
  fi
  read -r -p "Press Enter to exit..."
}

HOST_ARCH="$(uname -m)"
if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  MAC_ARCH="arm64"
elif [ "$HOST_ARCH" = "x86_64" ]; then
  MAC_ARCH="x64"
else
  echo "[U-Claw] Unsupported Mac architecture: $HOST_ARCH"
  wait_before_exit
  exit 1
fi

ARCHIVE="$ROOT/app/desktop-archive/u-claw-app-mac-$MAC_ARCH.tar.gz"
ARCHIVE_SHA_FILE="$ARCHIVE.sha256"
if [ "$MAC_ARCH" = "arm64" ]; then
  ARCHIVE_SHA_ENV_NAME="UCLAW_MAC_ARM64_ARCHIVE_SHA256"
else
  ARCHIVE_SHA_ENV_NAME="UCLAW_MAC_X64_ARCHIVE_SHA256"
fi
USB_DATA_DIR="$ROOT/data"
CACHE_ROOT="$HOME/Library/Caches/U-Claw"
ROOT_ID="$(printf '%s' "$ROOT" | shasum -a 256 | awk '{print substr($1,1,16)}')"
ARCHIVE_CACHE_DIR="$CACHE_ROOT/archive-cache"
APP_CACHE_DIR="$CACHE_ROOT/u-claw-app-mac-$MAC_ARCH"
RUN_DATA_DIR="$CACHE_ROOT/usb-portable-$ROOT_ID/data"
APP_BIN="$APP_CACHE_DIR/U-Claw.app/Contents/MacOS/U-Claw"
STAMP_FILE="$APP_CACHE_DIR/.u-claw-archive.sha256"
LOCAL_ARCHIVE="$ARCHIVE_CACHE_DIR/u-claw-app-mac-$MAC_ARCH.tar.gz"
LOCAL_ARCHIVE_STAMP="$LOCAL_ARCHIVE.sha256"
USB_LOG_DIR="$USB_DATA_DIR/logs"
LOCAL_LOG_DIR="$CACHE_ROOT/launcher-logs"
LOG_FILE="$LOCAL_LOG_DIR/Mac-Start-App.log"
USB_MAC_START_LOG="$USB_LOG_DIR/Mac-Start-App.log"
LAUNCHER_LOCAL_LOG="${UCLAW_LAUNCHER_LOCAL_LOG:-}"
USB_LAUNCHER_LOG="${UCLAW_USB_LAUNCHER_LOG:-$USB_LOG_DIR/U-Claw-Launcher.log}"
SYNC_STATE_DIR="$RUN_DATA_DIR/.uclaw-sync"
DIRTY_FILE="$SYNC_STATE_DIR/dirty.json"
USB_DIRTY_FILE="$USB_DATA_DIR/.uclaw-sync/dirty.json"
LAST_SYNC_FILE="$SYNC_STATE_DIR/last-sync.json"
USB_LAST_SYNC_FILE="$USB_DATA_DIR/.uclaw-sync/last-sync.json"

mkdir -p "$LOCAL_LOG_DIR" "$USB_LOG_DIR" "$USB_DATA_DIR/.openclaw" "$CACHE_ROOT" "$ARCHIVE_CACHE_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1

sync_launcher_log() {
  mkdir -p "$USB_LOG_DIR"
  cp "$LOG_FILE" "$USB_MAC_START_LOG" 2>/dev/null || true
  if [ -n "$LAUNCHER_LOCAL_LOG" ] && [ -f "$LAUNCHER_LOCAL_LOG" ]; then
    mkdir -p "$(dirname "$USB_LAUNCHER_LOG")"
    cp "$LAUNCHER_LOCAL_LOG" "$USB_LAUNCHER_LOG" 2>/dev/null || true
  fi
}

sync_dir() {
  local from_dir="$1"
  local to_dir="$2"
  mkdir -p "$to_dir"
  rsync -a \
    --exclude '.cache/v8-compile-cache/' \
    --exclude '**/Cache/' \
    --exclude '**/Code Cache/' \
    --exclude '**/GPUCache/' \
    --exclude '**/DawnCache/' \
    --exclude '**/Crashpad/' \
    --exclude '**/Network/Cookies' \
    --exclude '**/Network/Cookies-journal' \
    --exclude '**/LOCK' \
    --exclude '**/SingletonCookie' \
    --exclude '**/SingletonLock' \
    --exclude '**/SingletonSocket' \
    --exclude '.DS_Store' \
    --exclude '._*' \
    --exclude '.Spotlight-V100/' \
    --exclude '.Trashes/' \
    "$from_dir"/ "$to_dir"/
}

sync_dir_with_progress() {
  local label="$1"
  local from_dir="$2"
  local to_dir="$3"
  local timeout_seconds="${4:-300}"
  local delete_mode="${5:-keep}"
  local started_at
  local sync_pid
  local elapsed
  local file_count
  local megabytes
  local source_file_count
  local source_megabytes
  local rsync_args=(
    -a
    --exclude '.cache/v8-compile-cache/'
    --exclude '**/Cache/'
    --exclude '**/Code Cache/'
    --exclude '**/GPUCache/'
    --exclude '**/DawnCache/'
    --exclude '**/Crashpad/'
    --exclude '**/Network/Cookies'
    --exclude '**/Network/Cookies-journal'
    --exclude '**/LOCK'
    --exclude '**/SingletonCookie'
    --exclude '**/SingletonLock'
    --exclude '**/SingletonSocket'
    --exclude '.DS_Store'
    --exclude '._*'
    --exclude '.Spotlight-V100/'
    --exclude '.Trashes/'
  )

  if [ "$delete_mode" = "delete" ]; then
    rsync_args+=(--delete)
  fi

  mkdir -p "$to_dir"
  source_file_count="$(find "$from_dir" -type f 2>/dev/null | wc -l | tr -d '[:space:]' || echo 0)"
  source_megabytes="$(du -sm "$from_dir" 2>/dev/null | awk '{print $1}' || echo 0)"
  started_at="$(date +%s)"
  (
    exec rsync "${rsync_args[@]}" "$from_dir"/ "$to_dir"/
  ) &
  sync_pid=$!
  while kill -0 "$sync_pid" 2>/dev/null; do
    sleep 5
    elapsed="$(($(date +%s) - started_at))"
    if kill -0 "$sync_pid" 2>/dev/null; then
      file_count="$(find "$to_dir" -type f 2>/dev/null | wc -l | tr -d '[:space:]' || echo 0)"
      megabytes="$(du -sm "$to_dir" 2>/dev/null | awk '{print $1}' || echo 0)"
      echo "[U-Claw] ${label}... ${elapsed}s elapsed, ${file_count}/${source_file_count} files, ${megabytes}/${source_megabytes} MB."
    fi
    if [ "$elapsed" -ge "$timeout_seconds" ]; then
      pkill -TERM -P "$sync_pid" 2>/dev/null || true
      kill -TERM "$sync_pid" 2>/dev/null || true
      sleep 1
      pkill -KILL -P "$sync_pid" 2>/dev/null || true
      kill -KILL "$sync_pid" 2>/dev/null || true
      wait "$sync_pid" 2>/dev/null || true
      echo "[U-Claw] ${label} timed out after ${timeout_seconds}s."
      return 1
    fi
  done
  wait "$sync_pid"
}

write_dirty() {
  mkdir -p "$SYNC_STATE_DIR"
  printf '{"dirty":true,"reason":"launcher-running","updatedAt":"%s"}\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$DIRTY_FILE"
  mkdir -p "$USB_DATA_DIR/.uclaw-sync"
  cp "$DIRTY_FILE" "$USB_DIRTY_FILE" 2>/dev/null || true
}

clear_dirty() {
  rm -f "$DIRTY_FILE" "$USB_DATA_DIR/.uclaw-sync/dirty.json"
  mkdir -p "$SYNC_STATE_DIR" "$USB_DATA_DIR/.uclaw-sync"
  printf '{"success":true,"reason":"launcher-final-sync","syncedAt":"%s"}\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$LAST_SYNC_FILE"
  cp "$LAST_SYNC_FILE" "$USB_DATA_DIR/.uclaw-sync/last-sync.json"
}

mark_sync_current() {
  mkdir -p "$SYNC_STATE_DIR" "$USB_DATA_DIR/.uclaw-sync"
  printf '{"success":true,"reason":"launcher-startup-sync","syncedAt":"%s"}\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$LAST_SYNC_FILE"
  cp "$LAST_SYNC_FILE" "$USB_DATA_DIR/.uclaw-sync/last-sync.json"
}

runtime_cache_is_current() {
  [ -f "$RUN_DATA_DIR/.openclaw/openclaw.json" ] &&
    [ -f "$LAST_SYNC_FILE" ] &&
    [ -f "$USB_LAST_SYNC_FILE" ] &&
    cmp -s "$LAST_SYNC_FILE" "$USB_LAST_SYNC_FILE"
}

sync_back() {
  local status=$?
  echo "[U-Claw] Syncing runtime data back to USB..."
  if ! sync_dir_with_progress "Syncing runtime data back to USB" "$RUN_DATA_DIR" "$USB_DATA_DIR" 300 "keep"; then
    status=1
  fi
  clear_dirty
  sync_launcher_log
  echo "[U-Claw] Exit status: $status"
  exit "$status"
}

echo "[U-Claw] $(date '+%Y-%m-%d %H:%M:%S')"
echo "[U-Claw] USB root: $ROOT"
echo "[U-Claw] Mac architecture: $MAC_ARCH"
echo "[U-Claw] USB data dir: $USB_DATA_DIR"
echo "[U-Claw] Runtime data dir: $RUN_DATA_DIR"

if [ ! -f "$ARCHIVE" ]; then
  echo "[U-Claw] Missing Mac archive:"
  echo "$ARCHIVE"
  wait_before_exit
  exit 1
fi

if [ -z "${!ARCHIVE_SHA_ENV_NAME:-}" ] && [ ! -f "$ARCHIVE_SHA_FILE" ]; then
  echo "[U-Claw] Missing Mac archive manifest:"
  echo "$ARCHIVE_SHA_FILE"
  wait_before_exit
  exit 1
fi

if [ ! -f "$USB_DATA_DIR/.openclaw/openclaw.json" ]; then
  echo "[U-Claw] Missing config:"
  echo "$USB_DATA_DIR/.openclaw/openclaw.json"
  wait_before_exit
  exit 1
fi

echo "[U-Claw] Checking Mac archive..."
CURRENT_STAMP="${!ARCHIVE_SHA_ENV_NAME:-}"
if [ -z "$CURRENT_STAMP" ]; then
  CURRENT_STAMP="$(tr -d '[:space:]' < "$ARCHIVE_SHA_FILE")"
fi
CACHED_STAMP=""
if [ -f "$STAMP_FILE" ]; then
  CACHED_STAMP="$(cat "$STAMP_FILE" || true)"
fi
USE_EXISTING_APP_CACHE=0

if [ ! -x "$APP_BIN" ] || [ "$CURRENT_STAMP" != "$CACHED_STAMP" ]; then
  TMP_CACHE_DIR="$APP_CACHE_DIR.tmp.$$"
  INSTALL_STARTED_AT="$(date +%s)"
  LOCAL_STAMP=""
  if [ -f "$LOCAL_ARCHIVE_STAMP" ]; then
    LOCAL_STAMP="$(cat "$LOCAL_ARCHIVE_STAMP" || true)"
  fi
  if [ ! -f "$LOCAL_ARCHIVE" ] || [ "$LOCAL_STAMP" != "$CURRENT_STAMP" ]; then
    TMP_ARCHIVE="$LOCAL_ARCHIVE.tmp.$$"
    COPY_STARTED_AT="$(date +%s)"
    COPY_TIMEOUT_SECONDS=1800
    echo "[U-Claw] Copying Mac archive to local cache..."
    rm -f "$TMP_ARCHIVE"
    cp "$ARCHIVE" "$TMP_ARCHIVE" &
    COPY_PID=$!
    while kill -0 "$COPY_PID" 2>/dev/null; do
      sleep 5
      ELAPSED="$(($(date +%s) - COPY_STARTED_AT))"
      if kill -0 "$COPY_PID" 2>/dev/null; then
        ARCHIVE_BYTES="$(stat -f%z "$ARCHIVE" 2>/dev/null || echo 0)"
        COPIED_BYTES="$(stat -f%z "$TMP_ARCHIVE" 2>/dev/null || echo 0)"
        if [ "$ARCHIVE_BYTES" -gt 0 ]; then
          ARCHIVE_MB="$((ARCHIVE_BYTES / 1048576))"
          COPIED_MB="$((COPIED_BYTES / 1048576))"
          PERCENT="$(awk -v copied="$COPIED_BYTES" -v total="$ARCHIVE_BYTES" 'BEGIN { printf "%.1f", (copied * 100) / total }')"
          echo "[U-Claw] Copying Mac archive... ${COPIED_MB}/${ARCHIVE_MB} MB (${PERCENT}%), ${ELAPSED}s elapsed."
        else
          echo "[U-Claw] Copying Mac archive... ${ELAPSED}s elapsed."
        fi
      fi
      if [ "$ELAPSED" -ge "$COPY_TIMEOUT_SECONDS" ]; then
        kill "$COPY_PID" 2>/dev/null || true
        wait "$COPY_PID" 2>/dev/null || true
        rm -f "$TMP_ARCHIVE"
        echo "[U-Claw] Failed to copy Mac archive within ${COPY_TIMEOUT_SECONDS}s."
        if [ -x "$APP_BIN" ]; then
          echo "[U-Claw] Existing app cache is available; starting cached app instead."
          USE_EXISTING_APP_CACHE=1
          break
        else
          echo "[U-Claw] Please reconnect the USB disk or copy the U-Claw folder to a healthier disk."
          wait_before_exit
          exit 1
        fi
      fi
    done
    if [ "$USE_EXISTING_APP_CACHE" != "1" ] && ! wait "$COPY_PID"; then
      rm -f "$TMP_ARCHIVE"
      echo "[U-Claw] Failed to copy Mac archive."
      if [ -x "$APP_BIN" ]; then
        echo "[U-Claw] Existing app cache is available; starting cached app instead."
        USE_EXISTING_APP_CACHE=1
      else
        wait_before_exit
        exit 1
      fi
    fi
    if [ "$USE_EXISTING_APP_CACHE" != "1" ]; then
      mv "$TMP_ARCHIVE" "$LOCAL_ARCHIVE"
      printf '%s\n' "$CURRENT_STAMP" > "$LOCAL_ARCHIVE_STAMP"
      echo "[U-Claw] Mac archive copied in $(($(date +%s) - COPY_STARTED_AT))s."
    fi
  else
    echo "[U-Claw] Reusing local Mac archive cache."
  fi
  if [ "$USE_EXISTING_APP_CACHE" != "1" ]; then
    echo "[U-Claw] Installing updated app cache from local archive..."
    echo "[U-Claw] This runs once per package version; later starts reuse the computer cache."
    rm -rf "$TMP_CACHE_DIR"
    mkdir -p "$TMP_CACHE_DIR"
    COPYFILE_DISABLE=1 tar -xzf "$LOCAL_ARCHIVE" -C "$TMP_CACHE_DIR" &
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
      wait_before_exit
      exit 1
    fi
    if [ ! -x "$TMP_CACHE_DIR/U-Claw.app/Contents/MacOS/U-Claw" ]; then
      echo "[U-Claw] Invalid archive: U-Claw.app binary missing."
      rm -rf "$TMP_CACHE_DIR"
      wait_before_exit
      exit 1
    fi
    rm -rf "$APP_CACHE_DIR"
    mv "$TMP_CACHE_DIR" "$APP_CACHE_DIR"
    echo "$CURRENT_STAMP" > "$STAMP_FILE"
    echo "[U-Claw] App cache installed in $(($(date +%s) - INSTALL_STARTED_AT))s."
  fi
else
  echo "[U-Claw] Reusing app cache: $APP_CACHE_DIR"
fi

echo "[U-Claw] Preparing runtime data cache..."
mkdir -p "$RUN_DATA_DIR" "$USB_DATA_DIR"
if [ -f "$DIRTY_FILE" ]; then
  echo "[U-Claw] Runtime data has unsynced changes; syncing runtime cache back to USB before startup..."
  sync_dir_with_progress "Syncing runtime cache back to USB" "$RUN_DATA_DIR" "$USB_DATA_DIR" 300 "keep" || true
fi
if runtime_cache_is_current; then
  echo "[U-Claw] Runtime data cache is current; USB data sync skipped."
else
  echo "[U-Claw] Syncing USB data to runtime cache..."
  if ! sync_dir_with_progress "Syncing USB data to runtime cache" "$USB_DATA_DIR" "$RUN_DATA_DIR" 300 "delete"; then
    echo "[U-Claw] Failed to prepare runtime data cache."
    wait_before_exit
    exit 1
  fi
  mark_sync_current
fi
trap sync_back EXIT
write_dirty

export UCLAW_PORTABLE_DATA_DIR="$USB_DATA_DIR"
export UCLAW_PORTABLE_WORK_DATA_DIR="$RUN_DATA_DIR"
export UCLAW_USB_DATA_DIR="$USB_DATA_DIR"
export OPENCLAW_HOME="$RUN_DATA_DIR"
export OPENCLAW_STATE_DIR="$RUN_DATA_DIR/.openclaw"
export OPENCLAW_CONFIG_PATH="$RUN_DATA_DIR/.openclaw/openclaw.json"
export OPENCLAW_DISABLE_BONJOUR=1
export UCLAW_MEDIA_PREVIEW_ROOTS="$RUN_DATA_DIR/.openclaw/media"
export UCLAW_ACTIVATION_ENDPOINT="${UCLAW_ACTIVATION_ENDPOINT:-https://license.yiyong.me}"
export UCLAW_ACTIVATION_REQUIRE_CLOUD="${UCLAW_ACTIVATION_REQUIRE_CLOUD:-1}"

echo "[U-Claw] App binary: $APP_BIN"
echo "[U-Claw] Starting U-Claw..."
"$APP_BIN"
