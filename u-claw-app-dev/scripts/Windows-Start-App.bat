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
set "LOCK_DIR=%CACHE_ROOT%\app-win-x64.lock"
set "LOCAL_ARCHIVE=%CACHE_ROOT%\u-claw-app-win-x64.zip"
set "LOCAL_ARCHIVE_TMP=%CACHE_ROOT%\u-claw-app-win-x64.zip.copying"
set "EXTRACT_TIMEOUT_SECONDS=1800"

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
set "LOCK_WAIT_SECONDS=0"

:acquire_install_lock
mkdir "%LOCK_DIR%" >nul 2>&1
if not errorlevel 1 goto install_lock_acquired
if exist "%APP_BIN%" (
  set "CACHED_STAMP="
  if exist "%STAMP_FILE%" set /p "CACHED_STAMP="<"%STAMP_FILE%"
  if "%CURRENT_STAMP%"=="%CACHED_STAMP%" goto app_cache_ready
)
if %LOCK_WAIT_SECONDS% GEQ 900 (
  echo [U-Claw] Timed out waiting for another startup to install the app cache.
  echo [U-Claw] Close other U-Claw startup windows and retry.
  goto fatal
)
echo [U-Claw] Another U-Claw startup is installing the app cache; waiting... %LOCK_WAIT_SECONDS%s elapsed.
timeout /t 5 /nobreak >nul
set /a LOCK_WAIT_SECONDS+=5
goto acquire_install_lock

:install_lock_acquired
set "INSTALL_LOCK_HELD=1"
set "TMP_APP_DIR=%CACHE_ROOT%\app-win-x64.tmp-%RANDOM%-%RANDOM%"
echo [U-Claw] Installing updated app cache from archive...
echo [U-Claw] This runs once per package version; later starts reuse the computer cache.
echo [U-Claw] Copying Windows archive to computer cache...
if exist "%LOCAL_ARCHIVE_TMP%" del /q "%LOCAL_ARCHIVE_TMP%" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$source=$env:ARCHIVE; $dest=$env:LOCAL_ARCHIVE_TMP; $total=(Get-Item -LiteralPath $source).Length; $inputStream=[System.IO.File]::OpenRead($source); $outputStream=[System.IO.File]::Create($dest); $copied=0L; $started=Get-Date; $last=Get-Date; try { $buffer=New-Object byte[] (4MB); while (($read=$inputStream.Read($buffer,0,$buffer.Length)) -gt 0) { $outputStream.Write($buffer,0,$read); $copied+=$read; $now=Get-Date; if (($now-$last).TotalSeconds -ge 5) { $pct=[math]::Round(($copied*100.0)/$total,1); $elapsed=[int](($now-$started).TotalSeconds); Write-Host ('[U-Claw] Copying Windows archive... {0:N0}/{1:N0} MB ({2}%%), {3}s elapsed.' -f ($copied/1MB),($total/1MB),$pct,$elapsed); $last=$now } } } finally { $outputStream.Close(); $inputStream.Close() }; $elapsed=[int]((Get-Date)-$started).TotalSeconds; Write-Host ('[U-Claw] Copying Windows archive... {0:N0}/{1:N0} MB (100%%), {2}s elapsed.' -f ($copied/1MB),($total/1MB),$elapsed)"
if errorlevel 1 goto fatal
move /y "%LOCAL_ARCHIVE_TMP%" "%LOCAL_ARCHIVE%" >nul
echo [U-Claw] Verifying cached Windows archive...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$expected=(Get-Content -LiteralPath $env:ARCHIVE_SHA_FILE -TotalCount 1).Trim().ToLowerInvariant(); $actual=(Get-FileHash -LiteralPath $env:LOCAL_ARCHIVE -Algorithm SHA256).Hash.ToLowerInvariant(); if ($actual -ne $expected) { Write-Error ('Archive SHA-256 mismatch. expected={0} actual={1}' -f $expected,$actual); exit 1 }"
if errorlevel 1 goto fatal
for /d %%D in ("%CACHE_ROOT%\app-win-x64.tmp-*") do if exist "%%~fD" rmdir /s /q "%%~fD"
if exist "%TMP_APP_DIR%" rmdir /s /q "%TMP_APP_DIR%"
mkdir "%TMP_APP_DIR%" >nul 2>&1
where tar.exe >nul 2>&1
if errorlevel 1 goto extract_with_powershell
echo [U-Claw] Extracting with Windows tar...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$started=Get-Date; $timeout=[int]$env:EXTRACT_TIMEOUT_SECONDS; $destination=$env:TMP_APP_DIR; $lastFiles=0; $lastMb=0; $job=Start-Job -ScriptBlock { param($archive,$destination) & tar.exe -xf $archive -C $destination; if ($LASTEXITCODE -ne 0) { throw ('tar.exe exited with status {0}' -f $LASTEXITCODE) } } -ArgumentList $env:LOCAL_ARCHIVE,$destination; while (-not (Wait-Job -Job $job -Timeout 5)) { $elapsed=[int]((Get-Date)-$started).TotalSeconds; $items=@(Get-ChildItem -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue); $files=$items.Count; $mb=[math]::Round((($items | Measure-Object -Property Length -Sum).Sum)/1MB,1); $deltaFiles=$files-$lastFiles; $deltaMb=[math]::Round($mb-$lastMb,1); Write-Host ('[U-Claw] Extracting Windows app... {0}s elapsed, {1} files, {2} MB, +{3} files, +{4} MB.' -f $elapsed,$files,$mb,$deltaFiles,$deltaMb); $lastFiles=$files; $lastMb=$mb; if ($elapsed -ge $timeout) { Stop-Job -Job $job; Write-Error ('Extract timeout after {0}s. The USB drive, antivirus, or Windows tar may be stuck.' -f $timeout); exit 1 } }; $state=$job.State; Receive-Job -Job $job; Remove-Job -Job $job; if ($state -ne 'Completed') { exit 1 }"
if errorlevel 1 goto fatal
goto extract_complete

