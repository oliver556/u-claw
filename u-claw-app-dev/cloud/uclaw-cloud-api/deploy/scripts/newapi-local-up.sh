#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/deploy/newapi-local/docker-compose.yml"

docker compose -f "$COMPOSE_FILE" up -d
echo "New API local lab: http://127.0.0.1:${NEWAPI_LOCAL_PORT:-3000}"
