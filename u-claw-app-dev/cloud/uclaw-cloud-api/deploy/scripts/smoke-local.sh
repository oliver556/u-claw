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
    curl -fsS -X POST http://127.0.0.1:8080/v1/auth/sms/send \
      -H 'Content-Type: application/json' \
      -d '{"phone":"13800138000","purpose":"login"}' >/dev/null
    activation_json="$(curl -fsS -X POST http://127.0.0.1:8080/v1/activations \
      -H 'Content-Type: application/json' \
      -d '{"phone":"13800138000","smsCode":"123456","activationCode":"ABCDE-FGHIJ-KLMNO-PQRST-UVWXYZ","usbFingerprintSummary":"PREVIEW-ONLY","idempotencyKey":"smoke-local-1"}')"
    activation_id="$(printf '%s' "$activation_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); const a=j.licenseArtifact; if(!j.ok||j.status!=="server_bound"||!j.activationId||!a||!a.payload||a.payload.activationId!==j.activationId||!a.signature||a.signature.algorithm!=="Ed25519"||!a.signature.value) process.exit(1); process.stdout.write(j.activationId);});')"
    curl -fsS -X POST "http://127.0.0.1:8080/v1/activations/${activation_id}/commit" \
      -H 'Content-Type: application/json' \
      -d '{"writeStatus":"verified"}' >/dev/null
    curl -fsS -X POST http://127.0.0.1:8080/v1/auth/sms/send \
      -H 'Content-Type: application/json' \
      -d '{"phone":"13800138000","purpose":"login"}' >/dev/null
    login_json="$(curl -fsS -X POST http://127.0.0.1:8080/v1/auth/sms/login \
      -H 'Content-Type: application/json' \
      -d '{"phone":"13800138000","purpose":"login","code":"123456"}')"
    access_token="$(printf '%s' "$login_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); if(!j.accessToken) process.exit(1); process.stdout.write(j.accessToken);});')"
    curl -fsS http://127.0.0.1:8080/v1/recharge/providers \
      -H "Authorization: Bearer $access_token" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); const v=j.providers&&j.providers.find(p=>p.code==="virtual"); if(!v||!v.enabled) process.exit(1);});'
    curl -fsS -X POST http://127.0.0.1:8080/v1/activation/redeem \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $access_token" \
      -d '{"activationCode":"ABCD-EFGH-IJKL-MNOP","deviceSummary":"PREVIEW-ONLY"}' >/dev/null
    echo "smoke ok"
    exit 0
  fi
  sleep 0.2
done

echo "server did not become healthy" >&2
cat "$TMP_LOG" >&2
exit 1
