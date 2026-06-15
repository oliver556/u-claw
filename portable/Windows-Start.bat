@echo off
chcp 65001 >nul 2>&1
title U-Claw - Portable AI Agent

echo.
echo   ========================================
echo     U-Claw v1.1 - Portable AI Agent
echo   ========================================
echo.

set "UCLAW_DIR=%~dp0"
set "APP_DIR=%UCLAW_DIR%app"

REM Migration shim: rename old core-win to core for existing USB users
if exist "%APP_DIR%\core-win" if not exist "%APP_DIR%\core" ren "%APP_DIR%\core-win" core

set "CORE_DIR=%APP_DIR%\core"
set "DATA_DIR=%UCLAW_DIR%data"
set "STATE_DIR=%DATA_DIR%\.openclaw"
set "NODE_DIR=%APP_DIR%\runtime\node-win-x64"
set "NODE_BIN=%NODE_DIR%\node.exe"
set "NPM_BIN=%NODE_DIR%\npm.cmd"

set "OPENCLAW_HOME=%DATA_DIR%"
set "OPENCLAW_STATE_DIR=%STATE_DIR%"
set "OPENCLAW_CONFIG_PATH=%STATE_DIR%\openclaw.json"
REM U-Claw opens the local dashboard directly; disable mDNS discovery on Windows
REM to avoid OpenClaw/@homebridge ciao crashes during bonjour re-advertise.
set "OPENCLAW_DISABLE_BONJOUR=1"

REM Check runtime
if not exist "%NODE_BIN%" (
    echo   [ERROR] Node.js runtime not found
    echo   Please ensure app\runtime\node-win-x64 is complete
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('"%NODE_BIN%" --version') do set NODE_VER=%%v
echo   Node.js: %NODE_VER%
echo.

set "PATH=%NODE_DIR%;%NODE_DIR%\node_modules\.bin;%PATH%"

REM Init data directories
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"
if not exist "%STATE_DIR%" mkdir "%STATE_DIR%"
if not exist "%DATA_DIR%\memory" mkdir "%DATA_DIR%\memory"
if not exist "%DATA_DIR%\backups" mkdir "%DATA_DIR%\backups"
if not exist "%DATA_DIR%\logs" mkdir "%DATA_DIR%\logs"

REM Default config (migrate legacy if present, otherwise create)
if not exist "%STATE_DIR%\openclaw.json" (
    if exist "%DATA_DIR%\config.json" (
        echo   Migrating legacy config...
        copy "%DATA_DIR%\config.json" "%STATE_DIR%\openclaw.json" >nul
        echo   Config migrated
    ) else (
        echo   First run - creating default config...
        (echo {"gateway":{"mode":"local","auth":{"token":"uclaw"}}})>"%STATE_DIR%\openclaw.json"
        echo   Config created
    )
    echo.
)

REM Check dependencies
REM Note: avoid unescaped parens inside this block — cmd.exe treats ) as block-end.
if not exist "%CORE_DIR%\node_modules" (
    echo   ========================================
    echo   [WARN] node_modules not found
    echo   ========================================
    echo   This release should ship with deps pre-installed.
    echo   Falling back to npm install ^(USB drives may take 20+ minutes^).
    echo.
    echo   TIP: Re-download u-claw-portable-*.zip from GitHub releases,
    echo        which includes pre-installed deps ^(~200 MB^).
    echo.
    echo   File system: NTFS recommended. exFAT/FAT32 will be very slow.
    echo.
    cd /d "%CORE_DIR%"
    REM 把 npm 缓存留在盘内，避免污染系统 %APPDATA%\npm-cache（拔盘不留痕）
    set "npm_config_cache=%APP_DIR%\.npm-cache"
    call "%NPM_BIN%" install --registry=https://registry.npmmirror.com --ignore-scripts --no-audit --no-fund --omit=dev
    echo.
    echo   Dependencies installed!
    echo.
)

REM Bind device fingerprint and inject Xiapan Cloud apiKey into openclaw.json
echo   Binding device fingerprint to Xiapan Cloud...
set "UCLAW_APP_ROOT=%UCLAW_DIR%"
"%NODE_BIN%" "%UCLAW_DIR%lib\bootstrap-xiapan.mjs" "%STATE_DIR%\openclaw.json"
echo.

