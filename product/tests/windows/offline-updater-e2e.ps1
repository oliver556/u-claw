param(
    [Parameter(Mandatory)][string]$OfflineUpdaterExe,
    [Parameter(Mandatory)][string]$FixtureExe,
    [Parameter(Mandatory)][string]$DiagnosticsPath,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9-]+$')][string]$CaseName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-True {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Code)
    if (-not $Condition) { throw $Code }
}

function Write-Utf8NoBom {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Content)
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Invoke-Process {
    param([Parameter(Mandatory)][string]$Executable, [Parameter(Mandatory)][string]$WorkingDirectory)
    $process = Start-Process -FilePath $Executable -WorkingDirectory $WorkingDirectory -PassThru
    $processHandle = $process.Handle
    try {
        if (-not $process.WaitForExit(30000)) { throw 'PROCESS_TIMEOUT' }
        return $process.ExitCode
    }
    finally {
        $process.Dispose()
    }
}

function Invoke-NodeChecked {
    param([Parameter(Mandatory)][string[]]$Arguments, [Parameter(Mandatory)][string]$Code)
    & node @Arguments
    Assert-True ($LASTEXITCODE -eq 0) $Code
}

function Write-Diagnostics {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Result)
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($DiagnosticsPath))
    [void][IO.Directory]::CreateDirectory($parent)
    $temporary = $DiagnosticsPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    Write-Utf8NoBom $temporary (($Result | ConvertTo-Json -Compress) + [Environment]::NewLine)
    [IO.File]::Move($temporary, $DiagnosticsPath)
}

