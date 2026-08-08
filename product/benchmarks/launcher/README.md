# Windows Launcher 预选基准复现

这是 Task 9A 的一次性 Go / .NET 8 NativeAOT 预选基准，不是正式 Launcher。报告测量 GitHub hosted runner 上的 process-start；它不等于 cold start，也不覆盖物理 U 盘、Microsoft Defender、普通用户权限、Windows 10 或 Windows 11 实机验收。结果只能支持 provisional decision，不得据此把 Task 9 或 Task 10 标记为完成。

## 固定环境

- Windows x64
- Node.js 24.15.0
- Go 1.24.4
- .NET SDK 8.0.408
- Windows PowerShell 5.1：仅用于行为兼容门禁
- PowerShell 7：用于行为兼容门禁、候选构建和正式基准

在 Windows x64 仓库根目录检查依赖。版本必须与上面一致：

```powershell
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -cne 'Core' -or $PSVersionTable.PSVersion.Major -ne 7) {
  throw 'Current shell must be PowerShell 7'
}
Get-Command git, node, go, dotnet, powershell.exe, pwsh | Select-Object Name, Source
$nodeVersion = (& node --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -cne 'v24.15.0') { throw 'Node must be v24.15.0' }
$goVersion = (& go version).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Go version check failed' }
$goVersionTokens = @($goVersion -split '\s+')
if ($goVersionTokens -notcontains 'go1.24.4' -or $goVersionTokens -notcontains 'windows/amd64') {
  throw 'Go must be go1.24.4 windows/amd64'
}
$dotnetVersion = (& dotnet --version).Trim()
if ($LASTEXITCODE -ne 0 -or $dotnetVersion -cne '8.0.408') { throw '.NET SDK must be 8.0.408' }
$windowsPowerShellVersion = (& powershell.exe -NoProfile -Command '$v = $PSVersionTable.PSVersion; "$($v.Major).$($v.Minor)"').Trim()
if ($LASTEXITCODE -ne 0 -or $windowsPowerShellVersion -cne '5.1') { throw 'Windows PowerShell must be 5.1' }
$pwshMajor = (& pwsh -NoProfile -Command '$PSVersionTable.PSVersion.Major.ToString()').Trim()
if ($LASTEXITCODE -ne 0 -or $pwshMajor -cne '7') { throw 'PowerShell must be major version 7' }
```

上述检查同时验证当前 shell 为 PowerShell 7、子 shell `powershell.exe` 为 5.1、子 shell `pwsh` major 为 7。缺少命令或版本不同会立即停止；不要把结果与 CI 固定环境混用。

## 行为兼容门禁

正式构建和基准只用 PowerShell 7 (`pwsh`)。构建候选、运行任何正式 trial 或生成 decision 前，必须先在 Windows PowerShell 5.1 和 PowerShell 7 分别通过行为门禁：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\product\tests\windows\launcher-benchmark-behavior.ps1
if ($LASTEXITCODE -ne 0) { throw 'Windows PowerShell behavior gate failed' }
pwsh -NoProfile -File .\product\tests\windows\launcher-benchmark-behavior.ps1
if ($LASTEXITCODE -ne 0) { throw 'PowerShell 7 behavior gate failed' }
```

该脚本编译 fake 候选并验证带引号 PATH、最近秩 percentile、严格 sidecar、超时后的 child process cleanup 等兼容与安全行为。

## Windows 本地复现

以下命令从干净 checkout 的仓库根目录运行。输出固定在 `product\.launcher-benchmark`。每个 EXE 的严格 sidecar 与 EXE 同目录，名称为 `<exe>.build.json`，且只含 `schemaVersion`、`candidate`、`commitSha`、`buildMs`、`toolchainVersion`。`buildMs` 来自真实 `Stopwatch`，不得填 `0` 或伪造。开始时整个输出根目录必须不存在；脚本拒绝复用它，避免新 EXE 与旧 sidecar 错配。harness 和 `decide` 也会拒绝覆盖已有输出。

```powershell
$ErrorActionPreference = 'Stop'
$benchmarkRoot = Join-Path $PWD 'product\.launcher-benchmark'
if (Test-Path -LiteralPath $benchmarkRoot) { throw 'Benchmark output root already exists' }
[void][IO.Directory]::CreateDirectory($benchmarkRoot)
$candidateRoot = Join-Path $benchmarkRoot 'candidates'
$publishRoot = Join-Path $benchmarkRoot 'nativeaot-publish'
$reportRoot = Join-Path $benchmarkRoot 'reports'
[void][IO.Directory]::CreateDirectory($candidateRoot)
[void][IO.Directory]::CreateDirectory($reportRoot)

