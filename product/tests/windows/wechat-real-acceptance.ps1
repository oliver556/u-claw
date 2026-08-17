param(
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$EvidencePath,
    [string[]]$CaseEvidencePath = @(),
    [ValidateSet('machine-a', 'machine-b')][string]$MachineRole = 'machine-a'
)

# WX-10/WX-12 evidence collector. It never promotes code, mock, localhost, or
# fixture evidence to a real pass. Run on the real Windows host; manual cases
# are supplied as redacted JSON files (see wechat-real-acceptance.template.json).
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Evidence { param($Value)
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($EvidencePath))
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $tmp = $EvidencePath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($tmp, (($Value | ConvertTo-Json -Depth 30) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($tmp, $EvidencePath)
}
function Sha256Text { param([string]$Text)
    $sha = [Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
}
function BlockedCase { param([string]$Id, [string]$Reason)
    return [ordered]@{ schemaVersion = 1; caseId = $Id; status = 'blocked'; evidenceClass = 'needs-input'; assertions = @(); artifacts = @(); blockers = @([ordered]@{ code = 'REAL_EVIDENCE_REQUIRED'; message = $Reason }) }
}

$started = [DateTime]::UtcNow
$requiredCases = @(
    'win10-x64-standard-user-defender-no-node', 'win11-x64-standard-user-defender-no-node',
    'physical-usb-data-layout', 'plugin-missing-repair', 'plugin-tamper-repair',
    'first-scan-phone-confirmation', 'gateway-connected', 'text-inbound', 'text-outbound',
    'second-launch-recovery', 'disconnect-reconnect', 'auth-expired-rescan',
    'logout-clears-credentials', 'usb-removal', 'drive-letter-change', 'host-residue'
)
$cases = @(); $inputCases = @{}
foreach ($path in $CaseEvidencePath) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    $item = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if (-not $item.caseId) { continue }
    $inputCases[[string]$item.caseId] = $item
}
foreach ($id in $requiredCases) {
    if (-not $inputCases.ContainsKey($id)) { $cases += BlockedCase $id 'Attach redacted evidence from the real Windows/USB/Gateway/Tencent/phone run.'; continue }
    $item = $inputCases[$id]
    $realClass = @('real-windows', 'real-usb', 'real-gateway', 'real-tencent-ilink', 'real-phone') -contains [string]$item.evidenceClass
    if (-not $realClass -or [string]$item.status -ne 'passed') {
        $cases += BlockedCase $id 'Only passed evidenceClass real-windows/real-usb/real-gateway/real-tencent-ilink/real-phone is eligible.'
    } else { $cases += $item }
}

$resolved = [IO.Path]::GetFullPath($ReleaseRoot); $root = [IO.Path]::GetPathRoot($resolved)
$driveLetter = $root.TrimEnd('\').TrimEnd(':'); $disk = $null; $diskDrive = $null
try { $partition = Get-Partition -DriveLetter $driveLetter -ErrorAction Stop; $disk = $partition | Get-Disk -ErrorAction Stop; $diskDrive = Get-CimInstance Win32_DiskDrive | Where-Object { $_.Index -eq $disk.Number } | Select-Object -First 1 } catch {}
$driveInfo = New-Object IO.DriveInfo($root)
$physicalUsb = $driveInfo.DriveType -eq [IO.DriveType]::Removable -and $null -ne $disk -and [string]$disk.BusType -ceq 'USB' -and $null -ne $diskDrive
$os = Get-CimInstance Win32_OperatingSystem; $build = [int]$os.BuildNumber
$osFamily = if ($build -ge 22000) { 'windows-11' } else { 'windows-10' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); $isAdmin = @($identity.Groups | Where-Object Value -ceq 'S-1-5-32-544').Count -gt 0
$defender = $null; try { $defender = Get-MpComputerStatus -ErrorAction Stop } catch {}
$nodeOnPath = $null -ne (Get-Command node -ErrorAction SilentlyContinue)
$pluginManifest = Join-Path $resolved 'app\extensions\openclaw-weixin\openclaw.plugin.json'
$runtimePackage = Join-Path $resolved '.uclaw\runtime.pkg'
$runtimeManifest = Join-Path $resolved '.uclaw\version.json'
$policyPath = Join-Path $PSScriptRoot 'wechat-host-residue-policy.json'
$policy = if (Test-Path -LiteralPath $policyPath) { Get-Content $policyPath -Raw | ConvertFrom-Json } else { $null }
$blockers = @()
if (-not $physicalUsb) { $blockers += [ordered]@{ code = 'PHYSICAL_USB_REQUIRED'; message = 'ReleaseRoot is not verified as a removable USB bus disk.' } }
if ($nodeOnPath) { $blockers += [ordered]@{ code = 'LOCAL_NODE_MUST_BE_ABSENT'; message = 'Remove/disable machine Node.js before WX-12; bundled runtime is allowed.' } }
if ($isAdmin) { $blockers += [ordered]@{ code = 'STANDARD_USER_REQUIRED'; message = 'Run as a user outside Builtin Administrators.' } }
if ($null -eq $defender -or -not $defender.AntivirusEnabled -or -not $defender.RealTimeProtectionEnabled) { $blockers += [ordered]@{ code = 'DEFENDER_REQUIRED'; message = 'Microsoft Defender antivirus and real-time protection must be enabled.' } }
if ($null -eq $policy -or [string]$policy.portableGuaranteeScope -ne 'portable-usb' -or [string]$policy.usbBusinessDataCleanup -ne 'never') { $blockers += [ordered]@{ code = 'RESIDUE_POLICY_MISMATCH'; message = 'WX-10 requires the portable USB DATA-005 policy with never-clean business data.' } }
foreach ($requiredArtifact in @(@{ path = (Join-Path $resolved 'U-Claw.exe'); code = 'LAUNCHER_MISSING' }, @{ path = $runtimePackage; code = 'RUNTIME_PACKAGE_MISSING' }, @{ path = $runtimeManifest; code = 'RUNTIME_MANIFEST_MISSING' }, @{ path = $pluginManifest; code = 'WECHAT_PLUGIN_MISSING' })) {
    if (-not (Test-Path -LiteralPath $requiredArtifact.path -PathType Leaf)) { $blockers += [ordered]@{ code = $requiredArtifact.code; message = 'Released artifact is missing; do not substitute a source checkout or npm install.' } }
}
if ($cases.Count -ne $requiredCases.Count) { $blockers += [ordered]@{ code = 'CASE_SET_INCOMPLETE'; message = 'The WX-10/WX-12 case set is incomplete.' } }
foreach ($case in $cases) { if ([string]$case.status -ne 'passed') { $blockers += [ordered]@{ code = 'CASE_BLOCKED'; message = [string]$case.caseId } } }

$result = [ordered]@{
    schemaVersion = 1; runId = [Guid]::NewGuid().ToString('D'); status = if ($blockers.Count -eq 0) { 'passed' } else { 'needs-input' }; startedAtUtc = $started.ToString('o'); completedAtUtc = [DateTime]::UtcNow.ToString('o'); machineRole = $MachineRole
    evidenceBoundary = [ordered]@{ codeOrMock = 'not-eligible'; localhost = 'not-eligible'; realWindows = 'required'; realUsb = 'required'; realGateway = 'required'; realTencentILink = 'required'; realPhone = 'required' }
    environment = [ordered]@{ osFamily = $osFamily; osCaption = [string]$os.Caption; osBuild = [string]$os.BuildNumber; architecture = [string]$os.OSArchitecture; standardUser = (-not $isAdmin); defenderAntivirusEnabled = if ($null -ne $defender) { [bool]$defender.AntivirusEnabled } else { $false }; defenderRealtimeProtectionEnabled = if ($null -ne $defender) { [bool]$defender.RealTimeProtectionEnabled } else { $false }; localNodeOnPath = $nodeOnPath; machineIdentitySha256 = (Sha256Text ([string]$env:COMPUTERNAME)) }
    device = [ordered]@{ driveLetter = $root; driveType = [string]$driveInfo.DriveType; busType = if ($null -ne $disk) { [string]$disk.BusType } else { 'unknown' }; physicalUsbVerified = $physicalUsb; deviceIdentitySha256 = (Sha256Text ([string]$root + '|' + [string]$diskDrive.SerialNumber)) }
    release = [ordered]@{ pluginManifestPresent = (Test-Path -LiteralPath $pluginManifest -PathType Leaf); pluginManifestSha256 = if (Test-Path -LiteralPath $pluginManifest -PathType Leaf) { (Get-FileHash $pluginManifest -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null } }
    cases = $cases; blockers = $blockers
}
Write-Evidence $result
if ($result.status -ne 'passed') { [Console]::Error.WriteLine('WX-10/WX-12 NEEDS_INPUT: real evidence required'); exit 2 }
