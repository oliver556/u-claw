#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${ALIYUN_DEPLOY_HOST:-121.41.89.103}"
REMOTE_USER="${ALIYUN_DEPLOY_USER:-root}"
REMOTE_PORT="${ALIYUN_DEPLOY_PORT:-22}"
REMOTE_DIR="${UCLAW_UPDATE_REMOTE_DIR:-/opt/uclaw-update}"
SERVICE_PORT="${UCLAW_UPDATE_CHECK_PORT:-18080}"
DOMAIN="${UCLAW_UPDATE_DOMAIN:-updates.yiyong.me}"
AUTH_MODE="${UCLAW_UPDATE_AUTH_MODE:-permissive}"
DATABASE_ENV_FILE="${UCLAW_UPDATE_DATABASE_ENV_FILE:-}"

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_SOURCE="${UCLAW_UPDATE_RELEASE_SOURCE:-$APP_DIR/release/mock-hard-update}"
TMP_DIR="$(mktemp -d)"
cleanup() {
  node -e "require('fs').rmSync(process.argv[1], { recursive: true, force: true })" "$TMP_DIR"
}
trap cleanup EXIT

if [[ ! -f "$RELEASE_SOURCE/production.json" ]]; then
  echo "[deploy-hard-update-control-plane] release not found: $RELEASE_SOURCE" >&2
  exit 1
fi

mkdir -p "$TMP_DIR/uclaw-update/scripts/lib" "$TMP_DIR/uclaw-update/release"
cp "$APP_DIR/scripts/hard-update-control-plane-server.js" "$TMP_DIR/uclaw-update/scripts/"
cp "$APP_DIR/scripts/lib/hard-update-utils.js" "$TMP_DIR/uclaw-update/scripts/lib/"
cp "$APP_DIR/scripts/lib/local-env.js" "$TMP_DIR/uclaw-update/scripts/lib/"
cp -R "$RELEASE_SOURCE/." "$TMP_DIR/uclaw-update/release/"

tar -C "$TMP_DIR" -czf "$TMP_DIR/uclaw-update-control-plane.tgz" uclaw-update

ssh -p "$REMOTE_PORT" "$REMOTE_USER@$REMOTE_HOST" "mkdir -p '$REMOTE_DIR'"
scp -P "$REMOTE_PORT" "$TMP_DIR/uclaw-update-control-plane.tgz" "$REMOTE_USER@$REMOTE_HOST:/tmp/uclaw-update-control-plane.tgz"
ssh -p "$REMOTE_PORT" "$REMOTE_USER@$REMOTE_HOST" "tar -xzf /tmp/uclaw-update-control-plane.tgz -C /opt && python3 - <<'PY'
import os
try:
    os.remove('/tmp/uclaw-update-control-plane.tgz')
except FileNotFoundError:
    pass
PY"

ssh -p "$REMOTE_PORT" "$REMOTE_USER@$REMOTE_HOST" "cat > /etc/systemd/system/uclaw-update.service <<'UNIT'
[Unit]
Description=U-Claw update check control plane
After=network.target

[Service]
Type=simple
WorkingDirectory=$REMOTE_DIR
EnvironmentFile=$REMOTE_DIR/.env
ExecStart=/usr/bin/node $REMOTE_DIR/scripts/hard-update-control-plane-server.js --env $REMOTE_DIR/.env
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable uclaw-update.service
systemctl restart uclaw-update.service"

echo "[deploy-hard-update-control-plane] service deployed on 127.0.0.1:$SERVICE_PORT"
echo "[deploy-hard-update-control-plane] release source $RELEASE_SOURCE"
echo "[deploy-hard-update-control-plane] configure reverse proxy for https://$DOMAIN/uclaw/update/check"
