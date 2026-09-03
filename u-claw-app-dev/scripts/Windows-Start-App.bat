@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions EnableDelayedExpansion
echo [Bavi-box] Launcher started; checking portable package...

set "ROOT=%UCLAW_PORTABLE_ROOT%"
if "%ROOT%"=="" set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
if not exist "%ROOT%\app\desktop-archive" if exist "%ROOT%\..\desktop-archive" for %%R in ("%ROOT%\..\..") do set "ROOT=%%~fR"

set "HOST_LOCALAPPDATA=%LOCALAPPDATA%"
set "HOST_USERPROFILE=%USERPROFILE%"
set "USB_DATA_DIR=%ROOT%\data"
set "USB_LOG_DIR=%USB_DATA_DIR%\logs"
set "LOCAL_LOG_DIR=%HOST_LOCALAPPDATA%\Bavi-box\launcher-logs"
set "LOCAL_START_LOG=%UCLAW_WINDOWS_START_LOCAL_LOG%"
if "%LOCAL_START_LOG%"=="" set "LOCAL_START_LOG=%LOCAL_LOG_DIR%\Windows-Start-App.log"
set "USB_START_LOG=%UCLAW_USB_WINDOWS_START_LOG%"
if "%USB_START_LOG%"=="" set "USB_START_LOG=%USB_LOG_DIR%\Windows-Start-App.log"
set "ARCHIVE=%ROOT%\app\desktop-archive\u-claw-app-win-x64.zip"
set "ARCHIVE_SHA_FILE=%ARCHIVE%.sha256"
set "SYNC_SCRIPT=%ROOT%\app\scripts\Windows-Sync-Data.ps1"
for /f %%H in ('powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$bytes=[Text.Encoding]::UTF8.GetBytes($env:ROOT.ToLowerInvariant()); $hash=[Security.Cryptography.SHA256]::Create().ComputeHash($bytes); ([BitConverter]::ToString($hash)).Replace('-','').Substring(0,16).ToLowerInvariant()"') do set "ROOT_ID=%%H"
if "%ROOT_ID%"=="" set "ROOT_ID=default"
set "CACHE_ROOT=%HOST_LOCALAPPDATA%\Bavi-box\usb-portable"
set "APP_CACHE_DIR=%CACHE_ROOT%\app-win-x64"
set "RUN_DATA_DIR=%CACHE_ROOT%\data-%ROOT_ID%"
set "ELECTRON_PROFILE_DIR=%CACHE_ROOT%\electron-profile-win32-%ROOT_ID%"
set "SYNC_STATE_DIR=%RUN_DATA_DIR%\.uclaw-sync"
set "DIRTY_FILE=%SYNC_STATE_DIR%\dirty.json"
set "USB_DIRTY_FILE=%USB_DATA_DIR%\.uclaw-sync\dirty.json"
set "LAST_SYNC_FILE=%SYNC_STATE_DIR%\last-sync.json"
set "USB_LAST_SYNC_FILE=%USB_DATA_DIR%\.uclaw-sync\last-sync.json"
set "APP_BIN=%APP_CACHE_DIR%\Bavi-box.exe"
set "STAMP_FILE=%APP_CACHE_DIR%\.u-claw-archive.sha256"
set "LOCK_DIR=%CACHE_ROOT%\app-win-x64.lock"
set "LOCAL_ARCHIVE=%CACHE_ROOT%\u-claw-app-win-x64.zip"
set "LOCAL_ARCHIVE_TMP=%CACHE_ROOT%\u-claw-app-win-x64.zip.copying"
set "RUNTIME_PROTOCOL_DIR=%ROOT%\app\.runtime"
set "HANDOFF_FILE=%RUNTIME_PROTOCOL_DIR%\launcher-handoff.json"
set "RUN_STATE_FILE=%RUNTIME_PROTOCOL_DIR%\run-state.json"
set "APP_LAUNCH_ENV_FILE=%RUNTIME_PROTOCOL_DIR%\windows-app-launch.env"
set "EXTRACT_TIMEOUT_SECONDS=1800"
set "DATA_SYNC_TIMEOUT_SECONDS=300"
set "STALE_LOCK_SECONDS=120"

echo [Bavi-box] Checking Windows app package...
if not exist "%ARCHIVE%" (
  echo [Bavi-box] Missing Windows archive:
  echo %ARCHIVE%
  echo.
  call :pause_if_interactive
  exit /b 1
)

