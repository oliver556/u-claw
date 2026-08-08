# Task 9A Windows 启动器基准测试实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 Go 与 .NET 8 NativeAOT 一次性 Windows x64 启动器小样，在三台独立 GitHub Hosted Windows Runner 上生成可审计基准报告和预选结论。

**Architecture:** 两个小样只实现相同的 manifest/SHA-256/路径边界；统一 PowerShell 运行器负责测量和输出。Node 脚本验证报告并聚合三份独立 Runner 数据，只输出 provisional decision，不修改 ADR 或虚标实机验收。

**Tech Stack:** Go 1.24.4，.NET SDK 8.0.408 + NativeAOT，PowerShell 7/Windows PowerShell 5.1，Node.js 24.15.0 `node:test`，GitHub Actions `windows-2022`

---

## 文件边界

```text
product/scripts/launcher-benchmark-report.mjs
  报告运行时校验、三次聚合、预选决策

product/tests/windows/launcher-benchmark.schema.json
  报告 JSON Schema

product/benchmarks/launcher/go/
  Go 一次性小样；无正式 Launcher 逻辑

product/benchmarks/launcher/dotnet/
  NativeAOT 一次性小样；无正式 Launcher 逻辑

product/tests/windows/launcher-benchmark.ps1
  同机同口径运行两个 EXE，产生一份 trial report

.github/workflows/launcher-benchmark.yml
  三个独立 Windows job + 一个聚合 job
```

### Task 1：锁定报告契约和决策规则

**Files:**
- Create: `product/tests/windows/launcher-benchmark.schema.json`
- Create: `product/scripts/launcher-benchmark-report.mjs`
- Create: `product/scripts/launcher-benchmark-report.test.mjs`
- Modify: `product/package.json`

- [ ] **Step 1: 先写报告校验和决策失败测试**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { decideLauncher, validateTrialReport } from "./launcher-benchmark-report.mjs";

function candidate(overrides = {}) {
  return {
    exeBytes: 8_000_000, buildMs: 1_000, p50Ms: 20, p95Ms: 30,
    mandatoryPassed: true, cases: { "valid-manifest": true },
    toolchainVersion: "test", ...overrides
  };
}

function makeTrial(trial, overrides = {}) {
  return {
    schemaVersion: 1, trial, measurementKind: "hosted-runner-process-start",
    commitSha: "a".repeat(40), runner: { os: "Windows", arch: "X64", cpu: "test" },
    candidates: {
      go: candidate(overrides.go),
      dotnet: candidate(overrides.dotnet)
    }
  };
}

function nearEqualReports() {
  return [1, 2, 3].map((trial) => makeTrial(trial, {
    go: { p95Ms: 30, exeBytes: 8_000_000 },
    dotnet: { p95Ms: 33, exeBytes: 7_000_000 }
  }));
}

test("rejects reports that claim hosted runner cold start", () => {
  assert.throws(() => validateTrialReport({ measurementKind: "cold-start" }), /measurementKind/);
});

test("eliminates a candidate when a mandatory case fails", () => {
  const reports = [1, 2, 3].map((trial) => makeTrial(trial, {
    go: { mandatoryPassed: false }, dotnet: { mandatoryPassed: true }
  }));
  assert.equal(decideLauncher(reports).selected, "dotnet");
});

test("uses p95 20 percent threshold before size", () => {
  const reports = [1, 2, 3].map((trial) => makeTrial(trial, {
    go: { p95Ms: 80, exeBytes: 9_000_000 },
    dotnet: { p95Ms: 110, exeBytes: 4_000_000 }
  }));
  assert.equal(decideLauncher(reports).reason, "p95-margin");
});

