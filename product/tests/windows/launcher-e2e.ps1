param(
    [Parameter(Mandatory)][string]$LauncherExe,
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

function Invoke-Launcher {
    param([Parameter(Mandatory)][string]$Executable, [Parameter(Mandatory)][string]$WorkingDirectory)
    $process = Start-Process -FilePath $Executable -WorkingDirectory $WorkingDirectory -PassThru
    $processHandle = $process.Handle
    try {
        if (-not $process.WaitForExit(30000)) {
            & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $process.Id /T /F *> $null
            try { [void]$process.WaitForExit(5000) } catch {}
            throw 'LAUNCHER_TIMEOUT'
        }
        return $process.ExitCode
    }
    finally {
        $process.Dispose()
    }
}

function Wait-ForFixtureMarker {
    param([Parameter(Mandatory)][string]$DataDirectory)
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        $markers = @(Get-ChildItem -LiteralPath $DataDirectory -Filter '.fixture-ready-*' -File -ErrorAction SilentlyContinue)
        if ($markers.Count -gt 0) { return }
        Start-Sleep -Milliseconds 100
    }
    throw 'FIXTURE_READY_TIMEOUT'
}

function Write-Diagnostics {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Result)
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($DiagnosticsPath))
    [void][IO.Directory]::CreateDirectory($parent)
    $temporary = $DiagnosticsPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    Write-Utf8NoBom $temporary (($Result | ConvertTo-Json -Compress) + [Environment]::NewLine)
    [IO.File]::Move($temporary, $DiagnosticsPath)
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$launcherPath = [IO.Path]::GetFullPath($LauncherExe)
$fixturePath = [IO.Path]::GetFullPath($FixtureExe)
$workRoot = Join-Path $env:RUNNER_TEMP ('uclaw-portable-' + [Guid]::NewGuid().ToString('N'))
$buildRoot = Join-Path $workRoot 'build'
$runtimeSource = Join-Path $buildRoot 'runtime source'
$runtimePackage = Join-Path $buildRoot 'runtime.pkg'
$unsignedManifestPath = Join-Path $buildRoot 'version.unsigned.json'
$manifestPath = Join-Path $buildRoot 'version.json'
$fixturePublicKey = Join-Path $buildRoot 'fixture-public.pem'
$fixtureTrustedKeys = Join-Path $buildRoot 'fixture-trusted-keys.json'
$fixtureLicenseDir = Join-Path $buildRoot 'fixture-license'
$fixtureLicenseTrustedKeys = Join-Path $buildRoot 'fixture-license-trusted-keys.json'
$fixtureLauncher = Join-Path $buildRoot 'U-Claw-fixture.exe'
$unicodePrefix = ([string][char]0x4E2D) + ([string][char]0x6587)
$releaseRoot = Join-Path $workRoot ($unicodePrefix + ' U disk')
$localAppData = Join-Path $workRoot 'Local App Data'
$runtimeId = 'openclaw-2026.7.1-2-win-x64'
$cachePath = $null
$cacheMarker = $null
$launcher = Join-Path $releaseRoot 'U-Claw.exe'
$packageRoot = Join-Path $releaseRoot '.uclaw'
$dataDirectory = Join-Path $packageRoot 'data'
$runtimePackageInRelease = Join-Path $packageRoot 'runtime.pkg'
$versionInRelease = Join-Path $packageRoot 'version.json'
$licenseDirectory = Join-Path $packageRoot 'license'
$startupCredentialInRelease = Join-Path $licenseDirectory '.startup-credential.json'
$licenseInRelease = Join-Path $licenseDirectory 'license.json'
$licenseStatusInRelease = Join-Path $licenseDirectory '.status-response.json'
$originalLocalAppData = $env:LOCALAPPDATA
$originalHeadless = $env:UCLAW_LAUNCHER_HEADLESS
$originalHold = $env:UCLAW_FIXTURE_HOLD_MS
$phase = 'SETUP'
$firstProcess = $null