function Get-SHA256 {
    param([Parameter(Mandatory)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Wait-ForMarker {
    param([Parameter(Mandatory)][string]$DataDirectory)
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        if (@(Get-ChildItem -LiteralPath $DataDirectory -Filter '.fixture-ready-*' -File -ErrorAction SilentlyContinue).Count -gt 0) { return }
        Start-Sleep -Milliseconds 100
    }
    throw 'FIXTURE_READY_TIMEOUT'
}

function Copy-TamperedPayload {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][ValidateSet('manifest', 'runtime')][string]$Section
    )
    [byte[]]$bytes = [IO.File]::ReadAllBytes($Source)
    $trailer = $bytes.Length - 16
    $manifestLength = ([int]$bytes[$trailer + 8] -shl 24) -bor ([int]$bytes[$trailer + 9] -shl 16) -bor ([int]$bytes[$trailer + 10] -shl 8) -bor [int]$bytes[$trailer + 11]
    $runtimeLength = ([int]$bytes[$trailer + 12] -shl 24) -bor ([int]$bytes[$trailer + 13] -shl 16) -bor ([int]$bytes[$trailer + 14] -shl 8) -bor [int]$bytes[$trailer + 15]
    $manifestOffset = $trailer - $manifestLength - $runtimeLength
    $offset = if ($Section -ceq 'manifest') { $manifestOffset } else { $manifestOffset + $manifestLength }
    $bytes[$offset] = $bytes[$offset] -bxor 1
    [IO.File]::WriteAllBytes($Destination, $bytes)
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$updaterBase = [IO.Path]::GetFullPath($OfflineUpdaterExe)
$fixturePath = [IO.Path]::GetFullPath($FixtureExe)
$workRoot = Join-Path $env:RUNNER_TEMP ('uclaw-offline-update-' + [Guid]::NewGuid().ToString('N'))
$buildRoot = Join-Path $workRoot 'build'
$releaseRoot = Join-Path $workRoot 'U-Claw drive'
$secondRoot = Join-Path $workRoot 'Second U-Claw drive'
$localAppData = Join-Path $workRoot 'Local App Data'
$runtimeId = 'openclaw-2026.7.1-2-win-x64'
$runtimePrivateKey = Join-Path $buildRoot 'runtime-private.pem'
$fixtureLicenseDir = Join-Path $buildRoot 'fixture-license'
$fixtureLicenseTrustedKeys = Join-Path $buildRoot 'fixture-license-trusted-keys.json'
$fixtureLauncher = Join-Path $buildRoot 'U-Claw-fixture.exe'
$packageRoot = Join-Path $releaseRoot '.uclaw'
$dataDirectory = Join-Path $packageRoot 'data'
$licenseDirectory = Join-Path $packageRoot 'license'
$licensePath = Join-Path $licenseDirectory 'license.json'
$credentialPath = Join-Path $licenseDirectory '.startup-credential.json'
$userDataPath = Join-Path $dataDirectory 'user-data.fixture'
$launcher = Join-Path $releaseRoot 'U-Claw.exe'
$transactionPath = Join-Path $packageRoot '.update-transaction.json'
$originalLocalAppData = $env:LOCALAPPDATA
$originalHeadless = $env:UCLAW_LAUNCHER_HEADLESS
$originalHold = $env:UCLAW_FIXTURE_HOLD_MS
$originalRoots = $env:UCLAW_UPDATER_CANDIDATE_ROOTS
$originalSelected = $env:UCLAW_UPDATER_SELECTED_ROOT
$originalSkipLaunch = $env:UCLAW_UPDATER_SKIP_LAUNCH
$phase = 'SETUP'
$runningProcess = $null

try {
    Assert-True (Test-Path -LiteralPath $updaterBase -PathType Leaf) 'UPDATER_MISSING'
    Assert-True (Test-Path -LiteralPath $fixturePath -PathType Leaf) 'FIXTURE_MISSING'
    [void][IO.Directory]::CreateDirectory($buildRoot)

    $buildRuntime = Join-Path $repositoryRoot 'product\packaging\build-runtime.mjs'
    $signRuntime = Join-Path $repositoryRoot 'product\tests\windows\sign-runtime-fixture.mjs'
    $buildRelease = Join-Path $repositoryRoot 'product\packaging\build-release.mjs'
    $buildFeed = Join-Path $repositoryRoot 'product\packaging\build-update-feed.mjs'
    $buildOffline = Join-Path $repositoryRoot 'product\packaging\build-offline-updater.mjs'

    foreach ($generation in @(
        @{ Name = 'v1'; Version = '1.2.3'; Sequence = '1'; Content = 'version-one' },
        @{ Name = 'v2'; Version = '1.2.4'; Sequence = '2'; Content = 'version-two' },
        @{ Name = 'v3'; Version = '1.2.5'; Sequence = '3'; Content = 'version-three' }
    )) {
        $source = Join-Path $buildRoot ($generation.Name + '-source')
        [void][IO.Directory]::CreateDirectory((Join-Path $source 'electron'))
        [void][IO.Directory]::CreateDirectory((Join-Path $source 'resources'))
        Copy-Item -LiteralPath $fixturePath -Destination (Join-Path $source 'electron\electron.exe')
        Write-Utf8NoBom (Join-Path $source 'resources\app.asar') $generation.Content
        $runtime = Join-Path $buildRoot ($generation.Name + '-runtime.pkg')
        $unsigned = Join-Path $buildRoot ($generation.Name + '-unsigned.json')
        $manifest = Join-Path $buildRoot ($generation.Name + '-manifest.json')
        $publicKey = Join-Path $buildRoot ($generation.Name + '-public.pem')
        $trustedKeys = Join-Path $buildRoot ($generation.Name + '-trusted.json')
        $manifestLines = @(& node $buildRuntime --input $source --output $runtime --product-version $generation.Version --runtime-id $runtimeId --entrypoint 'electron/electron.exe')
        Assert-True ($LASTEXITCODE -eq 0) 'BUILD_RUNTIME_FAILED'
        Write-Utf8NoBom $unsigned (($manifestLines -join [Environment]::NewLine) + [Environment]::NewLine)
        Invoke-NodeChecked @($signRuntime, '--input', $unsigned, '--output', $manifest, '--public-key', $publicKey, '--trusted-keys', $trustedKeys, '--private-key', $runtimePrivateKey, '--sequence', $generation.Sequence) 'SIGN_RUNTIME_FAILED'
        $generation.Runtime = $runtime
        $generation.Manifest = $manifest
        $generation.PublicKey = $publicKey
        $generation.TrustedKeys = $trustedKeys

        $feed = Join-Path $buildRoot ($generation.Name + '-feed')
        Invoke-NodeChecked @($buildFeed, '--runtime', $runtime, '--manifest', $manifest, '--output', $feed, '--id', ('fixture-' + $generation.Name), '--version', $generation.Version, '--notes', ('Update ' + $generation.Name), '--published', '2026-08-14T00:00:00.000Z', '--expires', '2036-08-14T00:00:00.000Z', '--sequence', $generation.Sequence, '--key-id', 'windows-fixture-runtime', '--private-key', $runtimePrivateKey, '--public-key', $publicKey, '--runtime-public-key', $publicKey) 'BUILD_FEED_FAILED'
        $offline = Join-Path $buildRoot ($generation.Name + '-offline.exe')
        Invoke-NodeChecked @($buildOffline, '--updater', $updaterBase, '--feed', (Join-Path $feed 'stable.json'), '--runtime', (Join-Path (Join-Path (Join-Path $feed 'packages') ('fixture-' + $generation.Name)) 'runtime.pkg'), '--output', $offline) 'BUILD_OFFLINE_FAILED'
        $generation.Offline = $offline
    }

    $v1 = $generation = $null
    $generations = @{}
    foreach ($name in @('v1', 'v2', 'v3')) {
        $generations[$name] = @{
            Runtime = Join-Path $buildRoot ($name + '-runtime.pkg')
            Manifest = Join-Path $buildRoot ($name + '-manifest.json')
            PublicKey = Join-Path $buildRoot ($name + '-public.pem')
            TrustedKeys = Join-Path $buildRoot ($name + '-trusted.json')
            Offline = Join-Path $buildRoot ($name + '-offline.exe')
        }
    }

    $phase = 'BUILD_FIXTURE_LAUNCHER'
    $trustedKeysJson = [IO.File]::ReadAllText($generations.v1.TrustedKeys).Trim()
    $signLicenseFixture = Join-Path $repositoryRoot 'product\tests\windows\sign-license-fixture.mjs'
    Invoke-NodeChecked @($signLicenseFixture, '--license-dir', $fixtureLicenseDir, '--trusted-keys', $fixtureLicenseTrustedKeys) 'SIGN_LICENSE_FAILED'
    $licenseKeysJson = [IO.File]::ReadAllText($fixtureLicenseTrustedKeys).Trim()
    Push-Location (Join-Path $repositoryRoot 'product\launcher')
    try {
        & go build -trimpath -tags licensefixture -ldflags "-s -w -H windowsgui -X main.trustedRuntimeKeys=$trustedKeysJson -X main.trustedStartupLicenseKeys=$licenseKeysJson -X main.trustedLicenseStatusKeys=$licenseKeysJson" -o $fixtureLauncher .
        Assert-True ($LASTEXITCODE -eq 0) 'BUILD_FIXTURE_LAUNCHER_FAILED'
    }
    finally { Pop-Location }

    $phase = 'BUILD_INITIAL_RELEASE'
    Invoke-NodeChecked @($buildRelease, '--launcher', $fixtureLauncher, '--runtime-package', $generations.v1.Runtime, '--manifest', $generations.v1.Manifest, '--public-key', $generations.v1.PublicKey, '--output', $releaseRoot) 'BUILD_INITIAL_RELEASE_FAILED'
    [void][IO.Directory]::CreateDirectory($licenseDirectory)
    Copy-Item -LiteralPath (Join-Path $fixtureLicenseDir '.startup-credential.json') -Destination $credentialPath
    Copy-Item -LiteralPath (Join-Path $fixtureLicenseDir 'license.json') -Destination $licensePath
    Copy-Item -LiteralPath (Join-Path $fixtureLicenseDir '.status-response.json') -Destination (Join-Path $licenseDirectory '.status-response.json')
    Write-Utf8NoBom $userDataPath 'preserve-this-user-data'

    $env:LOCALAPPDATA = $localAppData
    $env:UCLAW_LAUNCHER_HEADLESS = '1'
    $env:UCLAW_FIXTURE_HOLD_MS = '100'
    Assert-True ((Invoke-Process $launcher $releaseRoot) -eq 0) 'INITIAL_LICENSE_GATE_FAILED'
    $licenseBefore = Get-SHA256 $licensePath
    $credentialBefore = Get-SHA256 $credentialPath
    $userDataBefore = Get-SHA256 $userDataPath

    $phase = 'MULTIPLE_DRIVES'
    Copy-Item -LiteralPath $releaseRoot -Destination $secondRoot -Recurse
    $env:UCLAW_UPDATER_CANDIDATE_ROOTS = $releaseRoot + [IO.Path]::PathSeparator + $secondRoot
    $env:UCLAW_UPDATER_SELECTED_ROOT = $null
    $env:UCLAW_UPDATER_SKIP_LAUNCH = '1'
    $multipleDrivesRequireSelection = (Invoke-Process $generations.v2.Offline $buildRoot) -ne 0
    Assert-True $multipleDrivesRequireSelection 'MULTIPLE_DRIVES_AUTO_SELECTED'

    $phase = 'OFFLINE_UPDATE'
    $env:UCLAW_UPDATER_CANDIDATE_ROOTS = $releaseRoot
    $offlineUpdateSucceeded = (Invoke-Process $generations.v2.Offline $buildRoot) -eq 0
    Assert-True $offlineUpdateSucceeded 'OFFLINE_UPDATE_FAILED'

    $phase = 'INTERRUPTED_SWITCH_RECOVERY'
    $transaction = [IO.File]::ReadAllText($transactionPath) | ConvertFrom-Json
    $transaction.state = 'switching'
    Write-Utf8NoBom $transactionPath (($transaction | ConvertTo-Json -Depth 10 -Compress) + [Environment]::NewLine)
    $newVersionPassedFullLicenseGate = (Invoke-Process $launcher $releaseRoot) -eq 0
    $interruptedSwitchRecovered = $newVersionPassedFullLicenseGate -and -not (Test-Path -LiteralPath $transactionPath)
    Assert-True $interruptedSwitchRecovered 'INTERRUPTED_SWITCH_NOT_RECOVERED'

    $licenseUnchanged = (Get-SHA256 $licensePath) -ceq $licenseBefore
    $startupCredentialUnchanged = (Get-SHA256 $credentialPath) -ceq $credentialBefore
    $userDataUnchanged = (Get-SHA256 $userDataPath) -ceq $userDataBefore
    Assert-True $licenseUnchanged 'LICENSE_CHANGED'
    Assert-True $startupCredentialUnchanged 'STARTUP_CREDENTIAL_CHANGED'
    Assert-True $userDataUnchanged 'USER_DATA_CHANGED'

    $phase = 'TAMPERED_MANIFEST'
    $tamperedManifest = Join-Path $buildRoot 'tampered-manifest.exe'
    Copy-TamperedPayload $generations.v3.Offline $tamperedManifest 'manifest'
    $tamperedManifestRejected = (Invoke-Process $tamperedManifest $buildRoot) -ne 0
    Assert-True $tamperedManifestRejected 'TAMPERED_MANIFEST_ACCEPTED'

    $phase = 'TAMPERED_RUNTIME'
    $tamperedRuntime = Join-Path $buildRoot 'tampered-runtime.exe'
    Copy-TamperedPayload $generations.v3.Offline $tamperedRuntime 'runtime'
    $tamperedRuntimeRejected = (Invoke-Process $tamperedRuntime $buildRoot) -ne 0
    Assert-True $tamperedRuntimeRejected 'TAMPERED_RUNTIME_ACCEPTED'

    $phase = 'DOWNGRADE'
    $downgradeRejected = (Invoke-Process $generations.v1.Offline $buildRoot) -ne 0
    Assert-True $downgradeRejected 'DOWNGRADE_ACCEPTED'

    $phase = 'RUNNING_APPLICATION'
    Get-ChildItem -LiteralPath $dataDirectory -Filter '.fixture-ready-*' -File -ErrorAction SilentlyContinue | Remove-Item -Force
    $env:UCLAW_FIXTURE_HOLD_MS = '5000'
    $runningProcess = Start-Process -FilePath $launcher -WorkingDirectory $releaseRoot -PassThru
    $runningProcessHandle = $runningProcess.Handle
    Wait-ForMarker $dataDirectory
    $runningApplicationRejected = (Invoke-Process $generations.v3.Offline $buildRoot) -ne 0
    Assert-True $runningApplicationRejected 'RUNNING_APPLICATION_UPDATED'
    Assert-True ($runningProcess.WaitForExit(15000)) 'RUNNING_APPLICATION_TIMEOUT'
    Assert-True ($runningProcess.ExitCode -eq 0) 'RUNNING_APPLICATION_TERMINATED'
    $runningProcess.Dispose()
    $runningProcess = $null

    Write-Diagnostics ([ordered]@{
        schemaVersion = 1
        caseName = $CaseName
        offlineUpdateSucceeded = $offlineUpdateSucceeded
        licenseUnchanged = $licenseUnchanged
        startupCredentialUnchanged = $startupCredentialUnchanged
        userDataUnchanged = $userDataUnchanged
        tamperedManifestRejected = $tamperedManifestRejected
        tamperedRuntimeRejected = $tamperedRuntimeRejected
        downgradeRejected = $downgradeRejected
        multipleDrivesRequireSelection = $multipleDrivesRequireSelection
        runningApplicationRejected = $runningApplicationRejected
        interruptedSwitchRecovered = $interruptedSwitchRecovered
        newVersionPassedFullLicenseGate = $newVersionPassedFullLicenseGate
    })
}
catch {
    Write-Diagnostics ([ordered]@{ schemaVersion = 1; caseName = $CaseName; success = $false; phase = $phase })
    [Console]::Error.WriteLine(('OFFLINE_UPDATER_E2E_FAILED_' + $phase + ': validation failed'))
    exit 1
}
finally {
    if ($null -ne $runningProcess) {
        try { $runningProcess.Kill() } catch {}
        try { $runningProcess.Dispose() } catch {}
    }
    $env:LOCALAPPDATA = $originalLocalAppData
    $env:UCLAW_LAUNCHER_HEADLESS = $originalHeadless
    $env:UCLAW_FIXTURE_HOLD_MS = $originalHold
    $env:UCLAW_UPDATER_CANDIDATE_ROOTS = $originalRoots
    $env:UCLAW_UPDATER_SELECTED_ROOT = $originalSelected
    $env:UCLAW_UPDATER_SKIP_LAUNCH = $originalSkipLaunch
    if (Test-Path -LiteralPath $workRoot) { Remove-Item -LiteralPath $workRoot -Recurse -Force }
}