test("uses Go as the documented tie breaker", () => {
  assert.equal(decideLauncher(nearEqualReports()).selected, "go");
});
```

- [ ] **Step 2: 运行 RED**

Run: `cd product && node --test scripts/launcher-benchmark-report.test.mjs`

Expected: FAIL，`launcher-benchmark-report.mjs` 不存在。

- [ ] **Step 3: 实现最小校验和决策器**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "trial", "measurementKind", "commitSha", "runner", "candidates"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "trial": { "type": "integer", "minimum": 1, "maximum": 3 },
    "measurementKind": { "const": "hosted-runner-process-start" },
    "commitSha": { "type": "string", "pattern": "^[0-9a-f]{40}$" },
    "runner": {
      "type": "object",
      "required": ["os", "arch", "cpu"],
      "properties": {
        "os": { "type": "string" }, "arch": { "type": "string" }, "cpu": { "type": "string" }
      }
    },
    "candidates": {
      "type": "object",
      "required": ["go", "dotnet"],
      "properties": {
        "go": { "$ref": "#/$defs/candidate" },
        "dotnet": { "$ref": "#/$defs/candidate" }
      }
    }
  },
  "$defs": {
    "candidate": {
      "type": "object",
      "required": ["exeBytes", "buildMs", "p50Ms", "p95Ms", "mandatoryPassed", "cases", "toolchainVersion"],
      "properties": {
        "exeBytes": { "type": "integer", "minimum": 1 },
        "buildMs": { "type": "number", "minimum": 0 },
        "p50Ms": { "type": "number", "minimum": 0 },
        "p95Ms": { "type": "number", "minimum": 0 },
        "mandatoryPassed": { "type": "boolean" },
        "cases": { "type": "object", "additionalProperties": { "type": "boolean" } },
        "toolchainVersion": { "type": "string", "minLength": 1 }
      }
    }
  }
}
```

```js
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function validateTrialReport(report) {
  if (report.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (report.measurementKind !== "hosted-runner-process-start") {
    throw new Error("measurementKind must identify hosted runner process start");
  }
  if (!["go", "dotnet"].every((id) => report.candidates?.[id])) {
    throw new Error("both candidates are required");
  }
  return report;
}

export function decideLauncher(reports) {
  if (reports.length !== 3) throw new Error("exactly three trial reports are required");
  reports.forEach(validateTrialReport);
  const median = (values) => [...values].sort((a, b) => a - b)[1];
  const summary = Object.fromEntries(["go", "dotnet"].map((id) => [id, {
    mandatoryPassed: reports.every((report) => report.candidates[id].mandatoryPassed),
    p95Ms: median(reports.map((report) => report.candidates[id].p95Ms)),
    exeBytes: median(reports.map((report) => report.candidates[id].exeBytes))
  }]));
  const eligible = ["go", "dotnet"].filter((id) => summary[id].mandatoryPassed);
  if (eligible.length === 0) return { selected: null, reason: "mandatory-failure", summary };
  if (eligible.length === 1) return { selected: eligible[0], reason: "mandatory-elimination", summary };
  const chooseByMargin = (field, threshold, reason) => {
    const ordered = [...eligible].sort((a, b) => summary[a][field] - summary[b][field]);
    const [better, worse] = ordered;
    const margin = (summary[worse][field] - summary[better][field]) / summary[worse][field];
    return margin >= threshold ? { selected: better, reason, summary } : null;
  };
  return chooseByMargin("p95Ms", 0.20, "p95-margin")
    ?? chooseByMargin("exeBytes", 0.25, "size-margin")
    ?? { selected: "go", reason: "documented-tie-breaker", summary };
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === "validate" && args.length === 1) {
    validateTrialReport(JSON.parse(await readFile(args[0], "utf8")));
    return;
  }
  if (command === "decide") {
    const outputIndex = args.indexOf("--output");
    if (outputIndex !== 3 || !args[4]) throw new Error("decide requires three reports and --output");
    const reports = await Promise.all(args.slice(0, 3).map(async (file) => JSON.parse(await readFile(file, "utf8"))));
    await writeFile(args[4], `${JSON.stringify(decideLauncher(reports), null, 2)}\n`, { flag: "wx" });
    return;
  }
  throw new Error("usage: validate <report> | decide <r1> <r2> <r3> --output <file>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
```

Schema 必须要求：`schemaVersion`、`trial`、`measurementKind`、`runner`、`commitSha`、`candidates.go`、`candidates.dotnet`；候选结果必须包含 `exeBytes/buildMs/p50Ms/p95Ms/mandatoryPassed/cases/toolchainVersion`。

