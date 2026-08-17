param(
    [Parameter(Mandatory = $true)][string]$LauncherExe,
    [Parameter(Mandatory = $true)][string]$UsbRoot,
    [Parameter(Mandatory = $true)][string]$DiagnosticsPath,
    [Parameter(Mandatory = $true)][string]$CaseName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$expectedRuntimeVersion = '2026.7.1-2'
$launcher = [IO.Path]::GetFullPath((Join-Path $PWD $LauncherExe))
$root = [IO.Path]::GetFullPath((Join-Path $PWD $UsbRoot))
$diagnostics = [IO.Path]::GetFullPath((Join-Path $PWD $DiagnosticsPath))
$ready = Join-Path $root '.uclaw\data\diagnostics\runtime-ready.json'
$startupFailure = Join-Path $root '.uclaw\data\diagnostics\runtime-startup-failure.json'
$launcherLog = Join-Path $root '.uclaw\data\diagnostics\desktop-logs\uclaw-launcher.jsonl'
$gatewayLog = Join-Path $root '.uclaw\data\diagnostics\desktop-logs\uclaw-gateway.jsonl'
$ruleName = 'UCLAW_REAL_RUNTIME_READY_' + [Guid]::NewGuid().ToString('N')
$previousLocalAppData = $env:LOCALAPPDATA
$process = $null
$ruleCreated = $false

function Read-SafeLogRecords([string]$path, [string]$expectedSource, [string[]]$allowedEvents) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return }
    try {
        foreach ($line in @(Get-Content -LiteralPath $path -ErrorAction Stop)) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            try {
                $value = $line | ConvertFrom-Json
                if ($value.source -eq $expectedSource -and $allowedEvents -contains [string]$value.event) {
                    Write-Output $value
                }
            }
            catch { }
        }
    }
    catch { }
}

