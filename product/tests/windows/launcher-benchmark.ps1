param(
    [Parameter(Mandatory)]
    [string]$GoExe,

    [Parameter(Mandatory)]
    [string]$DotnetExe,

    [Parameter(Mandatory)]
    [ValidateRange(5, 100)]
    [int]$Iterations,

    [Parameter(Mandatory)]
    [ValidateRange(1, 3)]
    [int]$Trial,

    [Parameter(Mandatory)]
    [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

class LauncherBenchmarkError : System.Exception {
    [string]$ErrorCode

    LauncherBenchmarkError([string]$errorCode) : base('launcher benchmark failed') {
        $this.ErrorCode = $errorCode
    }
}

function Throw-BenchmarkError {
    param([Parameter(Mandatory)][string]$Code)
    throw [LauncherBenchmarkError]::new($Code)
}

function Get-CanonicalAbsolutePath {
    param([Parameter(Mandatory)][string]$InputPath)

    if ([string]::IsNullOrWhiteSpace($InputPath)) {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_UNSAFE_PATH'
    }
    try {
        if ((Get-Location).Provider.Name -ne 'FileSystem') {
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_UNSAFE_PATH'
        }
        $workingDirectory = (Get-Location).ProviderPath
        if ([IO.Path]::IsPathRooted($InputPath)) {
            return [IO.Path]::GetFullPath($InputPath)
        }
        return [IO.Path]::GetFullPath($InputPath, $workingDirectory)
    }
    catch {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_UNSAFE_PATH'
    }
}

function Assert-NoReparsePath {
    param([Parameter(Mandatory)][System.IO.FileSystemInfo]$Item)

    $current = $Item
    while ($null -ne $current) {
        if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_UNSAFE_PATH'
        }
        $current = $current.Parent
    }
}

function Assert-RegularExecutable {
    param([Parameter(Mandatory)][string]$ExecutablePath)

    $absolutePath = Get-CanonicalAbsolutePath $ExecutablePath
    try {
        $item = Get-Item -LiteralPath $absolutePath
    }
    catch {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_INVALID_EXECUTABLE'
    }
    if ($item.PSProvider.Name -ne 'FileSystem' -or $item.PSIsContainer -or $item.Length -le 0) {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_INVALID_EXECUTABLE'
    }
    Assert-NoReparsePath $item
    return $item.FullName
}

function Assert-SafeOutputPath {
    param([Parameter(Mandatory)][string]$RequestedPath)

    $absolutePath = Get-CanonicalAbsolutePath $RequestedPath
    $leaf = [IO.Path]::GetFileName($absolutePath)
    if ([string]::IsNullOrWhiteSpace($leaf) -or
        $leaf.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
        $leaf -cne $leaf.TrimEnd(' ', '.')) {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_UNSAFE_PATH'
    }
    if (Test-Path -LiteralPath $absolutePath) {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_OUTPUT_EXISTS'
    }
    $parentPath = [IO.Path]::GetDirectoryName($absolutePath)
    if ([string]::IsNullOrEmpty($parentPath)) {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_UNSAFE_PATH'
    }
    try {
        $parent = Get-Item -LiteralPath $parentPath
    }
    catch {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_UNSAFE_PATH'
    }
    if ($parent.PSProvider.Name -ne 'FileSystem' -or -not $parent.PSIsContainer) {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_UNSAFE_PATH'
    }
    Assert-NoReparsePath $parent
    return $absolutePath
}

function Test-FiniteNumber {
    param([Parameter(Mandatory)]$Value)

    $numericTypeCodes = @(
        [TypeCode]::Byte, [TypeCode]::SByte, [TypeCode]::Int16, [TypeCode]::UInt16,
        [TypeCode]::Int32, [TypeCode]::UInt32, [TypeCode]::Int64, [TypeCode]::UInt64,
        [TypeCode]::Single, [TypeCode]::Double, [TypeCode]::Decimal
    )
    if ([Convert]::GetTypeCode($Value) -notin $numericTypeCodes) {
        return $false
    }
    $number = [double]$Value
    return -not [double]::IsNaN($number) -and -not [double]::IsInfinity($number) -and $number -ge 0
}

function Read-BuildMetadata {
    param(
        [Parameter(Mandatory)][string]$ExecutablePath,
        [Parameter(Mandatory)][ValidateSet('go', 'dotnet')][string]$Candidate
    )

    $sidecarPath = $ExecutablePath + '.build.json'
    try {
        $sidecarItem = Get-Item -LiteralPath $sidecarPath
        if ($sidecarItem.PSProvider.Name -ne 'FileSystem' -or $sidecarItem.PSIsContainer) {
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_INVALID_BUILD_METADATA'
        }
        Assert-NoReparsePath $sidecarItem
        $metadata = [IO.File]::ReadAllText($sidecarItem.FullName) | ConvertFrom-Json
    }
    catch [LauncherBenchmarkError] {
        throw
    }
    catch {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_INVALID_BUILD_METADATA'
    }

    $expectedNames = @('buildMs', 'candidate', 'commitSha', 'schemaVersion', 'toolchainVersion')
    $actualNames = @($metadata.PSObject.Properties.Name | Sort-Object)
    if ([string]::Join(',', $actualNames) -cne [string]::Join(',', $expectedNames) -or
        $metadata.schemaVersion -isnot [int64] -and $metadata.schemaVersion -isnot [int32] -or
        $metadata.schemaVersion -ne 1 -or
        $metadata.candidate -isnot [string] -or $metadata.candidate -cne $Candidate -or
        $metadata.commitSha -isnot [string] -or $metadata.commitSha -cnotmatch '^[0-9a-f]{40}$' -or
        -not (Test-FiniteNumber $metadata.buildMs) -or
        $metadata.toolchainVersion -isnot [string] -or [string]::IsNullOrWhiteSpace($metadata.toolchainVersion)) {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_INVALID_BUILD_METADATA'
    }
    return $metadata
}

function Invoke-CapturedProcess {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][int]$TimeoutMs,
        [AllowNull()][string]$PathOverride
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    foreach ($argument in $Arguments) {
        [void]$startInfo.ArgumentList.Add($argument)
    }
    if ($null -ne $PathOverride) {
        $startInfo.Environment['PATH'] = $PathOverride
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    try {
        if (-not $process.Start()) {
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_PROCESS_FAILED'
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMs)) {
            Stop-TimedOutProcess $process 5000
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_PROCESS_TIMEOUT'
        }
        $CaptureTimeoutMs = 5000
        $captureTasks = [Threading.Tasks.Task[]]@($stdoutTask, $stderrTask)
        if (-not [Threading.Tasks.Task]::WaitAll($captureTasks, $CaptureTimeoutMs)) {
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_PROCESS_CAPTURE_TIMEOUT'
        }
        $stopwatch.Stop()
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            Stdout = $stdoutTask.GetAwaiter().GetResult()
            Stderr = $stderrTask.GetAwaiter().GetResult()
            ElapsedMs = $stopwatch.Elapsed.TotalMilliseconds
        }
    }
    finally {
        $stopwatch.Stop()
        $process.Dispose()
    }
}

