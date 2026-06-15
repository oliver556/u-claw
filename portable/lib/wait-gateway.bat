@echo off
REM wait-gateway.bat - open Dashboard only after the Gateway is actually listening.
REM Fixes issue #46/#48: on slow USB drives the gateway needs tens of seconds to
REM stage bundled deps on first run; opening http://127.0.0.1:PORT before it is
REM LISTENING shows "connection refused" and users think it is broken.
REM Usage (called in background by Windows-Start.bat): wait-gateway.bat PORT
REM Polls every 2s, up to 150 tries (~5 min). Opens the browser once ready.

set "PORT=%~1"
if "%PORT%"=="" set "PORT=18789"

set /a TRIES=0
:wait_loop
netstat -an | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 goto :ready
set /a TRIES+=1
if %TRIES% geq 150 goto :timeout
timeout /t 2 /nobreak >nul
goto :wait_loop

:ready
timeout /t 1 /nobreak >nul
start "" http://127.0.0.1:%PORT%/#token=uclaw
exit /b 0

:timeout
start "" http://127.0.0.1:18788/
exit /b 1
