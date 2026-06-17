#!/bin/bash
# ============================================================
# U-Claw - Portable AI Agent (macOS)
# Double-click to start / 双击启动
# ============================================================

UCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$UCLAW_DIR/app"
CORE_DIR="$APP_DIR/core"
DATA_DIR="$UCLAW_DIR/data"
STATE_DIR="$DATA_DIR/.openclaw"
CONFIG_FILE="$STATE_DIR/openclaw.json"

# Migration shim: rename old core-mac to core for existing USB users
if [ -d "$APP_DIR/core-mac" ] && [ ! -d "$APP_DIR/core" ]; then
    mv "$APP_DIR/core-mac" "$APP_DIR/core"
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo -e "${CYAN}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║     🦞 U-Claw v1.1                  ║"
echo "  ║     Portable AI Agent               ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"

# ---- 1. Detect CPU & set runtime ----
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    NODE_DIR="$APP_DIR/runtime/node-mac-arm64"
    echo -e "  ${GREEN}Apple Silicon (M series)${NC}"
elif [ "$ARCH" = "x86_64" ]; then
    NODE_DIR="$APP_DIR/runtime/node-mac-x64"
    echo -e "  ${GREEN}Intel Mac (x64)${NC}"
else
    echo -e "  ${RED}Unsupported architecture: $ARCH${NC}"
    echo ""
    read -p "  Press Enter to exit..."
    exit 1
fi

NODE_BIN="$NODE_DIR/bin/node"
export PATH="$NODE_DIR/bin:$PATH"

# ---- 2. Remove macOS quarantine ----
if xattr -l "$NODE_BIN" 2>/dev/null | grep -q "com.apple.quarantine"; then
    echo -e "  ${YELLOW}Removing macOS security restriction...${NC}"
    xattr -rd com.apple.quarantine "$UCLAW_DIR" 2>/dev/null || true
    echo -e "  ${GREEN}Done${NC}"
fi

# ---- 3. Check runtime ----
if [ ! -f "$NODE_BIN" ]; then
    echo -e "  ${RED}Error: Node.js runtime not found${NC}"
    echo "  Please run: bash setup.sh"
    read -p "  Press Enter to exit..."
    exit 1
fi

NODE_VER=$("$NODE_BIN" --version)
echo -e "  Node.js: ${GREEN}${NODE_VER}${NC}"
echo ""

# ---- 4. Init data directories ----
mkdir -p "$STATE_DIR" "$DATA_DIR/memory" "$DATA_DIR/backups" "$DATA_DIR/logs"

# ---- 5. Default config ----
if [ ! -f "$CONFIG_FILE" ]; then
    if [ -f "$DATA_DIR/config.json" ]; then
        echo -e "  ${YELLOW}Migrating legacy config...${NC}"
        cp "$DATA_DIR/config.json" "$CONFIG_FILE"
        echo -e "  ${GREEN}Config migrated${NC}"
    else
        echo -e "  ${YELLOW}First run - creating default config...${NC}"
        cat > "$CONFIG_FILE" << 'CFGEOF'
{
  "gateway": {
    "mode": "local",
    "auth": { "token": "uclaw" }
  }
}
CFGEOF
        echo -e "  ${GREEN}Config created${NC}"
    fi
    echo ""
fi

# ---- 6. Set environment (portable mode) ----
export OPENCLAW_HOME="$DATA_DIR"
export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_CONFIG_PATH="$CONFIG_FILE"
# U-Claw opens the local dashboard directly; disable mDNS/Bonjour discovery.
# On macOS the bonjour plugin auto-starts and advertises the gateway on the LAN
# (_openclaw-gw._tcp.local), which is unnecessary for local use and triggers
# "no IPv4 address available on utunN" warnings on machines with VPN/Tailscale.
export OPENCLAW_DISABLE_BONJOUR=1

# ---- 7. Check dependencies ----
if [ ! -d "$CORE_DIR/node_modules" ]; then
    echo -e "  ${YELLOW}[WARN] node_modules not found${NC}"
    echo "  This release should ship with deps pre-installed."
    echo "  Falling back to npm install (USB drives may take 20+ min)."
    echo "  TIP: re-download u-claw-portable-*.zip with bundled deps."
    cd "$CORE_DIR"
    # 把 npm 缓存留在盘内，避免污染系统 ~/.npm（拔盘不留痕）
    npm_config_cache="$APP_DIR/.npm-cache" \
    "$NODE_BIN" "$NODE_DIR/bin/npm" install --registry=https://registry.npmmirror.com --ignore-scripts --no-audit --no-fund --omit=dev 2>&1
    echo -e "  ${GREEN}Dependencies installed${NC}"
    echo ""
fi

