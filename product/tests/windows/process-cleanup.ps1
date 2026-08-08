param(
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$EvidencePath,
    [string]$CacheRoot = (Join-Path $env:LOCALAPPDATA 'U-Claw\runtime'),
    [ValidateRange(0, 120)][int]$GraceSeconds = 10,
    [ValidateSet('exit-cleanup', 'usb-removal')][string]$Mode = 'exit-cleanup'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Evidence { param($Value) $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($EvidencePath)); [void][IO.Directory]::CreateDirectory($parent); $temporary = $EvidencePath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'; [IO.File]::WriteAllText($temporary, (($Value | ConvertTo-Json -Depth 20) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false)); [IO.File]::Move($temporary, $EvidencePath) }
function Get-OwnedProcesses {
    $release = [IO.Path]::GetFullPath($ReleaseRoot)
    $cache = [IO.Path]::GetFullPath($CacheRoot)
    return @(Get-CimInstance -ClassName Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and (
            ($_.ExecutablePath -and ($_.ExecutablePath.StartsWith($release, [StringComparison]::OrdinalIgnoreCase) -or $_.ExecutablePath.StartsWith($cache, [StringComparison]::OrdinalIgnoreCase))) -or
            ($_.CommandLine -and $_.CommandLine.IndexOf($release, [StringComparison]::OrdinalIgnoreCase) -ge 0)
        )
    } | ForEach-Object { [ordered]@{ processId = [int]$_.ProcessId; name = [string]$_.Name } })
}

$started = [DateTime]::UtcNow; $status = 'failed'; $blockers = @(); $assertions = @()
if ($Mode -eq 'usb-removal') {
    $beforeRemoval = @(Get-OwnedProcesses)
    $assertions += [ordered]@{ name = 'product-running-before-usb-removal'; passed = ($beforeRemoval.Count -gt 0); actual = [string]$beforeRemoval.Count }
    if ($beforeRemoval.Count -eq 0) { $blockers += [ordered]@{ code = 'PRODUCT_PROCESS_NOT_RUNNING'; message = 'Start U-Claw before beginning physical USB removal observation.' } }
    $driveRoot = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($ReleaseRoot))
    $deadline = [DateTime]::UtcNow.AddMinutes(5)
    while ((Test-Path -LiteralPath $driveRoot) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 500 }
    if (Test-Path -LiteralPath $driveRoot) { $blockers += [ordered]@{ code = 'PHYSICAL_USB_REMOVAL_NOT_OBSERVED'; message = 'Remove the physical USB drive during the five-minute observation window.' } }
}
Start-Sleep -Seconds $GraceSeconds
$owned = @(Get-OwnedProcesses)
$clean = $owned.Count -eq 0
$assertions += [ordered]@{ name = if ($Mode -eq 'usb-removal') { 'processes-stopped-after-usb-removal' } else { 'no-owned-orphan-processes' }; passed = $clean; actual = [string]$owned.Count }
if (-not $clean) { $blockers += [ordered]@{ code = 'PRODUCT_PROCESS_REMAINS'; message = 'Product-owned processes remain after the cleanup window.' } }
if ($blockers.Count -eq 0) { $status = 'passed' }
$caseId = if ($Mode -eq 'usb-removal') { 'usb-removal' } else { 'process-cleanup' }
Write-Evidence ([ordered]@{ schemaVersion = 1; caseId = $caseId; status = $status; startedAtUtc = $started.ToString('o'); completedAtUtc = [DateTime]::UtcNow.ToString('o'); assertions = $assertions; artifacts = @(); blockers = $blockers })
if ($status -ne 'passed') { exit 1 }
