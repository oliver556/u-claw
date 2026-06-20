@echo off
REM wait-gateway.bat - fallback watcher after Windows-Start opens loading.html.
REM Slow USB drives can need tens of seconds before the gateway listens.
REM
REM Windows-Start opens Config Center immediately, so the ready path only
REM exits quietly. On timeout, reopen Config Center as a recovery hint.
REM Usage (called in background by Windows-Start.bat): wait-gateway.bat PORT
REM Polls every 2 seconds, up to about 5 minutes.

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
exit /b 0

:timeout
start "" http://127.0.0.1:18788/
exit /b 1
