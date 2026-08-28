@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "HOST_LOCALAPPDATA=%LOCALAPPDATA%"
set "USB_DATA_DIR=%ROOT%\data"
set "USB_LOG_DIR=%USB_DATA_DIR%\logs"
set "LOCAL_LOG_DIR=%HOST_LOCALAPPDATA%\U-Claw\launcher-logs"
set "LOCAL_START_LOG=%UCLAW_WINDOWS_START_LOCAL_LOG%"
if "%LOCAL_START_LOG%"=="" set "LOCAL_START_LOG=%LOCAL_LOG_DIR%\Windows-Start-App.log"
set "USB_START_LOG=%UCLAW_USB_WINDOWS_START_LOG%"
if "%USB_START_LOG%"=="" set "USB_START_LOG=%USB_LOG_DIR%\Windows-Start-App.log"
set "ARCHIVE=%ROOT%\app\desktop-archive\u-claw-app-win-x64.zip"
set "ARCHIVE_SHA_FILE=%ARCHIVE%.sha256"
for /f %%H in ('powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$bytes=[Text.Encoding]::UTF8.GetBytes($env:ROOT.ToLowerInvariant()); $hash=[Security.Cryptography.SHA256]::Create().ComputeHash($bytes); ([BitConverter]::ToString($hash)).Replace('-','').Substring(0,16).ToLowerInvariant()"') do set "ROOT_ID=%%H"
if "%ROOT_ID%"=="" set "ROOT_ID=default"
set "CACHE_ROOT=%HOST_LOCALAPPDATA%\U-Claw\usb-portable"
set "APP_CACHE_DIR=%CACHE_ROOT%\app-win-x64"
set "RUN_DATA_DIR=%CACHE_ROOT%\data-%ROOT_ID%"
set "SYNC_STATE_DIR=%RUN_DATA_DIR%\.uclaw-sync"
set "DIRTY_FILE=%SYNC_STATE_DIR%\dirty.json"
set "USB_DIRTY_FILE=%USB_DATA_DIR%\.uclaw-sync\dirty.json"
set "LAST_SYNC_FILE=%SYNC_STATE_DIR%\last-sync.json"
set "USB_LAST_SYNC_FILE=%USB_DATA_DIR%\.uclaw-sync\last-sync.json"
set "APP_BIN=%APP_CACHE_DIR%\U-Claw.exe"
set "STAMP_FILE=%APP_CACHE_DIR%\.u-claw-archive.sha256"
set "LOCK_DIR=%CACHE_ROOT%\app-win-x64.lock"
set "LOCAL_ARCHIVE=%CACHE_ROOT%\u-claw-app-win-x64.zip"
set "LOCAL_ARCHIVE_TMP=%CACHE_ROOT%\u-claw-app-win-x64.zip.copying"
set "EXTRACT_TIMEOUT_SECONDS=1800"
set "DATA_SYNC_TIMEOUT_SECONDS=300"
set "STALE_LOCK_SECONDS=120"

if not exist "%ARCHIVE%" (
  echo [U-Claw] Missing Windows archive:
  echo %ARCHIVE%
  echo.
  call :pause_if_interactive
  exit /b 1
)

if not exist "%ARCHIVE_SHA_FILE%" (
  echo [U-Claw] Missing Windows archive manifest:
  echo %ARCHIVE_SHA_FILE%
  call :pause_if_interactive
  exit /b 1
)

if not exist "%USB_DATA_DIR%\.openclaw\openclaw.json" (
  echo [U-Claw] Missing config:
  echo %USB_DATA_DIR%\.openclaw\openclaw.json
  call :pause_if_interactive
  exit /b 1
)

