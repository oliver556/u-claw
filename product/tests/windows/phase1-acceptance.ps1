param(
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$EvidencePath,
    [string[]]$CaseEvidencePath = @(),
    [string]$PeerEvidencePath,
    [ValidateSet('machine-a', 'machine-b')][string]$MachineRole = 'machine-a',
    [switch]$ContinuityConfirmed,
    [switch]$AllowSimulatedDrive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Sha256Text { param([string]$Text) $bytes = [Text.Encoding]::UTF8.GetBytes($Text); $sha = [Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() } }
function Write-Evidence { param($Value) $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($EvidencePath)); [void][IO.Directory]::CreateDirectory($parent); $temporary = $EvidencePath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'; [IO.File]::WriteAllText($temporary, (($Value | ConvertTo-Json -Depth 30) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false)); [IO.File]::Move($temporary, $EvidencePath) }
function New-Case { param([string]$Id, [string]$Status, [string]$Code, [string]$Message) $caseBlockers = @(); if ($Status -ne 'passed') { $caseBlockers += [ordered]@{ code = $Code; message = $Message } }; return [ordered]@{ schemaVersion = 1; caseId = $Id; status = $Status; startedAtUtc = $started.ToString('o'); completedAtUtc = [DateTime]::UtcNow.ToString('o'); assertions = @(); artifacts = @(); blockers = $caseBlockers } }

$started = [DateTime]::UtcNow
$resolvedRelease = [IO.Path]::GetFullPath($ReleaseRoot)
$root = [IO.Path]::GetPathRoot($resolvedRelease)
$driveLetter = $root.TrimEnd('\').TrimEnd(':')
$driveInfo = New-Object IO.DriveInfo($root)
$disk = $null; $diskDrive = $null
try {
    $partition = Get-Partition -DriveLetter $driveLetter -ErrorAction Stop
    $disk = $partition | Get-Disk -ErrorAction Stop
    $diskDrive = Get-CimInstance -ClassName Win32_DiskDrive | Where-Object { $_.Index -eq $disk.Number } | Select-Object -First 1
} catch {}
$busUsb = $null -ne $disk -and ([string]$disk.BusType -ceq 'USB')
$cimUsb = $null -ne $diskDrive -and (([string]$diskDrive.InterfaceType -ceq 'USB') -or ([string]$diskDrive.PNPDeviceID).StartsWith('USBSTOR\', [StringComparison]::OrdinalIgnoreCase))
$physicalUsbVerified = $driveInfo.DriveType -eq [IO.DriveType]::Removable -and $busUsb -and $cimUsb
$simulated = -not $physicalUsbVerified

$os = Get-CimInstance -ClassName Win32_OperatingSystem
$build = [int]$os.BuildNumber
$osFamily = if ($build -ge 22000) { 'windows-11' } else { 'windows-10' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$administratorSid = 'S-1-5-32-544'
$accountInAdministrators = @($identity.Groups | Where-Object { $_.Value -ceq $administratorSid }).Count -gt 0
$tokenElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$defender = $null
try { $defender = Get-MpComputerStatus -ErrorAction Stop } catch {}
$defenderEnabled = $null -ne $defender -and $defender.AntivirusEnabled -and $defender.RealTimeProtectionEnabled
$machineGuid = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid
$machineIdentitySha256 = Get-Sha256Text ([string]$machineGuid)
$deviceSource = if ($null -ne $disk -and $disk.UniqueId) { [string]$disk.UniqueId } elseif ($null -ne $diskDrive) { ([string]$diskDrive.Model + '|' + [string]$diskDrive.SerialNumber + '|' + [string]$diskDrive.Size) } else { $root }
$deviceIdentitySha256 = Get-Sha256Text $deviceSource

$cases = @()
foreach ($path in $CaseEvidencePath) {
    if (Test-Path -LiteralPath $path -PathType Leaf) { $cases += (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json) }
}
function Find-Case { param([string]$Id) return @($cases | Where-Object { $_.caseId -ceq $Id } | Select-Object -Last 1) }
foreach ($required in @('first-launch', 'second-launch', 'process-cleanup', 'usb-removal', 'host-residue')) {
    if (@(Find-Case $required).Count -eq 0) { $cases += New-Case $required 'blocked' 'CASE_EVIDENCE_MISSING' ('Missing case evidence: ' + $required) }
}
$requirementsPath = Join-Path $PSScriptRoot 'phase1-requirements.json'
$requirements = Get-Content -LiteralPath $requirementsPath -Raw | ConvertFrom-Json
foreach ($requirement in @($requirements.requirements)) {
    if (@(Find-Case ([string]$requirement.id)).Count -eq 0) {
        $cases += New-Case ([string]$requirement.id) 'blocked' 'REQUIREMENT_EVIDENCE_MISSING' ('Missing final Windows evidence for ' + [string]$requirement.id)
    }
}
$cases += New-Case 'standard-user' $(if (-not $accountInAdministrators) { 'passed' } else { 'blocked' }) 'STANDARD_USER_REQUIRED' 'Run from an account that is not a member of Builtin Administrators.'
$cases += New-Case 'defender-enabled' $(if ($defenderEnabled) { 'passed' } else { 'blocked' }) 'DEFENDER_ENABLED_REQUIRED' 'Microsoft Defender antivirus and real-time protection must be enabled.'
$cases += New-Case 'physical-usb' $(if ($physicalUsbVerified) { 'passed' } else { 'blocked' }) 'PHYSICAL_USB_REQUIRED' 'ReleaseRoot must resolve to a removable USB bus disk and Win32_DiskDrive USB identity.'

$peer = $null
if ($PeerEvidencePath -and (Test-Path -LiteralPath $PeerEvidencePath -PathType Leaf)) { $peer = Get-Content -LiteralPath $PeerEvidencePath -Raw | ConvertFrom-Json }
$differentMachine = $null -ne $peer -and $peer.environment.machineIdentitySha256 -cne $machineIdentitySha256
$sameUsb = $null -ne $peer -and $peer.device.deviceIdentitySha256 -ceq $deviceIdentitySha256
$peerRequiredCaseIds = @(
    'first-launch', 'second-launch', 'process-cleanup', 'usb-removal', 'host-residue',
    'standard-user', 'defender-enabled', 'physical-usb', 'windows-x64'
) + @($requirements.requirements | ForEach-Object { [string]$_.id })
$peerSuitePassed = $null -ne $peer
if ($peerSuitePassed) {
    foreach ($requiredPeerCaseId in $peerRequiredCaseIds) {
        $peerMatches = @($peer.cases | Where-Object { $_.caseId -ceq $requiredPeerCaseId })
        if ($peerMatches.Count -ne 1 -or $peerMatches[0].status -cne 'passed') { $peerSuitePassed = $false }
    }
}
$peerUnexpectedBlockers = @()
$peerExpectedBlockersPresent = $false
if ($null -ne $peer) {
    $allowedPeerBlockerCases = @('two-machine-continuity', 'windows-11')
    $peerUnexpectedBlockers = @($peer.blockers | Where-Object { $allowedPeerBlockerCases -notcontains $_.caseId })
    $peerExpectedBlockersPresent = @($peer.blockers | Where-Object { $_.caseId -ceq 'two-machine-continuity' }).Count -eq 1 -and @($peer.blockers | Where-Object { $_.caseId -ceq 'windows-11' }).Count -eq 1
}
$peerArtifactKinds = if ($null -ne $peer) { @($peer.artifacts | ForEach-Object { [string]$_.kind }) } else { @() }
$peerArtifactsComplete = @(@('launcher', 'runtime-package', 'runtime-manifest') | Where-Object { $peerArtifactKinds -notcontains $_ }).Count -eq 0
$peerEligible = $null -ne $peer -and $peer.status -ceq 'blocked' -and $peer.environment.machineRole -ceq 'machine-a' -and $peer.device.physicalUsbVerified -and $peer.environment.standardUser -and $peer.environment.defenderAntivirusEnabled -and $peer.environment.defenderRealtimeProtectionEnabled -and $peerSuitePassed -and $peerUnexpectedBlockers.Count -eq 0 -and $peerExpectedBlockersPresent -and $peerArtifactsComplete
$twoMachine = $MachineRole -eq 'machine-b' -and $differentMachine -and $sameUsb -and $peerEligible -and $ContinuityConfirmed
$cases += New-Case 'two-machine-continuity' $(if ($twoMachine) { 'passed' } else { 'blocked' }) 'TWO_MACHINE_EVIDENCE_REQUIRED' 'Machine B must supply Machine A evidence from the same physical USB on a different host.'
$hasWin10 = $osFamily -eq 'windows-10' -or ($null -ne $peer -and $peer.environment.osFamily -eq 'windows-10')
$hasWin11 = $osFamily -eq 'windows-11' -or ($null -ne $peer -and $peer.environment.osFamily -eq 'windows-11')
$cases += New-Case 'windows-10' $(if ($hasWin10) { 'passed' } else { 'blocked' }) 'WINDOWS_10_EVIDENCE_REQUIRED' 'A real Windows 10 x64 report is required.'
$cases += New-Case 'windows-11' $(if ($hasWin11) { 'passed' } else { 'blocked' }) 'WINDOWS_11_EVIDENCE_REQUIRED' 'A real Windows 11 x64 report is required.'
$currentX64 = ([string]$os.OSArchitecture).IndexOf('64', [StringComparison]::OrdinalIgnoreCase) -ge 0
$peerX64 = $null -ne $peer -and ([string]$peer.environment.architecture).IndexOf('64', [StringComparison]::OrdinalIgnoreCase) -ge 0
$cases += New-Case 'windows-x64' $(if ($currentX64 -and ($null -eq $peer -or $peerX64)) { 'passed' } else { 'blocked' }) 'WINDOWS_X64_REQUIRED' 'Each supplied Windows machine must use x64 architecture.'

$artifacts = @()
$missingArtifacts = @()
foreach ($candidate in @(
    @{ Path = (Join-Path $resolvedRelease 'U-Claw.exe'); Kind = 'launcher' },
    @{ Path = (Join-Path $resolvedRelease '.uclaw\runtime.pkg'); Kind = 'runtime-package' },
    @{ Path = (Join-Path $resolvedRelease '.uclaw\version.json'); Kind = 'runtime-manifest' }
)) {
    if (Test-Path -LiteralPath $candidate.Path -PathType Leaf) {
        $item = Get-Item -LiteralPath $candidate.Path
        $artifacts += [ordered]@{ kind = $candidate.Kind; name = $item.Name; bytes = $item.Length; sha256 = (Get-FileHash -LiteralPath $candidate.Path -Algorithm SHA256).Hash.ToLowerInvariant() }
    } else {
        $missingArtifacts += [string]$candidate.Kind
    }
}
$cases += New-Case 'release-artifacts' $(if ($missingArtifacts.Count -eq 0) { 'passed' } else { 'blocked' }) 'RELEASE_ARTIFACT_MISSING' ('Missing release artifacts: ' + ($missingArtifacts -join ', '))
$blockers = @()
foreach ($case in $cases) { if ($case.status -ne 'passed') { foreach ($blocker in @($case.blockers)) { $blockers += [ordered]@{ caseId = [string]$case.caseId; code = [string]$blocker.code; message = [string]$blocker.message } } } }
if ($simulated -and $AllowSimulatedDrive) { $blockers += [ordered]@{ caseId = 'physical-usb'; code = 'SIMULATED_DRIVE_NOT_ACCEPTANCE_EVIDENCE'; message = 'AllowSimulatedDrive permits CI collection only and can never pass the physical USB gate.' } }
$status = if ($blockers.Count -eq 0) { 'passed' } else { 'blocked' }
$result = [ordered]@{
    schemaVersion = 1; runId = [Guid]::NewGuid().ToString('D'); startedAtUtc = $started.ToString('o'); completedAtUtc = [DateTime]::UtcNow.ToString('o'); status = $status
    environment = [ordered]@{ osFamily = $osFamily; osCaption = [string]$os.Caption; osBuild = [string]$os.BuildNumber; architecture = [string]$os.OSArchitecture; accountInAdministrators = $accountInAdministrators; tokenElevated = $tokenElevated; standardUser = (-not $accountInAdministrators); defenderAntivirusEnabled = if ($null -ne $defender) { [bool]$defender.AntivirusEnabled } else { $false }; defenderRealtimeProtectionEnabled = if ($null -ne $defender) { [bool]$defender.RealTimeProtectionEnabled } else { $false }; machineIdentitySha256 = $machineIdentitySha256; machineRole = $MachineRole }
    device = [ordered]@{ driveLetter = $root; driveType = [string]$driveInfo.DriveType; busType = if ($null -ne $disk) { [string]$disk.BusType } else { 'unknown' }; model = if ($null -ne $diskDrive) { [string]$diskDrive.Model } else { 'unknown' }; deviceIdentitySha256 = $deviceIdentitySha256; physicalUsbVerified = $physicalUsbVerified; simulatedEvidence = $simulated }
    artifacts = $artifacts; cases = $cases; blockers = $blockers
}
Write-Evidence $result
if ($status -ne 'passed') { [Console]::Error.WriteLine('P1_T23_BLOCKED: see machine-readable evidence'); exit 2 }
