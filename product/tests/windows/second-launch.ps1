param(
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$EvidencePath,
    [string]$CacheRoot = (Join-Path $env:LOCALAPPDATA 'U-Claw\runtime'),
    [ValidateRange(10, 1800)][int]$TimeoutSeconds = 300
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Evidence {
    param([System.Collections.IDictionary]$Value)
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($EvidencePath)); [void][IO.Directory]::CreateDirectory($parent)
    $temporary = $EvidencePath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temporary, (($Value | ConvertTo-Json -Depth 20) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false)); [IO.File]::Move($temporary, $EvidencePath)
}

function Get-CacheSnapshot {
    $result = @()
    if (Test-Path -LiteralPath $CacheRoot) {
        $result = @(Get-ChildItem -LiteralPath $CacheRoot -Filter '.uclaw-runtime.json' -File -Recurse | ForEach-Object {
            [ordered]@{ path = $_.FullName; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash; lastWriteUtc = $_.LastWriteTimeUtc.ToString('o') }
        })
    }
    return $result
}

$started = [DateTime]::UtcNow; $status = 'failed'; $process = $null; $blockers = @(); $assertions = @()
try {
    $launcher = Join-Path $ReleaseRoot 'U-Claw.exe'
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'LAUNCHER_MISSING' }
    $before = @(Get-CacheSnapshot)
    if ($before.Count -eq 0) { throw 'FIRST_LAUNCH_CACHE_MISSING' }
    $process = Start-Process -FilePath $launcher -WorkingDirectory $ReleaseRoot -PassThru
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { throw 'MANUAL_CLOSE_TIMEOUT' }
    $after = @(Get-CacheSnapshot)
    $reused = (($before | ConvertTo-Json -Depth 5 -Compress) -ceq ($after | ConvertTo-Json -Depth 5 -Compress))
    $assertions += [ordered]@{ name = 'cache-marker-unchanged'; passed = $reused; actual = if ($reused) { 'reused' } else { 'changed' } }
    $assertions += [ordered]@{ name = 'launcher-exit-code'; passed = ($process.ExitCode -eq 0); actual = [string]$process.ExitCode }
    if (-not $reused) { throw 'SECOND_LAUNCH_REEXTRACTED' }
    if ($process.ExitCode -ne 0) { throw 'SECOND_LAUNCH_FAILED' }
    $status = 'passed'
}
catch { $blockers += [ordered]@{ code = [string]$_.Exception.Message; message = 'Second launch acceptance did not pass.' } }
finally {
    if ($null -ne $process) {
        if (-not $process.HasExited) { & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $process.Id /T /F *> $null }
        $process.Dispose()
    }
    Write-Evidence ([ordered]@{ schemaVersion = 1; caseId = 'second-launch'; status = $status; startedAtUtc = $started.ToString('o'); completedAtUtc = [DateTime]::UtcNow.ToString('o'); assertions = $assertions; artifacts = @(); blockers = $blockers })
}
if ($status -ne 'passed') { exit 1 }
