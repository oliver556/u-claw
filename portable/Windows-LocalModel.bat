@echo off
chcp 65001 >nul 2>&1
title U-Claw - Local / Intranet Model Setup
setlocal

set "UCLAW_DIR=%~dp0"
set "NODE_BIN=%UCLAW_DIR%app\runtime\node-win-x64\node.exe"
set "CONFIG_PATH=%UCLAW_DIR%data\.openclaw\openclaw.json"

if not exist "%NODE_BIN%" (
    echo   [ERROR] Node runtime not found.
    echo   Put this file inside your U-Claw folder, next to Windows-Start.bat, then run again.
    echo.
    pause
    exit /b 1
)

"%NODE_BIN%" "%UCLAW_DIR%lib\setup-local-model.mjs" "%CONFIG_PATH%"

echo.
pause
