@echo off
chcp 65001 >nul 2>&1
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "USB_DATA_DIR=%ROOT%\data"
set "ARCHIVE=%ROOT%\app\desktop-archive\u-claw-app-win-x64.zip"
set "ARCHIVE_SHA_FILE=%ARCHIVE%.sha256"
set "CACHE_ROOT=%LOCALAPPDATA%\U-Claw\usb-portable"
set "APP_CACHE_DIR=%CACHE_ROOT%\app-win-x64"
set "RUN_DATA_DIR=%CACHE_ROOT%\data"
set "APP_BIN=%APP_CACHE_DIR%\U-Claw.exe"
set "STAMP_FILE=%APP_CACHE_DIR%\.u-claw-archive.sha256"

if not exist "%ARCHIVE%" (
  echo [U-Claw] Missing Windows archive:
  echo %ARCHIVE%
  echo.
  pause
  exit /b 1
)

if not exist "%ARCHIVE_SHA_FILE%" (
  echo [U-Claw] Missing Windows archive manifest:
  echo %ARCHIVE_SHA_FILE%
  pause
  exit /b 1
)

if not exist "%USB_DATA_DIR%\.openclaw\openclaw.json" (
  echo [U-Claw] Missing config:
  echo %USB_DATA_DIR%\.openclaw\openclaw.json
  pause
  exit /b 1
)

if not exist "%CACHE_ROOT%" mkdir "%CACHE_ROOT%" >nul 2>&1

set /p "CURRENT_STAMP="<"%ARCHIVE_SHA_FILE%"
set "CACHED_STAMP="
if exist "%STAMP_FILE%" set /p "CACHED_STAMP="<"%STAMP_FILE%"

if not exist "%APP_BIN%" goto install_app_cache
if not "%CURRENT_STAMP%"=="%CACHED_STAMP%" goto install_app_cache
goto app_cache_ready

:install_app_cache
set "TMP_APP_DIR=%CACHE_ROOT%\app-win-x64.installing"
echo [U-Claw] Installing updated app cache from archive...
echo [U-Claw] This runs once per package version; later starts reuse the computer cache.
echo [U-Claw] Verifying Windows archive...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$expected=(Get-Content -LiteralPath $env:ARCHIVE_SHA_FILE -TotalCount 1).Trim().ToLowerInvariant(); $actual=(Get-FileHash -LiteralPath $env:ARCHIVE -Algorithm SHA256).Hash.ToLowerInvariant(); if ($actual -ne $expected) { Write-Error ('Archive SHA-256 mismatch. expected={0} actual={1}' -f $expected,$actual); exit 1 }"
if errorlevel 1 goto fatal
for /d %%D in ("%CACHE_ROOT%\app-win-x64.tmp-*") do if exist "%%~fD" rmdir /s /q "%%~fD"
if exist "%TMP_APP_DIR%" rmdir /s /q "%TMP_APP_DIR%"
mkdir "%TMP_APP_DIR%" >nul 2>&1
where tar.exe >nul 2>&1
if errorlevel 1 goto extract_with_powershell
echo [U-Claw] Extracting with Windows tar...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$started=Get-Date; $job=Start-Job -ScriptBlock { param($archive,$destination) & tar.exe -xf $archive -C $destination; if ($LASTEXITCODE -ne 0) { throw ('tar.exe exited with status {0}' -f $LASTEXITCODE) } } -ArgumentList $env:ARCHIVE,$env:TMP_APP_DIR; while (-not (Wait-Job -Job $job -Timeout 5)) { $elapsed=[int]((Get-Date)-$started).TotalSeconds; Write-Host ('[U-Claw] Extracting Windows app... {0}s elapsed.' -f $elapsed) }; $state=$job.State; Receive-Job -Job $job; Remove-Job -Job $job; if ($state -ne 'Completed') { exit 1 }"
if errorlevel 1 goto fatal
goto extract_complete

