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
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($EvidencePath))
    [void][IO.Directory]::CreateDirectory($parent)
    $temporary = $EvidencePath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temporary, (($Value | ConvertTo-Json -Depth 20) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary, $EvidencePath)
}

function Get-Artifact {
    param([string]$Path, [string]$Kind)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $item = Get-Item -LiteralPath $Path
    return [ordered]@{ kind = $Kind; name = $item.Name; bytes = $item.Length; sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
}

$started = [DateTime]::UtcNow
$launcher = Join-Path $ReleaseRoot 'U-Claw.exe'
$process = $null
$status = 'failed'
$blockers = @()
$assertions = @()
$artifacts = @()
try {
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'LAUNCHER_MISSING' }
    foreach ($candidate in @(
        @{ Path = $launcher; Kind = 'launcher' },
        @{ Path = (Join-Path $ReleaseRoot '.uclaw\runtime.pkg'); Kind = 'runtime-package' },
        @{ Path = (Join-Path $ReleaseRoot '.uclaw\version.json'); Kind = 'runtime-manifest' }
    )) {
        $artifact = Get-Artifact $candidate.Path $candidate.Kind
        if ($null -ne $artifact) { $artifacts += $artifact }
    }
    $before = @()
    if (Test-Path -LiteralPath $CacheRoot) { $before = @(Get-ChildItem -LiteralPath $CacheRoot -Directory | ForEach-Object { $_.FullName }) }
    $process = Start-Process -FilePath $launcher -WorkingDirectory $ReleaseRoot -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $cacheMarker = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        $markers = @()
        if (Test-Path -LiteralPath $CacheRoot) { $markers = @(Get-ChildItem -LiteralPath $CacheRoot -Filter '.uclaw-runtime.json' -File -Recurse -ErrorAction SilentlyContinue) }
        if ($markers.Count -gt 0) { $cacheMarker = $markers[0]; break }
        if ($process.HasExited) { break }
        Start-Sleep -Milliseconds 250
    }
    $cacheCreated = $null -ne $cacheMarker
    $assertions += [ordered]@{ name = 'version-cache-created'; passed = $cacheCreated; actual = if ($cacheCreated) { $cacheMarker.Directory.Name } else { 'missing' } }
    if (-not $cacheCreated) { throw 'VERSION_CACHE_NOT_CREATED' }
    if (-not $process.HasExited) {
        if (-not $process.WaitForExit([Math]::Max(1, [int](($deadline - [DateTime]::UtcNow).TotalMilliseconds)))) { throw 'MANUAL_CLOSE_TIMEOUT' }
    }
    $assertions += [ordered]@{ name = 'launcher-exit-code'; passed = ($process.ExitCode -eq 0); actual = [string]$process.ExitCode }
    if ($process.ExitCode -ne 0) { throw 'FIRST_LAUNCH_FAILED' }
    $newCaches = @(Get-ChildItem -LiteralPath $CacheRoot -Directory | Where-Object { $before -notcontains $_.FullName })
    $assertions += [ordered]@{ name = 'new-version-cache'; passed = ($newCaches.Count -ge 1); actual = [string]$newCaches.Count }
    if ($newCaches.Count -lt 1) { throw 'FIRST_LAUNCH_DID_NOT_CREATE_NEW_CACHE' }
    $status = 'passed'
}
catch {
    $blockers += [ordered]@{ code = [string]$_.Exception.Message; message = 'First launch acceptance did not pass.' }
}
finally {
    if ($null -ne $process) {
        if (-not $process.HasExited) { & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $process.Id /T /F *> $null }
        $process.Dispose()
    }
    Write-Evidence ([ordered]@{
        schemaVersion = 1; caseId = 'first-launch'; status = $status
        startedAtUtc = $started.ToString('o'); completedAtUtc = [DateTime]::UtcNow.ToString('o')
        assertions = $assertions; artifacts = $artifacts; blockers = $blockers
    })
}

if ($status -ne 'passed') { exit 1 }