if not exist "%ARCHIVE_SHA_FILE%" (
  echo [Bavi-box] Missing Windows archive manifest:
  echo %ARCHIVE_SHA_FILE%
  call :pause_if_interactive
  exit /b 1
)

if not exist "%USB_DATA_DIR%\.openclaw\openclaw.json" (
  echo [Bavi-box] Missing config:
  echo %USB_DATA_DIR%\.openclaw\openclaw.json
  call :pause_if_interactive
  exit /b 1
)

if not exist "%SYNC_SCRIPT%" (
  echo [Bavi-box] Missing Windows sync helper:
  echo %SYNC_SCRIPT%
  call :pause_if_interactive
  exit /b 1
)

powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$dir=$env:USB_DATA_DIR; if (-not (Test-Path -LiteralPath $dir -PathType Container)) { Write-Error ('USB data dir unavailable: {0}' -f $dir); exit 1 }; $probe=Join-Path $dir '.uclaw-write-test'; try { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $probe) | Out-Null; Set-Content -LiteralPath $probe -Value 'ok' -Encoding ASCII; Remove-Item -LiteralPath $probe -Force; exit 0 } catch { Write-Error ('USB data dir is not writable: {0}: {1}' -f $dir,$_.Exception.Message); exit 1 }"
if errorlevel 1 (
  echo [Bavi-box] USB data dir is unavailable or not writable:
  echo %USB_DATA_DIR%
  call :pause_if_interactive
  exit /b 1
)

echo [Bavi-box] Checking local runtime cache...
if not exist "%CACHE_ROOT%" mkdir "%CACHE_ROOT%" >nul 2>&1
if not exist "%CACHE_ROOT%" (
  echo [Bavi-box] Cannot create local runtime cache:
  echo %CACHE_ROOT%
  call :pause_if_interactive
  exit /b 1
)
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
  echo [Bavi-box] Timed out waiting for another startup to install the app cache.
  echo [Bavi-box] Close other Bavi-box startup windows and retry.
  goto fatal
)
echo [Bavi-box] Another Bavi-box startup is installing the app cache; waiting... %LOCK_WAIT_SECONDS%s elapsed.
call :sleep_seconds 5
set /a LOCK_WAIT_SECONDS+=5
goto acquire_install_lock

