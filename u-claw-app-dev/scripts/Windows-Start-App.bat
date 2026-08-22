@echo off
chcp 65001 >nul 2>&1
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "USB_DATA_DIR=%ROOT%\data"
set "CACHE_ROOT=%LOCALAPPDATA%\U-Claw\usb-portable"
set "CACHE_DATA_DIR=%CACHE_ROOT%\data"
set "EXE=%ROOT%\app\desktop-archive\U-Claw 2.1.17.exe"

if not exist "%EXE%" (
  echo [U-Claw] Missing Windows app:
  echo %EXE%
  echo.
  echo Put U-Claw 2.1.17.exe at app\desktop-archive\ first.
  pause
  exit /b 1
)

if not exist "%USB_DATA_DIR%" mkdir "%USB_DATA_DIR%" >nul 2>&1
if not exist "%USB_DATA_DIR%\.openclaw" mkdir "%USB_DATA_DIR%\.openclaw" >nul 2>&1
if not exist "%USB_DATA_DIR%\logs" mkdir "%USB_DATA_DIR%\logs" >nul 2>&1
if not exist "%CACHE_DATA_DIR%" mkdir "%CACHE_DATA_DIR%" >nul 2>&1

echo [U-Claw] Syncing USB data to local runtime cache...
robocopy "%USB_DATA_DIR%" "%CACHE_DATA_DIR%" /MIR /FFT /R:2 /W:1 >nul
if %ERRORLEVEL% GEQ 8 (
  echo [U-Claw] Failed to sync data from USB to local cache. robocopy exit: %ERRORLEVEL%
  pause
  exit /b 1
)

set "UCLAW_PORTABLE_DATA_DIR=%CACHE_DATA_DIR%"
set "OPENCLAW_HOME=%CACHE_DATA_DIR%"
set "OPENCLAW_STATE_DIR=%CACHE_DATA_DIR%\.openclaw"
set "OPENCLAW_CONFIG_PATH=%CACHE_DATA_DIR%\.openclaw\openclaw.json"
set "OPENCLAW_DISABLE_BONJOUR=1"

echo [U-Claw] USB root: %ROOT%
echo [U-Claw] USB data dir: %USB_DATA_DIR%
echo [U-Claw] Runtime data dir: %CACHE_DATA_DIR%
echo [U-Claw] Starting Windows desktop app...
echo.

"%EXE%"

echo.
echo [U-Claw] App closed. Syncing local runtime data back to USB...
robocopy "%CACHE_DATA_DIR%" "%USB_DATA_DIR%" /MIR /FFT /R:2 /W:1 >nul
if %ERRORLEVEL% GEQ 8 (
  echo [U-Claw] Failed to sync data back to USB. robocopy exit: %ERRORLEVEL%
  pause
  exit /b 1
)

exit /b 0
