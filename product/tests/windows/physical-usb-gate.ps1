param(
    [Parameter(Mandatory)][ValidateSet('Prepare', 'Record', 'FinalizeHost', 'Aggregate')][string]$Action,
    [string]$ReleaseRoot,
    [string]$EvidenceRoot,
    [ValidateSet('recommended', 'low-speed')][string]$UsbClass,
    [string]$RunPath,
    [string]$CaseId,
    [ValidateSet('passed', 'failed', 'blocked')][string]$Outcome,
    [string]$Note,
    [string[]]$AttachmentPath = @(),
    [string[]]$HostEvidencePath = @(),
    [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Require-Value {
    param([string]$Value, [string]$Name)
    if ([string]::IsNullOrWhiteSpace($Value)) { throw ($Name + '_REQUIRED') }
}

function Write-Json {
    param([string]$Path, $Value)
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))
    [void][IO.Directory]::CreateDirectory($parent)
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temporary, (($Value | ConvertTo-Json -Depth 40) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Read-Json {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw ('JSON_FILE_MISSING: ' + $Path) }
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Get-Sha256Text {
    param([string]$Text)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

function Assert-NoSecretLikeText {
    param([string]$Text, [string]$Source)
    $secretPattern = '(?i)(authorization\s*:|bearer\s+[A-Za-z0-9._-]{12,}|device.?token|startup.?secret|provider.?key|api[_-]?key\s*[:=]|activation.?code\s*[:=]|BEGIN [A-Z ]*PRIVATE KEY)'
    if ($Text -match $secretPattern) { throw ('POTENTIAL_SECRET_IN_EVIDENCE: ' + $Source) }
}

function Get-PhysicalUsb {
    param([string]$Root)
    $driveRoot = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Root))
    $driveLetter = $driveRoot.TrimEnd('\').TrimEnd(':')
    $drive = [IO.DriveInfo]::new($driveRoot)
    $partition = Get-Partition -DriveLetter $driveLetter -ErrorAction Stop
    $disk = $partition | Get-Disk -ErrorAction Stop
    $diskDrive = Get-CimInstance -ClassName Win32_DiskDrive |
        Where-Object { $_.Index -eq $disk.Number } |
        Select-Object -First 1
    $cimUsb = $null -ne $diskDrive -and (
        [string]$diskDrive.InterfaceType -ceq 'USB' -or
        [string]$diskDrive.PNPDeviceID -like 'USBSTOR\*'
    )
    $verified = $drive.DriveType -eq [IO.DriveType]::Removable -and [string]$disk.BusType -ceq 'USB' -and $cimUsb
    $identitySource = [string]$disk.UniqueId
    if ([string]::IsNullOrWhiteSpace($identitySource) -and $null -ne $diskDrive) {
        $identitySource = [string]$diskDrive.Model + '|' + [string]$diskDrive.SerialNumber + '|' + [string]$diskDrive.Size
    }
    return [ordered]@{
        verified = $verified
        driveType = [string]$drive.DriveType
        busType = [string]$disk.BusType
        identitySha256 = Get-Sha256Text $identitySource
    }
}

function Get-ReleaseArtifacts {
    param([string]$Root)
    $resolved = [IO.Path]::GetFullPath($Root)
    $candidates = @(
        @{ kind = 'launcher'; path = (Join-Path $resolved 'U-Claw.exe') },
        @{ kind = 'runtime-package'; path = (Join-Path $resolved '.uclaw\runtime.pkg') },
        @{ kind = 'runtime-manifest'; path = (Join-Path $resolved '.uclaw\version.json') }
    )
    $artifacts = @()
    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate.path -PathType Leaf)) { throw ('RELEASE_ARTIFACT_MISSING: ' + $candidate.kind) }
        $item = Get-Item -LiteralPath $candidate.path
        $artifacts += [ordered]@{
            kind = $candidate.kind
            bytes = [long]$item.Length
            sha256 = (Get-FileHash -LiteralPath $candidate.path -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    return $artifacts
}

function Invoke-Prepare {
    Require-Value $ReleaseRoot 'RELEASE_ROOT'
    Require-Value $EvidenceRoot 'EVIDENCE_ROOT'
    Require-Value $UsbClass 'USB_CLASS'
    $resolvedRelease = [IO.Path]::GetFullPath($ReleaseRoot)
    $matrix = Read-Json (Join-Path $PSScriptRoot 'physical-usb-gate.matrix.json')
    $os = Get-CimInstance -ClassName Win32_OperatingSystem
    $build = [int]$os.BuildNumber
    $osFamily = if ($build -ge 22000) { 'windows-11' } else { 'windows-10' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $administratorSid = 'S-1-5-32-544'
    $accountInAdministrators = @($identity.Groups | Where-Object { $_.Value -ceq $administratorSid }).Count -gt 0
    $tokenElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $defender = $null
    try { $defender = Get-MpComputerStatus -ErrorAction Stop } catch {}
    $defenderEnabled = $null -ne $defender -and [bool]$defender.AntivirusEnabled -and [bool]$defender.RealTimeProtectionEnabled
    $nodeAbsent = $null -eq (Get-Command node -ErrorAction SilentlyContinue)
    $usb = Get-PhysicalUsb $resolvedRelease
    $machineGuid = [string](Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid
    $runId = [Guid]::NewGuid().ToString('D')
    $directory = Join-Path ([IO.Path]::GetFullPath($EvidenceRoot)) $runId
    [void][IO.Directory]::CreateDirectory($directory)
    $cases = @($matrix.cases | ForEach-Object {
        [ordered]@{
            id = [string]$_.id
            category = [string]$_.category
            title = [string]$_.title
            passCriterion = [string]$_.pass
            status = 'pending'
            note = ''
            recordedAtUtc = $null
            attachments = @()
        }
    })
    $manifest = Read-Json (Join-Path $resolvedRelease '.uclaw\version.json')
    $run = [ordered]@{
        schemaVersion = 1
        runId = $runId
        createdAtUtc = [DateTime]::UtcNow.ToString('o')
        release = [ordered]@{
            releaseId = [string]$manifest.releaseId
            releaseSequence = [long]$manifest.releaseSequence
            artifacts = @(Get-ReleaseArtifacts $resolvedRelease)
        }
        environment = [ordered]@{
            osFamily = $osFamily
            osCaption = [string]$os.Caption
            osBuild = [string]$os.BuildNumber
            architecture = [string]$os.OSArchitecture
            standardUser = (-not $accountInAdministrators)
            tokenElevated = $tokenElevated
            defenderEnabled = $defenderEnabled
            nodeAbsent = $nodeAbsent
            physicalUsb = [bool]$usb.verified
            usbClass = $UsbClass
            machineIdentitySha256 = Get-Sha256Text $machineGuid
            usbIdentitySha256 = [string]$usb.identitySha256
            driveType = [string]$usb.driveType
            busType = [string]$usb.busType
        }
        cases = $cases
    }
    Write-Json (Join-Path $directory 'run.json') $run
    Write-Output $directory
}

function Invoke-Record {
    Require-Value $RunPath 'RUN_PATH'
    Require-Value $CaseId 'CASE_ID'
    Require-Value $Outcome 'OUTCOME'
    Require-Value $Note 'NOTE'
    if ($AttachmentPath.Count -eq 0) { throw 'ATTACHMENT_REQUIRED' }
    Assert-NoSecretLikeText $Note 'note'
    $runFile = Join-Path ([IO.Path]::GetFullPath($RunPath)) 'run.json'
    $run = Read-Json $runFile
    $matches = @($run.cases | Where-Object { [string]$_.id -ceq $CaseId })
    if ($matches.Count -ne 1) { throw ('UNKNOWN_CASE_ID: ' + $CaseId) }
    $case = $matches[0]
    $attachmentRoot = Join-Path ([IO.Path]::GetFullPath($RunPath)) (Join-Path 'attachments' $CaseId)
    [void][IO.Directory]::CreateDirectory($attachmentRoot)
    $records = @()
    foreach ($source in $AttachmentPath) {
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw ('ATTACHMENT_MISSING: ' + $source) }
        $extension = [IO.Path]::GetExtension($source).ToLowerInvariant()
        if ($extension -in @('.txt', '.log', '.json', '.md', '.csv')) {
            Assert-NoSecretLikeText ([IO.File]::ReadAllText([IO.Path]::GetFullPath($source))) $source
        }
        $safeName = ([IO.Path]::GetFileName($source) -replace '[^A-Za-z0-9._-]', '_')
        $destination = Join-Path $attachmentRoot (([Guid]::NewGuid().ToString('N')) + '-' + $safeName)
        Copy-Item -LiteralPath $source -Destination $destination
        $item = Get-Item -LiteralPath $destination
        $resolvedRunRoot = [IO.Path]::GetFullPath($RunPath).TrimEnd('\') + '\'
        $records += [ordered]@{
            relativePath = $destination.Substring($resolvedRunRoot.Length).Replace('\', '/')
            bytes = [long]$item.Length
            sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $case.status = $Outcome
    $case.note = $Note
    $case.recordedAtUtc = [DateTime]::UtcNow.ToString('o')
    $case.attachments = $records
    Write-Json $runFile $run
}

function Invoke-FinalizeHost {
    Require-Value $RunPath 'RUN_PATH'
    $resolvedRun = [IO.Path]::GetFullPath($RunPath)
    $run = Read-Json (Join-Path $resolvedRun 'run.json')
    $environmentFailures = @()
    if ([string]$run.environment.osFamily -notin @('windows-10', 'windows-11')) { $environmentFailures += 'WINDOWS_10_OR_11_REQUIRED' }
    if ([string]$run.environment.architecture -notmatch '64') { $environmentFailures += 'WINDOWS_X64_REQUIRED' }
    if (-not [bool]$run.environment.standardUser -or [bool]$run.environment.tokenElevated) { $environmentFailures += 'NON_ADMIN_STANDARD_USER_REQUIRED' }
    if (-not [bool]$run.environment.defenderEnabled) { $environmentFailures += 'DEFENDER_REQUIRED' }
    if (-not [bool]$run.environment.nodeAbsent) { $environmentFailures += 'HOST_NODE_MUST_BE_ABSENT' }
    if (-not [bool]$run.environment.physicalUsb) { $environmentFailures += 'PHYSICAL_USB_REQUIRED' }
    $caseFailures = @($run.cases | Where-Object { [string]$_.status -cne 'passed' } | ForEach-Object { [string]$_.id + ':' + [string]$_.status })
    $missingAttachments = @($run.cases | Where-Object { @($_.attachments).Count -eq 0 } | ForEach-Object { [string]$_.id })
    $blocked = $environmentFailures.Count -gt 0 -or $caseFailures.Count -gt 0 -or $missingAttachments.Count -gt 0
    $final = [ordered]@{
        schemaVersion = 1
        status = if ($blocked) { 'blocked' } else { 'passed' }
        finalizedAtUtc = [DateTime]::UtcNow.ToString('o')
        blockers = @($environmentFailures + $caseFailures + ($missingAttachments | ForEach-Object { 'ATTACHMENT_MISSING:' + $_ }))
        run = $run
    }
    $path = Join-Path $resolvedRun 'host-final.json'
    Write-Json $path $final
    Write-Output $path
    if ($blocked) { exit 2 }
}

function Invoke-Aggregate {
    Require-Value $OutputPath 'OUTPUT_PATH'
    if ($HostEvidencePath.Count -eq 0) { throw 'HOST_EVIDENCE_PATH_REQUIRED' }
    $matrix = Read-Json (Join-Path $PSScriptRoot 'physical-usb-gate.matrix.json')
    $hosts = @($HostEvidencePath | ForEach-Object { Read-Json $_ })
    $blockers = @()
    foreach ($host in $hosts) {
        if ([string]$host.status -cne 'passed') { $blockers += ('HOST_NOT_PASSED:' + [string]$host.run.runId) }
    }
    foreach ($required in @($matrix.requiredHostMatrix)) {
        $matches = @($hosts | Where-Object {
            [string]$_.run.environment.osFamily -ceq [string]$required.osFamily -and
            [string]$_.run.environment.usbClass -ceq [string]$required.usbClass
        })
        if ($matches.Count -eq 0) { $blockers += ('HOST_MATRIX_MISSING:' + [string]$required.osFamily + ':' + [string]$required.usbClass) }
    }
    $fingerprints = @($hosts | ForEach-Object {
        (@($_.run.release.artifacts | Sort-Object kind | ForEach-Object { [string]$_.kind + ':' + [string]$_.bytes + ':' + [string]$_.sha256 }) -join '|')
    } | Select-Object -Unique)
    if ($fingerprints.Count -ne 1) { $blockers += 'RELEASE_ARTIFACTS_DIFFER_ACROSS_HOSTS' }
    $releaseIdentities = @($hosts | ForEach-Object { [string]$_.run.release.releaseId + ':' + [string]$_.run.release.releaseSequence } | Select-Object -Unique)
    if ($releaseIdentities.Count -ne 1) { $blockers += 'RELEASE_IDENTITY_DIFFERS_ACROSS_HOSTS' }
    $aggregate = [ordered]@{
        schemaVersion = 1
        status = if ($blockers.Count -eq 0) { 'passed' } else { 'blocked' }
        finalizedAtUtc = [DateTime]::UtcNow.ToString('o')
        releaseIdentity = if ($releaseIdentities.Count -eq 1) { $releaseIdentities[0] } else { $null }
        hostRunIds = @($hosts | ForEach-Object { [string]$_.run.runId })
        blockers = $blockers
    }
    Write-Json ([IO.Path]::GetFullPath($OutputPath)) $aggregate
    if ($blockers.Count -gt 0) { exit 2 }
}

switch ($Action) {
    'Prepare' { Invoke-Prepare }
    'Record' { Invoke-Record }
    'FinalizeHost' { Invoke-FinalizeHost }
    'Aggregate' { Invoke-Aggregate }
}
