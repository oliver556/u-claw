#!/bin/bash
set -euo pipefail

ROOT="${UCLAW_PORTABLE_ROOT:-$(cd "$(dirname "$0")" && pwd)}"
if [ ! -d "$ROOT/app/desktop-archive" ] && [ -d "$ROOT/../desktop-archive" ]; then
  ROOT="$(cd "$ROOT/../.." && pwd)"
fi

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
  echo "[Bavi-box] Unsupported Mac architecture: $HOST_ARCH"
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
CACHE_ROOT="$HOME/Library/Caches/Bavi-box"
ROOT_ID="$(printf '%s' "$ROOT" | shasum -a 256 | awk '{print substr($1,1,16)}')"
ARCHIVE_CACHE_DIR="$CACHE_ROOT/archive-cache"
APP_CACHE_DIR="$CACHE_ROOT/u-claw-app-mac-$MAC_ARCH"
RUN_DATA_DIR="$CACHE_ROOT/usb-portable-$ROOT_ID/data"
ELECTRON_PROFILE_DIR="$CACHE_ROOT/electron-profile-darwin-$ROOT_ID"
APP_BIN="$APP_CACHE_DIR/Bavi-box.app/Contents/MacOS/Bavi-box"
STAMP_FILE="$APP_CACHE_DIR/.u-claw-archive.sha256"
LOCAL_ARCHIVE="$ARCHIVE_CACHE_DIR/u-claw-app-mac-$MAC_ARCH.tar.gz"
LOCAL_ARCHIVE_STAMP="$LOCAL_ARCHIVE.sha256"
USB_LOG_DIR="$USB_DATA_DIR/logs"
LOCAL_LOG_DIR="$CACHE_ROOT/launcher-logs"
LOG_FILE="$LOCAL_LOG_DIR/Mac-Start-App.log"
USB_MAC_START_LOG="$USB_LOG_DIR/Mac-Start-App.log"
LAUNCHER_LOCAL_LOG="${UCLAW_LAUNCHER_LOCAL_LOG:-}"
USB_LAUNCHER_LOG="${UCLAW_USB_LAUNCHER_LOG:-$USB_LOG_DIR/Bavi-box-Launcher.log}"
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
    --exclude '/Cookies' \
    --exclude '/Cookies-journal' \
    --exclude '/DIPS' \
    --exclude '/DIPS-shm' \
    --exclude '/DIPS-wal' \
    --exclude '/Local State' \
    --exclude '/Network Persistent State' \
    --exclude '/Preferences' \
    --exclude '/SharedStorage' \
    --exclude '/SharedStorage-wal' \
    --exclude '/Trust Tokens' \
    --exclude '/Trust Tokens-journal' \
    --exclude '/Cache/' \
    --exclude '/Code Cache/' \
    --exclude '/GPUCache/' \
    --exclude '/DawnGraphiteCache/' \
    --exclude '/DawnWebGPUCache/' \
    --exclude '/Network/' \
    --exclude '/Local Storage/' \
    --exclude '/Session Storage/' \
    --exclude '/Service Worker/' \
    --exclude '/WebStorage/' \
    --exclude '/Shared Dictionary/' \
    --exclude '/Dictionaries/' \
    --exclude '/blob_storage/' \
    --exclude '.openclaw/devices/' \
    --exclude '.openclaw/identity/' \
    --exclude '.openclaw/openclaw.json' \
    --exclude '.openclaw/openclaw.json.last-good' \
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
  local preserve_config="${6:-preserve-config}"
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
    --exclude '/Cookies'
    --exclude '/Cookies-journal'
    --exclude '/DIPS'
    --exclude '/DIPS-shm'
    --exclude '/DIPS-wal'
    --exclude '/Local State'
    --exclude '/Network Persistent State'
    --exclude '/Preferences'
    --exclude '/SharedStorage'
    --exclude '/SharedStorage-wal'
    --exclude '/Trust Tokens'
    --exclude '/Trust Tokens-journal'
    --exclude '/Cache/'
    --exclude '/Code Cache/'
    --exclude '/GPUCache/'
    --exclude '/DawnGraphiteCache/'
    --exclude '/DawnWebGPUCache/'
    --exclude '/Network/'
    --exclude '/Local Storage/'
    --exclude '/Session Storage/'
    --exclude '/Service Worker/'
    --exclude '/WebStorage/'
    --exclude '/Shared Dictionary/'
    --exclude '/Dictionaries/'
    --exclude '/blob_storage/'
    --exclude '.openclaw/devices/'
    --exclude '.openclaw/identity/'
    --exclude '.DS_Store'
    --exclude '._*'
    --exclude '.Spotlight-V100/'
    --exclude '.Trashes/'
  )

  if [ "$delete_mode" = "delete" ]; then
    rsync_args+=(--delete)
  fi
  if [ "$preserve_config" = "preserve-config" ]; then
    rsync_args+=(
      --exclude '.openclaw/openclaw.json'
      --exclude '.openclaw/openclaw.json.last-good'
    )
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
      echo "[Bavi-box] ${label}... ${elapsed}s elapsed, ${file_count}/${source_file_count} files, ${megabytes}/${source_megabytes} MB."
    fi
    if [ "$elapsed" -ge "$timeout_seconds" ]; then
      pkill -TERM -P "$sync_pid" 2>/dev/null || true
      kill -TERM "$sync_pid" 2>/dev/null || true
      sleep 1
      pkill -KILL -P "$sync_pid" 2>/dev/null || true
      kill -KILL "$sync_pid" 2>/dev/null || true
      wait "$sync_pid" 2>/dev/null || true
      echo "[Bavi-box] ${label} timed out after ${timeout_seconds}s."
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
  echo "[Bavi-box] Syncing runtime data back to USB..."
  if ! sync_dir_with_progress "Syncing runtime data back to USB" "$RUN_DATA_DIR" "$USB_DATA_DIR" 300 "keep" "preserve-config"; then
    status=1
  fi
  clear_dirty
  sync_launcher_log
  echo "[Bavi-box] Exit status: $status"
  exit "$status"
}