# ---- 7b. Async update check (non-blocking, 5s timeout, silent failure) ----
# Writes data/.openclaw/update-available.json if a newer version is on OSS.
# Welcome.html / Config.html read this file and show a banner.
# Version file lookup: portable/OPENCLAW_VERSION (USB) → ../OPENCLAW_VERSION (dev)
VERSION_FILE="$UCLAW_DIR/OPENCLAW_VERSION"
[ -f "$VERSION_FILE" ] || VERSION_FILE="$UCLAW_DIR/../OPENCLAW_VERSION"
if [ -f "$VERSION_FILE" ]; then
    "$NODE_BIN" "$UCLAW_DIR/lib/check-update.mjs" "$VERSION_FILE" "$STATE_DIR" >/dev/null 2>&1 &
fi

# ---- 8. Find available port ----
PORT=18789
while lsof -i :$PORT >/dev/null 2>&1; do
    echo -e "  ${YELLOW}Port $PORT in use, trying next...${NC}"
    PORT=$((PORT + 1))
    if [ $PORT -gt 18799 ]; then
        echo -e "  ${RED}No available port (18789-18799)${NC}"
        read -p "  Press Enter to exit..."
        exit 1
    fi
done

# ---- 9. Start Config Server in background ----
echo -e "  ${CYAN}Starting Config Center on port 18788...${NC}"
CONFIG_SERVER="$UCLAW_DIR/config-server"
"$NODE_BIN" "$CONFIG_SERVER/server.js" &
CONFIG_PID=$!
sleep 1

# ---- 10. Start gateway ----
echo -e "  ${CYAN}Starting OpenClaw on port $PORT...${NC}"
echo ""

cd "$CORE_DIR"
OPENCLAW_MJS="$CORE_DIR/node_modules/openclaw/openclaw.mjs"
"$NODE_BIN" "$OPENCLAW_MJS" gateway run --allow-unconfigured --force --port $PORT &
GW_PID=$!

# ---- 11. 是否已配置模型？openclaw.json 含 "providers" 即视为已配置 (issue #24) ----
# 已配置：只开 Dashboard，不再每次弹配置页。未配置（首次）：开 Config Center 引导填 Key。
MODEL_CONFIGURED=0
if grep -q '"providers"' "$CONFIG_FILE" 2>/dev/null; then
    MODEL_CONFIGURED=1
fi

# ---- 12. Wait for gateway, then open browser ----
# 首次启动会 staging ~35 个 bundled deps，慢盘上实测可达 90 秒以上，期间端口还没
# LISTENING。轮询上限必须覆盖这段，否则浏览器在 gateway ready 前就放弃打开，用户
# 看到"拒绝连接"以为坏了（同 Windows issue #46/#48）。最多等 ~3 分钟（180×1s）。
echo -e "  ${YELLOW}首次启动需准备运行环境，约 30-90 秒，请稍候...${NC}"
GATEWAY_READY=0
for i in $(seq 1 180); do
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
        GATEWAY_READY=1
        if [ "$MODEL_CONFIGURED" = "1" ]; then
            # 已配置：只开 Dashboard
            open "http://127.0.0.1:$PORT/#token=uclaw" 2>/dev/null || true
        else
            # 首次：开 Config Center 引导填 Key
            open "http://127.0.0.1:18788/" 2>/dev/null || true
        fi
        break
    fi
    sleep 1
done
if [ "$GATEWAY_READY" != "1" ]; then
    # 超时回退：gateway 还没就绪也别让用户干等，先开 Config Center
    echo -e "  ${YELLOW}Gateway 启动较慢，先打开配置中心...${NC}"
    open "http://127.0.0.1:18788/" 2>/dev/null || true
fi

echo -e "  ${GREEN}════════════════════════════════${NC}"
echo -e "  ${GREEN}🦞 U-Claw is running!${NC}"
echo -e "  ${GREEN}   Dashboard:     http://127.0.0.1:$PORT/#token=uclaw${NC}"
echo -e "  ${GREEN}   Config Center: http://127.0.0.1:18788/${NC}"
echo ""
echo -e "  ${YELLOW}Press Ctrl+C to stop${NC}"
echo -e "  ${GREEN}════════════════════════════════${NC}"
echo ""

# ---- Cleanup on exit ----
cleanup() {
    kill $GW_PID 2>/dev/null
    kill $CONFIG_PID 2>/dev/null
    echo ""
    echo -e "  🦞 U-Claw stopped."
    exit 0
}
trap cleanup INT TERM

wait $GW_PID
GW_EXIT=$?

# Ctrl+C 走 trap cleanup（exit 0）不会到这；走到这里说明 gateway 自己退了。
if [ "$GW_EXIT" -ne 0 ]; then
    echo -e "  ${YELLOW}OpenClaw exited unexpectedly (code $GW_EXIT)${NC}"
fi
kill $CONFIG_PID 2>/dev/null
echo ""
echo -e "  🦞 U-Claw stopped."