- [ ] **Step 4: 运行 GREEN 和根脚本回归**

Run: `cd product && node --test scripts/launcher-benchmark-report.test.mjs scripts/*.test.mjs`

Expected: PASS，无 skip。

- [ ] **Step 5: 提交**

```bash
git add product/tests/windows/launcher-benchmark.schema.json \
  product/scripts/launcher-benchmark-report.mjs \
  product/scripts/launcher-benchmark-report.test.mjs product/package.json
git commit -m "test(packaging): lock launcher benchmark contract"
```

### Task 2：实现 Go 一次性小样

**Files:**
- Create: `product/benchmarks/launcher/go/go.mod`
- Create: `product/benchmarks/launcher/go/main.go`
- Create: `product/benchmarks/launcher/go/manifest.go`
- Create: `product/benchmarks/launcher/go/manifest_test.go`

- [ ] **Step 1: 先写 manifest 和 Windows 路径边界测试**

```go
func TestValidateManifest(t *testing.T) {
    valid := Manifest{RuntimeID: "openclaw-2026.7.1-2-win-x64", Archive: "runtime.pkg", SHA256: strings.Repeat("a", 64)}
    if err := ValidateManifest(valid); err != nil { t.Fatal(err) }
}

func TestRejectsTraversalAbsoluteAndUNCPaths(t *testing.T) {
    for _, path := range []string{"../runtime.pkg", `C:\\runtime.pkg`, `\\\\server\\share\\runtime.pkg`, "/runtime.pkg"} {
        manifest := validManifest()
        manifest.Archive = path
        if err := ValidateManifest(manifest); err == nil { t.Fatalf("accepted %q", path) }
    }
}

func TestRejectsMalformedSHA256(t *testing.T) {
    manifest := validManifest()
    manifest.SHA256 = "abc"
    if err := ValidateManifest(manifest); err == nil { t.Fatal("expected SHA-256 rejection") }
}

func TestRejectsArchiveHashMismatch(t *testing.T) {
    dir := t.TempDir()
    if err := os.WriteFile(filepath.Join(dir, "runtime.pkg"), []byte("payload"), 0o600); err != nil { t.Fatal(err) }
    manifest := validManifest()
    manifest.SHA256 = strings.Repeat("0", 64)
    if err := ValidatePackage(dir, manifest); err == nil { t.Fatal("expected archive hash mismatch") }
}
```

- [ ] **Step 2: 运行 RED**

Run: `cd product/benchmarks/launcher/go && go test ./...`

Expected: FAIL，`Manifest`/`ValidateManifest` 未定义。

- [ ] **Step 3: 实现最小 manifest 校验和 ready JSON**

```go
type Manifest struct {
    RuntimeID string `json:"runtimeId"`
    Archive   string `json:"archive"`
    SHA256    string `json:"sha256"`
}

func ValidateManifest(m Manifest) error {
    if !runtimeIDPattern.MatchString(m.RuntimeID) { return errors.New("invalid runtimeId") }
    if !isSafeRelativeWindowsPath(m.Archive) { return errors.New("invalid archive path") }
    if !sha256Pattern.MatchString(m.SHA256) { return errors.New("invalid sha256") }
    return nil
}

func ValidatePackage(baseDir string, m Manifest) error {
    if err := ValidateManifest(m); err != nil { return err }
    data, err := os.ReadFile(filepath.Join(baseDir, filepath.FromSlash(m.Archive)))
    if err != nil { return errors.New("archive unavailable") }
    actual := fmt.Sprintf("%x", sha256.Sum256(data))
    if subtle.ConstantTimeCompare([]byte(actual), []byte(strings.ToLower(m.SHA256))) != 1 {
        return errors.New("archive hash mismatch")
    }
    return nil
}
```

`main.go` 只接受 `--manifest <path>`，成功输出 `{"status":"ready","candidate":"go"}`；错误只输出固定错误码，不回显绝对路径或 manifest 原文。

- [ ] **Step 4: 运行 GREEN，再交叉编译 Windows x64**

Run: `cd product/benchmarks/launcher/go && go test ./...`

Expected: PASS。