function Stop-TimedOutProcess {
    param(
        [Parameter(Mandatory)][Diagnostics.Process]$Process,
        [Parameter(Mandatory)][int]$KillTimeoutMs
    )

    try {
        $Process.Kill($true)
    }
    catch {
        if (-not $Process.HasExited) {
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_PROCESS_KILL_FAILED'
        }
    }
    if (-not $Process.WaitForExit($KillTimeoutMs)) {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_PROCESS_KILL_FAILED'
    }
}

function Resolve-CommitSha {
    if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_SHA)) {
        if ($env:GITHUB_SHA -cnotmatch '^[0-9a-f]{40}$') {
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_INVALID_COMMIT'
        }
        return $env:GITHUB_SHA
    }

    try {
        $git = Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1
        $result = Invoke-CapturedProcess $git.Source @('rev-parse', 'HEAD') 10000 $null
        $sha = $result.Stdout.Trim()
    }
    catch [LauncherBenchmarkError] {
        throw
    }
    catch {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_INVALID_COMMIT'
    }
    if ($result.ExitCode -ne 0 -or $result.Stderr.Length -ne 0 -or $sha -cnotmatch '^[0-9a-f]{40}$') {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_INVALID_COMMIT'
    }
    return $sha
}

function Get-Sha256Hex {
    param([Parameter(Mandatory)][byte[]]$Bytes)

    $digest = [Security.Cryptography.SHA256]::HashData($Bytes)
    return [Convert]::ToHexString($digest).ToLowerInvariant()
}

function Write-Utf8Json {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value
    )

    $json = $Value | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($Path, $json, [Text.UTF8Encoding]::new($false))
}

