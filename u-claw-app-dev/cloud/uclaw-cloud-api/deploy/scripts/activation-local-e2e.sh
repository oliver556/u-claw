#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NEWAPI_BASE_URL="${NEWAPI_ADMIN_BASE_URL:-http://127.0.0.1:${NEWAPI_LOCAL_PORT:-3000}}"
ROOT_USERNAME="${NEWAPI_LOCAL_ROOT_USERNAME:-root}"
ROOT_PASSWORD="${NEWAPI_LOCAL_ROOT_PASSWORD:-UclawLocal@2026}"
PG_PORT="${UCLAW_E2E_PG_PORT:-$((55400 + RANDOM % 100))}"
PG_CONTAINER="uclaw-cloud-api-e2e-pg-${PG_PORT}-$$"
API_ADDR="127.0.0.1:${UCLAW_E2E_API_PORT:-18080}"
ACTIVATION_CODE="${UCLAW_E2E_ACTIVATION_CODE:-ABCD-EFGH-IJKL-MNOP}"
PHONE="${UCLAW_E2E_PHONE:-138$(date +%s | tail -c 9)}"

cd "$ROOT_DIR"

node_get() {
  local expression="$1"
  node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s);${expression}})"
}

cleanup() {
  if [[ -n "${API_PID:-}" ]]; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi
  docker stop "$PG_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --rm \
  --name "$PG_CONTAINER" \
  -e POSTGRES_USER=uclaw \
  -e POSTGRES_PASSWORD=uclaw \
  -e POSTGRES_DB=uclaw_cloud \
  -p "127.0.0.1:${PG_PORT}:5432" \
  -d postgres:16-alpine >/dev/null

pg_ready=false
for _ in $(seq 1 60); do
  if docker exec "$PG_CONTAINER" pg_isready -U uclaw -d postgres >/dev/null 2>&1; then
    pg_ready=true
    break
  fi
  sleep 0.2
done
if [[ "$pg_ready" != "true" ]]; then
  docker logs "$PG_CONTAINER" >&2 || true
  exit 1
fi

docker exec "$PG_CONTAINER" psql -U uclaw -d postgres -tc "SELECT 1 FROM pg_database WHERE datname = 'uclaw_cloud'" \
  | grep -q 1 || docker exec "$PG_CONTAINER" psql -U uclaw -d postgres -c "CREATE DATABASE uclaw_cloud" >/dev/null
docker exec -i "$PG_CONTAINER" psql -U uclaw -d uclaw_cloud >/dev/null < migrations/000001_init.sql

admin_login="$(curl -fsS -X POST "$NEWAPI_BASE_URL/api/user/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ROOT_USERNAME\",\"password\":\"$ROOT_PASSWORD\"}")"
admin_token="$(printf '%s' "$admin_login" | node_get "if(!j.success){console.error(JSON.stringify(j));process.exit(1)}process.stdout.write(j.data.access_token)")"

DATABASE_URL="postgres://uclaw:uclaw@127.0.0.1:${PG_PORT}/uclaw_cloud?sslmode=disable" \
ACTIVATION_CODE_PEPPER="e2e-activation-pepper" \
  go run ./cmd/adminctl activation seed --code "$ACTIVATION_CODE" >/dev/null

APP_ENV=development \
UCLAW_HTTP_ADDR="$API_ADDR" \
DATABASE_URL="postgres://uclaw:uclaw@127.0.0.1:${PG_PORT}/uclaw_cloud?sslmode=disable" \
JWT_SECRET="e2e-jwt-secret-at-least-32-bytes" \
SMS_CODE_PEPPER="e2e-sms-pepper" \
ACTIVATION_CODE_PEPPER="e2e-activation-pepper" \
NEWAPI_ADMIN_BASE_URL="$NEWAPI_BASE_URL" \
NEWAPI_ADMIN_TOKEN="$admin_token" \
NEWAPI_CLIENT_BASE_URL="$NEWAPI_BASE_URL/v1" \
NEWAPI_ACTIVATION_QUOTA="100000" \
NEWAPI_USER_PASSWORD_SECRET="e2e-newapi-password-secret" \
go run ./cmd/api serve >/tmp/uclaw-cloud-api-e2e.log 2>&1 &
API_PID="$!"

for _ in $(seq 1 60); do
  if curl -fsS "http://${API_ADDR}/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

curl -fsS -X POST "http://${API_ADDR}/v1/auth/sms/send" \
  -H 'Content-Type: application/json' \
  -d "{\"phone\":\"$PHONE\",\"purpose\":\"login\"}" >/dev/null

login_json="$(curl -fsS -X POST "http://${API_ADDR}/v1/auth/sms/login" \
  -H 'Content-Type: application/json' \
  -d "{\"phone\":\"$PHONE\",\"purpose\":\"login\",\"code\":\"123456\"}")"
access_token="$(printf '%s' "$login_json" | node_get "if(!j.accessToken){console.error(JSON.stringify(j));process.exit(1)}process.stdout.write(j.accessToken)")"

redeem_json="$(curl -fsS -X POST "http://${API_ADDR}/v1/activation/redeem" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $access_token" \
  -d "{\"activationCode\":\"$ACTIVATION_CODE\",\"deviceSummary\":\"LOCAL-E2E\"}")"

printf '%s' "$redeem_json" | node_get "if(j.status!=='activated'||!j.newapiToken||!j.newapiToken.startsWith('sk-')){console.error(JSON.stringify(j));process.exit(1)}process.stdout.write(JSON.stringify({ok:true,step:'activation_local_e2e',phoneMasked:j.phoneMasked,token_present:true,baseUrl:j.newapiBaseUrl}))"
echo
