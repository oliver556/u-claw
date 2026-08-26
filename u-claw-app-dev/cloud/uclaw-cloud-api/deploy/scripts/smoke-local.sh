#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

go test ./...
go vet ./...
go run ./cmd/adminctl activation generate 1 >/dev/null

TMP_LOG="$(mktemp)"
go run ./cmd/api serve >"$TMP_LOG" 2>&1 &
SERVER_PID="$!"
trap 'kill "$SERVER_PID" >/dev/null 2>&1 || true; wait "$SERVER_PID" >/dev/null 2>&1 || true; rm -f "$TMP_LOG"' EXIT

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    curl -fsS http://127.0.0.1:8080/readyz >/dev/null 2>&1
    curl -fsS http://127.0.0.1:8080/dev/auth >/dev/null
    curl -fsS -X POST http://127.0.0.1:8080/v1/auth/sms/send \
      -H 'Content-Type: application/json' \
      -d '{"phone":"13800138000","purpose":"login"}' >/dev/null
    curl -fsS -X POST http://127.0.0.1:8080/v1/auth/sms/login \
      -H 'Content-Type: application/json' \
      -d '{"phone":"13800138000","purpose":"login","code":"123456"}' >/dev/null
    echo "smoke ok"
    exit 0
  fi
  sleep 0.2
done

echo "server did not become healthy" >&2
cat "$TMP_LOG" >&2
exit 1