npm ci --ignore-scripts --prefix product
if ($LASTEXITCODE -ne 0) { throw 'Product dependency install failed' }

$commitSha = (& git rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $commitSha -cnotmatch '^[0-9a-f]{40}$') { throw 'Invalid Git commit SHA' }

$goExe = Join-Path $candidateRoot 'uclaw-launcher-go.exe'
if (Test-Path -LiteralPath $goExe) { throw 'Go candidate output already exists' }
$hadCgoEnabled = Test-Path Env:CGO_ENABLED
$originalCgoEnabled = $env:CGO_ENABLED
$hadGoos = Test-Path Env:GOOS
$originalGoos = $env:GOOS
$hadGoarch = Test-Path Env:GOARCH
$originalGoarch = $env:GOARCH
$env:CGO_ENABLED = '0'
$env:GOOS = 'windows'
$env:GOARCH = 'amd64'
try {
  Push-Location product\benchmarks\launcher\go
  try {
    go test ./...
    if ($LASTEXITCODE -ne 0) { throw 'Go tests failed' }
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    go build -trimpath -ldflags '-s -w' -o $goExe .
    if ($LASTEXITCODE -ne 0) { $stopwatch.Stop(); throw 'Go build failed' }
    $stopwatch.Stop()
  }
  finally {
    Pop-Location
  }
}
finally {
  if ($hadCgoEnabled) { $env:CGO_ENABLED = $originalCgoEnabled } else { Remove-Item Env:CGO_ENABLED -ErrorAction SilentlyContinue }
  if ($hadGoos) { $env:GOOS = $originalGoos } else { Remove-Item Env:GOOS -ErrorAction SilentlyContinue }
  if ($hadGoarch) { $env:GOARCH = $originalGoarch } else { Remove-Item Env:GOARCH -ErrorAction SilentlyContinue }
}
$goToolchainVersion = (& go version).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Go version capture failed' }
$metadata = [ordered]@{
  schemaVersion = 1
  candidate = 'go'
  commitSha = $commitSha
  buildMs = $stopwatch.Elapsed.TotalMilliseconds
  toolchainVersion = $goToolchainVersion
}
$sidecar = $goExe + '.build.json'
if (Test-Path -LiteralPath $sidecar) { throw 'Go build sidecar already exists' }
$temporary = $sidecar + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
[IO.File]::WriteAllText($temporary, (($metadata | ConvertTo-Json -Compress) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
[IO.File]::Move($temporary, $sidecar)

$project = Join-Path $PWD 'product\benchmarks\launcher\dotnet\UClaw.Launcher.Benchmark.csproj'
dotnet run --project $project -c Release -- --self-test
if ($LASTEXITCODE -ne 0) { throw 'NativeAOT source self-test failed' }
if (Test-Path -LiteralPath $publishRoot) { throw 'NativeAOT publish output already exists' }
$stopwatch = [Diagnostics.Stopwatch]::StartNew()
dotnet publish $project -c Release -r win-x64 --self-contained true -p:PublishAot=true -o $publishRoot
if ($LASTEXITCODE -ne 0) { $stopwatch.Stop(); throw 'NativeAOT publish failed' }
$stopwatch.Stop()
$publishedExecutables = @(Get-ChildItem -LiteralPath $publishRoot -Filter '*.exe' -File -Recurse)
if ($publishedExecutables.Count -ne 1) { throw 'NativeAOT publish must contain exactly one executable' }
if (@(Get-ChildItem -LiteralPath $publishRoot -Filter '*.dll' -File -Recurse).Count -ne 0) { throw 'NativeAOT publish contains DLL runtime dependencies' }
$dotnetExe = Join-Path $candidateRoot 'uclaw-launcher-dotnet.exe'
if (Test-Path -LiteralPath $dotnetExe) { throw 'NativeAOT candidate output already exists' }
Copy-Item -LiteralPath $publishedExecutables[0].FullName -Destination $dotnetExe -ErrorAction Stop
& $dotnetExe --self-test
if ($LASTEXITCODE -ne 0) { throw 'Published NativeAOT self-test failed' }
$dotnetToolchainVersion = (& dotnet --version).Trim()
if ($LASTEXITCODE -ne 0) { throw '.NET version capture failed' }
$metadata = [ordered]@{
  schemaVersion = 1
  candidate = 'dotnet'
  commitSha = $commitSha
  buildMs = $stopwatch.Elapsed.TotalMilliseconds
  toolchainVersion = $dotnetToolchainVersion
}
$sidecar = $dotnetExe + '.build.json'
if (Test-Path -LiteralPath $sidecar) { throw 'NativeAOT build sidecar already exists' }
$temporary = $sidecar + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
[IO.File]::WriteAllText($temporary, (($metadata | ConvertTo-Json -Compress) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
[IO.File]::Move($temporary, $sidecar)

pwsh -NoProfile -File product\tests\windows\launcher-benchmark.ps1 `
  -GoExe product\.launcher-benchmark\candidates\uclaw-launcher-go.exe `
  -DotnetExe product\.launcher-benchmark\candidates\uclaw-launcher-dotnet.exe `
  -Iterations 20 `
  -Trial 1 `
  -OutputPath product\.launcher-benchmark\reports\trial-1.json
if ($LASTEXITCODE -ne 0) { throw 'Formal launcher benchmark failed' }
node product\scripts\launcher-benchmark-report.mjs validate product\.launcher-benchmark\reports\trial-1.json
if ($LASTEXITCODE -ne 0) { throw 'Trial validation failed' }
node product\scripts\launcher-benchmark-report.mjs require-mandatory product\.launcher-benchmark\reports\trial-1.json
if ($LASTEXITCODE -ne 0) { throw 'Mandatory safety cases failed' }
```

## 三次聚合

用相同候选和 sidecar 再运行 trial 2、3；每次使用新输出路径：

```powershell
pwsh -NoProfile -File product\tests\windows\launcher-benchmark.ps1 -GoExe product\.launcher-benchmark\candidates\uclaw-launcher-go.exe -DotnetExe product\.launcher-benchmark\candidates\uclaw-launcher-dotnet.exe -Iterations 20 -Trial 2 -OutputPath product\.launcher-benchmark\reports\trial-2.json
if ($LASTEXITCODE -ne 0) { throw 'Trial 2 benchmark failed' }
pwsh -NoProfile -File product\tests\windows\launcher-benchmark.ps1 -GoExe product\.launcher-benchmark\candidates\uclaw-launcher-go.exe -DotnetExe product\.launcher-benchmark\candidates\uclaw-launcher-dotnet.exe -Iterations 20 -Trial 3 -OutputPath product\.launcher-benchmark\reports\trial-3.json
if ($LASTEXITCODE -ne 0) { throw 'Trial 3 benchmark failed' }

node product\scripts\launcher-benchmark-report.mjs validate product\.launcher-benchmark\reports\trial-1.json
if ($LASTEXITCODE -ne 0) { throw 'Trial 1 validation failed' }
node product\scripts\launcher-benchmark-report.mjs validate product\.launcher-benchmark\reports\trial-2.json
if ($LASTEXITCODE -ne 0) { throw 'Trial 2 validation failed' }
node product\scripts\launcher-benchmark-report.mjs validate product\.launcher-benchmark\reports\trial-3.json
if ($LASTEXITCODE -ne 0) { throw 'Trial 3 validation failed' }
node product\scripts\launcher-benchmark-report.mjs require-mandatory product\.launcher-benchmark\reports\trial-1.json
if ($LASTEXITCODE -ne 0) { throw 'Trial 1 mandatory gate failed' }
node product\scripts\launcher-benchmark-report.mjs require-mandatory product\.launcher-benchmark\reports\trial-2.json
if ($LASTEXITCODE -ne 0) { throw 'Trial 2 mandatory gate failed' }
node product\scripts\launcher-benchmark-report.mjs require-mandatory product\.launcher-benchmark\reports\trial-3.json
if ($LASTEXITCODE -ne 0) { throw 'Trial 3 mandatory gate failed' }
node product\scripts\launcher-benchmark-report.mjs decide product\.launcher-benchmark\reports\trial-1.json product\.launcher-benchmark\reports\trial-2.json product\.launcher-benchmark\reports\trial-3.json --output product\.launcher-benchmark\reports\decision.json
if ($LASTEXITCODE -ne 0) { throw 'Decision failed' }
```

只有 Windows PowerShell 5.1 和 PowerShell 7 双行为门禁都成功、三份报告属于同一 `commitSha`，且三份都通过 mandatory gate 后，`decision.json` 才是 provisional decision。本地单机运行三次不等于三台独立 hosted runner，不得把它描述为 CI 证据。

## CI 与 artifact

分支先 push，且操作者拥有 GitHub Actions workflow dispatch 权限后，才能手动触发：

```powershell
$branch = 'codex/task9-launcher-benchmark'
if ([string]::IsNullOrWhiteSpace($branch)) { throw 'Branch must not be empty' }
gh workflow run launcher-benchmark.yml --ref $branch
if ($LASTEXITCODE -ne 0) { throw 'Workflow dispatch failed' }
```

本复现任务不 push，也不运行 workflow。三个独立 trial artifact 名为 `launcher-benchmark-trial-1`、`launcher-benchmark-trial-2`、`launcher-benchmark-trial-3`；聚合 artifact 名为 `launcher-benchmark-results`，包含三份 trial JSON 和 `decision.json`。

## 输出与清理

`product\.launcher-benchmark`、任何 `.tmp`、EXE、DLL、PDB、`bin`、`obj`、trial JSON 和 decision JSON 都是本地产物，不得提交。sidecar 必须与对应 EXE 同目录，也不得提交。运行前使用新的输出路径；不要覆盖或篡改已有报告。

提交前只删除仓库内固定的 benchmark 输出根目录和 .NET `bin`/`obj`。脚本先证明 `$work` 等于预期目录，并逐一校验其他清理路径在仓库内固定位置；拒绝 reparse point，删除后用 `Test-Path` 确认不存在，再检查 Git。报告、日志和提交内容不得包含用户绝对路径、用户名或 secret。

```powershell
$ErrorActionPreference = 'Stop'
$repositoryRoot = (& git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Repository root lookup failed' }
$repositoryRoot = [IO.Path]::GetFullPath($repositoryRoot)
$currentDirectory = [IO.Path]::GetFullPath($PWD)
if (-not $currentDirectory.Equals($repositoryRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Cleanup must run from repository root'
}

$expectedWork = [IO.Path]::GetFullPath([IO.Path]::Combine($repositoryRoot, 'product', '.launcher-benchmark'))
$work = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'product\.launcher-benchmark'))
if (-not $work.Equals($expectedWork, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Unexpected benchmark cleanup path'
}
$repositoryPrefix = $repositoryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $work.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Benchmark cleanup path is outside repository'
}

$buildOutputs = @(
  [IO.Path]::GetFullPath([IO.Path]::Combine($repositoryRoot, 'product', 'benchmarks', 'launcher', 'dotnet', 'bin')),
  [IO.Path]::GetFullPath([IO.Path]::Combine($repositoryRoot, 'product', 'benchmarks', 'launcher', 'dotnet', 'obj'))
)
$expectedBuildOutputs = @(
  [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'product\benchmarks\launcher\dotnet\bin')),
  [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'product\benchmarks\launcher\dotnet\obj'))
)
for ($index = 0; $index -lt $buildOutputs.Count; $index++) {
  if (-not $buildOutputs[$index].Equals($expectedBuildOutputs[$index], [StringComparison]::OrdinalIgnoreCase) -or
      -not $buildOutputs[$index].StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unexpected .NET cleanup path'
  }
}

foreach ($path in @($work) + $buildOutputs) {
  if (Test-Path -LiteralPath $path) {
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Cleanup path is a reparse point' }
    Remove-Item -LiteralPath $path -Recurse -Force
  }
  if (Test-Path -LiteralPath $path) { throw 'Benchmark cleanup failed' }
}
if (Test-Path -LiteralPath $work) { throw 'Benchmark cleanup failed' }

$status = (& git status --short)
if ($LASTEXITCODE -ne 0) { throw 'Git status check failed' }
if ($status) { throw ('Working tree is not clean:' + [Environment]::NewLine + ($status -join [Environment]::NewLine)) }
```
