#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_URL="${NEWAPI_ADMIN_BASE_URL:-http://127.0.0.1:${NEWAPI_LOCAL_PORT:-3000}}"
ROOT_USERNAME="${NEWAPI_LOCAL_ROOT_USERNAME:-root}"
ROOT_PASSWORD="${NEWAPI_LOCAL_ROOT_PASSWORD:-UclawLocal@2026}"
DEFAULT_TEST_USERNAME="139$(date +%s | tail -c 9)"
TEST_USERNAME="${NEWAPI_LOCAL_TEST_USERNAME:-$DEFAULT_TEST_USERNAME}"
TEST_PASSWORD="${NEWAPI_LOCAL_TEST_PASSWORD:-UclawTest@2026}"
TEST_QUOTA="${NEWAPI_LOCAL_TEST_QUOTA:-100000}"

cd "$ROOT_DIR"

post_json() {
  local path="$1"
  local payload="$2"
  curl -fsS -X POST "$BASE_URL$path" \
    -H 'Content-Type: application/json' \
    -d "$payload"
}

node_get() {
  local expression="$1"
  node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s);${expression}})"
}

setup_status="$(curl -fsS "$BASE_URL/api/setup")"
is_initialized="$(printf '%s' "$setup_status" | node_get "process.stdout.write(String(j?.data?.status === true))")"
if [[ "$is_initialized" != "true" ]]; then
  post_json "/api/setup" "{\"username\":\"$ROOT_USERNAME\",\"password\":\"$ROOT_PASSWORD\",\"confirmPassword\":\"$ROOT_PASSWORD\",\"usageMode\":\"external\"}" >/dev/null
fi

admin_login="$(post_json "/api/user/login" "{\"username\":\"$ROOT_USERNAME\",\"password\":\"$ROOT_PASSWORD\"}")"
admin_token="$(printf '%s' "$admin_login" | node_get "if(!j.success){console.error(JSON.stringify(j));process.exit(1)}process.stdout.write(j.data.access_token)")"

NEWAPI_ADMIN_BASE_URL="$BASE_URL" NEWAPI_ADMIN_TOKEN="$admin_token" \
  go run ./cmd/adminctl spike newapi create-user \
    --username "$TEST_USERNAME" \
    --password "$TEST_PASSWORD"

search_result="$(curl -fsS "$BASE_URL/api/user/search?keyword=$TEST_USERNAME" -H "Authorization: Bearer $admin_token")"
user_id="$(printf '%s' "$search_result" | node_get "const item=(j.data?.items||[]).find(x=>x.username==='${TEST_USERNAME}'); if(!item){console.error(JSON.stringify(j));process.exit(1)} process.stdout.write(String(item.id))")"

NEWAPI_ADMIN_BASE_URL="$BASE_URL" NEWAPI_ADMIN_TOKEN="$admin_token" \
  go run ./cmd/adminctl spike newapi add-quota \
    --user-id "$user_id" \
    --quota "$TEST_QUOTA"

user_login="$(post_json "/api/user/login" "{\"username\":\"$TEST_USERNAME\",\"password\":\"$TEST_PASSWORD\"}")"
user_token="$(printf '%s' "$user_login" | node_get "if(!j.success){console.error(JSON.stringify(j));process.exit(1)}process.stdout.write(j.data.access_token)")"

NEWAPI_ADMIN_BASE_URL="$BASE_URL" NEWAPI_ADMIN_TOKEN="$user_token" \
  go run ./cmd/adminctl spike newapi create-token \
    --token-name uclaw-main

echo "{\"ok\":true,\"step\":\"local_spike\",\"base_url\":\"$BASE_URL\",\"username\":\"$TEST_USERNAME\",\"user_id\":$user_id,\"quota\":$TEST_QUOTA}"