function New-ManifestFixture {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Archive,
        [Parameter(Mandatory)][byte[]]$Payload,
        [string]$HashOverride
    )

    $caseRoot = Join-Path $Root $Name
    [void][IO.Directory]::CreateDirectory($caseRoot)
    if ($Archive -notmatch '^(?:[A-Za-z]:|\\\\|/|\.\.)') {
        $archivePath = Join-Path $caseRoot ($Archive.Replace('\', [IO.Path]::DirectorySeparatorChar))
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($archivePath))
        [IO.File]::WriteAllBytes($archivePath, $Payload)
    }
    $hash = if ([string]::IsNullOrEmpty($HashOverride)) { Get-Sha256Hex $Payload } else { $HashOverride }
    $manifestPath = Join-Path $caseRoot 'launcher-manifest.json'
    Write-Utf8Json $manifestPath ([ordered]@{
        runtimeId = 'openclaw-2026.7.1-2-win-x64'
        archive = $Archive
        sha256 = $hash
    })
    return $manifestPath
}

function New-CandidateFixtures {
    param([Parameter(Mandatory)][string]$Root)

    $payload = [Text.Encoding]::UTF8.GetBytes('equivalent launcher benchmark payload')
    $unicodeRoot = Join-Path $Root 'unicode 空间'
    [void][IO.Directory]::CreateDirectory($unicodeRoot)
    return [ordered]@{
        'valid-manifest' = New-ManifestFixture $Root 'valid-manifest' 'packages\runtime package.pkg' $payload
        'invalid-sha256' = New-ManifestFixture $Root 'invalid-sha256' 'packages\runtime.pkg' $payload ('0' * 64)
        'path-traversal' = New-ManifestFixture $Root 'path-traversal' '..\outside.pkg' $payload
        'absolute-path' = New-ManifestFixture $Root 'absolute-path' 'C:\benchmark\runtime.pkg' $payload
        'absolute-path-unc' = New-ManifestFixture $Root 'absolute-path-unc' '\\benchmark-host\share\runtime.pkg' $payload
        'unicode-space-path' = New-ManifestFixture $unicodeRoot 'valid' 'packages\runtime package.pkg' $payload
        'sdk-path-removed' = New-ManifestFixture $Root 'sdk-path-removed' 'packages\runtime.pkg' $payload
    }
}

function Test-ExpectedInvocation {
    param(
        [Parameter(Mandatory)]$Candidate,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][int]$ExpectedExitCode,
        [Parameter(Mandatory)][string]$ExpectedStdout,
        [Parameter(Mandatory)][string]$ExpectedStderr,
        [AllowNull()][string]$PathOverride
    )

    try {
        $result = Invoke-CapturedProcess $Candidate.Executable $Arguments 15000 $PathOverride
        return $result.ExitCode -eq $ExpectedExitCode -and
            $result.Stdout -ceq $ExpectedStdout -and
            $result.Stderr -ceq $ExpectedStderr
    }
    catch {
        return $false
    }
}

function Get-SdkFreePath {
    $sdkDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($commandName in @('go', 'dotnet')) {
        @(Get-Command $commandName -CommandType Application -All -ErrorAction SilentlyContinue) | ForEach-Object {
            [void]$sdkDirectories.Add([IO.Path]::GetDirectoryName($_.Source))
        }
    }
    $separator = [IO.Path]::PathSeparator
    $segments = @($env:PATH.Split($separator) | Where-Object { -not $sdkDirectories.Contains($_) })
    return [string]::Join($separator, $segments)
}

function Invoke-WithoutSdkPath {
    param([Parameter(Mandatory)][scriptblock]$Operation)

    $originalPath = $env:PATH
    try {
        $env:PATH = Get-SdkFreePath
        return & $Operation $env:PATH
    }
    finally {
        $env:PATH = $originalPath
    }
}

function Get-CandidateNewline {
    param([Parameter(Mandatory)][ValidateSet('go', 'dotnet')][string]$CandidateId)

    if ($CandidateId -ceq 'go') {
        return "`n"
    }
    return [Environment]::NewLine
}

function Test-ReadyJson {
    param(
        [Parameter(Mandatory)][string]$Output,
        [Parameter(Mandatory)][string]$CandidateId
    )

    $expected = '{"status":"ready","candidate":"' + $CandidateId + '"}' + (Get-CandidateNewline $CandidateId)
    if ($Output -cne $expected) {
        return $false
    }
    try {
        $ready = $Output.TrimEnd("`r", "`n") | ConvertFrom-Json
        return $ready.status -ceq 'ready' -and $ready.candidate -ceq $CandidateId -and
            $ready.PSObject.Properties.Count -eq 2
    }
    catch {
        return $false
    }
}

