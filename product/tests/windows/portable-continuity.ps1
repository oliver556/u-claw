param(
    [Parameter(Mandatory)][ValidateSet('Capture', 'DeleteCache', 'VerifyCacheRecovery', 'Verify')][string]$Action,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$EvidencePath,
    [Parameter(Mandatory)][string]$SnapshotPath,
    [string]$PeerSnapshotPath,
    [string]$HostAuditEvidencePath,
    [switch]$ContinuityConfirmed,
    [string]$CacheRoot = (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'U-Claw')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-JsonAtomic {
    param([string]$Path, $Value)
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))
    [void][IO.Directory]::CreateDirectory($parent)
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temporary, (($Value | ConvertTo-Json -Depth 20) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary, $Path)
}

function Get-Sha256Text {
    param([string]$Text)
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-MachineIdSha256 {
    $machineGuid = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid
    return Get-Sha256Text (([string]$machineGuid).ToLowerInvariant())
}

function Test-PhysicalUsb {
    param([string]$Root)
    $driveRoot = [IO.Path]::GetPathRoot($Root)
    $driveLetter = $driveRoot.TrimEnd('\').TrimEnd(':')
    $drive = [IO.DriveInfo]::new($driveRoot)
    try {
        $partition = Get-Partition -DriveLetter $driveLetter -ErrorAction Stop
        $disk = $partition | Get-Disk -ErrorAction Stop
        return $drive.DriveType -eq [IO.DriveType]::Removable -and [string]$disk.BusType -eq 'USB'
    } catch { return $false }
}

function Get-UsbSnapshot {
    param([string]$DataRoot)
    if (-not (Test-Path -LiteralPath $DataRoot -PathType Container)) { throw 'USB_DATA_DIRECTORY_MISSING' }
    $root = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
    $files = @()
    foreach ($file in @(Get-ChildItem -LiteralPath $root -File -Recurse -Force -ErrorAction Stop)) {
        $relativePath = $file.FullName.Substring($root.Length).TrimStart('\').Replace('\', '/')
        $files += [ordered]@{
            relativePathSha256 = Get-Sha256Text ($relativePath.ToLowerInvariant())
            bytes = $file.Length
            sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $files = @($files | Sort-Object relativePathSha256)
    $inventoryJson = ConvertTo-Json -InputObject @($files) -Depth 10 -Compress
    return [ordered]@{
        schemaVersion = 1
        machineIdSha256 = Get-MachineIdSha256
        driveRoot = [IO.Path]::GetPathRoot($root)
        physicalUsbVerified = Test-PhysicalUsb $root
        capturedAtUtc = [DateTime]::UtcNow.ToString('o')
        snapshotSha256 = Get-Sha256Text $inventoryJson
        files = $files
    }
}

function Assert-OwnedCacheRoot {
    param([string]$Root)
    $cacheRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    $expectedCacheRoot = [IO.Path]::GetFullPath((Join-Path $localAppData 'U-Claw')).TrimEnd('\')
    if (-not [String]::Equals($cacheRoot, $expectedCacheRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'CACHE_ROOT_MUST_EQUAL_LOCALAPPDATA_UCLAW'
    }
    $driveRoot = [IO.Path]::GetPathRoot($cacheRoot).TrimEnd('\')
    if ($cacheRoot -eq $driveRoot) { throw 'CACHE_ROOT_UNSAFE' }
    $cacheItem = Get-Item -LiteralPath $cacheRoot -Force -ErrorAction Stop
    if (($cacheItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'CACHE_ROOT_REPARSE_POINT' }
    $markerPath = Join-Path $cacheRoot '.uclaw-cache.json'
    $markerItem = Get-Item -LiteralPath $markerPath -Force -ErrorAction Stop
    if (($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'CACHE_OWNERSHIP_MARKER_INVALID' }
    $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    $names = @($marker.PSObject.Properties.Name | Sort-Object)
    $expectedNames = @('product', 'purpose', 'schemaVersion')
    if (
        (Compare-Object $names $expectedNames) -or
        [int]$marker.schemaVersion -ne 1 -or
        [string]$marker.product -cne 'U-Claw' -or
        [string]$marker.purpose -cne 'rebuildable-cache'
    ) { throw 'CACHE_OWNERSHIP_MARKER_INVALID' }
    return $cacheRoot
}

$started = [DateTime]::UtcNow
$release = [IO.Path]::GetFullPath($ReleaseRoot)
$dataRoot = Join-Path $release '.uclaw\data'
$status = 'failed'
$assertions = @()
$blockers = @()
$current = $null

try {
    $current = Get-UsbSnapshot $dataRoot
    switch ($Action) {
        'Capture' {
            Write-JsonAtomic $SnapshotPath $current
            $assertions += [ordered]@{ name = 'usb-snapshot-captured'; passed = $true; actual = $current.snapshotSha256 }
            $status = 'needs-input'
            $blockers += [ordered]@{ code = 'TWO_REAL_WINDOWS_AND_PHYSICAL_USB_REQUIRED'; message = 'Run Verify on a second real Windows machine with the same physical USB drive.' }
        }
        'DeleteCache' {
            $before = $current.snapshotSha256
            $cacheRoot = Assert-OwnedCacheRoot $CacheRoot
            Remove-Item -LiteralPath $cacheRoot -Recurse -Force
            $after = (Get-UsbSnapshot $dataRoot).snapshotSha256
            if ($before -cne $after) { throw 'USB_DATA_CHANGED_DURING_CACHE_DELETE' }
            $assertions += [ordered]@{ name = 'owned-cache-deleted'; passed = (-not (Test-Path -LiteralPath $cacheRoot)); actual = 'deleted' }
            $assertions += [ordered]@{ name = 'usb-data-unchanged'; passed = $true; actual = $after }
            $status = 'passed'
        }
        'VerifyCacheRecovery' {
            if (-not (Test-Path -LiteralPath $SnapshotPath -PathType Leaf)) { throw 'USB_SNAPSHOT_MISSING' }
            $snapshot = Get-Content -LiteralPath $SnapshotPath -Raw | ConvertFrom-Json
            if ([string]$snapshot.snapshotSha256 -cne [string]$current.snapshotSha256) { throw 'USB_DATA_CHANGED_DURING_CACHE_RECOVERY' }
            $cacheRoot = Assert-OwnedCacheRoot $CacheRoot
            $runtimeMarkers = @(Get-ChildItem -LiteralPath (Join-Path $cacheRoot 'runtime') -Filter '.uclaw-runtime.json' -File -Recurse -Force -ErrorAction SilentlyContinue)
            if ($runtimeMarkers.Count -eq 0) { throw 'CACHE_RUNTIME_NOT_REBUILT' }
            $assertions += [ordered]@{ name = 'runtime-cache-rebuilt'; passed = $true; actual = [string]$runtimeMarkers.Count }
            $assertions += [ordered]@{ name = 'usb-data-preserved-after-rebuild'; passed = $true; actual = $current.snapshotSha256 }
            $status = 'passed'
        }
        'Verify' {
            if (-not $PeerSnapshotPath -or -not (Test-Path -LiteralPath $PeerSnapshotPath -PathType Leaf)) { throw 'PEER_SNAPSHOT_MISSING' }
            if (-not $ContinuityConfirmed) { throw 'CONTINUITY_NOT_CONFIRMED_IN_RUNNING_APP' }
            if (-not $HostAuditEvidencePath -or -not (Test-Path -LiteralPath $HostAuditEvidencePath -PathType Leaf)) { throw 'HOST_USER_DATA_AUDIT_NOT_PASSED' }
            $hostAudit = Get-Content -LiteralPath $HostAuditEvidencePath -Raw | ConvertFrom-Json
            $hostAuditPassed = [string]$hostAudit.caseId -ceq 'host-residue' -and [string]$hostAudit.status -ceq 'passed' -and @($hostAudit.assertions | Where-Object { $_.name -ceq 'no-new-host-user-data' -and $_.passed }).Count -eq 1
            if (-not $hostAuditPassed) { throw 'HOST_USER_DATA_AUDIT_NOT_PASSED' }
            $peer = Get-Content -LiteralPath $PeerSnapshotPath -Raw | ConvertFrom-Json
            if ([string]$peer.machineIdSha256 -ceq [string]$current.machineIdSha256) { throw 'SECOND_WINDOWS_MACHINE_REQUIRED' }
            if (-not [bool]$peer.physicalUsbVerified -or -not [bool]$current.physicalUsbVerified) { throw 'PHYSICAL_USB_NOT_VERIFIED' }
            if ([string]$peer.snapshotSha256 -cne [string]$current.snapshotSha256) { throw 'USB_CONTINUITY_MISMATCH' }
            $assertions += [ordered]@{ name = 'different-windows-machines'; passed = $true; actual = 'hashed-identities-differ' }
            $assertions += [ordered]@{ name = 'same-physical-usb-content'; passed = $true; actual = $current.snapshotSha256 }
            $assertions += [ordered]@{ name = 'running-app-continuity-confirmed'; passed = $true; actual = 'configuration-session-memory-work-file-opened' }
            $assertions += [ordered]@{ name = 'host-user-data-audit-passed'; passed = $true; actual = 'no-new-host-user-data' }
            $status = 'passed'
        }
    }
} catch {
    $blockers += [ordered]@{ code = [string]$_.Exception.Message; message = 'Portable continuity verification did not pass.' }
}

Write-JsonAtomic $EvidencePath ([ordered]@{
    schemaVersion = 1
    caseId = 'portable-continuity'
    action = $Action
    status = $status
    startedAtUtc = $started.ToString('o')
    completedAtUtc = [DateTime]::UtcNow.ToString('o')
    machineIdSha256 = if ($null -ne $current) { $current.machineIdSha256 } else { $null }
    driveRoot = if ($null -ne $current) { $current.driveRoot } else { $null }
    physicalUsbVerified = if ($null -ne $current) { $current.physicalUsbVerified } else { $false }
    assertions = $assertions
    blockers = $blockers
})
if ($status -eq 'failed') { exit 1 }
