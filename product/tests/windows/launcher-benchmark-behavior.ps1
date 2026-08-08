param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-True {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw $Message }
}

function Write-Sidecar {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][ValidateSet('go', 'dotnet')][string]$Candidate,
        [Parameter(Mandatory)][string]$CommitSha
    )
    $destination = $Executable + '.build.json'
    $temporary = $destination + '.tmp'
    $metadata = [ordered]@{
        schemaVersion = 1
        candidate = $Candidate
        commitSha = $CommitSha
        buildMs = 1
        toolchainVersion = 'fake-compatibility-1'
    }
    [IO.File]::WriteAllText(
        $temporary,
        (($metadata | ConvertTo-Json -Compress) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )
    [IO.File]::Move($temporary, $destination)
}

function Invoke-HarnessProcess {
    param(
        [Parameter(Mandatory)][string]$RepositoryRoot,
        [Parameter(Mandatory)][string]$Harness,
        [Parameter(Mandatory)][string]$GoExe,
        [Parameter(Mandatory)][string]$DotnetExe,
        [Parameter(Mandatory)][string]$OutputPath,
        [Parameter(Mandatory)][string]$CaptureRoot
    )
    $stdoutPath = Join-Path $CaptureRoot ([Guid]::NewGuid().ToString('N') + '.stdout')
    $stderrPath = Join-Path $CaptureRoot ([Guid]::NewGuid().ToString('N') + '.stderr')
    $shellExe = (Get-Process -Id $PID).Path
    $arguments = @(
        '-NoProfile', '-File', $Harness,
        '-GoExe', $GoExe,
        '-DotnetExe', $DotnetExe,
        '-Iterations', '7',
        '-Trial', '1',
        '-OutputPath', $OutputPath
    )
    $process = Start-Process -FilePath $shellExe -ArgumentList $arguments -WorkingDirectory $RepositoryRoot `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -Wait -PassThru
    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        Stdout = [IO.File]::ReadAllText($stdoutPath)
        Stderr = [IO.File]::ReadAllText($stderrPath)
    }
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$relativeRoot = '.launcher-benchmark-behavior-' + [Guid]::NewGuid().ToString('N')
$absoluteRoot = Join-Path $repositoryRoot $relativeRoot
$harness = 'product\tests\windows\launcher-benchmark.ps1'
$goExe = Join-Path $relativeRoot 'fake-go.exe'
$dotnetExe = Join-Path $relativeRoot 'fake-dotnet.exe'
$originalPath = $env:PATH
$originalTimingRoot = $env:LAUNCHER_BENCHMARK_FAKE_TIMING_ROOT
$originalCounter = $env:LAUNCHER_BENCHMARK_FAKE_COUNTER
$originalPidFile = $env:LAUNCHER_BENCHMARK_FAKE_CHILD_PID_FILE

try {
    [void][IO.Directory]::CreateDirectory($absoluteRoot)
    Push-Location $repositoryRoot
    try {
        & go test .\product\tests\windows\fixtures\fake-launcher.go `
            .\product\tests\windows\fixtures\fake-launcher_test.go
        Assert-True ($LASTEXITCODE -eq 0) 'fake candidate tests failed'
        & go build -trimpath -o $goExe .\product\tests\windows\fixtures\fake-launcher.go
        Assert-True ($LASTEXITCODE -eq 0) 'fake candidate build failed'
        Copy-Item -LiteralPath $goExe -Destination $dotnetExe

        $commitSha = if ($env:GITHUB_SHA) { $env:GITHUB_SHA } else { (& git rev-parse HEAD).Trim() }
        Assert-True ($commitSha -cmatch '^[0-9a-f]{40}$') 'invalid compatibility commit'
        Write-Sidecar $goExe 'go' $commitSha
        Write-Sidecar $dotnetExe 'dotnet' $commitSha

        # Exercise quoted SDK PATH entries with a trailing-backslash segment.
        $goDirectory = [IO.Path]::GetDirectoryName((Get-Command go -CommandType Application).Source)
        $dotnetDirectory = [IO.Path]::GetDirectoryName((Get-Command dotnet -CommandType Application).Source)
        $env:PATH = ('"' + $goDirectory + '\"') + [IO.Path]::PathSeparator +
            ('"' + $dotnetDirectory + '\"') + [IO.Path]::PathSeparator + $originalPath

        $reportPath = Join-Path $relativeRoot 'relative-trial.json'
        $timingRoot = Join-Path $absoluteRoot 'timing-state'
        [void][IO.Directory]::CreateDirectory($timingRoot)
        $env:LAUNCHER_BENCHMARK_FAKE_TIMING_ROOT = $timingRoot
        $result = Invoke-HarnessProcess $repositoryRoot $harness $goExe $dotnetExe $reportPath $absoluteRoot
        $env:LAUNCHER_BENCHMARK_FAKE_TIMING_ROOT = $null
        Assert-True ($result.ExitCode -eq 0) ('relative benchmark failed: ' + $result.Stderr)
        $report = Get-Content -LiteralPath (Join-Path $repositoryRoot $reportPath) -Raw | ConvertFrom-Json
        foreach ($candidateId in @('go', 'dotnet')) {
            $invocations = [int]([IO.File]::ReadAllText((Join-Path $timingRoot ($candidateId + '.timing-count'))))
            Assert-True ($invocations -eq 16) ($candidateId + ' timing sequence was not isolated')
            $candidate = $report.candidates.$candidateId
            $p50 = [Convert]::ToDouble($candidate.p50Ms, [Globalization.CultureInfo]::InvariantCulture)
            $p95 = [Convert]::ToDouble($candidate.p95Ms, [Globalization.CultureInfo]::InvariantCulture)
            Assert-True ($p50 -ge 220 -and $p50 -le 500) 'p50Ms is not nearest-rank sample 4'
            Assert-True ($p95 -ge 1850 -and $p95 -le 2400) 'p95Ms is not nearest-rank sample 7'
        }

        $validGoSidecar = [IO.File]::ReadAllText((Join-Path $repositoryRoot ($goExe + '.build.json')))
        $duplicate = '{"schemaVersion":1,"candidate":"go","candidate":"go","commitSha":"' +
            $commitSha + '","buildMs":1,"toolchainVersion":"fake-compatibility-1"}'
        [IO.File]::WriteAllText((Join-Path $repositoryRoot ($goExe + '.build.json')), $duplicate, [Text.UTF8Encoding]::new($false))
        $result = Invoke-HarnessProcess $repositoryRoot $harness $goExe $dotnetExe `
            (Join-Path $relativeRoot 'duplicate.json') $absoluteRoot
        Assert-True ($result.ExitCode -ne 0 -and $result.Stderr -ceq "LAUNCHER_BENCHMARK_INVALID_BUILD_METADATA: benchmark failed`r`n") `
            'duplicate sidecar did not return fixed error'

        $nullSidecar = '{"schemaVersion":1,"candidate":"go","commitSha":"' + $commitSha +
            '","buildMs":null,"toolchainVersion":"fake-compatibility-1"}'
        [IO.File]::WriteAllText((Join-Path $repositoryRoot ($goExe + '.build.json')), $nullSidecar, [Text.UTF8Encoding]::new($false))
        $result = Invoke-HarnessProcess $repositoryRoot $harness $goExe $dotnetExe `
            (Join-Path $relativeRoot 'null.json') $absoluteRoot
        Assert-True ($result.ExitCode -ne 0 -and $result.Stderr -ceq "LAUNCHER_BENCHMARK_INVALID_BUILD_METADATA: benchmark failed`r`n") `
            'null sidecar did not return fixed error'
        [IO.File]::WriteAllText((Join-Path $repositoryRoot ($goExe + '.build.json')), $validGoSidecar, [Text.UTF8Encoding]::new($false))

        $counterPath = Join-Path $absoluteRoot 'fake-counter.txt'
        $fakeChildPidPath = Join-Path $absoluteRoot 'fake-child.pid'
        $env:LAUNCHER_BENCHMARK_FAKE_COUNTER = $counterPath
        $env:LAUNCHER_BENCHMARK_FAKE_CHILD_PID_FILE = $fakeChildPidPath
        $result = Invoke-HarnessProcess $repositoryRoot $harness $goExe $dotnetExe `
            (Join-Path $relativeRoot 'capture-timeout.json') $absoluteRoot
        Assert-True ($result.ExitCode -ne 0 -and $result.Stderr -ceq "LAUNCHER_BENCHMARK_PROCESS_CAPTURE_TIMEOUT: benchmark failed`r`n") `
            'PROCESS_CAPTURE_TIMEOUT fixed error missing'
        $fakeChildPid = [int]([IO.File]::ReadAllText($fakeChildPidPath))
        $fakeChild = $null
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            $fakeChild = Get-Process -Id $fakeChildPid -ErrorAction SilentlyContinue
            if ($null -eq $fakeChild) { break }
            Start-Sleep -Milliseconds 100
        }
        Assert-True ($null -eq $fakeChild) 'fake-child remained after Job Object timeout cleanup'
    }
    finally {
        Pop-Location
    }
}
finally {
    $env:PATH = $originalPath
    $env:LAUNCHER_BENCHMARK_FAKE_TIMING_ROOT = $originalTimingRoot
    $env:LAUNCHER_BENCHMARK_FAKE_COUNTER = $originalCounter
    $env:LAUNCHER_BENCHMARK_FAKE_CHILD_PID_FILE = $originalPidFile
    if (Test-Path -LiteralPath $absoluteRoot) { Remove-Item -LiteralPath $absoluteRoot -Recurse }
}