:install_lock_acquired
set "INSTALL_LOCK_HELD=1"
>"%LOCK_DIR%\owner.txt" echo %DATE% %TIME%
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$owner=(Get-CimInstance Win32_Process -Filter \"ProcessId=$PID\").ParentProcessId; $owner | Set-Content -LiteralPath (Join-Path $env:LOCK_DIR 'owner.pid') -Encoding ASCII"
set "TMP_APP_DIR=%CACHE_ROOT%\app-win-x64.tmp-%RANDOM%-%RANDOM%"
echo [Bavi-box] Installing updated app cache from archive...
echo [Bavi-box] This runs once per package version; later starts reuse the computer cache.
echo [Bavi-box] Copying Windows archive to computer cache...
if exist "%LOCAL_ARCHIVE_TMP%" del /q "%LOCAL_ARCHIVE_TMP%" >nul 2>&1
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$source=$env:ARCHIVE; $dest=$env:LOCAL_ARCHIVE_TMP; $total=(Get-Item -LiteralPath $source).Length; $inputStream=[System.IO.File]::OpenRead($source); $outputStream=[System.IO.File]::Create($dest); $copied=0L; $started=Get-Date; $last=Get-Date; try { $buffer=New-Object byte[] (4MB); while (($read=$inputStream.Read($buffer,0,$buffer.Length)) -gt 0) { $outputStream.Write($buffer,0,$read); $copied+=$read; $now=Get-Date; if (($now-$last).TotalSeconds -ge 5) { $pct=[math]::Round(($copied*100.0)/$total,1); $elapsed=[int](($now-$started).TotalSeconds); Write-Host ('[Bavi-box] Copying Windows archive... {0:N0}/{1:N0} MB ({2}%%), {3}s elapsed.' -f ($copied/1MB),($total/1MB),$pct,$elapsed); $last=$now } } } finally { $outputStream.Close(); $inputStream.Close() }; $elapsed=[int]((Get-Date)-$started).TotalSeconds; Write-Host ('[Bavi-box] Copying Windows archive... {0:N0}/{1:N0} MB (100%%), {2}s elapsed.' -f ($copied/1MB),($total/1MB),$elapsed)"
if errorlevel 1 goto fatal
move /y "%LOCAL_ARCHIVE_TMP%" "%LOCAL_ARCHIVE%" >nul
echo [Bavi-box] Verifying cached Windows archive...
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$expected=(Get-Content -LiteralPath $env:ARCHIVE_SHA_FILE -TotalCount 1).Trim().ToLowerInvariant(); $actual=(Get-FileHash -LiteralPath $env:LOCAL_ARCHIVE -Algorithm SHA256).Hash.ToLowerInvariant(); if ($actual -ne $expected) { Write-Error ('Archive SHA-256 mismatch. expected={0} actual={1}' -f $expected,$actual); exit 1 }"
if errorlevel 1 goto fatal
for /d %%D in ("%CACHE_ROOT%\app-win-x64.tmp-*") do if exist "%%~fD" rmdir /s /q "%%~fD"
if exist "%TMP_APP_DIR%" rmdir /s /q "%TMP_APP_DIR%"
mkdir "%TMP_APP_DIR%" >nul 2>&1
where tar.exe >nul 2>&1
if errorlevel 1 goto extract_with_powershell
echo [Bavi-box] Extracting with Windows tar...
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$started=Get-Date; $timeout=[int]$env:EXTRACT_TIMEOUT_SECONDS; $destination=$env:TMP_APP_DIR; $lastFiles=0; $lastMb=0; $job=Start-Job -ScriptBlock { param($archive,$destination) & tar.exe -xf $archive -C $destination; if ($LASTEXITCODE -ne 0) { throw ('tar.exe exited with status {0}' -f $LASTEXITCODE) } } -ArgumentList $env:LOCAL_ARCHIVE,$destination; while (-not (Wait-Job -Job $job -Timeout 5)) { $elapsed=[int]((Get-Date)-$started).TotalSeconds; $items=@(Get-ChildItem -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue); $files=$items.Count; $mb=[math]::Round((($items | Measure-Object -Property Length -Sum).Sum)/1MB,1); $deltaFiles=$files-$lastFiles; $deltaMb=[math]::Round($mb-$lastMb,1); Write-Host ('[Bavi-box] Extracting Windows app... {0}s elapsed, {1} files, {2} MB, +{3} files, +{4} MB.' -f $elapsed,$files,$mb,$deltaFiles,$deltaMb); $lastFiles=$files; $lastMb=$mb; if ($elapsed -ge $timeout) { Stop-Job -Job $job; Write-Error ('Extract timeout after {0}s. The USB drive, antivirus, or Windows tar may be stuck.' -f $timeout); exit 1 } }; $state=$job.State; Receive-Job -Job $job; Remove-Job -Job $job; if ($state -ne 'Completed') { exit 1 }"
if errorlevel 1 goto fatal
goto extract_complete

:extract_with_powershell
echo [Bavi-box] Windows tar unavailable; using PowerShell fallback...
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$started=Get-Date; $timeout=[int]$env:EXTRACT_TIMEOUT_SECONDS; $destination=$env:TMP_APP_DIR; $lastFiles=0; $lastMb=0; $job=Start-Job -ScriptBlock { param($archive,$destination) $ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force } -ArgumentList $env:LOCAL_ARCHIVE,$destination; while (-not (Wait-Job -Job $job -Timeout 5)) { $elapsed=[int]((Get-Date)-$started).TotalSeconds; $items=@(Get-ChildItem -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue); $files=$items.Count; $mb=[math]::Round((($items | Measure-Object -Property Length -Sum).Sum)/1MB,1); $deltaFiles=$files-$lastFiles; $deltaMb=[math]::Round($mb-$lastMb,1); Write-Host ('[Bavi-box] Extracting Windows app... {0}s elapsed, {1} files, {2} MB, +{3} files, +{4} MB.' -f $elapsed,$files,$mb,$deltaFiles,$deltaMb); $lastFiles=$files; $lastMb=$mb; if ($elapsed -ge $timeout) { Stop-Job -Job $job; Write-Error ('Extract timeout after {0}s. The USB drive, antivirus, or PowerShell Expand-Archive may be stuck.' -f $timeout); exit 1 } }; $state=$job.State; Receive-Job -Job $job; Remove-Job -Job $job; if ($state -ne 'Completed') { exit 1 }"
if errorlevel 1 goto fatal

:extract_complete
if not exist "%TMP_APP_DIR%\Bavi-box.exe" (
  echo [Bavi-box] Invalid archive: Bavi-box.exe missing.
  goto fatal
)
if not exist "%TMP_APP_DIR%\resources\resources\runtime\node-win32-x64\node.exe" (
  echo [Bavi-box] Invalid archive: bundled node.exe missing.
  goto fatal
)
if not exist "%TMP_APP_DIR%\resources\app\node_modules\openclaw\dist\entry.mjs" if not exist "%TMP_APP_DIR%\resources\app\node_modules\openclaw\dist\entry.js" (
  echo [Bavi-box] Invalid archive: openclaw dist entry missing.
  goto fatal
)
if not exist "%TMP_APP_DIR%\resources\app\node_modules\chokidar" (
  echo [Bavi-box] Invalid archive: chokidar package missing.
  goto fatal
)
call :stop_existing_app_cache_processes
if exist "%APP_CACHE_DIR%" rmdir /s /q "%APP_CACHE_DIR%"
if exist "%APP_CACHE_DIR%" (
  echo [Bavi-box] Existing app cache is still locked by another Bavi-box process.
  echo [Bavi-box] Please close Bavi-box from Task Manager, then start again.
  goto fatal
)
move "%TMP_APP_DIR%" "%APP_CACHE_DIR%" >nul
>"%STAMP_FILE%" echo %CURRENT_STAMP%
if defined INSTALL_LOCK_HELD rmdir "%LOCK_DIR%" >nul 2>&1
set "INSTALL_LOCK_HELD="
goto app_cache_ready

:app_cache_ready
echo [Bavi-box] Reusing app cache: %APP_CACHE_DIR%
call :run_startup_hard_update
set "HARD_UPDATE_STATUS=%ERRORLEVEL%"
if "%HARD_UPDATE_STATUS%"=="20" exit /b 0
if "%HARD_UPDATE_STATUS%"=="2" goto install_app_cache
if not "%HARD_UPDATE_STATUS%"=="0" goto fatal
echo [Bavi-box] Preparing runtime data cache...
if not exist "%RUN_DATA_DIR%" (
  echo [Bavi-box] Creating runtime data cache...
  set "RUNTIME_DATA_CREATE_ATTEMPTS=0"
:create_runtime_data_cache
  if exist "%RUN_DATA_DIR%" goto runtime_data_cache_ready
  mkdir "%RUN_DATA_DIR%" >nul 2>&1
  if exist "%RUN_DATA_DIR%" goto runtime_data_cache_ready
  set /a RUNTIME_DATA_CREATE_ATTEMPTS+=1
  if !RUNTIME_DATA_CREATE_ATTEMPTS! GEQ 5 (
    echo [Bavi-box] Cannot create runtime data cache after 5 attempts:
    echo %RUN_DATA_DIR%
    echo [Bavi-box] Check LOCALAPPDATA permissions and available disk space.
    goto fatal
  )
  echo [Bavi-box] Runtime cache is temporarily unavailable; retrying... !RUNTIME_DATA_CREATE_ATTEMPTS!/5
  call :sleep_seconds 2
  goto create_runtime_data_cache
)
:runtime_data_cache_ready
if exist "%DIRTY_FILE%" (
  echo [Bavi-box] Runtime data has unsynced changes; syncing runtime cache back to USB before startup...
  call :sync_e "Syncing runtime cache back to USB" "%RUN_DATA_DIR%" "%USB_DATA_DIR%"
)
call :runtime_cache_is_current
if not errorlevel 1 (
  echo [Bavi-box] Runtime data cache is current; USB data sync skipped.
) else (
  echo [Bavi-box] Syncing USB data to runtime cache...
  call :sync_mir "Syncing USB data to runtime cache" "%USB_DATA_DIR%" "%RUN_DATA_DIR%"
  if errorlevel 1 goto fatal
  call :mark_sync_current
)

set "UCLAW_PORTABLE_DATA_DIR=%USB_DATA_DIR%"
set "UCLAW_PORTABLE_WORK_DATA_DIR=%RUN_DATA_DIR%"
set "UCLAW_USB_DATA_DIR=%USB_DATA_DIR%"
set "UCLAW_PORTABLE_ROOT=%ROOT%"
set "UCLAW_CACHE_ROOT=%CACHE_ROOT%"
set "UCLAW_APP_CACHE_DIR=%APP_CACHE_DIR%"
set "UCLAW_ARCHIVE_CACHE=%LOCAL_ARCHIVE%"
set "UCLAW_APP_CACHE_STAMP=%STAMP_FILE%"
set "UCLAW_ELECTRON_PROFILE_DIR=%ELECTRON_PROFILE_DIR%"
set "OPENCLAW_HOME=%RUN_DATA_DIR%"
set "OPENCLAW_STATE_DIR=%RUN_DATA_DIR%\.openclaw"
set "OPENCLAW_CONFIG_PATH=%RUN_DATA_DIR%\.openclaw\openclaw.json"
set "OPENCLAW_DISABLE_BONJOUR=1"
set "UCLAW_ACTIVATION_ENDPOINT=https://license.yiyong.me"
set "UCLAW_ACTIVATION_REQUIRE_CLOUD=1"
set "UCLAW_MEDIA_PREVIEW_ROOTS=%RUN_DATA_DIR%\.openclaw\media;%USB_DATA_DIR%\.openclaw\media"
set "UCLAW_PORTABLE_HOME=%RUN_DATA_DIR%\.home"
set "HOME=%UCLAW_PORTABLE_HOME%"
set "USERPROFILE=%UCLAW_PORTABLE_HOME%"
set "APPDATA=%UCLAW_PORTABLE_HOME%\AppData\Roaming"
set "LOCALAPPDATA=%UCLAW_PORTABLE_HOME%\AppData\Local"
set "UCLAW_HOST_LOCALAPPDATA=%HOST_LOCALAPPDATA%"
set "UCLAW_HOST_USERPROFILE=%HOST_USERPROFILE%"
set "CODEX_HOME=%RUN_DATA_DIR%\.codex"
if not exist "%HOME%" mkdir "%HOME%" >nul 2>&1
if not exist "%HOME%\Desktop" mkdir "%HOME%\Desktop" >nul 2>&1
if not exist "%HOME%\Downloads" mkdir "%HOME%\Downloads" >nul 2>&1
if not exist "%HOME%\Documents" mkdir "%HOME%\Documents" >nul 2>&1
if not exist "%HOME%\Pictures" mkdir "%HOME%\Pictures" >nul 2>&1
if not exist "%APPDATA%" mkdir "%APPDATA%" >nul 2>&1
if not exist "%LOCALAPPDATA%" mkdir "%LOCALAPPDATA%" >nul 2>&1
if not exist "%CODEX_HOME%" mkdir "%CODEX_HOME%" >nul 2>&1
if not exist "%SYNC_STATE_DIR%" mkdir "%SYNC_STATE_DIR%" >nul 2>&1
if not exist "%USB_DATA_DIR%\.uclaw-sync" mkdir "%USB_DATA_DIR%\.uclaw-sync" >nul 2>&1
>"%DIRTY_FILE%" echo {"dirty":true,"reason":"launcher-running"}
copy /y "%DIRTY_FILE%" "%USB_DATA_DIR%\.uclaw-sync\dirty.json" >nul 2>&1

echo [Bavi-box] USB root: %ROOT%
echo [Bavi-box] USB data dir: %USB_DATA_DIR%
echo [Bavi-box] Runtime data dir: %RUN_DATA_DIR%
echo [Bavi-box] App binary: %APP_BIN%
call :stop_existing_app_cache_processes
echo [Bavi-box] Starting Windows desktop app...
echo.
if not exist "%RUNTIME_PROTOCOL_DIR%" mkdir "%RUNTIME_PROTOCOL_DIR%" >nul 2>&1
if exist "%HANDOFF_FILE%" del /q "%HANDOFF_FILE%" >nul 2>&1
if exist "%RUN_STATE_FILE%" del /q "%RUN_STATE_FILE%" >nul 2>&1
call :write_app_launch_env
if "%UCLAW_PREPARE_ONLY%"=="1" (
  echo [Bavi-box] Startup preparation complete; desktop app will be launched by Bavi-box.exe.
  exit /b 0
)
call :start_detached_app
if errorlevel 1 goto fatal
call :wait_for_launcher_handoff
set "APP_EXIT=%ERRORLEVEL%"
call :sync_launcher_logs
if "%APP_EXIT%"=="20" (
  echo [Bavi-box] Activation completed; restarting through normal startup gate...
  goto app_cache_ready
)
exit /b %APP_EXIT%

:fatal
if defined INSTALL_LOCK_HELD rmdir "%LOCK_DIR%" >nul 2>&1
echo [Bavi-box] Portable startup failed.
call :pause_if_interactive
exit /b 1

:pause_if_interactive
echo [Bavi-box] Startup failed. This window will stay open so the error can be read.
pause
exit /b 0

:sleep_seconds
set "UCLAW_SLEEP_SECONDS=%~1"
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds ([int]$env:UCLAW_SLEEP_SECONDS)"
exit /b 0

:cleanup_stale_install_lock
if not exist "%LOCK_DIR%" exit /b 0
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$lock=$env:LOCK_DIR; if (-not (Test-Path -LiteralPath $lock)) { exit 0 }; $now=Get-Date; $lockAge=(New-TimeSpan -Start (Get-Item -LiteralPath $lock).LastWriteTime -End $now).TotalSeconds; $pidFile=Join-Path $lock 'owner.pid'; $ownerAlive=$false; if (Test-Path -LiteralPath $pidFile) { $ownerText=(Get-Content -LiteralPath $pidFile -TotalCount 1 -ErrorAction SilentlyContinue); $ownerPid=0; if ([int]::TryParse($ownerText,[ref]$ownerPid) -and $ownerPid -gt 0) { $ownerAlive=[bool](Get-Process -Id $ownerPid -ErrorAction SilentlyContinue) } }; $active=$ownerAlive; $copy=$env:LOCAL_ARCHIVE_TMP; if ((-not $active) -and (Test-Path -LiteralPath $copy)) { $copyAge=(New-TimeSpan -Start (Get-Item -LiteralPath $copy).LastWriteTime -End $now).TotalSeconds; if ($copyAge -lt [int]$env:STALE_LOCK_SECONDS) { $active=$true } }; $cache=$env:CACHE_ROOT; if ((-not $active) -and (Test-Path -LiteralPath $cache)) { $tmpDirs=@(Get-ChildItem -LiteralPath $cache -Directory -Filter 'app-win-x64.tmp-*' -ErrorAction SilentlyContinue); foreach ($dir in $tmpDirs) { $dirAge=(New-TimeSpan -Start $dir.LastWriteTime -End $now).TotalSeconds; if ($dirAge -lt [int]$env:STALE_LOCK_SECONDS) { $active=$true } } }; if (($lockAge -ge [int]$env:STALE_LOCK_SECONDS) -or (-not $active)) { Remove-Item -LiteralPath $lock -Recurse -Force -ErrorAction SilentlyContinue; Write-Host ('[Bavi-box] Removed stale app cache install lock after {0:N0}s.' -f $lockAge) }"
exit /b 0

:run_startup_hard_update
if not "%UCLAW_ENABLE_STARTUP_HARD_UPDATE%"=="1" (
  echo [Bavi-box] Startup hard update disabled by environment.
  exit /b 0
)
set "HARD_UPDATE_NODE=%APP_CACHE_DIR%\resources\resources\runtime\node-win32-x64\node.exe"
set "HARD_UPDATE_CLIENT=%APP_CACHE_DIR%\resources\app\scripts\hard-update-client.js"
if not exist "%HARD_UPDATE_NODE%" (
  echo [Bavi-box] Missing bundled Node runtime for startup hard update:
  echo %HARD_UPDATE_NODE%
  exit /b 1
)
if not exist "%HARD_UPDATE_CLIENT%" (
  echo [Bavi-box] Missing startup hard update client:
  echo %HARD_UPDATE_CLIENT%
  exit /b 1
)
echo [Bavi-box] Checking mandatory hard update...
"%HARD_UPDATE_NODE%" "%HARD_UPDATE_CLIENT%" startup-update --usb "%ROOT%" --platform win32-x64
set "HARD_UPDATE_EXIT=%ERRORLEVEL%"
if "%HARD_UPDATE_EXIT%"=="20" (
  echo [Bavi-box] Hard update staged; applying update and relaunching.
  set "HARD_UPDATE_APPLY_LOG=%LOCAL_LOG_DIR%\Windows-Hard-Update-Apply.log"
  set "HARD_UPDATE_APPLY_CMD=%LOCAL_LOG_DIR%\Windows-Hard-Update-Apply.cmd"
  >"%HARD_UPDATE_APPLY_CMD%" echo @echo off
  >>"%HARD_UPDATE_APPLY_CMD%" echo chcp 65001 ^>nul 2^>^&1
  >>"%HARD_UPDATE_APPLY_CMD%" echo "%HARD_UPDATE_NODE%" "%HARD_UPDATE_CLIENT%" apply-startup-update --usb "%ROOT%" --transaction "%ROOT%\app\update-transaction.json" --wait-pid "%UCLAW_LAUNCHER_PID%" --launch-after "%ROOT%\Bavi-box.exe" --stamp-file "%STAMP_FILE%" ^>^> "%HARD_UPDATE_APPLY_LOG%" 2^>^&1
  start "" /min "%HARD_UPDATE_APPLY_CMD%"
  exit /b 20
)
if not "%HARD_UPDATE_EXIT%"=="0" exit /b 1
set "POST_UPDATE_STAMP="
if exist "%ARCHIVE_SHA_FILE%" set /p "POST_UPDATE_STAMP="<"%ARCHIVE_SHA_FILE%"
if not "%POST_UPDATE_STAMP%"=="" if not "%POST_UPDATE_STAMP%"=="%CURRENT_STAMP%" (
  echo [Bavi-box] Hard update changed the Windows archive; reinstalling app cache before launch.
  set "CURRENT_STAMP=%POST_UPDATE_STAMP%"
  set "CACHED_STAMP="
  exit /b 2
)
exit /b 0

:stop_existing_app_cache_processes
if not exist "%APP_CACHE_DIR%" exit /b 0
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$cache=[IO.Path]::GetFullPath($env:APP_CACHE_DIR).TrimEnd('\')+'\'; $current=$PID; $matches=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $current -and (($_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($cache,[StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($cache,[StringComparison]::OrdinalIgnoreCase) -ge 0)) }); if ($matches.Count -eq 0) { exit 0 }; Write-Host ('[Bavi-box] Stopping {0} old Bavi-box cache process(es) before app cache update...' -f $matches.Count); foreach ($p in $matches) { Stop-Process -Id $p.ProcessId -ErrorAction SilentlyContinue }; $deadline=(Get-Date).AddSeconds(8); do { Start-Sleep -Milliseconds 250; $alive=@($matches | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }) } while ($alive.Count -gt 0 -and (Get-Date) -lt $deadline); foreach ($p in $alive) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 500"
exit /b 0

:write_app_launch_env
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$keys=@('APP_BIN','UCLAW_PORTABLE_DATA_DIR','UCLAW_PORTABLE_WORK_DATA_DIR','UCLAW_USB_DATA_DIR','UCLAW_PORTABLE_ROOT','UCLAW_CACHE_ROOT','UCLAW_APP_CACHE_DIR','UCLAW_ARCHIVE_CACHE','UCLAW_APP_CACHE_STAMP','UCLAW_ELECTRON_PROFILE_DIR','OPENCLAW_HOME','OPENCLAW_STATE_DIR','OPENCLAW_CONFIG_PATH','OPENCLAW_DISABLE_BONJOUR','UCLAW_ACTIVATION_ENDPOINT','UCLAW_ACTIVATION_REQUIRE_CLOUD','UCLAW_MEDIA_PREVIEW_ROOTS','UCLAW_PORTABLE_HOME','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','UCLAW_HOST_LOCALAPPDATA','UCLAW_HOST_USERPROFILE','CODEX_HOME','UCLAW_LAUNCHER_PID'); $lines=foreach($key in $keys){ $key + '=' + [Environment]::GetEnvironmentVariable($key,'Process') }; [IO.File]::WriteAllText($env:APP_LAUNCH_ENV_FILE,($lines -join [Environment]::NewLine)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))"
echo [Bavi-box] Launch env written: %APP_LAUNCH_ENV_FILE%
exit /b 0

:start_detached_app
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$envFile=$env:APP_LAUNCH_ENV_FILE; if (-not (Test-Path -LiteralPath $envFile)) { Write-Error ('Missing launch env file: {0}' -f $envFile); exit 1 }; foreach ($line in [IO.File]::ReadAllLines($envFile,[Text.UTF8Encoding]::new($false))) { if (-not $line -or $line.StartsWith('#')) { continue }; $idx=$line.IndexOf('='); if ($idx -lt 1) { continue }; [Environment]::SetEnvironmentVariable($line.Substring(0,$idx), $line.Substring($idx+1), 'Process') }; Write-Host ('[Bavi-box] Launch env loaded. work data: {0}' -f $env:UCLAW_PORTABLE_WORK_DATA_DIR); $p=Start-Process -FilePath $env:APP_BIN -WorkingDirectory (Split-Path -Parent $env:APP_BIN) -WindowStyle Normal -PassThru; Write-Host ('[Bavi-box] Windows desktop app process started: {0}' -f $p.Id)"
exit /b %ERRORLEVEL%

:sync_launcher_logs
if not exist "%USB_LOG_DIR%" mkdir "%USB_LOG_DIR%" >nul 2>&1
if exist "%LOCAL_START_LOG%" copy /y "%LOCAL_START_LOG%" "%USB_START_LOG%" >nul 2>&1
if not "%UCLAW_LAUNCHER_LOCAL_LOG%"=="" if exist "%UCLAW_LAUNCHER_LOCAL_LOG%" copy /y "%UCLAW_LAUNCHER_LOCAL_LOG%" "%UCLAW_USB_LAUNCHER_LOG%" >nul 2>&1
exit /b 0

:sync_e
set "SYNC_LABEL=%~1"
set "SYNC_FROM=%~2"
set "SYNC_TO=%~3"
set "SYNC_PRESERVE_CONFIG=1"
call :sync_impl E
exit /b %ERRORLEVEL%

:sync_mir
set "SYNC_LABEL=%~1"
set "SYNC_FROM=%~2"
set "SYNC_TO=%~3"
set "SYNC_PRESERVE_CONFIG=0"
call :sync_impl MIR
exit /b %ERRORLEVEL%

:sync_impl
set "SYNC_MODE=%~1"
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%SYNC_SCRIPT%"
exit /b %ERRORLEVEL%

:runtime_cache_is_current
if not exist "%RUN_DATA_DIR%\.openclaw\openclaw.json" exit /b 1
if not exist "%LAST_SYNC_FILE%" exit /b 1
if not exist "%USB_LAST_SYNC_FILE%" exit /b 1
fc /b "%LAST_SYNC_FILE%" "%USB_LAST_SYNC_FILE%" >nul 2>&1
exit /b %ERRORLEVEL%

:wait_for_launcher_handoff
set "HANDOFF_WAIT_SECONDS=0"
:wait_for_launcher_handoff_loop
set /a HANDOFF_WAIT_REMAINDER=HANDOFF_WAIT_SECONDS %% 5
if %HANDOFF_WAIT_SECONDS% GTR 0 if %HANDOFF_WAIT_REMAINDER% EQU 0 echo [Bavi-box] Starting desktop app... %HANDOFF_WAIT_SECONDS%s elapsed.
if exist "%HANDOFF_FILE%" (
  powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$file=$env:HANDOFF_FILE; $launcherPid=$env:UCLAW_LAUNCHER_PID; try { $payload=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json; if ($payload.schemaVersion -eq 1 -and [string]$payload.state -eq 'gateway-ready' -and [string]$payload.launcherPid -eq [string]$launcherPid) { exit 0 } } catch {}; exit 1"
  if not errorlevel 1 (
    echo [Bavi-box] Windows desktop app is ready; startup terminal will close.
    exit /b 0
  )
)
if exist "%RUN_STATE_FILE%" (
  powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$file=$env:RUN_STATE_FILE; $launcherPid=$env:UCLAW_LAUNCHER_PID; try { $payload=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json; if ($payload.schemaVersion -eq 1 -and [string]$payload.state -eq 'gateway-ready' -and [string]$payload.launcherPid -eq [string]$launcherPid) { exit 0 } } catch {}; exit 1"
  if not errorlevel 1 (
    echo [Bavi-box] Windows desktop app is ready; startup terminal will close.
    exit /b 0
  )
)
if %HANDOFF_WAIT_SECONDS% GEQ 180 (
  echo [Bavi-box] Windows desktop app did not become ready within 180 seconds.
  echo [Bavi-box] Please keep this window open and check logs if the app does not appear.
  exit /b 1
)
call :sleep_seconds 1
set /a HANDOFF_WAIT_SECONDS+=1
goto wait_for_launcher_handoff_loop

:mark_sync_current
if not exist "%SYNC_STATE_DIR%" mkdir "%SYNC_STATE_DIR%" >nul 2>&1
if not exist "%USB_DATA_DIR%\.uclaw-sync" mkdir "%USB_DATA_DIR%\.uclaw-sync" >nul 2>&1
>"%LAST_SYNC_FILE%" echo {"success":true,"reason":"launcher-startup-sync"}
copy /y "%LAST_SYNC_FILE%" "%USB_DATA_DIR%\.uclaw-sync\last-sync.json" >nul
exit /b 0