:extract_with_powershell
echo [U-Claw] Windows tar unavailable; using PowerShell fallback...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$started=Get-Date; $timeout=[int]$env:EXTRACT_TIMEOUT_SECONDS; $destination=$env:TMP_APP_DIR; $lastFiles=0; $lastMb=0; $job=Start-Job -ScriptBlock { param($archive,$destination) $ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force } -ArgumentList $env:LOCAL_ARCHIVE,$destination; while (-not (Wait-Job -Job $job -Timeout 5)) { $elapsed=[int]((Get-Date)-$started).TotalSeconds; $items=@(Get-ChildItem -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue); $files=$items.Count; $mb=[math]::Round((($items | Measure-Object -Property Length -Sum).Sum)/1MB,1); $deltaFiles=$files-$lastFiles; $deltaMb=[math]::Round($mb-$lastMb,1); Write-Host ('[U-Claw] Extracting Windows app... {0}s elapsed, {1} files, {2} MB, +{3} files, +{4} MB.' -f $elapsed,$files,$mb,$deltaFiles,$deltaMb); $lastFiles=$files; $lastMb=$mb; if ($elapsed -ge $timeout) { Stop-Job -Job $job; Write-Error ('Extract timeout after {0}s. The USB drive, antivirus, or PowerShell Expand-Archive may be stuck.' -f $timeout); exit 1 } }; $state=$job.State; Receive-Job -Job $job; Remove-Job -Job $job; if ($state -ne 'Completed') { exit 1 }"
if errorlevel 1 goto fatal

:extract_complete
if not exist "%TMP_APP_DIR%\U-Claw.exe" (
  echo [U-Claw] Invalid archive: U-Claw.exe missing.
  goto fatal
)
if exist "%APP_CACHE_DIR%" rmdir /s /q "%APP_CACHE_DIR%"
move "%TMP_APP_DIR%" "%APP_CACHE_DIR%" >nul
>"%STAMP_FILE%" echo %CURRENT_STAMP%
if defined INSTALL_LOCK_HELD rmdir "%LOCK_DIR%" >nul 2>&1
set "INSTALL_LOCK_HELD="
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
if defined INSTALL_LOCK_HELD rmdir "%LOCK_DIR%" >nul 2>&1
echo [U-Claw] Portable startup failed.
pause
exit /b 1
