param(
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$EvidencePath,
    [Parameter(Mandatory)][string]$BaselinePath,
    [switch]$CaptureBaseline
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-JsonAtomic { param([string]$Path, $Value) $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path)); [void][IO.Directory]::CreateDirectory($parent); $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'; [IO.File]::WriteAllText($temporary, (($Value | ConvertTo-Json -Depth 20) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false)); [IO.File]::Move($temporary, $Path) }
function Get-Sha256Text { param([string]$Text) $bytes = [Text.Encoding]::UTF8.GetBytes($Text); $sha = [Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() } }
function Get-Inventory {
    $roots = @(
        (Join-Path $env:USERPROFILE '.openclaw'),
        (Join-Path $env:USERPROFILE '.uclaw'),
        (Join-Path $env:APPDATA 'U-Claw'),
        (Join-Path $env:LOCALAPPDATA 'U-Claw'),
        (Join-Path $env:TEMP 'U-Claw'),
        (Join-Path $env:TEMP '.uclaw')
    ) | Select-Object -Unique
    $runtimeCache = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'U-Claw\runtime'))
    $sensitiveRuntimePattern = '(^|[\\/])(\.openclaw|\.uclaw|sessions?|memory|workspace|openclaw\.json|uclaw\.json|credentials?\.json|tokens?\.json)([\\/]|$)'
    $files = @()
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        foreach ($item in @(Get-ChildItem -LiteralPath $root -File -Recurse -Force -ErrorAction SilentlyContinue)) {
            if ($item.FullName.StartsWith($runtimeCache, [StringComparison]::OrdinalIgnoreCase) -and $item.FullName -notmatch $sensitiveRuntimePattern) { continue }
            $pathSha256 = Get-Sha256Text ($item.FullName.ToLowerInvariant())
            $files += [ordered]@{ pathSha256 = $pathSha256; bytes = $item.Length; sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); lastWriteUtc = $item.LastWriteTimeUtc.ToString('o') }
        }
    }
    return @($files | Sort-Object pathSha256)
}

$started = [DateTime]::UtcNow; $current = @(Get-Inventory)
if ($CaptureBaseline) {
    Write-JsonAtomic $BaselinePath ([ordered]@{ schemaVersion = 1; capturedAtUtc = [DateTime]::UtcNow.ToString('o'); files = $current })
    Write-JsonAtomic $EvidencePath ([ordered]@{ schemaVersion = 1; caseId = 'host-residue-baseline'; status = 'passed'; startedAtUtc = $started.ToString('o'); completedAtUtc = [DateTime]::UtcNow.ToString('o'); assertions = @([ordered]@{ name = 'baseline-captured'; passed = $true; actual = [string]$current.Count }); artifacts = @(); blockers = @() })
    exit 0
}

$status = 'failed'; $blockers = @(); $assertions = @()
try {
    if (-not (Test-Path -LiteralPath $BaselinePath -PathType Leaf)) { throw 'HOST_AUDIT_BASELINE_MISSING' }
    $baseline = Get-Content -LiteralPath $BaselinePath -Raw | ConvertFrom-Json
    $before = @{}; foreach ($file in @($baseline.files)) { $before[[string]$file.pathSha256] = ([string]$file.sha256).ToLowerInvariant() }
    $newOrChanged = @($current | Where-Object { -not $before.ContainsKey($_.pathSha256) -or $before[$_.pathSha256] -cne $_.sha256 })
    $usbData = Join-Path $ReleaseRoot '.uclaw\data'
    $usbFileCount = if (Test-Path -LiteralPath $usbData) { @(Get-ChildItem -LiteralPath $usbData -File -Recurse -Force -ErrorAction SilentlyContinue).Count } else { 0 }
    $assertions += [ordered]@{ name = 'no-new-host-user-data'; passed = ($newOrChanged.Count -eq 0); actual = [string]$newOrChanged.Count }
    $assertions += [ordered]@{ name = 'usb-data-directory-present'; passed = (Test-Path -LiteralPath $usbData -PathType Container); actual = [string]$usbFileCount }
    if ($newOrChanged.Count -ne 0) { throw 'HOST_USER_DATA_RESIDUE_FOUND' }
    if (-not (Test-Path -LiteralPath $usbData -PathType Container)) { throw 'USB_DATA_DIRECTORY_MISSING' }
    $status = 'passed'
}
catch { $blockers += [ordered]@{ code = [string]$_.Exception.Message; message = 'Host residue audit did not pass.' } }
Write-JsonAtomic $EvidencePath ([ordered]@{ schemaVersion = 1; caseId = 'host-residue'; status = $status; startedAtUtc = $started.ToString('o'); completedAtUtc = [DateTime]::UtcNow.ToString('o'); assertions = $assertions; artifacts = @(); blockers = $blockers })
if ($status -ne 'passed') { exit 1 }