run_startup_hard_update() {
  if [ "${UCLAW_ENABLE_STARTUP_HARD_UPDATE:-0}" != "1" ]; then
    echo "[Bavi-box] Startup hard update disabled by environment."
    return 0
  fi
  local hard_update_node="$APP_CACHE_DIR/Bavi-box.app/Contents/Resources/resources/runtime/node-darwin-$MAC_ARCH/bin/node"
  local hard_update_client="$APP_CACHE_DIR/Bavi-box.app/Contents/Resources/app/scripts/hard-update-client.js"
  if [ ! -x "$hard_update_node" ]; then
    echo "[Bavi-box] Missing bundled Node runtime for startup hard update:"
    echo "$hard_update_node"
    return 1
  fi
  if [ ! -f "$hard_update_client" ]; then
    echo "[Bavi-box] Missing startup hard update client:"
    echo "$hard_update_client"
    return 1
  fi
  echo "[Bavi-box] Checking mandatory hard update..."
  "$hard_update_node" "$hard_update_client" startup-update --usb "$ROOT" --platform "darwin-$MAC_ARCH"
  return $?
}

echo "[Bavi-box] $(date '+%Y-%m-%d %H:%M:%S')"
echo "[Bavi-box] USB root: $ROOT"
echo "[Bavi-box] Mac architecture: $MAC_ARCH"
echo "[Bavi-box] USB data dir: $USB_DATA_DIR"
echo "[Bavi-box] Runtime data dir: $RUN_DATA_DIR"

if [ ! -f "$ARCHIVE" ]; then
  echo "[Bavi-box] Missing Mac archive:"
  echo "$ARCHIVE"
  wait_before_exit
  exit 1
fi

if [ -z "${!ARCHIVE_SHA_ENV_NAME:-}" ] && [ ! -f "$ARCHIVE_SHA_FILE" ]; then
  echo "[Bavi-box] Missing Mac archive manifest:"
  echo "$ARCHIVE_SHA_FILE"
  wait_before_exit
  exit 1
fi

if [ ! -f "$USB_DATA_DIR/.openclaw/openclaw.json" ]; then
  echo "[Bavi-box] Missing config:"
  echo "$USB_DATA_DIR/.openclaw/openclaw.json"
  wait_before_exit
  exit 1
fi

