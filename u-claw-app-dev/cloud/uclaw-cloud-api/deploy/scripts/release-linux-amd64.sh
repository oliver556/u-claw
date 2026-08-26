#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="${VERSION:-dev}"
COMMIT="${COMMIT:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo none)}"
BUILT_AT="${BUILT_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
OUT_DIR="$ROOT_DIR/dist/uclaw-cloud-api-linux-amd64"
ARCHIVE="$ROOT_DIR/dist/uclaw-cloud-api-linux-amd64.tar.gz"
LDFLAGS="-s -w -X main.version=$VERSION -X main.commit=$COMMIT -X main.builtAt=$BUILT_AT"

rm -rf "$OUT_DIR" "$ARCHIVE"
mkdir -p "$OUT_DIR/bin" "$OUT_DIR/migrations" "$OUT_DIR/deploy"

GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "$LDFLAGS" -o "$OUT_DIR/bin/uclaw-cloud-api" ./cmd/api
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "$LDFLAGS" -o "$OUT_DIR/bin/uclaw-adminctl" ./cmd/adminctl

cp -R "$ROOT_DIR/migrations/." "$OUT_DIR/migrations/"
cp -R "$ROOT_DIR/deploy/systemd" "$OUT_DIR/deploy/"
cp -R "$ROOT_DIR/deploy/nginx" "$OUT_DIR/deploy/"
cp -R "$ROOT_DIR/deploy/env" "$OUT_DIR/deploy/"
cp -R "$ROOT_DIR/deploy/scripts" "$OUT_DIR/deploy/"
cp "$ROOT_DIR/README.md" "$OUT_DIR/README.md"

tar -C "$(dirname "$OUT_DIR")" -czf "$ARCHIVE" "$(basename "$OUT_DIR")"
echo "$ARCHIVE"