Run: `cd product/benchmarks/launcher/go && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o ../../../.tmp/go/u-claw-launcher-go.exe .`

Expected: 生成 PE32+ x86-64 单 EXE。

- [ ] **Step 5: 提交**

```bash
git add product/benchmarks/launcher/go
git commit -m "test(packaging): add Go launcher benchmark candidate"
```

### Task 3：实现 .NET 8 NativeAOT 一次性小样

**Files:**
- Create: `product/benchmarks/launcher/dotnet/UClaw.Launcher.Benchmark.csproj`
- Create: `product/benchmarks/launcher/dotnet/Program.cs`
- Create: `product/benchmarks/launcher/dotnet/ManifestValidator.cs`
- Create: `product/benchmarks/launcher/dotnet/ManifestValidatorTests.cs`

- [ ] **Step 1: 先写无外部测试包的 self-test**

```csharp
internal static class ManifestValidatorTests
{
    public static void Run()
    {
        AssertAccepted(new Manifest("openclaw-2026.7.1-2-win-x64", "runtime.pkg", new string('a', 64)));
        foreach (var path in new[] { "../runtime.pkg", @"C:\runtime.pkg", @"\\server\share\runtime.pkg", "/runtime.pkg" })
            AssertRejected(new Manifest("openclaw-2026.7.1-2-win-x64", path, new string('a', 64)));
        AssertRejected(new Manifest("openclaw-2026.7.1-2-win-x64", "runtime.pkg", "abc"));
    }
}
```

- [ ] **Step 2: 在 Windows Runner 执行 RED**

Run: `dotnet run --project product/benchmarks/launcher/dotnet -- --self-test`

Expected: FAIL，`ManifestValidator` 未定义。macOS 当前无 `dotnet`，本 RED 必须由 workflow 证据记录。

- [ ] **Step 3: 实现与 Go 相同的校验与输出**

```xml
<PropertyGroup>
  <OutputType>Exe</OutputType>
  <TargetFramework>net8.0</TargetFramework>
  <RuntimeIdentifier>win-x64</RuntimeIdentifier>
  <PublishAot>true</PublishAot>
  <SelfContained>true</SelfContained>
  <InvariantGlobalization>true</InvariantGlobalization>
  <StripSymbols>true</StripSymbols>
</PropertyGroup>
```

`Program.cs` 支持 `--self-test` 和 `--manifest <path>`；成功输出 `{"status":"ready","candidate":"dotnet"}`，失败只输出固定错误码。

- [ ] **Step 4: 在 Windows Runner 运行 GREEN 和 NativeAOT publish**

Run: `dotnet run --project product/benchmarks/launcher/dotnet -- --self-test`

Run: `dotnet publish product/benchmarks/launcher/dotnet -c Release -r win-x64 -o product/.tmp/dotnet /p:PublishAot=true`

Expected: self-test PASS；输出目录存在单个主 EXE，无 `.dll` 运行依赖。

- [ ] **Step 5: 提交**

```bash
git add product/benchmarks/launcher/dotnet
git commit -m "test(packaging): add NativeAOT launcher benchmark candidate"
```

### Task 4：实现统一 PowerShell 基准运行器

**Files:**
- Create: `product/tests/windows/launcher-benchmark.ps1`
- Create: `product/tests/packaging/fixtures/launcher-trial.example.json`
- Modify: `product/scripts/launcher-benchmark-report.test.mjs`

- [ ] **Step 1: 先写脚本结构和示例报告失败测试**

```js
test("Windows harness contains every mandatory case and no elevation", async () => {
  const source = await readFile(new URL("../tests/windows/launcher-benchmark.ps1", import.meta.url), "utf8");
  for (const marker of ["valid-manifest", "invalid-sha256", "path-traversal", "absolute-path", "unicode-space-path", "sdk-path-removed"])
    assert.match(source, new RegExp(marker));
  assert.doesNotMatch(source, /RunAs|Start-Process[^\n]+-Verb/i);
});
```

- [ ] **Step 2: 运行 RED**

Run: `cd product && node --test scripts/launcher-benchmark-report.test.mjs`

