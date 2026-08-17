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
$ruleName = 'UCLAW_REAL_RUNTIME_READY_' + [Guid]::NewGuid().ToString('N')
$previousLocalAppData = $env:LOCALAPPDATA
$process = $null
$ruleCreated = $false

function Write-SanitizedDiagnostic([bool]$readyResult, [AllowNull()][string]$failureCode) {
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($diagnostics))
    $record = [ordered]@{
        schemaVersion = 1
        caseName = $CaseName
        realRuntimeReady = $readyResult
        runtimeVersion = $expectedRuntimeVersion
        networkDisabled = $true
        failureCode = $failureCode
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
