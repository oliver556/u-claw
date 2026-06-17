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

REM ── 加速：把"重 IO、可重建"的缓存从 U 盘搬到本机硬盘 ──────────────────
REM portable-cache.mjs 算出本机缓存目录（%LOCALAPPDATA%\U-Claw\slot，UUID 隔离，
REM 换盘符仍复用），并把 .openclaw\browser 做成 junction 指向本机盘。
REM 浏览器 user-data（几百 MB 随机小写）和 V8 编译缓存因此落本机 SSD，不再拖慢 U 盘。
REM 静默失败：取不到就跳过，缓存留 U 盘，照常启动。
for /f "usebackq tokens=1,* delims==" %%a in (`""%NODE_BIN%" "%UCLAW_DIR%lib\portable-cache.mjs" "%STATE_DIR%" "%UCLAW_DIR%" 2^>nul"`) do (
    if "%%a"=="UCLAW_COMPILE_CACHE_DIR" set "NODE_COMPILE_CACHE=%%b"
    if "%%a"=="UCLAW_CACHE_ROOT" set "UCLAW_CACHE_ROOT=%%b"
)
if defined NODE_COMPILE_CACHE echo   Cache on local disk: %UCLAW_CACHE_ROOT%

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

REM 等 Config Server 就绪 —— 动态探测而非写死等待。
REM 它通常 <1s 就起来，写死 timeout /t 2 是白等。改为每 ~0.3s 探测 18788，
REM 最多 ~6s（20 次）兜底。监听到就立刻往下走。
set /a CFG_TRIES=0
:wait_config
netstat -an | findstr ":18788 " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 goto :config_ready
set /a CFG_TRIES+=1
if %CFG_TRIES% geq 20 goto :config_ready
ping -n 1 -w 300 127.0.0.1 >nul 2>&1
goto :wait_config
:config_ready

REM IMPORTANT: 不要在 gateway 启动前就开 Dashboard 浏览器！
REM 慢 U 盘上 OpenClaw 首次启动要 staging bundled deps（几十秒），
REM 过早打开 http://127.0.0.1:18789 会"拒绝连接"，是 issue #46/#48 的根因。
REM 方案：立刻打开本地"启动首屏"loading.html，给用户即时反馈（移植自 4.0 splash）。
REM 首屏自己轮询 /ready，gateway 真就绪后自动跳 Dashboard——天然解决拒连。

REM 是否已配置模型？openclaw.json 含 providers 即视为已配置 (issue #24)。
REM 未配置（首次）：先开 Config Center 引导填 Key。
set "MODEL_CONFIGURED="
findstr /C:"providers" "%STATE_DIR%\openclaw.json" >nul 2>&1
if %errorlevel%==0 set "MODEL_CONFIGURED=1"

REM 立刻开启动首屏（带 port 参数，就绪后自动跳 Dashboard）
REM 用 file:/// URL（正斜杠）+ 转义 & ，确保 query string 能传给浏览器。
echo   Opening startup screen...
set "LOADING_PATH=%UCLAW_DIR%lib\loading.html"
set "LOADING_URL=file:///%LOADING_PATH:\=/%?port=%PORT%&token=uclaw"
start "" "%LOADING_URL%"

if not defined MODEL_CONFIGURED (
    echo   First-time setup - opening Config Center...
    start "" http://127.0.0.1:18788/
)

REM 后台等待器兜底：万一首屏页没起作用（浏览器拦本地 fetch 等），
REM 仍轮询端口，gateway LISTENING 后开 Dashboard。
start /B "" cmd /c ""%UCLAW_DIR%lib\wait-gateway.bat" %PORT%"

REM gateway 首轮预热（后台、静默、非阻塞）：就绪后先唤醒 config/model 子系统，
REM 用户首次点发送时不再等。移植自 4.0 first-turn-prewarm。
start /B "" "%NODE_BIN%" "%UCLAW_DIR%lib\prewarm.mjs" %PORT% uclaw >nul 2>&1

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
if not "%GW_EXIT%"=="0" if not "%GW_EXIT%"=="-1073741510" (
    echo   OpenClaw exited unexpectedly ^(code %GW_EXIT%^)
)
echo   OpenClaw stopped.
pause