:extract_with_powershell
echo [U-Claw] Windows tar unavailable; using PowerShell fallback...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$started=Get-Date; $job=Start-Job -ScriptBlock { param($archive,$destination) $ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force } -ArgumentList $env:ARCHIVE,$env:TMP_APP_DIR; while (-not (Wait-Job -Job $job -Timeout 5)) { $elapsed=[int]((Get-Date)-$started).TotalSeconds; Write-Host ('[U-Claw] Extracting Windows app... {0}s elapsed.' -f $elapsed) }; $state=$job.State; Receive-Job -Job $job; Remove-Job -Job $job; if ($state -ne 'Completed') { exit 1 }"
if errorlevel 1 goto fatal

:extract_complete
if not exist "%TMP_APP_DIR%\U-Claw.exe" (
  echo [U-Claw] Invalid archive: U-Claw.exe missing.
  goto fatal
)
if exist "%APP_CACHE_DIR%" rmdir /s /q "%APP_CACHE_DIR%"
move "%TMP_APP_DIR%" "%APP_CACHE_DIR%" >nul
>"%STAMP_FILE%" echo %CURRENT_STAMP%
goto app_cache_ready

:app_cache_ready
echo [U-Claw] Reusing app cache: %APP_CACHE_DIR%
echo [U-Claw] Syncing USB data to computer cache...
if not exist "%RUN_DATA_DIR%" mkdir "%RUN_DATA_DIR%" >nul 2>&1
robocopy "%USB_DATA_DIR%" "%RUN_DATA_DIR%" /MIR /R:2 /W:1 /XJ /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto fatal

set "UCLAW_PORTABLE_DATA_DIR=%RUN_DATA_DIR%"
set "OPENCLAW_HOME=%RUN_DATA_DIR%"
set "OPENCLAW_STATE_DIR=%RUN_DATA_DIR%\.openclaw"
set "OPENCLAW_CONFIG_PATH=%RUN_DATA_DIR%\.openclaw\openclaw.json"
set "OPENCLAW_DISABLE_BONJOUR=1"
set "UCLAW_MEDIA_PREVIEW_ROOTS=%RUN_DATA_DIR%\.openclaw\media"
set "UCLAW_PORTABLE_HOME=%RUN_DATA_DIR%\.home"
set "HOME=%UCLAW_PORTABLE_HOME%"
set "USERPROFILE=%UCLAW_PORTABLE_HOME%"
set "APPDATA=%UCLAW_PORTABLE_HOME%\AppData\Roaming"
set "LOCALAPPDATA=%UCLAW_PORTABLE_HOME%\AppData\Local"
set "CODEX_HOME=%RUN_DATA_DIR%\.codex"
if not exist "%HOME%" mkdir "%HOME%" >nul 2>&1
if not exist "%APPDATA%" mkdir "%APPDATA%" >nul 2>&1
if not exist "%LOCALAPPDATA%" mkdir "%LOCALAPPDATA%" >nul 2>&1
if not exist "%CODEX_HOME%" mkdir "%CODEX_HOME%" >nul 2>&1

echo [U-Claw] USB root: %ROOT%
echo [U-Claw] USB data dir: %USB_DATA_DIR%
echo [U-Claw] Runtime data dir: %RUN_DATA_DIR%
echo [U-Claw] App binary: %APP_BIN%
echo [U-Claw] Starting Windows desktop app...
echo.

"%APP_BIN%"
set "APP_EXIT=%ERRORLEVEL%"

echo [U-Claw] Syncing runtime data back to USB...
robocopy "%RUN_DATA_DIR%" "%USB_DATA_DIR%" /MIR /R:2 /W:1 /XJ /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo [U-Claw] Failed to sync runtime data back to USB.
  exit /b 1
)

exit /b %APP_EXIT%

:fatal
echo [U-Claw] Portable startup failed.
pause
exit /b 1