function Read-SafeStartupFailure([string]$path) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try {
        $value = [IO.File]::ReadAllText($path) | ConvertFrom-Json
        if ($value.schemaVersion -ne 1) { return $null }
        if (@('load-options', 'start-desktop') -notcontains [string]$value.stage) { return $null }
        if ($value.PSObject.Properties.Name -contains 'wiringStage' -and @(
            'development-environment', 'production-module',
            'environment', 'development-provider', 'portable-skills', 'provider-store',
            'plugin-runtime', 'wechat-runtime', 'desktop-log', 'domain-modules', 'options-complete'
        ) -notcontains [string]$value.wiringStage) { return $null }
        if ($value.PSObject.Properties.Name -contains 'desktopStage' -and @(
            'startup', 'electron-runtime', 'attachment-cleanup', 'skills', 'plugins',
            'domain-services', 'gateway-main', 'readiness'
        ) -notcontains [string]$value.desktopStage) { return $null }
        if (@(
            'UNCONFIGURED', 'UNAVAILABLE', 'INVALID_ARGUMENT', 'FORBIDDEN', 'AUTH_FAILED',
            'PROTOCOL_ERROR', 'UNSUPPORTED', 'OFFLINE', 'CONFLICT', 'OPERATION_FAILED', 'UNKNOWN',
            'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED',
            'ERR_INVALID_PACKAGE_CONFIG', 'ERR_UNKNOWN_FILE_EXTENSION'
        ) -notcontains [string]$value.code) { return $null }
        if (@('Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'AggregateError', 'DesktopWiringError', 'UnknownError') -notcontains [string]$value.name) { return $null }
        return $value
    }
    catch { return $null }
}

function Write-SanitizedDiagnostic([bool]$readyResult, [AllowNull()][string]$failureCode) {
    $launcherRecords = @(Read-SafeLogRecords $launcherLog 'launcher' @(
        'launcher-started', 'runtime-started', 'runtime-stopped', 'launcher-failed'
    ))
    $gatewayRecords = @(Read-SafeLogRecords $gatewayLog 'gateway' @(
        'gateway-spawned', 'gateway-health-ready', 'gateway-capability-ready', 'gateway-started',
        'gateway-startup-failed', 'gateway-exited', 'gateway-stop-requested'
    ))
    $launcherRecord = if ($launcherRecords.Count -eq 0) { $null } else { $launcherRecords[-1] }
    $gatewayRecord = if ($gatewayRecords.Count -eq 0) { $null } else { $gatewayRecords[-1] }
    $startupRecord = Read-SafeStartupFailure $startupFailure
    $launcherEvent = if ($null -eq $launcherRecord) { $null } else { [string]$launcherRecord.event }
    $gatewayEvent = if ($null -eq $gatewayRecord) { $null } else { [string]$gatewayRecord.event }
    $gatewaySpawned = @($gatewayRecords | Where-Object { $_.event -eq 'gateway-spawned' }).Count -gt 0
    $gatewayHealthReady = @($gatewayRecords | Where-Object { $_.event -eq 'gateway-health-ready' }).Count -gt 0
    $gatewayCapabilityReady = @($gatewayRecords | Where-Object { $_.event -eq 'gateway-capability-ready' }).Count -gt 0
    $startupStage = if ($null -eq $startupRecord) { $null } else { [string]$startupRecord.stage }
    $startupWiringStage = if ($null -eq $startupRecord -or -not ($startupRecord.PSObject.Properties.Name -contains 'wiringStage')) { $null } else { [string]$startupRecord.wiringStage }
    $startupDesktopStage = if ($null -eq $startupRecord -or -not ($startupRecord.PSObject.Properties.Name -contains 'desktopStage')) { $null } else { [string]$startupRecord.desktopStage }
    $startupErrorCode = if ($null -eq $startupRecord) { $null } else { [string]$startupRecord.code }
    $startupErrorName = if ($null -eq $startupRecord) { $null } else { [string]$startupRecord.name }
    $gatewayPhase = $null
    $gatewayClassification = $null
    if ($null -ne $gatewayRecord -and $gatewayRecord.PSObject.Properties.Name -contains 'phase') {
        $candidate = [string]$gatewayRecord.phase
        if (@('starting', 'health-ready', 'ready', 'stopping') -contains $candidate) { $gatewayPhase = $candidate }
    }
    if ($null -ne $gatewayRecord -and $gatewayRecord.PSObject.Properties.Name -contains 'classification') {
        $candidate = [string]$gatewayRecord.classification
        if (@('requested-stop', 'unexpected-exit', 'startup-failure') -contains $candidate) { $gatewayClassification = $candidate }
    }
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($diagnostics))
    $record = [ordered]@{
        schemaVersion = 1
        caseName = $CaseName
        realRuntimeReady = $readyResult
        runtimeVersion = $expectedRuntimeVersion
        networkDisabled = $true
        failureCode = $failureCode
        launcherEvent = $launcherEvent
        gatewayEvent = $gatewayEvent
        gatewayPhase = $gatewayPhase
        gatewayClassification = $gatewayClassification
        gatewaySpawned = $gatewaySpawned
        gatewayHealthReady = $gatewayHealthReady
        gatewayCapabilityReady = $gatewayCapabilityReady
        startupStage = $startupStage
        startupWiringStage = $startupWiringStage
        startupDesktopStage = $startupDesktopStage
        startupErrorCode = $startupErrorCode
        startupErrorName = $startupErrorName
    }
    [IO.File]::WriteAllText($diagnostics, (($record | ConvertTo-Json -Compress) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
}

try {
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'UCLAW_REAL_RUNTIME_LAUNCHER_MISSING' }
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'UCLAW_REAL_RUNTIME_USB_ROOT_MISSING' }
    Remove-Item -LiteralPath $ready -Force -ErrorAction SilentlyContinue
    $env:LOCALAPPDATA = Join-Path ([IO.Path]::GetDirectoryName($root)) ('.real-runtime-cache-' + $CaseName)

    New-NetFirewallRule -DisplayName $ruleName -Direction Outbound -Action Block -Profile Any -Enabled True | Out-Null
    $ruleCreated = $true
    $process = Start-Process -FilePath $launcher -WorkingDirectory $root -PassThru
    for ($attempt = 0; $attempt -lt 120 -and -not (Test-Path -LiteralPath $ready -PathType Leaf); $attempt++) {
        if ($process.HasExited) { throw 'UCLAW_REAL_RUNTIME_EXITED' }
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-Path -LiteralPath $ready -PathType Leaf)) { throw 'UCLAW_REAL_RUNTIME_READY_TIMEOUT' }
    $body = [IO.File]::ReadAllText($ready)
    $record = $body | ConvertFrom-Json
    if ($record.schemaVersion -ne 1 -or $record.runtimeVersion -ne $expectedRuntimeVersion -or $record.gatewayReady -ne $true) {
        throw 'UCLAW_REAL_RUNTIME_NOT_READY'
    }
    if ($body.Contains($root)) { throw 'UCLAW_REAL_RUNTIME_DIAGNOSTIC_PATH_LEAK' }
    Write-SanitizedDiagnostic $true $null
}
catch {
    $failureCode = $_.Exception.Message
    if ($failureCode -notmatch '^UCLAW_REAL_RUNTIME_[A-Z_]+$') {
        $failureCode = 'UCLAW_REAL_RUNTIME_UNKNOWN'
    }
    Write-SanitizedDiagnostic $false $failureCode
    throw 'UCLAW_REAL_RUNTIME_SMOKE_FAILED'
}
finally {
    if ($null -ne $process) {
        if (-not $process.HasExited) {
            [void]$process.CloseMainWindow()
            [void]$process.WaitForExit(2000)
        }
        if (-not $process.HasExited) {
            & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
            [void]$process.WaitForExit(15000)
        }
        $process.Dispose()
    }
    if ($ruleCreated) {
        Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    }
    $env:LOCALAPPDATA = $previousLocalAppData
}