try {
    Assert-True (Test-Path -LiteralPath $launcherPath -PathType Leaf) 'LAUNCHER_MISSING'
    Assert-True (Test-Path -LiteralPath $fixturePath -PathType Leaf) 'FIXTURE_MISSING'
    [void][IO.Directory]::CreateDirectory((Join-Path $runtimeSource 'electron'))
    [void][IO.Directory]::CreateDirectory((Join-Path $runtimeSource 'resources'))
    Copy-Item -LiteralPath $fixturePath -Destination (Join-Path $runtimeSource 'electron\electron.exe')
    Write-Utf8NoBom (Join-Path $runtimeSource 'resources\app.asar') 'fixture'

    $phase = 'BUILD_RUNTIME'
    $buildRuntime = Join-Path $repositoryRoot 'product\packaging\build-runtime.mjs'
    $manifestLines = @(& node $buildRuntime `
        --input $runtimeSource `
        --output $runtimePackage `
        --product-version '0.1.0' `
        --release-id 'release-1' `
        --release-sequence '1' `
        --runtime-id $runtimeId `
        --test-fixture-runtime `
        --entrypoint 'electron/electron.exe')
    Assert-True ($LASTEXITCODE -eq 0) 'BUILD_RUNTIME_FAILED'
    Write-Utf8NoBom $unsignedManifestPath (($manifestLines -join [Environment]::NewLine) + [Environment]::NewLine)

    $phase = 'SIGN_RUNTIME_FIXTURE'
    $signFixture = Join-Path $repositoryRoot 'product\tests\windows\sign-runtime-fixture.mjs'
    & node $signFixture `
        --input $unsignedManifestPath `
        --output $manifestPath `
        --public-key $fixturePublicKey `
        --trusted-keys $fixtureTrustedKeys
    Assert-True ($LASTEXITCODE -eq 0) 'SIGN_RUNTIME_FIXTURE_FAILED'
    $signedManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $runtimeInstallName = ([string]$signedManifest.releaseSequence + '-' + [string]$signedManifest.runtimeTreeSha256).ToLowerInvariant()
    $cachePath = Join-Path (Join-Path (Join-Path $localAppData 'U-Claw') 'runtimes') $runtimeInstallName
    $cacheMarker = Join-Path $cachePath '.uclaw-runtime.json'
    $trustedKeysJson = [IO.File]::ReadAllText($fixtureTrustedKeys).Trim()
    $signLicenseFixture = Join-Path $repositoryRoot 'product\tests\windows\sign-license-fixture.mjs'
    & node $signLicenseFixture `
        --license-dir $fixtureLicenseDir `
        --trusted-keys $fixtureLicenseTrustedKeys
    Assert-True ($LASTEXITCODE -eq 0) 'SIGN_LICENSE_FIXTURE_FAILED'
    $licenseTrustedKeysJson = [IO.File]::ReadAllText($fixtureLicenseTrustedKeys).Trim()
    $licenseStatusTrustedKeysJson = $licenseTrustedKeysJson
    Push-Location (Join-Path $repositoryRoot 'product\launcher')
    try {
        & go build -trimpath -tags licensefixture -ldflags "-s -w -H windowsgui -X main.trustedRuntimeKeys=$trustedKeysJson -X main.trustedStartupLicenseKeys=$licenseTrustedKeysJson -X main.trustedLicenseStatusKeys=$licenseStatusTrustedKeysJson" -o $fixtureLauncher .
        Assert-True ($LASTEXITCODE -eq 0) 'BUILD_SIGNED_FIXTURE_LAUNCHER_FAILED'
    }
    finally {
        Pop-Location
    }

    $phase = 'BUILD_RELEASE'
    $buildRelease = Join-Path $repositoryRoot 'product\packaging\build-release.mjs'
    & node $buildRelease `
        --launcher $fixtureLauncher `
        --runtime-package $runtimePackage `
        --manifest $manifestPath `
        --public-key $fixturePublicKey `
        --test-fixture-launcher `
        --output $releaseRoot
    Assert-True ($LASTEXITCODE -eq 0) 'BUILD_RELEASE_FAILED'
    [void][IO.Directory]::CreateDirectory($licenseDirectory)
    Copy-Item -LiteralPath (Join-Path $fixtureLicenseDir '.startup-credential.json') -Destination $startupCredentialInRelease
    Copy-Item -LiteralPath (Join-Path $fixtureLicenseDir 'license.json') -Destination $licenseInRelease
    Copy-Item -LiteralPath (Join-Path $fixtureLicenseDir '.status-response.json') -Destination $licenseStatusInRelease

    $env:LOCALAPPDATA = $localAppData
    $env:UCLAW_LAUNCHER_HEADLESS = '1'
    $env:UCLAW_FIXTURE_HOLD_MS = '100'

    $phase = 'MISSING_STARTUP_CREDENTIAL'
    $credentialOriginal = [IO.File]::ReadAllBytes($startupCredentialInRelease)
    Remove-Item -LiteralPath $startupCredentialInRelease -Force
    $missingStartupCredentialRejected = (Invoke-Launcher $launcher $releaseRoot) -ne 0 -and -not (Test-Path -LiteralPath $cacheMarker)
    Assert-True $missingStartupCredentialRejected 'MISSING_STARTUP_CREDENTIAL_ACCEPTED'
    [IO.File]::WriteAllBytes($startupCredentialInRelease, $credentialOriginal)

    $phase = 'MISSING_LICENSE'
    $licenseOriginal = [IO.File]::ReadAllText($licenseInRelease)
    Remove-Item -LiteralPath $licenseInRelease -Force
    $missingLicenseRejected = (Invoke-Launcher $launcher $releaseRoot) -ne 0 -and -not (Test-Path -LiteralPath $cacheMarker)
    Assert-True $missingLicenseRejected 'MISSING_LICENSE_ACCEPTED'
    Write-Utf8NoBom $licenseInRelease $licenseOriginal

    $phase = 'TAMPERED_LICENSE'
    $tamperedLicense = $licenseOriginal.Replace('dev_windows_fixture_001', 'dev_windows_fixture_002')
    Write-Utf8NoBom $licenseInRelease $tamperedLicense
    $tamperedLicenseRejected = (Invoke-Launcher $launcher $releaseRoot) -ne 0 -and -not (Test-Path -LiteralPath $cacheMarker)
    Assert-True $tamperedLicenseRejected 'TAMPERED_LICENSE_ACCEPTED'
    Write-Utf8NoBom $licenseInRelease $licenseOriginal

    $phase = 'FIRST_LAUNCH'
    $firstLaunch = (Invoke-Launcher $launcher $releaseRoot) -eq 0
    Assert-True $firstLaunch 'FIRST_LAUNCH_FAILED'
    Assert-True (Test-Path -LiteralPath $cacheMarker -PathType Leaf) 'CACHE_MARKER_MISSING'
    $firstMarkerHash = (Get-FileHash -LiteralPath $cacheMarker -Algorithm SHA256).Hash
    $firstMarkerTime = (Get-Item -LiteralPath $cacheMarker).LastWriteTimeUtc

    $phase = 'SECOND_LAUNCH'
    $secondExit = Invoke-Launcher $launcher $releaseRoot
    $secondMarkerHash = (Get-FileHash -LiteralPath $cacheMarker -Algorithm SHA256).Hash
    $secondMarkerTime = (Get-Item -LiteralPath $cacheMarker).LastWriteTimeUtc
    $secondLaunchReused = $secondExit -eq 0 -and `
        $secondMarkerHash -ceq $firstMarkerHash -and `
        $secondMarkerTime -eq $firstMarkerTime
    Assert-True $secondLaunchReused 'SECOND_LAUNCH_REEXTRACTED'

    $manifestOriginal = [IO.File]::ReadAllText($versionInRelease)
    $packageOriginal = [IO.File]::ReadAllBytes($runtimePackageInRelease)

    $phase = 'INVALID_HASH'
    $invalidManifest = $manifestOriginal | ConvertFrom-Json
    $invalidManifest.runtimeSha256 = '0' * 64
    Write-Utf8NoBom $versionInRelease (($invalidManifest | ConvertTo-Json -Depth 10) + [Environment]::NewLine)
    $invalidHashRejected = (Invoke-Launcher $launcher $releaseRoot) -ne 0
    Assert-True $invalidHashRejected 'INVALID_HASH_ACCEPTED'
    Write-Utf8NoBom $versionInRelease $manifestOriginal

    $phase = 'TRUNCATED_PACKAGE'
    $truncatedLength = [Math]::Max(1, [Math]::Floor($packageOriginal.Length / 2))
    [byte[]]$truncated = $packageOriginal[0..($truncatedLength - 1)]
    [IO.File]::WriteAllBytes($runtimePackageInRelease, $truncated)
    $truncatedPackageIgnoredOnWarm = (Invoke-Launcher $launcher $releaseRoot) -eq 0
    Assert-True $truncatedPackageIgnoredOnWarm 'WARM_START_READ_RUNTIME_PACKAGE'
    [IO.File]::WriteAllBytes($runtimePackageInRelease, $packageOriginal)

    $phase = 'PARTIAL_CACHE'
    $partialPath = Join-Path ([IO.Path]::GetDirectoryName($cachePath)) ($runtimeInstallName + '.partial-interrupted')
    [void][IO.Directory]::CreateDirectory($partialPath)
    Write-Utf8NoBom (Join-Path $partialPath '.uclaw-runtime.json') '{}'
    $partialExit = Invoke-Launcher $launcher $releaseRoot
    $partialCacheIgnored = $partialExit -eq 0 -and (Test-Path -LiteralPath $partialPath)
    Assert-True $partialCacheIgnored 'PARTIAL_CACHE_REUSED_OR_DELETED'

    $phase = 'DUPLICATE_LAUNCH'
    Get-ChildItem -LiteralPath $dataDirectory -Filter '.fixture-ready-*' -File -ErrorAction SilentlyContinue |
        Remove-Item -Force
    $env:UCLAW_FIXTURE_HOLD_MS = '5000'
    $firstProcess = Start-Process -FilePath $launcher -WorkingDirectory $releaseRoot -PassThru
    $firstProcessHandle = $firstProcess.Handle
    Wait-ForFixtureMarker $dataDirectory
    $duplicateLaunchRejected = (Invoke-Launcher $launcher $releaseRoot) -ne 0
    Assert-True $duplicateLaunchRejected 'DUPLICATE_LAUNCH_ACCEPTED'
    Assert-True ($firstProcess.WaitForExit(15000)) 'FIRST_DUPLICATE_PROCESS_TIMEOUT'
    Assert-True ($firstProcess.ExitCode -eq 0) 'FIRST_DUPLICATE_PROCESS_FAILED'
    $firstProcess.Dispose()
    $firstProcess = $null

    $phase = 'DATA_BOUNDARY'
    $usbMarkers = @(Get-ChildItem -LiteralPath $dataDirectory -Filter '.fixture-ready-*' -File)
    $cacheMarkers = @(Get-ChildItem -LiteralPath $localAppData -Filter '.fixture-ready-*' -File -Recurse -ErrorAction SilentlyContinue)
    $dataStayedOnUSB = $usbMarkers.Count -gt 0 -and $cacheMarkers.Count -eq 0
    Assert-True $dataStayedOnUSB 'DATA_LEFT_USB'
    $unicodeSpacePath = $releaseRoot.Contains(' ') -and $releaseRoot.Contains($unicodePrefix)
    Assert-True $unicodeSpacePath 'UNICODE_SPACE_PATH_NOT_USED'

    $results = [ordered]@{
        schemaVersion = 1
        caseName = $CaseName
        firstLaunch = $firstLaunch
        secondLaunchReused = $secondLaunchReused
        invalidHashRejected = $invalidHashRejected
        truncatedPackageIgnoredOnWarm = $truncatedPackageIgnoredOnWarm
        partialCacheIgnored = $partialCacheIgnored
        unicodeSpacePath = $unicodeSpacePath
        duplicateLaunchRejected = $duplicateLaunchRejected
        dataStayedOnUSB = $dataStayedOnUSB
        missingStartupCredentialRejected = $missingStartupCredentialRejected
        missingLicenseRejected = $missingLicenseRejected
        tamperedLicenseRejected = $tamperedLicenseRejected
    }
    Write-Diagnostics $results
}
catch {
    $failure = [ordered]@{
        schemaVersion = 1
        caseName = $CaseName
        success = $false
        phase = $phase
    }
    Write-Diagnostics $failure
    [Console]::Error.WriteLine(('PORTABLE_LAUNCHER_E2E_FAILED_' + $phase + ': validation failed'))
    exit 1
}
finally {
    if ($null -ne $firstProcess) {
        try {
            & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $firstProcess.Id /T /F *> $null
        } catch {}
        try { $firstProcess.Dispose() } catch {}
    }
    $env:LOCALAPPDATA = $originalLocalAppData
    $env:UCLAW_LAUNCHER_HEADLESS = $originalHeadless
    $env:UCLAW_FIXTURE_HOLD_MS = $originalHold
    if (Test-Path -LiteralPath $workRoot) {
        Remove-Item -LiteralPath $workRoot -Recurse -Force
    }
}
