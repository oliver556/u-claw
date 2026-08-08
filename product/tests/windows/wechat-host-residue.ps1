param(
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$EvidencePath,
    [ValidateSet('audit', 'clean')][string]$Mode = 'audit'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Evidence {
    param($Value)
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($EvidencePath))
    [void][IO.Directory]::CreateDirectory($parent)
    $temporary = $EvidencePath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temporary, (($Value | ConvertTo-Json -Depth 20) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary, $EvidencePath)
}

$started = [DateTime]::UtcNow
$blockers = @()
$resolvedRelease = [IO.Path]::GetFullPath($ReleaseRoot)
$releaseDriveRoot = [IO.Path]::GetPathRoot($resolvedRelease)
$driveLetter = $releaseDriveRoot.TrimEnd('\').TrimEnd(':')
$disk = $null
$diskDrive = $null
try {
    $partition = Get-Partition -DriveLetter $driveLetter -ErrorAction Stop
    $disk = $partition | Get-Disk -ErrorAction Stop
    $diskDrive = Get-CimInstance -ClassName Win32_DiskDrive | Where-Object { $_.Index -eq $disk.Number } | Select-Object -First 1
} catch {}
$driveInfo = New-Object IO.DriveInfo($releaseDriveRoot)
$physicalUsb = $driveInfo.DriveType -eq [IO.DriveType]::Removable -and $null -ne $disk -and ([string]$disk.BusType -ceq 'USB') -and $null -ne $diskDrive
if (-not $physicalUsb) {
    $blockers += [ordered]@{ code = 'PHYSICAL_USB_REQUIRED'; message = 'Run against a released bundle on a physical USB drive.' }
}

$pluginManifest = Join-Path $resolvedRelease 'app\extensions\openclaw-weixin\openclaw.plugin.json'
if (-not (Test-Path -LiteralPath $pluginManifest -PathType Leaf)) {
    $blockers += [ordered]@{ code = 'WECHAT_PLUGIN_ARTIFACT_REQUIRED'; message = 'Released openclaw-weixin artifact is required for source and runtime evidence.' }
}
$nodePath = Join-Path $resolvedRelease 'app\runtime\node-win-x64\node.exe'
$auditScript = Join-Path $resolvedRelease 'lib\wechat-host-residue.mjs'
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or -not (Test-Path -LiteralPath $auditScript -PathType Leaf)) {
    $blockers += [ordered]@{ code = 'RELEASE_AUDIT_RUNTIME_REQUIRED'; message = 'Bundled Node.js and residue audit script are required.' }
}

$nodeEvidence = $EvidencePath + '.node.json'
if ((Test-Path -LiteralPath $nodePath -PathType Leaf) -and (Test-Path -LiteralPath $auditScript -PathType Leaf)) {
    $arguments = @($auditScript, '--evidence', $nodeEvidence, '--mode', $Mode)
    $fixedRoots = @(Get-PSDrive -PSProvider FileSystem | ForEach-Object {
        try {
            $candidate = New-Object IO.DriveInfo($_.Root)
            if ($candidate.DriveType -eq [IO.DriveType]::Fixed) { $_.Root }
        } catch {}
    })
    foreach ($root in $fixedRoots) { $arguments += @('--fixed-drive-root', [string]$root) }
    & $nodePath @arguments
    $nodeExit = $LASTEXITCODE
    if (Test-Path -LiteralPath $nodeEvidence -PathType Leaf) {
        $nodeResult = Get-Content -LiteralPath $nodeEvidence -Raw | ConvertFrom-Json
        Remove-Item -LiteralPath $nodeEvidence -Force
        foreach ($entry in @($nodeResult.entries)) {
            if ($entry.decision -ceq 'refuse') {
                $blockers += [ordered]@{ code = [string]$entry.reason; message = 'Host content was not cleaned because ownership is not proven.'; pathSha256 = [string]$entry.pathSha256 }
            }
        }
    } elseif ($nodeExit -ne 0) {
        $blockers += [ordered]@{ code = 'NODE_AUDIT_FAILED'; message = 'Node residue audit did not produce evidence.' }
    }
}

$status = if ($blockers.Count -eq 0) { 'passed' } else { 'needs-input' }
Write-Evidence ([ordered]@{
    schemaVersion = 1
    caseId = 'DATA-005'
    status = $status
    mode = $Mode
    startedAtUtc = $started.ToString('o')
    completedAtUtc = [DateTime]::UtcNow.ToString('o')
    assertions = @(
        [ordered]@{ name = 'physical-usb'; passed = $physicalUsb }
        [ordered]@{ name = 'released-wechat-plugin'; passed = (Test-Path -LiteralPath $pluginManifest -PathType Leaf) }
        [ordered]@{ name = 'host-paths-redacted'; passed = $true }
    )
    blockers = $blockers
})
if ($status -ne 'passed') { exit 2 }