function Invoke-MandatoryCases {
    param(
        [Parameter(Mandatory)]$Candidate,
        [Parameter(Mandatory)]$Fixtures
    )

    $newline = Get-CandidateNewline $Candidate.Id
    $ready = '{"status":"ready","candidate":"' + $Candidate.Id + '"}' + $newline
    $cases = [ordered]@{}
    $cases['valid-manifest'] = Test-ExpectedInvocation $Candidate @('--manifest', $Fixtures['valid-manifest']) 0 $ready '' $null
    $cases['invalid-sha256'] = Test-ExpectedInvocation $Candidate @('--manifest', $Fixtures['invalid-sha256']) 1 '' ('E_PACKAGE_INVALID' + $newline) $null
    $cases['path-traversal'] = Test-ExpectedInvocation $Candidate @('--manifest', $Fixtures['path-traversal']) 1 '' ('E_MANIFEST_INVALID' + $newline) $null
    $cases['absolute-path'] = Test-ExpectedInvocation $Candidate @('--manifest', $Fixtures['absolute-path']) 1 '' ('E_MANIFEST_INVALID' + $newline) $null
    $cases['absolute-path-unc'] = Test-ExpectedInvocation $Candidate @('--manifest', $Fixtures['absolute-path-unc']) 1 '' ('E_MANIFEST_INVALID' + $newline) $null
    $cases['unicode-space-path'] = Test-ExpectedInvocation $Candidate @('--manifest', $Fixtures['unicode-space-path']) 0 $ready '' $null
    $cases['sdk-path-removed'] = Invoke-WithoutSdkPath {
        param($sdkFreePath)
        Test-ExpectedInvocation $Candidate @('--manifest', $Fixtures['sdk-path-removed']) 0 $ready '' $sdkFreePath
    }
    $cases['cli-invalid-arguments'] = Test-ExpectedInvocation $Candidate @('--private-secret-path') 1 '' ('E_ARGUMENTS' + $newline) $null
    return $cases
}

function Get-Median {
    param([Parameter(Mandatory)][double[]]$Values)

    $sorted = @($Values | Sort-Object)
    $middle = [int]($sorted.Count / 2)
    if ($sorted.Count % 2 -eq 0) {
        return ($sorted[$middle - 1] + $sorted[$middle]) / 2
    }
    return $sorted[$middle]
}

function Get-Percentile {
    param(
        [Parameter(Mandatory)][double[]]$Values,
        [Parameter(Mandatory)][ValidateRange(0.0, 1.0)][double]$Percentile
    )

    $sorted = @($Values | Sort-Object)
    $index = [Math]::Ceiling($Percentile * $sorted.Count) - 1
    return $sorted[[Math]::Max(0, $index)]
}

function Invoke-TimedReady {
    param(
        [Parameter(Mandatory)]$Candidate,
        [Parameter(Mandatory)][string]$ManifestPath
    )

    $result = Invoke-CapturedProcess $Candidate.Executable @('--manifest', $ManifestPath) 15000 $null
    if ($result.ExitCode -ne 0 -or $result.Stderr.Length -ne 0 -or
        -not (Test-ReadyJson $result.Stdout $Candidate.Id)) {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_PROCESS_FAILED'
    }
    return $result.ElapsedMs
}

function Write-AtomicReport {
    param(
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)]$Report
    )

    $directory = [IO.Path]::GetDirectoryName($Destination)
    $temporaryPath = Join-Path $directory ('.launcher-benchmark-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Report | ConvertTo-Json -Depth 8) + [Environment]::NewLine)
    try {
        $stream = [IO.FileStream]::new($temporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
        finally {
            $stream.Dispose()
        }
        [IO.File]::Move($temporaryPath, $Destination)
    }
    catch [IO.IOException] {
        if (Test-Path -LiteralPath $Destination) {
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_OUTPUT_EXISTS'
        }
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_IO_ERROR'
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath }
    }
}

