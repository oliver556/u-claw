#!/bin/zsh
set -eu

PRODUCT_DIR="$(cd "$(dirname "$0")" && pwd)"
UCLAW_RUNTIME_DIR="${UCLAW_RUNTIME_DIR:-$HOME/.uclaw}"
ARCH="$(uname -m)"
NODE_PLATFORM="node-mac-$ARCH"

export UCLAW_RUNTIME_DIR
export UCLAW_OPENCLAW_ENTRY="${UCLAW_OPENCLAW_ENTRY:-$UCLAW_RUNTIME_DIR/core/node_modules/openclaw/openclaw.mjs}"
export UCLAW_NODE_BIN="${UCLAW_NODE_BIN:-$UCLAW_RUNTIME_DIR/runtime/$NODE_PLATFORM/bin/node}"
export UCLAW_DATA_DIR="${UCLAW_DATA_DIR:-$UCLAW_RUNTIME_DIR/data}"
export UCLAW_CACHE_DIR="${UCLAW_CACHE_DIR:-$UCLAW_RUNTIME_DIR/cache}"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$UCLAW_DATA_DIR/.openclaw/openclaw.json}"

exec "$PRODUCT_DIR/node_modules/.bin/electron" "$PRODUCT_DIR/desktop/dist/entry.js" --uclaw-startup-mode=normal