Expected: FAIL，PowerShell 脚本不存在。

- [ ] **Step 3: 实现同机比较和安全检查**

```powershell
param(
  [Parameter(Mandatory=$true)][string]$GoExe,
  [Parameter(Mandatory=$true)][string]$DotnetExe,
  [Parameter(Mandatory=$true)][ValidateRange(5,100)][int]$Iterations,
  [Parameter(Mandatory=$true)][ValidateSet(1,2,3)][int]$Trial,
  [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# 创建“基准 中文路径”隔离目录；为两个 EXE 生成相同 fixture。
# 用 Stopwatch 采集 20 次新进程启动，验证 exit code 和 ready JSON。
# 测试 invalid SHA-256、.. traversal、drive absolute、UNC path。
# 执行时临时移除 Go/dotnet SDK PATH，不修改机器级环境。
# 报告不写入实际绝对路径或用户名。
```

- [ ] **Step 4: 在 Windows 运行 GREEN**

Run: `pwsh -NoProfile -File product/tests/windows/launcher-benchmark.ps1 -GoExe product/.tmp/go/u-claw-launcher-go.exe -DotnetExe product/.tmp/dotnet/UClaw.Launcher.Benchmark.exe -Iterations 20 -Trial 1 -OutputPath product/.tmp/trial-1.json`

Expected: exit 0；报告通过 `validateTrialReport`；全部 mandatory case 为 `true`。

- [ ] **Step 5: 提交**

```bash
git add product/tests/windows/launcher-benchmark.ps1 \
  product/tests/packaging/fixtures/launcher-trial.example.json \
  product/scripts/launcher-benchmark-report.test.mjs
git commit -m "test(packaging): add Windows launcher benchmark harness"
```

### Task 5：实现三台独立 Windows Runner 与聚合

**Files:**
- Create: `.github/workflows/launcher-benchmark.yml`
- Modify: `product/scripts/launcher-benchmark-report.mjs`
- Modify: `product/scripts/launcher-benchmark-report.test.mjs`

- [ ] **Step 1: 先写 workflow 安全与并行结构失败测试**

```js
test("workflow uses three independent Windows trials without secrets", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/launcher-benchmark.yml", import.meta.url), "utf8");
  assert.match(workflow, /matrix:[\s\S]*trial:\s*\[1, 2, 3\]/);
  assert.match(workflow, /runs-on:\s*windows-2022/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.match(workflow, /launcher-benchmark-trial-\$\{\{ matrix\.trial \}\}/);
});
```

- [ ] **Step 2: 运行 RED**

Run: `cd product && node --test scripts/launcher-benchmark-report.test.mjs`

Expected: FAIL，workflow 不存在。

- [ ] **Step 3: 实现 workflow**