echo "[Bavi-box] Checking Mac archive..."
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
  if [ "$USE_EXISTING_APP_CACHE" != "1" ]; then
    echo "[Bavi-box] Installing updated app cache from USB archive..."
    echo "[Bavi-box] This runs once per package version; later starts reuse the computer cache."
    rm -rf "$TMP_CACHE_DIR"
    mkdir -p "$TMP_CACHE_DIR"
    COPYFILE_DISABLE=1 tar -xzf "$ARCHIVE" -C "$TMP_CACHE_DIR" &
    EXTRACT_PID=$!
    (
      while kill -0 "$EXTRACT_PID" 2>/dev/null; do
        sleep 5
        if kill -0 "$EXTRACT_PID" 2>/dev/null; then
          echo "[Bavi-box] Decompressing Mac app... $(($(date +%s) - INSTALL_STARTED_AT))s elapsed."
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
      echo "[Bavi-box] Failed to decompress Mac archive."
      rm -rf "$TMP_CACHE_DIR"
      if [ -x "$APP_BIN" ]; then
        echo "[Bavi-box] Existing app cache is available; starting cached app instead."
        USE_EXISTING_APP_CACHE=1
      else
        wait_before_exit
        exit 1
      fi
    fi
    if [ "$USE_EXISTING_APP_CACHE" != "1" ] && [ ! -x "$TMP_CACHE_DIR/Bavi-box.app/Contents/MacOS/Bavi-box" ]; then
      echo "[Bavi-box] Invalid archive: Bavi-box.app binary missing."
      rm -rf "$TMP_CACHE_DIR"
      wait_before_exit
      exit 1
    fi
    if [ "$USE_EXISTING_APP_CACHE" != "1" ]; then
      rm -rf "$APP_CACHE_DIR"
      mv "$TMP_CACHE_DIR" "$APP_CACHE_DIR"
      echo "$CURRENT_STAMP" > "$STAMP_FILE"
      echo "[Bavi-box] App cache installed in $(($(date +%s) - INSTALL_STARTED_AT))s."
    fi
  fi
else
  echo "[Bavi-box] Reusing app cache: $APP_CACHE_DIR"
fi

set +e
run_startup_hard_update
HARD_UPDATE_STATUS=$?
set -e
if [ "$HARD_UPDATE_STATUS" -eq 2 ]; then
  unset UCLAW_MAC_ARM64_ARCHIVE_SHA256
  unset UCLAW_MAC_X64_ARCHIVE_SHA256
  export UCLAW_PORTABLE_ROOT="$ROOT"
  exec /bin/bash "$0"
fi
if [ "$HARD_UPDATE_STATUS" -eq 20 ]; then
  echo "[Bavi-box] Hard update staged; applying update and relaunching."
  HARD_UPDATE_NODE="$APP_CACHE_DIR/Bavi-box.app/Contents/Resources/resources/runtime/node-darwin-$MAC_ARCH/bin/node"
  HARD_UPDATE_CLIENT="$APP_CACHE_DIR/Bavi-box.app/Contents/Resources/app/scripts/hard-update-client.js"
  HARD_UPDATE_APPLY_LOG="$LOCAL_LOG_DIR/Mac-Hard-Update-Apply.log"
  nohup "$HARD_UPDATE_NODE" "$HARD_UPDATE_CLIENT" apply-startup-update \
    --usb "$ROOT" \
    --transaction "$ROOT/app/update-transaction.json" \
    --wait-pid "${UCLAW_LAUNCHER_PID:-}" \
    --launch-after "$ROOT/Bavi-box.app" \
    --stamp-file "$STAMP_FILE" >> "$HARD_UPDATE_APPLY_LOG" 2>&1 &
  exit 0
fi
if [ "$HARD_UPDATE_STATUS" -ne 0 ]; then
  echo "[Bavi-box] Startup hard update failed."
  wait_before_exit
  exit 1
fi

echo "[Bavi-box] Preparing runtime data cache..."
mkdir -p "$RUN_DATA_DIR" "$USB_DATA_DIR"
if [ -f "$DIRTY_FILE" ]; then
  echo "[Bavi-box] Runtime data has unsynced changes; syncing runtime cache back to USB before startup..."
  sync_dir_with_progress "Syncing runtime cache back to USB" "$RUN_DATA_DIR" "$USB_DATA_DIR" 300 "keep" "preserve-config" || true
fi
if runtime_cache_is_current; then
  echo "[Bavi-box] Runtime data cache is current; USB data sync skipped."
else
  echo "[Bavi-box] Syncing USB data to runtime cache..."
  if ! sync_dir_with_progress "Syncing USB data to runtime cache" "$USB_DATA_DIR" "$RUN_DATA_DIR" 300 "delete" "copy-config"; then
    echo "[Bavi-box] Failed to prepare runtime data cache."
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
export UCLAW_PORTABLE_ROOT="$ROOT"
export UCLAW_CACHE_ROOT="$CACHE_ROOT"
export UCLAW_APP_CACHE_DIR="$APP_CACHE_DIR"
export UCLAW_ARCHIVE_CACHE="$LOCAL_ARCHIVE"
export UCLAW_APP_CACHE_STAMP="$STAMP_FILE"
export UCLAW_ELECTRON_PROFILE_DIR="$ELECTRON_PROFILE_DIR"
export OPENCLAW_HOME="$RUN_DATA_DIR"
export OPENCLAW_STATE_DIR="$RUN_DATA_DIR/.openclaw"
export OPENCLAW_CONFIG_PATH="$RUN_DATA_DIR/.openclaw/openclaw.json"
export OPENCLAW_DISABLE_BONJOUR=1
export UCLAW_ACTIVATION_ENDPOINT="https://license.yiyong.me"
export UCLAW_ACTIVATION_REQUIRE_CLOUD=1
export UCLAW_MEDIA_PREVIEW_ROOTS="$RUN_DATA_DIR/.openclaw/media:$USB_DATA_DIR/.openclaw/media"

echo "[Bavi-box] App binary: $APP_BIN"
echo "[Bavi-box] Starting Bavi-box..."
"$APP_BIN"