REM Async update check (non-blocking, 5s timeout, silent failure)
REM Writes data\.openclaw\update-available.json if a newer version is on OSS.
REM Welcome.html / Config.html read this file and show a banner.
REM Version file lookup order: portable/OPENCLAW_VERSION (USB), then repo-root ../OPENCLAW_VERSION (dev)
set "VERSION_FILE=%UCLAW_DIR%OPENCLAW_VERSION"
if not exist "%VERSION_FILE%" set "VERSION_FILE=%UCLAW_DIR%..\OPENCLAW_VERSION"
if exist "%VERSION_FILE%" (
    start /B "" "%NODE_BIN%" "%UCLAW_DIR%lib\check-update.mjs" "%VERSION_FILE%" "%STATE_DIR%" >nul 2>&1
)


REM Auto-install WeChat plugin if available
set "WECHAT_PLUGIN_SRC=%APP_DIR%\extensions\openclaw-weixin"
set "WECHAT_PLUGIN_DST=%USERPROFILE%\.openclaw\extensions\openclaw-weixin"
if exist "%WECHAT_PLUGIN_SRC%\openclaw.plugin.json" (
    if not exist "%WECHAT_PLUGIN_DST%\openclaw.plugin.json" (
        echo   Installing WeChat plugin...
        mkdir "%USERPROFILE%\.openclaw\extensions" 2>nul
        xcopy /s /e /q /y "%WECHAT_PLUGIN_SRC%" "%WECHAT_PLUGIN_DST%\" >nul
        echo   WeChat plugin installed!
        echo.
    )
)

REM Find available port
set PORT=18789
:check_port
netstat -an | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo   Port %PORT% in use, trying next...
    set /a PORT+=1
    if %PORT% gtr 18799 (
        echo   No available port 18789-18799
        REM 自动上报：端口全被占，gateway 无法启动（detach、静默、失败不影响）
        start /B "" "%NODE_BIN%" "%UCLAW_DIR%lib\report-bug.mjs" --auto --title "gateway-no-free-port" --desc "Ports 18789-18799 all in use" --root "%UCLAW_DIR%." >nul 2>&1
        pause
        exit /b 1
    )
    goto :check_port
)

echo   Starting OpenClaw on port %PORT%...
echo.

REM Start Config Server in background
echo   Starting Config Center on port 18788...
set "CONFIG_SERVER=%UCLAW_DIR%config-server"
start /B "" "%NODE_BIN%" "%CONFIG_SERVER%\server.js" >nul 2>&1

REM Wait for config server to start
timeout /t 2 /nobreak >nul

REM IMPORTANT: 不要在 gateway 启动前就开 Dashboard 浏览器！
REM 慢 U 盘上 OpenClaw 首次启动要 staging bundled deps（几十秒），
REM 过早打开 http://127.0.0.1:18789 会"拒绝连接"，是 issue #46/#48 的根因。
REM 改为后台等待器：轮询端口，gateway 真正 LISTENING 后再开 Dashboard。
echo   Opening Config Center...
start "" http://127.0.0.1:18788/

REM 后台等待器：每 2s 探测 %PORT%，最多 ~5 分钟（150 次），监听到就开 Dashboard
start /B "" cmd /c ""%UCLAW_DIR%lib\wait-gateway.bat" %PORT%"

echo.
echo   ========================================
echo   Starting OpenClaw Gateway on port %PORT%...
echo   First run on a USB drive may take 30-90 seconds
echo   (unpacking bundled components). Please wait;
echo   the Dashboard opens automatically when ready.
echo   DO NOT close this window while using U-Claw!
echo   ========================================
echo.

cd /d "%CORE_DIR%"
set "OPENCLAW_MJS=%CORE_DIR%\node_modules\openclaw\openclaw.mjs"
"%NODE_BIN%" "%OPENCLAW_MJS%" gateway run --allow-unconfigured --force --port %PORT%
set "GW_EXIT=%errorlevel%"

echo.
REM 自动上报：gateway 异常退出（退出码非 0 且非 Ctrl+C/0xC000013A=-1073741510）
REM 用户正常 Ctrl+C 停止不上报，避免噪音。detach、静默、失败不影响。
if not "%GW_EXIT%"=="0" if not "%GW_EXIT%"=="-1073741510" (
    echo   OpenClaw exited unexpectedly (code %GW_EXIT%), reporting...
    start /B "" "%NODE_BIN%" "%UCLAW_DIR%lib\report-bug.mjs" --auto --title "gateway-exited-code-%GW_EXIT%" --desc "Gateway exited with code %GW_EXIT% on port %PORT%" --root "%UCLAW_DIR%." >nul 2>&1
)
echo   OpenClaw stopped.
pause