if not exist "%CACHE_ROOT%" mkdir "%CACHE_ROOT%" >nul 2>&1
if not exist "%LOCAL_LOG_DIR%" mkdir "%LOCAL_LOG_DIR%" >nul 2>&1
if not "%UCLAW_LAUNCHER_GUI%"=="1" if not "%UCLAW_SCRIPT_LOG_ACTIVE%"=="1" (
  set "UCLAW_SCRIPT_LOG_ACTIVE=1"
  call "%~f0" %* > "%LOCAL_START_LOG%" 2>&1
  set "APP_EXIT=%ERRORLEVEL%"
  call :sync_launcher_logs
  exit /b %APP_EXIT%
)

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
call :cleanup_stale_install_lock
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
call :sleep_seconds 5
set /a LOCK_WAIT_SECONDS+=5
goto acquire_install_lock

:install_lock_acquired
set "INSTALL_LOCK_HELD=1"
>"%LOCK_DIR%\owner.txt" echo %DATE% %TIME%
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$owner=(Get-CimInstance Win32_Process -Filter \"ProcessId=$PID\").ParentProcessId; $owner | Set-Content -LiteralPath (Join-Path $env:LOCK_DIR 'owner.pid') -Encoding ASCII"
set "TMP_APP_DIR=%CACHE_ROOT%\app-win-x64.tmp-%RANDOM%-%RANDOM%"
echo [U-Claw] Installing updated app cache from archive...
echo [U-Claw] This runs once per package version; later starts reuse the computer cache.
echo [U-Claw] Copying Windows archive to computer cache...
if exist "%LOCAL_ARCHIVE_TMP%" del /q "%LOCAL_ARCHIVE_TMP%" >nul 2>&1
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$source=$env:ARCHIVE; $dest=$env:LOCAL_ARCHIVE_TMP; $total=(Get-Item -LiteralPath $source).Length; $inputStream=[System.IO.File]::OpenRead($source); $outputStream=[System.IO.File]::Create($dest); $copied=0L; $started=Get-Date; $last=Get-Date; try { $buffer=New-Object byte[] (4MB); while (($read=$inputStream.Read($buffer,0,$buffer.Length)) -gt 0) { $outputStream.Write($buffer,0,$read); $copied+=$read; $now=Get-Date; if (($now-$last).TotalSeconds -ge 5) { $pct=[math]::Round(($copied*100.0)/$total,1); $elapsed=[int](($now-$started).TotalSeconds); Write-Host ('[U-Claw] Copying Windows archive... {0:N0}/{1:N0} MB ({2}%%), {3}s elapsed.' -f ($copied/1MB),($total/1MB),$pct,$elapsed); $last=$now } } } finally { $outputStream.Close(); $inputStream.Close() }; $elapsed=[int]((Get-Date)-$started).TotalSeconds; Write-Host ('[U-Claw] Copying Windows archive... {0:N0}/{1:N0} MB (100%%), {2}s elapsed.' -f ($copied/1MB),($total/1MB),$elapsed)"
if errorlevel 1 goto fatal
move /y "%LOCAL_ARCHIVE_TMP%" "%LOCAL_ARCHIVE%" >nul
echo [U-Claw] Verifying cached Windows archive...
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$expected=(Get-Content -LiteralPath $env:ARCHIVE_SHA_FILE -TotalCount 1).Trim().ToLowerInvariant(); $actual=(Get-FileHash -LiteralPath $env:LOCAL_ARCHIVE -Algorithm SHA256).Hash.ToLowerInvariant(); if ($actual -ne $expected) { Write-Error ('Archive SHA-256 mismatch. expected={0} actual={1}' -f $expected,$actual); exit 1 }"
if errorlevel 1 goto fatal
for /d %%D in ("%CACHE_ROOT%\app-win-x64.tmp-*") do if exist "%%~fD" rmdir /s /q "%%~fD"
if exist "%TMP_APP_DIR%" rmdir /s /q "%TMP_APP_DIR%"
mkdir "%TMP_APP_DIR%" >nul 2>&1
where tar.exe >nul 2>&1
if errorlevel 1 goto extract_with_powershell
echo [U-Claw] Extracting with Windows tar...
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$started=Get-Date; $timeout=[int]$env:EXTRACT_TIMEOUT_SECONDS; $destination=$env:TMP_APP_DIR; $lastFiles=0; $lastMb=0; $job=Start-Job -ScriptBlock { param($archive,$destination) & tar.exe -xf $archive -C $destination; if ($LASTEXITCODE -ne 0) { throw ('tar.exe exited with status {0}' -f $LASTEXITCODE) } } -ArgumentList $env:LOCAL_ARCHIVE,$destination; while (-not (Wait-Job -Job $job -Timeout 5)) { $elapsed=[int]((Get-Date)-$started).TotalSeconds; $items=@(Get-ChildItem -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue); $files=$items.Count; $mb=[math]::Round((($items | Measure-Object -Property Length -Sum).Sum)/1MB,1); $deltaFiles=$files-$lastFiles; $deltaMb=[math]::Round($mb-$lastMb,1); Write-Host ('[U-Claw] Extracting Windows app... {0}s elapsed, {1} files, {2} MB, +{3} files, +{4} MB.' -f $elapsed,$files,$mb,$deltaFiles,$deltaMb); $lastFiles=$files; $lastMb=$mb; if ($elapsed -ge $timeout) { Stop-Job -Job $job; Write-Error ('Extract timeout after {0}s. The USB drive, antivirus, or Windows tar may be stuck.' -f $timeout); exit 1 } }; $state=$job.State; Receive-Job -Job $job; Remove-Job -Job $job; if ($state -ne 'Completed') { exit 1 }"
if errorlevel 1 goto fatal
goto extract_complete

:extract_with_powershell
echo [U-Claw] Windows tar unavailable; using PowerShell fallback...
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$started=Get-Date; $timeout=[int]$env:EXTRACT_TIMEOUT_SECONDS; $destination=$env:TMP_APP_DIR; $lastFiles=0; $lastMb=0; $job=Start-Job -ScriptBlock { param($archive,$destination) $ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force } -ArgumentList $env:LOCAL_ARCHIVE,$destination; while (-not (Wait-Job -Job $job -Timeout 5)) { $elapsed=[int]((Get-Date)-$started).TotalSeconds; $items=@(Get-ChildItem -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue); $files=$items.Count; $mb=[math]::Round((($items | Measure-Object -Property Length -Sum).Sum)/1MB,1); $deltaFiles=$files-$lastFiles; $deltaMb=[math]::Round($mb-$lastMb,1); Write-Host ('[U-Claw] Extracting Windows app... {0}s elapsed, {1} files, {2} MB, +{3} files, +{4} MB.' -f $elapsed,$files,$mb,$deltaFiles,$deltaMb); $lastFiles=$files; $lastMb=$mb; if ($elapsed -ge $timeout) { Stop-Job -Job $job; Write-Error ('Extract timeout after {0}s. The USB drive, antivirus, or PowerShell Expand-Archive may be stuck.' -f $timeout); exit 1 } }; $state=$job.State; Receive-Job -Job $job; Remove-Job -Job $job; if ($state -ne 'Completed') { exit 1 }"
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
echo [U-Claw] Preparing runtime data cache...
if not exist "%RUN_DATA_DIR%" mkdir "%RUN_DATA_DIR%" >nul 2>&1
if exist "%DIRTY_FILE%" (
  echo [U-Claw] Runtime data has unsynced changes; syncing runtime cache back to USB before startup...
  call :sync_e "Syncing runtime cache back to USB" "%RUN_DATA_DIR%" "%USB_DATA_DIR%"
)
call :runtime_cache_is_current
if not errorlevel 1 (
  echo [U-Claw] Runtime data cache is current; USB data sync skipped.
) else (
  echo [U-Claw] Syncing USB data to runtime cache...
  call :sync_mir "Syncing USB data to runtime cache" "%USB_DATA_DIR%" "%RUN_DATA_DIR%"
  if errorlevel 1 goto fatal
  call :mark_sync_current
)

set "UCLAW_PORTABLE_DATA_DIR=%USB_DATA_DIR%"
set "UCLAW_PORTABLE_WORK_DATA_DIR=%RUN_DATA_DIR%"
set "UCLAW_USB_DATA_DIR=%USB_DATA_DIR%"
set "OPENCLAW_HOME=%RUN_DATA_DIR%"
set "OPENCLAW_STATE_DIR=%RUN_DATA_DIR%\.openclaw"
set "OPENCLAW_CONFIG_PATH=%RUN_DATA_DIR%\.openclaw\openclaw.json"
set "OPENCLAW_DISABLE_BONJOUR=1"
set "UCLAW_MEDIA_PREVIEW_ROOTS=%RUN_DATA_DIR%\.openclaw\media"
if "%UCLAW_ACTIVATION_ENDPOINT%"=="" set "UCLAW_ACTIVATION_ENDPOINT=https://license.yiyong.me"
if "%UCLAW_ACTIVATION_REQUIRE_CLOUD%"=="" set "UCLAW_ACTIVATION_REQUIRE_CLOUD=1"
set "UCLAW_PORTABLE_HOME=%RUN_DATA_DIR%\.home"
set "HOME=%UCLAW_PORTABLE_HOME%"
set "USERPROFILE=%UCLAW_PORTABLE_HOME%"
set "APPDATA=%UCLAW_PORTABLE_HOME%\AppData\Roaming"
set "LOCALAPPDATA=%UCLAW_PORTABLE_HOME%\AppData\Local"
set "UCLAW_HOST_LOCALAPPDATA=%HOST_LOCALAPPDATA%"
set "CODEX_HOME=%RUN_DATA_DIR%\.codex"
if not exist "%HOME%" mkdir "%HOME%" >nul 2>&1
if not exist "%APPDATA%" mkdir "%APPDATA%" >nul 2>&1
if not exist "%LOCALAPPDATA%" mkdir "%LOCALAPPDATA%" >nul 2>&1
if not exist "%CODEX_HOME%" mkdir "%CODEX_HOME%" >nul 2>&1
if not exist "%SYNC_STATE_DIR%" mkdir "%SYNC_STATE_DIR%" >nul 2>&1
if not exist "%USB_DATA_DIR%\.uclaw-sync" mkdir "%USB_DATA_DIR%\.uclaw-sync" >nul 2>&1
>"%DIRTY_FILE%" echo {"dirty":true,"reason":"launcher-running"}
copy /y "%DIRTY_FILE%" "%USB_DATA_DIR%\.uclaw-sync\dirty.json" >nul 2>&1

echo [U-Claw] USB root: %ROOT%
echo [U-Claw] USB data dir: %USB_DATA_DIR%
echo [U-Claw] Runtime data dir: %RUN_DATA_DIR%
echo [U-Claw] App binary: %APP_BIN%
echo [U-Claw] Starting Windows desktop app...
echo.

"%APP_BIN%"
set "APP_EXIT=%ERRORLEVEL%"

echo [U-Claw] Syncing runtime data back to USB...
call :sync_e "Syncing runtime data back to USB" "%RUN_DATA_DIR%" "%USB_DATA_DIR%"
if errorlevel 1 set "APP_EXIT=1"
if exist "%DIRTY_FILE%" del /q "%DIRTY_FILE%" >nul 2>&1
if exist "%USB_DATA_DIR%\.uclaw-sync\dirty.json" del /q "%USB_DATA_DIR%\.uclaw-sync\dirty.json" >nul 2>&1
if not exist "%SYNC_STATE_DIR%" mkdir "%SYNC_STATE_DIR%" >nul 2>&1
if not exist "%USB_DATA_DIR%\.uclaw-sync" mkdir "%USB_DATA_DIR%\.uclaw-sync" >nul 2>&1
>"%LAST_SYNC_FILE%" echo {"success":true,"reason":"launcher-final-sync"}
copy /y "%LAST_SYNC_FILE%" "%USB_DATA_DIR%\.uclaw-sync\last-sync.json" >nul
call :sync_launcher_logs

if "%APP_EXIT%"=="20" (
  echo [U-Claw] Activation completed; restarting through normal startup gate...
  goto app_cache_ready
)
exit /b %APP_EXIT%

:fatal
if defined INSTALL_LOCK_HELD rmdir "%LOCK_DIR%" >nul 2>&1
echo [U-Claw] Portable startup failed.
call :pause_if_interactive
exit /b 1

:pause_if_interactive
if "%UCLAW_LAUNCHER_GUI%"=="1" exit /b 0
pause
exit /b 0

:sleep_seconds
set "UCLAW_SLEEP_SECONDS=%~1"
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds ([int]$env:UCLAW_SLEEP_SECONDS)"
exit /b 0

:cleanup_stale_install_lock
if not exist "%LOCK_DIR%" exit /b 0
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$lock=$env:LOCK_DIR; if (-not (Test-Path -LiteralPath $lock)) { exit 0 }; $now=Get-Date; $lockAge=(New-TimeSpan -Start (Get-Item -LiteralPath $lock).LastWriteTime -End $now).TotalSeconds; $pidFile=Join-Path $lock 'owner.pid'; $ownerAlive=$false; if (Test-Path -LiteralPath $pidFile) { $ownerText=(Get-Content -LiteralPath $pidFile -TotalCount 1 -ErrorAction SilentlyContinue); $ownerPid=0; if ([int]::TryParse($ownerText,[ref]$ownerPid) -and $ownerPid -gt 0) { $ownerAlive=[bool](Get-Process -Id $ownerPid -ErrorAction SilentlyContinue) } }; $active=$ownerAlive; $copy=$env:LOCAL_ARCHIVE_TMP; if ((-not $active) -and (Test-Path -LiteralPath $copy)) { $copyAge=(New-TimeSpan -Start (Get-Item -LiteralPath $copy).LastWriteTime -End $now).TotalSeconds; if ($copyAge -lt [int]$env:STALE_LOCK_SECONDS) { $active=$true } }; $cache=$env:CACHE_ROOT; if ((-not $active) -and (Test-Path -LiteralPath $cache)) { $tmpDirs=@(Get-ChildItem -LiteralPath $cache -Directory -Filter 'app-win-x64.tmp-*' -ErrorAction SilentlyContinue); foreach ($dir in $tmpDirs) { $dirAge=(New-TimeSpan -Start $dir.LastWriteTime -End $now).TotalSeconds; if ($dirAge -lt [int]$env:STALE_LOCK_SECONDS) { $active=$true } } }; if (($lockAge -ge [int]$env:STALE_LOCK_SECONDS) -or (-not $active)) { Remove-Item -LiteralPath $lock -Recurse -Force -ErrorAction SilentlyContinue; Write-Host ('[U-Claw] Removed stale app cache install lock after {0:N0}s.' -f $lockAge) }"
exit /b 0

:sync_launcher_logs
if not exist "%USB_LOG_DIR%" mkdir "%USB_LOG_DIR%" >nul 2>&1
if exist "%LOCAL_START_LOG%" copy /y "%LOCAL_START_LOG%" "%USB_START_LOG%" >nul 2>&1
if not "%UCLAW_LAUNCHER_LOCAL_LOG%"=="" if exist "%UCLAW_LAUNCHER_LOCAL_LOG%" copy /y "%UCLAW_LAUNCHER_LOCAL_LOG%" "%UCLAW_USB_LAUNCHER_LOG%" >nul 2>&1
exit /b 0

:sync_e
set "SYNC_LABEL=%~1"
set "SYNC_FROM=%~2"
set "SYNC_TO=%~3"
call :sync_impl E
exit /b %ERRORLEVEL%

:sync_mir
set "SYNC_LABEL=%~1"
set "SYNC_FROM=%~2"
set "SYNC_TO=%~3"
call :sync_impl MIR
exit /b %ERRORLEVEL%

:sync_impl
set "SYNC_MODE=%~1"
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ^
  "$label=$env:SYNC_LABEL; $from=$env:SYNC_FROM; $to=$env:SYNC_TO; $timeout=[int]$env:DATA_SYNC_TIMEOUT_SECONDS; $mode=$env:SYNC_MODE; New-Item -ItemType Directory -Force -Path $to | Out-Null; $started=Get-Date; $job=Start-Job -ScriptBlock { param($from,$to,$mode) $xd=@((Join-Path $from '.cache\v8-compile-cache'),(Join-Path $from '.home\AppData\Roaming\u-claw\Cache'),(Join-Path $from '.home\AppData\Roaming\u-claw\Code Cache'),(Join-Path $from '.home\AppData\Roaming\u-claw\GPUCache'),(Join-Path $from '.home\AppData\Roaming\u-claw\DawnCache'),(Join-Path $from '.home\AppData\Roaming\u-claw\Crashpad')); $xf=@('.DS_Store','._*','Cookies','Cookies-journal','LOCK','SingletonCookie','SingletonLock','SingletonSocket'); if ($mode -eq 'MIR') { & robocopy $from $to /MIR /XD $xd /XF $xf /R:2 /W:1 /XJ /NFL /NDL /NJH /NJS /NP | Out-Null } else { & robocopy $from $to /E /XD $xd /XF $xf /R:2 /W:1 /XJ /NFL /NDL /NJH /NJS /NP | Out-Null }; if ($LASTEXITCODE -ge 8) { exit $LASTEXITCODE } exit 0 } -ArgumentList $from,$to,$mode; while (-not (Wait-Job -Job $job -Timeout 5)) { $elapsed=[int]((Get-Date)-$started).TotalSeconds; $items=@(Get-ChildItem -LiteralPath $to -Recurse -Force -File -ErrorAction SilentlyContinue); $files=$items.Count; $mb=[math]::Round((($items | Measure-Object -Property Length -Sum).Sum)/1MB,1); Write-Host ('[U-Claw] {0}... {1}s elapsed, {2} files, {3} MB.' -f $label,$elapsed,$files,$mb); if ($elapsed -ge $timeout) { Stop-Job -Job $job; Remove-Job -Job $job -Force; Write-Error ('{0} timed out after {1}s.' -f $label,$timeout); exit 1 } }; Receive-Job -Job $job; $ok=$job.State -eq 'Completed'; Remove-Job -Job $job; if (-not $ok) { exit 1 }"
exit /b %ERRORLEVEL%

:runtime_cache_is_current
if not exist "%RUN_DATA_DIR%\.openclaw\openclaw.json" exit /b 1
if not exist "%LAST_SYNC_FILE%" exit /b 1
if not exist "%USB_LAST_SYNC_FILE%" exit /b 1
fc /b "%LAST_SYNC_FILE%" "%USB_LAST_SYNC_FILE%" >nul 2>&1
exit /b %ERRORLEVEL%

:mark_sync_current
if not exist "%SYNC_STATE_DIR%" mkdir "%SYNC_STATE_DIR%" >nul 2>&1
if not exist "%USB_DATA_DIR%\.uclaw-sync" mkdir "%USB_DATA_DIR%\.uclaw-sync" >nul 2>&1
>"%LAST_SYNC_FILE%" echo {"success":true,"reason":"launcher-startup-sync"}
copy /y "%LAST_SYNC_FILE%" "%USB_DATA_DIR%\.uclaw-sync\last-sync.json" >nul
exit /b 0