```yaml
name: Launcher benchmark
on:
  workflow_dispatch:
  pull_request:
    paths:
      - '.github/workflows/launcher-benchmark.yml'
      - 'product/benchmarks/launcher/**'
      - 'product/tests/windows/launcher-benchmark*'
      - 'product/scripts/launcher-benchmark-report*'
permissions:
  contents: read
jobs:
  benchmark:
    strategy:
      fail-fast: false
      matrix:
        trial: [1, 2, 3]
    runs-on: windows-2022
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: '1.24.4' }
      - uses: actions/setup-dotnet@v4
        with: { dotnet-version: '8.0.408' }
      - uses: actions/setup-node@v4
        with: { node-version: '24.15.0' }
      - name: Build Go candidate
        shell: pwsh
        run: |
          New-Item -ItemType Directory -Force product/.tmp/go | Out-Null
          Push-Location product/benchmarks/launcher/go
          go test ./...
          $env:GOOS = 'windows'; $env:GOARCH = 'amd64'; $env:CGO_ENABLED = '0'
          go build -trimpath -ldflags='-s -w' -o ../../../.tmp/go/u-claw-launcher-go.exe .
          Pop-Location
      - name: Build NativeAOT candidate
        shell: pwsh
        run: |
          dotnet run --project product/benchmarks/launcher/dotnet -- --self-test
          dotnet publish product/benchmarks/launcher/dotnet -c Release -r win-x64 -o product/.tmp/dotnet /p:PublishAot=true
      - name: Run benchmark trial
        shell: pwsh
        run: |
          pwsh -NoProfile -File product/tests/windows/launcher-benchmark.ps1 -GoExe product/.tmp/go/u-claw-launcher-go.exe -DotnetExe product/.tmp/dotnet/UClaw.Launcher.Benchmark.exe -Iterations 20 -Trial ${{ matrix.trial }} -OutputPath product/.tmp/trial-${{ matrix.trial }}.json
          node product/scripts/launcher-benchmark-report.mjs validate product/.tmp/trial-${{ matrix.trial }}.json
      - uses: actions/upload-artifact@v4
        with:
          name: launcher-benchmark-trial-${{ matrix.trial }}
          path: product/.tmp/trial-${{ matrix.trial }}.json
  aggregate:
    needs: benchmark
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { pattern: 'launcher-benchmark-trial-*', path: 'product/.tmp/reports', merge-multiple: true }
      - uses: actions/setup-node@v4
        with: { node-version: '24.15.0' }
      - name: Produce provisional decision
        run: >-
          node product/scripts/launcher-benchmark-report.mjs decide
          product/.tmp/reports/trial-1.json
          product/.tmp/reports/trial-2.json
          product/.tmp/reports/trial-3.json
          --output product/.tmp/reports/decision.json
      - uses: actions/upload-artifact@v4
        with:
          name: launcher-benchmark-decision
          path: product/.tmp/reports/*.json
```

- [ ] **Step 4: 在 GitHub Actions 运行 GREEN**

Run: push branch, then `gh workflow run launcher-benchmark.yml --ref codex/task9-launcher-benchmark`

Expected: 3 个 Windows trial 全绿；aggregate 产生 `decision.json`；artifact 包含 3 份 trial report 和 1 份 provisional decision。未获得推送授权时，只完成 workflow 静态验证，不虚标 Windows GREEN。

- [ ] **Step 5: 提交**

```bash
git add .github/workflows/launcher-benchmark.yml \
  product/scripts/launcher-benchmark-report.mjs \
  product/scripts/launcher-benchmark-report.test.mjs
git commit -m "ci(packaging): benchmark launcher candidates on Windows"
```

### Task 6：固定复现命令和最终门禁

**Files:**
- Create: `product/benchmarks/launcher/README.md`
- Modify: `product/package.json`

- [ ] **Step 1: 写明一条 Windows 本地复现命令**

README 必须包含：SDK 精确版本、Go/.NET 构建命令、PowerShell 运行命令、JSON 输出路径、基准不等于实机验收的警告。

- [ ] **Step 2: 添加本地静态门禁脚本**

```json
{
  "scripts": {
    "test:launcher-benchmark": "node --test scripts/launcher-benchmark-report.test.mjs"
  }
}
```

- [ ] **Step 3: 运行当前平台可执行门禁**

Run: `cd product && npm run test:launcher-benchmark && npm test && npm run typecheck && npm run build`

Expected: 全部 exit 0。

Run: `cd product/benchmarks/launcher/go && go test ./...`

Expected: PASS。

- [ ] **Step 4: 运行清洁度检查**

Run: `git diff --check && git status --short`

Expected: 只有本 Task 预期文件；无 EXE、NativeAOT 中间产物、trial report 或用户绝对路径被跟踪。

- [ ] **Step 5: 提交**

```bash
git add product/benchmarks/launcher/README.md product/package.json
git commit -m "docs(packaging): document launcher benchmark reproduction"
```

## 完成条件

- macOS 可运行的 Node/Go 测试、全仓单测、typecheck、build 全绿。
- Workflow 静态结构已验证，不使用 secrets，三个 trial 为独立 Windows job。
- 若已获得推送/运行 Actions 授权：3 份 Windows trial 和 provisional decision artifact 存在且全绿。
- 若未获得外部执行授权：Task 9A 标记为“实现完成，Windows Runner 待运行”，不输出选型结论。
- 不更新 Task 9/10 整体完成状态，不声称真实 U 盘、Defender、普通用户或 Win10/Win11 实机验收通过。