function Assert-SafeReportValue {
    param([Parameter(Mandatory)][string]$Value)

    if ($Value -match '[A-Za-z]:[\\/]|\\\\|/(?:Users|home|tmp)/') {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_UNSAFE_REPORT'
    }
    foreach ($forbidden in @($env:USERNAME, [IO.Path]::GetTempPath())) {
        if (-not [string]::IsNullOrWhiteSpace($forbidden) -and
            $Value.IndexOf($forbidden, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_UNSAFE_REPORT'
        }
    }
}

function Invoke-LauncherBenchmark {
    $safeGoExe = Assert-RegularExecutable $GoExe
    $safeDotnetExe = Assert-RegularExecutable $DotnetExe
    $safeOutputPath = Assert-SafeOutputPath $OutputPath
    $commitSha = Resolve-CommitSha
    $goMetadata = Read-BuildMetadata $safeGoExe 'go'
    $dotnetMetadata = Read-BuildMetadata $safeDotnetExe 'dotnet'
    if ($goMetadata.commitSha -cne $commitSha -or $dotnetMetadata.commitSha -cne $commitSha) {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_COMMIT_MISMATCH'
    }

    $candidates = @(
        [pscustomobject]@{ Id = 'go'; Executable = $safeGoExe; Metadata = $goMetadata },
        [pscustomobject]@{ Id = 'dotnet'; Executable = $safeDotnetExe; Metadata = $dotnetMetadata }
    )
    $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('uclaw-launcher-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($temporaryRoot)
    try {
        $fixturesByCandidate = @{}
        $caseResults = @{}
        $timings = @{ go = [Collections.Generic.List[double]]::new(); dotnet = [Collections.Generic.List[double]]::new() }
        foreach ($candidate in $candidates) {
            $candidateRoot = Join-Path $temporaryRoot $candidate.Id
            [void][IO.Directory]::CreateDirectory($candidateRoot)
            $fixturesByCandidate[$candidate.Id] = New-CandidateFixtures $candidateRoot
            $caseResults[$candidate.Id] = Invoke-MandatoryCases $candidate $fixturesByCandidate[$candidate.Id]
        }

        foreach ($candidate in $candidates) {
            [void](Invoke-TimedReady $candidate $fixturesByCandidate[$candidate.Id]['valid-manifest'])
        }
        for ($iteration = 0; $iteration -lt $Iterations; $iteration++) {
            $iterationCandidates = if ($iteration % 2 -eq 0) { $candidates } else { @($candidates[1], $candidates[0]) }
            foreach ($candidate in $iterationCandidates) {
                $elapsed = Invoke-TimedReady $candidate $fixturesByCandidate[$candidate.Id]['valid-manifest']
                $timings[$candidate.Id].Add($elapsed)
            }
        }

        $candidateReports = [ordered]@{}
        foreach ($candidate in $candidates) {
            $cases = $caseResults[$candidate.Id]
            $mandatoryPassed = -not ($cases.Values -contains $false)
            Assert-SafeReportValue $candidate.Metadata.toolchainVersion
            $candidateReports[$candidate.Id] = [ordered]@{
                exeBytes = [int64](Get-Item -LiteralPath $candidate.Executable).Length
                buildMs = [double]$candidate.Metadata.buildMs
                p50Ms = [Math]::Round((Get-Median $timings[$candidate.Id].ToArray()), 6)
                p95Ms = [Math]::Round((Get-Percentile $timings[$candidate.Id].ToArray() 0.95), 6)
                mandatoryPassed = $mandatoryPassed
                cases = $cases
                toolchainVersion = $candidate.Metadata.toolchainVersion
            }
        }

        $cpu = if ([string]::IsNullOrWhiteSpace($env:PROCESSOR_IDENTIFIER)) { 'unknown-windows-cpu' } else { $env:PROCESSOR_IDENTIFIER }
        Assert-SafeReportValue $cpu
        $report = [ordered]@{
            schemaVersion = 1
            trial = $Trial
            measurementKind = 'hosted-runner-process-start'
            commitSha = $commitSha
            runner = [ordered]@{ os = 'Windows'; arch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString(); cpu = $cpu }
            candidates = $candidateReports
        }
        Write-AtomicReport $safeOutputPath $report
    }
    finally {
        if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse }
    }
}

try {
    Invoke-LauncherBenchmark
}
catch [LauncherBenchmarkError] {
    [Console]::Error.WriteLine(($_.Exception.ErrorCode + ': benchmark failed'))
    exit 1
}
catch {
    [Console]::Error.WriteLine('LAUNCHER_BENCHMARK_INTERNAL_ERROR: benchmark failed')
    exit 1
}
