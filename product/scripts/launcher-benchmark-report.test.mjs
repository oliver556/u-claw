import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { decideLauncher, validateTrialReport } from "./launcher-benchmark-report.mjs";

const scriptPath = fileURLToPath(new URL("./launcher-benchmark-report.mjs", import.meta.url));
const schemaUrl = new URL("../tests/windows/launcher-benchmark.schema.json", import.meta.url);
const harnessUrl = new URL("../tests/windows/launcher-benchmark.ps1", import.meta.url);
const behaviorTestUrl = new URL(
  "../tests/windows/launcher-benchmark-behavior.ps1",
  import.meta.url,
);
const workflowUrl = new URL("../../.github/workflows/launcher-benchmark.yml", import.meta.url);
const launcherReadmeUrl = new URL("../benchmarks/launcher/README.md", import.meta.url);
const goManifestUrl = new URL("../benchmarks/launcher/go/app.manifest", import.meta.url);
const dotnetManifestUrl = new URL("../benchmarks/launcher/dotnet/app.manifest", import.meta.url);
const dotnetProjectUrl = new URL(
  "../benchmarks/launcher/dotnet/UClaw.Launcher.Benchmark.csproj",
  import.meta.url,
);
const fixtureUrl = new URL(
  "../tests/packaging/fixtures/launcher-trial.example.json",
  import.meta.url,
);
const reportSchema = JSON.parse(await readFile(schemaUrl, "utf8"));
const validateSchema = new Ajv2020({ allErrors: true }).compile(reportSchema);

const mandatoryCaseNames = [
  "valid-manifest",
  "invalid-sha256",
  "path-traversal",
  "absolute-path",
  "absolute-path-unc",
  "unicode-space-path",
  "sdk-path-removed",
  "cli-invalid-arguments",
];

function mandatoryCases(overrides = {}) {
  return {
    ...Object.fromEntries(mandatoryCaseNames.map((name) => [name, true])),
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    exeBytes: 8_000_000,
    buildMs: 1_000,
    p50Ms: 20,
    p95Ms: 30,
    mandatoryPassed: true,
    cases: mandatoryCases(),
    toolchainVersion: "test",
    ...overrides,
  };
}

function makeTrial(trial, overrides = {}) {
  return {
    schemaVersion: 1,
    trial,
    measurementKind: "hosted-runner-process-start",
    commitSha: "a".repeat(40),
    runner: { os: "Windows", arch: "X64", cpu: `runner-${trial}` },
    candidates: {
      go: candidate(overrides.go),
      dotnet: candidate(overrides.dotnet),
    },
  };
}

function reports(overrides = {}) {
  return [1, 2, 3].map((trial) => makeTrial(trial, overrides));
}

function runCli(...args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8" });
}

function nearestRank(values, percentile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

test("accepts a complete trial report", () => {
  const report = makeTrial(1);
  assert.equal(validateTrialReport(report), report);
});

test("example launcher trial fixture satisfies the frozen report contract", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  assert.equal(validateSchema(fixture), true, JSON.stringify(validateSchema.errors));
  assert.equal(validateTrialReport(fixture), fixture);
  assert.equal(fixture.measurementKind, "hosted-runner-process-start");
  assert.doesNotMatch(JSON.stringify(fixture), /[A-Z]:\\|\\\\|\/Users\/|\/home\//);
});

test("PowerShell harness has strict bounded parameters and no elevation or persistence", async () => {
  const source = await readFile(harnessUrl, "utf8");
  assert.match(source, /Set-StrictMode -Version Latest/);
  assert.match(source, /\$ErrorActionPreference\s*=\s*['"]Stop['"]/);
  for (const parameter of ["GoExe", "DotnetExe", "Iterations", "Trial", "OutputPath"]) {
    assert.match(source, new RegExp(`\\[Parameter\\(Mandatory\\)\\][\\s\\S]{0,160}\\$${parameter}\\b`));
  }
  assert.match(source, /\[ValidateRange\(5, 100\)\][\s\S]{0,80}\$Iterations\b/);
  assert.match(source, /\[ValidateRange\(1, 3\)\][\s\S]{0,80}\$Trial\b/);
  assert.doesNotMatch(source, /Start-Process\s+[^\r\n]*-Verb\s+RunAs|\bRunAs\b/i);
  assert.doesNotMatch(source, /SetEnvironmentVariable\([^\r\n]*(Machine|User)|\bsetx\b|HKLM:|HKCU:/i);
});

test("PowerShell harness locks symmetric mandatory cases and safe fixed errors", async () => {
  const source = await readFile(harnessUrl, "utf8");
  for (const caseName of [
    "valid-manifest",
    "invalid-sha256",
    "path-traversal",
    "absolute-path",
    "absolute-path-unc",
    "unicode-space-path",
    "sdk-path-removed",
    "cli-invalid-arguments",
  ]) {
    assert.match(source, new RegExp(`['"]${caseName}['"]`));
  }
  assert.match(source, /foreach\s*\(\$candidate\s+in\s+\$candidates\)/i);
  assert.match(source, /E_MANIFEST_INVALID/);
  assert.match(source, /E_PACKAGE_INVALID/);
  assert.match(source, /E_ARGUMENTS/);
  assert.match(source, /LAUNCHER_BENCHMARK_[A-Z_]+/);
  assert.doesNotMatch(source, /Write-(Host|Verbose|Debug|Warning)/i);
});

test("PowerShell harness consumes strict auditable build sidecars", async () => {
  const source = await readFile(harnessUrl, "utf8");
  assert.match(source, /\$ExecutablePath\s*\+\s*['"]\.build\.json['"]/);
  for (const field of ["schemaVersion", "candidate", "commitSha", "buildMs", "toolchainVersion"]) {
    assert.match(source, new RegExp(`['"]${field}['"]`));
  }
  assert.match(source, /IsNaN/);
  assert.match(source, /IsInfinity/);
  assert.ok(source.includes('"\\\\A[0-9a-f]{40}\\\\z"'));
  assert.match(source, /new UTF8Encoding\(false, true\), false/);
  assert.match(source, /GITHUB_SHA/);
  assert.match(source, /rev-parse[\s\S]{0,80}HEAD/);
  assert.match(source, /class StrictJsonReader/);
  assert.match(source, /ReadString\(\)/);
  assert.match(source, /ReadNumber\(\)/);
  assert.match(source, /members\.ContainsKey/);
  assert.match(source, /Add-Type/);
  assert.match(source, /function Initialize-BuildMetadataParser/);
  assert.match(source, /LAUNCHER_BENCHMARK_METADATA_PARSER_INIT/);
  assert.match(source, /LAUNCHER_BENCHMARK_METADATA_PARSER_PARSE/);
  assert.match(source, /LAUNCHER_BENCHMARK_BEHAVIOR_DIAGNOSTICS/);
  assert.match(source, /function Write-BenchmarkDiagnostic/);
  assert.match(source, /Write-BenchmarkDiagnostic 'GO_METADATA_READ'/);
  assert.match(source, /Write-BenchmarkDiagnostic 'REPORT_WRITTEN'/);
  assert.match(source, /Console\]::Error\.WriteLine\(['"]LAUNCHER_BENCHMARK_METADATA_PARSER_(?:INIT|PARSE)['"]\)/);
  assert.match(source, /try\s*\{[\s\S]{0,600}Initialize-BuildMetadataParser[\s\S]{0,600}LauncherBuildMetadataParser\]::Parse/);
  assert.doesNotMatch(source, /System\.Runtime\.Serialization|System\.Xml\.Linq|JsonReaderWriterFactory|XElement/);
  assert.doesNotMatch(source, /ReadAllText\([^\r\n]*\)\s*\|\s*ConvertFrom-Json/);
  assert.doesNotMatch(source, /LastWriteTime|CreationTime|buildMs\s*=\s*0\b/);
});

test("PowerShell harness stays compatible with Windows PowerShell 5.1", async () => {
  const source = await readFile(harnessUrl, "utf8");
  assert.match(source, /function ConvertTo-WindowsCommandLineArgument/);
  assert.match(source, /CreateProcessW/);
  assert.match(source, /CREATE_UNICODE_ENVIRONMENT/);
  assert.match(source, /BuildEnvironmentBlock/);
  assert.match(source, /\[Security\.Cryptography\.SHA256\]::Create\(\)/);
  assert.match(source, /\[BitConverter\]::ToString/);
  assert.match(source, /\$backslashes \* 2 \+ 1/);
  assert.match(source, /\$backslashes \* 2/);
  assert.doesNotMatch(source, /GetFullPath\(\$InputPath\s*,|\.ArgumentList\b|\.Environment\[['"]PATH['"]\]|\.Kill\(\$true\)|SHA256\]::HashData|\[Convert\]::ToHexString/);
});

test("Windows launcher workflow has pinned tools, isolated trials, and safe triggers", async () => {
  const workflowSource = await readFile(workflowUrl, "utf8");
  assert.match(workflowSource, /workflow_dispatch:/);
  assert.match(workflowSource, /pull_request:[\s\S]*paths:/);
  assert.match(workflowSource, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflowSource, /runs-on:\s*windows-2022/);
  assert.match(workflowSource, /fail-fast:\s*false/);
  assert.match(workflowSource, /trial:\s*\[1,\s*2,\s*3\]/);
  assert.match(workflowSource, /runs-on:\s*ubuntu-latest/);
  assert.match(workflowSource, /benchmark:[\s\S]*timeout-minutes:\s*45/);
  assert.match(workflowSource, /aggregate:[\s\S]*timeout-minutes:\s*10/);
  assert.equal(
    [...workflowSource.matchAll(/uses:\s*actions\/checkout@v4\s*\n\s*with:\s*\n\s*persist-credentials:\s*false/g)].length,
    2,
  );
  for (const action of [
    "actions/checkout@v4",
    "actions/setup-go@v5",
    "actions/setup-dotnet@v4",
    "actions/setup-node@v4",
    "actions/upload-artifact@v4",
    "actions/download-artifact@v4",
  ]) {
    assert.match(workflowSource, new RegExp(action.replace("/", "\\/")));
  }
  assert.match(workflowSource, /node-version:\s*['"]?24\.15\.0/);
  assert.match(workflowSource, /go-version:\s*['"]?1\.24\.4/);
  assert.match(workflowSource, /dotnet-version:\s*['"]?8\.0\.408/);
  assert.doesNotMatch(workflowSource, /pull_request_target|\bsecrets\b|RunAs|Start-Process[^\n]*-Verb/i);
});

test("Windows launcher workflow builds measured sidecars and validates every trial", async () => {
  const workflowSource = await readFile(workflowUrl, "utf8");
  assert.match(workflowSource, /CGO_ENABLED[^\n]*0/);
  assert.match(workflowSource, /GOOS[^\n]*windows/);
  assert.match(workflowSource, /GOARCH[^\n]*amd64/);
  assert.match(workflowSource, /go test/);
  assert.match(workflowSource, /dotnet[^\n]*--self-test/);
  assert.match(workflowSource, /dotnet publish/);
  assert.match(workflowSource, /PublishAot=true/);
  assert.match(
    workflowSource,
    /publishedExecutables\s*=\s*@\(Get-ChildItem[^\n]*-Filter\s+['"]\*\.exe['"][^\n]*-File[^\n]*-Recurse/,
  );
  assert.match(workflowSource, /Stopwatch/);
  assert.match(workflowSource, /go version/);
  assert.match(workflowSource, /dotnet --version/);
  assert.match(workflowSource, /\.build\.json/);
  for (const field of ["schemaVersion", "candidate", "commitSha", "buildMs", "toolchainVersion"]) {
    assert.match(workflowSource, new RegExp(field));
  }
  assert.doesNotMatch(workflowSource, /buildMs\s*[:=]\s*0\b/);
  assert.match(workflowSource, /-Iterations\s+20/);
  assert.match(workflowSource, /-Trial\s+['"]?\$\{\{ matrix\.trial \}\}/);
  assert.match(workflowSource, /launcher-benchmark-report\.mjs validate/);
});

test("launcher candidates declare explicit asInvoker application manifests", async () => {
  const [goManifest, dotnetManifest, project] = await Promise.all([
    readFile(goManifestUrl, "utf8"),
    readFile(dotnetManifestUrl, "utf8"),
    readFile(dotnetProjectUrl, "utf8"),
  ]);
  for (const manifest of [goManifest, dotnetManifest]) {
    assert.equal((manifest.match(/requestedExecutionLevel/g) ?? []).length, 1);
    assert.match(manifest, /requestedExecutionLevel\s+level="asInvoker"\s+uiAccess="false"/);
    assert.doesNotMatch(manifest, /requireAdministrator|highestAvailable/);
  }
  assert.match(project, /<ApplicationManifest>app\.manifest<\/ApplicationManifest>/);
  assert.match(project, /<PublishAot>true<\/PublishAot>/);
  assert.doesNotMatch(project, /<PublishSingleFile>true<\/PublishSingleFile>/);
});

test("Windows workflow embeds and structurally gates both asInvoker manifests", async () => {
  const workflowSource = await readFile(workflowUrl, "utf8");
  const generateIndex = workflowSource.indexOf("go run github.com/akavel/rsrc@v0.10.2");
  const stopwatchIndex = workflowSource.indexOf("$stopwatch = [Diagnostics.Stopwatch]::StartNew()", generateIndex);
  assert.ok(generateIndex >= 0 && generateIndex < stopwatchIndex);
  assert.match(workflowSource, /go run github\.com\/akavel\/rsrc@v0\.10\.2[^\n]*-manifest app\.manifest[^\n]*-arch amd64[^\n]*-o rsrc_windows_amd64\.syso/);
  assert.match(workflowSource, /finally[\s\S]{0,240}Remove-Item[^\n]*rsrc_windows_amd64\.syso/);
  assert.match(workflowSource, /ProgramFiles\(x86\)[\s\S]*Windows Kits[\\/]10[\\/]bin/);
  assert.match(workflowSource, /Sort-Object[^\n]*\[version\]/);
  assert.match(workflowSource, /mt\.exe/);
  assert.match(workflowSource, /SelectNodes\([^\n]*requestedExecutionLevel/);
  assert.match(workflowSource, /GetAttribute\(['"]level['"]\)[^\n]*asInvoker/);
  assert.match(workflowSource, /GetAttribute\(['"]uiAccess['"]\)[^\n]*false/);
  assert.match(workflowSource, /foreach\s*\(\$executable\s+in\s+@\(\$goExe,\s*\$dotnetExe\)\)/);
  const gateIndex = workflowSource.indexOf("Verify asInvoker application manifests");
  const behaviorIndex = workflowSource.indexOf("behavior compatibility gate");
  const formalIndex = workflowSource.indexOf("Run formal benchmark trial");
  assert.ok(gateIndex >= 0 && gateIndex < behaviorIndex && gateIndex < formalIndex);
  assert.doesNotMatch(workflowSource, /RunAs|requireAdministrator|highestAvailable/i);
});

test("Windows workflow runs launcher Node tests before candidate builds", async () => {
  const workflowSource = await readFile(workflowUrl, "utf8");
  const installIndex = workflowSource.indexOf("npm ci --ignore-scripts --prefix product");
  const testIndex = workflowSource.indexOf("npm run test:launcher-benchmark --prefix product");
  const buildIndex = workflowSource.indexOf("name: Build and test Go candidate");
  assert.ok(installIndex >= 0 && installIndex < testIndex && testIndex < buildIndex);
});

test("launcher reproduction documents resource generation and asInvoker gate", async () => {
  const source = await readFile(launcherReadmeUrl, "utf8");
  assert.match(source, /github\.com\/akavel\/rsrc@v0\.10\.2/);
  assert.match(source, /rsrc_windows_amd64\.syso/);
  assert.match(source, /mt\.exe/);
  assert.match(source, /asInvoker/);
  assert.match(source, /uiAccess="false"/);
});

test("Windows harness workflow gates PowerShell 5.1 and pwsh with behavior tests", async () => {
  const workflowSource = await readFile(workflowUrl, "utf8");
  assert.match(workflowSource, /shell:\s*powershell\b/);
  assert.match(workflowSource, /shell:\s*pwsh\b/);
  assert.match(workflowSource, /launcher-benchmark-behavior\.ps1/g);
});

test("Windows workflow uploads unique trials and aggregates exactly four JSON files", async () => {
  const workflowSource = await readFile(workflowUrl, "utf8");
  assert.match(workflowSource, /name:\s*launcher-benchmark-trial-\$\{\{ matrix\.trial \}\}/);
  assert.match(workflowSource, /needs:\s*benchmark/);
  assert.match(workflowSource, /pattern:\s*launcher-benchmark-trial-\*/);
  assert.match(workflowSource, /merge-multiple:\s*true/);
  assert.match(workflowSource, /launcher-benchmark-report\.mjs decide[\s\S]*trial-1\.json[\s\S]*trial-2\.json[\s\S]*trial-3\.json[\s\S]*--output[\s\S]*decision\.json/);
  assert.match(workflowSource, /path:\s*\|[\s\S]*trial-1\.json[\s\S]*trial-2\.json[\s\S]*trial-3\.json[\s\S]*decision\.json/);
});

test("Windows workflow uploads diagnostics before mandatory gate and gates aggregation", async () => {
  const workflowSource = await readFile(workflowUrl, "utf8");
  const aggregateIndex = workflowSource.indexOf("\n  aggregate:");
  const benchmarkSource = workflowSource.slice(0, aggregateIndex);
  const aggregateSource = workflowSource.slice(aggregateIndex);
  const validateIndex = benchmarkSource.indexOf("launcher-benchmark-report.mjs validate");
  const uploadIndex = benchmarkSource.indexOf("name: Upload isolated trial report");
  const gateIndex = benchmarkSource.indexOf("launcher-benchmark-report.mjs require-mandatory");
  assert.ok(validateIndex >= 0 && validateIndex < uploadIndex && uploadIndex < gateIndex);
  assert.match(aggregateSource, /needs:\s*benchmark/);
  assert.equal(
    [...aggregateSource.matchAll(/launcher-benchmark-report\.mjs require-mandatory/g)].length,
    3,
  );
  assert.ok(
    aggregateSource.lastIndexOf("launcher-benchmark-report.mjs require-mandatory")
      < aggregateSource.indexOf("launcher-benchmark-report.mjs decide"),
  );
});

test("Windows behavior test covers Task 4 compatibility cases", async () => {
  const source = await readFile(behaviorTestUrl, "utf8");
  assert.match(source, /Iterations['"],\s*['"]7/);
  assert.match(source, /p50Ms[\s\S]*p95Ms/);
  assert.match(source, /LAUNCHER_BENCHMARK_FAKE_TIMING_ROOT/);
  assert.match(source, /\$p50\s+-ge\s+220[\s\S]*\$p50\s+-le\s+500/);
  assert.match(source, /\$p95\s+-ge\s+1850[\s\S]*\$p95\s+-le\s+2400/);
  assert.match(source, /duplicate/i);
  assert.match(source, /null/i);
  assert.match(source, /unknown/i);
  assert.match(source, /invalid escape/i);
  assert.match(source, /utf-16/i);
  assert.match(source, /invalid utf-8/i);
  assert.match(source, /escaped newline sha/i);
  assert.match(source, /\$behaviorPhase\s*=\s*['"]VALID_METADATA['"]/);
  assert.match(source, /VALID_METADATA['"]\s*\+\s*['"]_['"]\s*\+\s*\$fixedCode/);
  assert.match(source, /\[regex\]::Matches\([^\r\n]*LAUNCHER_BENCHMARK_DIAGNOSTIC_/i);
  assert.match(source, /\$behaviorPhase\s*=\s*['"]INVALID_UTF8['"]/);
  assert.match(source, /\$script:behaviorPhase\s*=\s*['"]HARNESS_PROCESS_TIMEOUT['"]/);
  assert.match(source, /::error title=Launcher benchmark behavior gate::['"]\s*\+\s*\$failureCode/);
  assert.doesNotMatch(source, /\$_\.Exception\.(Message|StackTrace)/);
  assert.match(source, /relative/i);
  assert.match(source, /trailing-backslash/i);
  assert.match(source, /fake-child/i);
  assert.match(source, /PROCESS_CAPTURE_TIMEOUT/);
  assert.match(source, /Get-Process/);
  assert.doesNotMatch(source, /RunAs|SetEnvironmentVariable\([^\n]*(Machine|User)|\bsetx\b|HKLM:|HKCU:/i);
});

test("Windows behavior test bounds harness processes and kills timeout trees", async () => {
  const source = await readFile(behaviorTestUrl, "utf8");
  assert.match(source, /Start-Process[\s\S]{0,300}-PassThru/);
  assert.doesNotMatch(source, /Start-Process[^\n]*-Wait/);
  assert.match(source, /WaitForExit\(120000\)/);
  assert.doesNotMatch(source, /WaitForExit\(\)/);
  assert.match(source, /taskkill\.exe[\s\S]{0,300}\/T[\s\S]{0,100}\/F/i);
  assert.match(source, /LAUNCHER_BENCHMARK_BEHAVIOR_TIMEOUT/);
});

test("PowerShell harness uses exact process capture, timeout, cleanup, and PATH restoration", async () => {
  const source = await readFile(harnessUrl, "utf8");
  assert.match(source, /CreatePipe/);
  assert.match(source, /SetHandleInformation/);
  assert.match(source, /PROC_THREAD_ATTRIBUTE_HANDLE_LIST/);
  assert.match(source, /SafeFileHandle/);
  assert.match(source, /CountdownEvent/);
  assert.match(source, /DeleteProcThreadAttributeList/);
  assert.match(source, /Marshal\.FreeHGlobal/);
  assert.match(source, /Task\.Factory\.StartNew[\s\S]{0,500}ReadToEnd\(\)/);
  assert.match(source, /WaitForExit\(\$TimeoutMs\)/);
  assert.match(source, /TerminateProcess/);
  assert.match(source, /WaitForSingleObject/);
  assert.match(source, /\[Threading\.Tasks\.Task\]::WaitAll\([^\r\n]*\$CaptureTimeoutMs\)/);
  assert.doesNotMatch(source, /Diagnostics\.ProcessStartInfo|\.ArgumentList\b|taskkill\.exe|Thread\.Sleep|Start-Sleep/);
  assert.match(source, /\[Diagnostics\.Stopwatch\]::StartNew\(\)/);
  assert.match(source, /finally[\s\S]{0,240}Remove-Item\s+-LiteralPath/i);
  assert.match(source, /finally[\s\S]{0,180}\$env:PATH\s*=\s*\$originalPath/i);
  assert.doesNotMatch(source, /&\s*\$[^\r\n]*2>&1|Invoke-Expression|\.\.\//i);
});

test("PowerShell harness contains descendants in a kill-on-close Windows Job Object", async () => {
  const source = await readFile(harnessUrl, "utf8");
  const invokeSource = source.slice(
    source.indexOf("function Invoke-CapturedProcess"),
    source.indexOf("function Resolve-CommitSha"),
  );
  for (const api of [
    "CreateJobObjectW",
    "SetInformationJobObject",
    "AssignProcessToJobObject",
    "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
    "CREATE_SUSPENDED",
    "EXTENDED_STARTUPINFO_PRESENT",
    "ResumeThread",
    "CloseHandle",
  ]) {
    assert.match(source, new RegExp(api));
  }
  assert.match(source, /CreateJobObjectW[\s\S]{0,140}ExactSpelling\s*=\s*true|ExactSpelling\s*=\s*true[\s\S]{0,140}CreateJobObjectW/);
  assert.match(source, /LAUNCHER_BENCHMARK_PROCESS_JOB_FAILED/);
  assert.match(source, /function Initialize-ProcessJob[\s\S]{0,500}Add-Type[\s\S]{0,300}catch[\s\S]{0,200}PROCESS_JOB_FAILED/);
  assert.match(source, /\$job\s*=\s*\[LauncherProcessJob\]::new\(\)[\s\S]{0,200}catch[\s\S]{0,200}PROCESS_JOB_FAILED/);
  assert.match(source, /PrepareCapture[\s\S]{0,500}Task\.Factory\.StartNew[\s\S]{0,500}captureReady\.Wait/);
  assert.match(source, /Task\.Factory\.StartNew[\s\S]{0,200}captureReady\.Signal\(\)[\s\S]{0,100}ReadToEnd\(\)/);
  assert.match(source, /Task\.Factory\.StartNew[\s\S]{0,1000}CreateProcessW[\s\S]{0,1000}AssignProcessToJobObject[\s\S]{0,500}ResumeThread/);
  assert.match(source, /CloseParentWriteHandles\(\)[\s\S]{0,200}WaitForCaptureTasks\(5000\)/);
  assert.match(source, /CreateProcessW[\s\S]{0,500}CloseParentWriteHandles[\s\S]{0,300}AssignProcessToJobObject/);
  assert.match(source, /AssignProcessToJobObject[\s\S]{0,300}TerminateSuspendedProcess/);
  assert.match(source, /ResumeThread[\s\S]{0,300}TerminateSuspendedProcess/);
  assert.doesNotMatch(source, /public void Assign\(/);
  assert.match(source, /finally[\s\S]{0,500}\$job\.Dispose\(\)[\s\S]{0,300}\$runner\.Dispose\(\)/);
  assert.match(source, /\$job\.Dispose\(\)[\s\S]{0,200}\$jobDisposeFailed\s*=\s*\$true[\s\S]{0,300}PROCESS_JOB_FAILED/);
  assert.ok(invokeSource.indexOf("Initialize-ProcessJob") < invokeSource.indexOf("[Diagnostics.Stopwatch]::StartNew()"));
  assert.ok(invokeSource.indexOf("[LauncherProcessJob]::new()") < invokeSource.indexOf("[Diagnostics.Stopwatch]::StartNew()"));
  assert.ok(invokeSource.indexOf("$job.PrepareProcess") < invokeSource.indexOf("[Diagnostics.Stopwatch]::StartNew()"));
  assert.match(invokeSource, /\$runner\.PrepareCapture\(\)\s*\r?\n\s*\$stopwatch\s*=\s*\[Diagnostics\.Stopwatch\]::StartNew\(\)\s*\r?\n\s*\$runner\.Start\(\)/);
  assert.ok(invokeSource.indexOf("$stopwatch.Stop()") < invokeSource.indexOf("return [pscustomobject]"));
  assert.ok(invokeSource.indexOf("return [pscustomobject]") < invokeSource.indexOf("$job.Dispose()"));
});

test("PowerShell harness preserves each candidate's exact newline contract", async () => {
  const source = await readFile(harnessUrl, "utf8");
  assert.match(source, /function Get-CandidateNewline/);
  assert.match(source, /\$CandidateId\s+-ceq\s+['"]go['"][\s\S]{0,80}return\s+['"]`n['"]/);
  assert.match(source, /Get-CandidateNewline \$Candidate\.Id/);
  assert.doesNotMatch(source, /\$newline\s*=\s*\[Environment\]::NewLine/);
});

test("PowerShell harness makes percentile and iteration policy auditable", async () => {
  const source = await readFile(harnessUrl, "utf8");
  assert.match(source, /function Get-Percentile/);
  assert.match(source, /\[Math\]::Ceiling\(\$Percentile\s*\*\s*\$sorted\.Count\)\s*-\s*1/);
  assert.match(source, /p50Ms\s*=\s*\[Math\]::Round\(\(Get-Percentile[^\r\n]+0\.50\)/);
  assert.match(source, /for\s*\(\$iteration\s*=\s*0;\s*\$iteration\s*-lt\s*\$Iterations/i);
  assert.match(source, /\$iteration\s*%\s*2/);
  assert.match(source, /hosted-runner-process-start/);
  assert.doesNotMatch(source, /cold[- ]start/i);
  const seven = [7, 1, 6, 2, 5, 3, 4];
  assert.equal(nearestRank(seven, 0.50), 4);
  assert.equal(nearestRank(seven, 0.95), 7);
});

test("PowerShell harness validates paths and creates report without overwrite", async () => {
  const source = await readFile(harnessUrl, "utf8");
  assert.match(source, /\[IO\.Path\]::IsPathRooted/);
  assert.match(source, /\$workingDirectory\s*=\s*\(Get-Location\)\.ProviderPath/);
  assert.match(source, /\[IO\.Path\]::Combine\(\$workingDirectory, \$InputPath\)/);
  assert.doesNotMatch(source, /IsNullOrWhiteSpace\(\$InputPath\)[^\r\n]*-not \[IO\.Path\]::IsPathRooted/);
  assert.match(source, /FileAttributes\]::ReparsePoint/);
  assert.match(source, /PSIsContainer/);
  assert.match(source, /GetFileName\(\$absolutePath\)/);
  assert.match(source, /GetInvalidFileNameChars\(\)/);
  assert.match(source, /FileMode\]::CreateNew/);
  assert.match(source, /\[IO\.File\]::Move\(/);
  assert.match(source, /ConvertTo-Json/);
  assert.doesNotMatch(source, /\b-Force\b/);
});

test("PowerShell harness normalizes PATH entries and proves SDK commands are absent", async () => {
  const source = await readFile(harnessUrl, "utf8");
  assert.match(source, /function Get-NormalizedPathSegment/);
  assert.match(source, /\.Trim\(\)\.Trim\('"'\)/);
  assert.match(source, /GetFullPath\(\$expanded\)/);
  assert.match(source, /Get-Command\s+@\(['"]go['"],\s*['"]dotnet['"]\)[^\r\n]*SilentlyContinue/);
  assert.match(source, /if\s*\(\$remainingSdkCommands\.Count\s+-ne\s+0\)[\s\S]{0,160}return \$false/);
  assert.match(source, /finally[\s\S]{0,180}\$env:PATH\s*=\s*\$originalPath/);
});

test("PowerShell harness rejects path, username, and temp disclosures before reporting", async () => {
  const source = await readFile(harnessUrl, "utf8");
  assert.match(source, /function Assert-SafeReportValue/);
  assert.match(source, /\$env:USERNAME/);
  assert.match(source, /\[IO\.Path\]::GetTempPath\(\)/);
  assert.match(source, /Assert-SafeReportValue \$cpu/);
  assert.match(source, /Assert-SafeReportValue \$candidate\.Metadata\.toolchainVersion/);
  assert.match(source, /LAUNCHER_BENCHMARK_UNSAFE_REPORT/);
});

test("rejects invalid report fields", () => {
  const invalidReports = [
    ["schemaVersion", { ...makeTrial(1), schemaVersion: 2 }],
    ["trial", { ...makeTrial(1), trial: 0 }],
    ["trial", { ...makeTrial(1), trial: 1.5 }],
    ["measurementKind", { ...makeTrial(1), measurementKind: "cold-start" }],
    ["commitSha", { ...makeTrial(1), commitSha: "A".repeat(40) }],
    ["runner.os", { ...makeTrial(1), runner: { os: "", arch: "X64", cpu: "test" } }],
    ["candidates.go", { ...makeTrial(1), candidates: { dotnet: candidate() } }],
    ["toolchainVersion", makeTrial(1, { go: { toolchainVersion: "" } })],
  ];

  for (const [field, report] of invalidReports) {
    assert.throws(() => validateTrialReport(report), new RegExp(field.replace(".", "\\.")));
  }
});

test("rejects unknown fields at every fixed report level", () => {
  const base = makeTrial(1);
  const invalidReports = [
    { ...base, unexpected: true },
    { ...base, runner: { ...base.runner, unexpected: true } },
    { ...base, candidates: { ...base.candidates, unexpected: candidate() } },
    {
      ...base,
      candidates: { ...base.candidates, go: { ...base.candidates.go, unexpected: true } },
    },
  ];

  for (const report of invalidReports) {
    assert.throws(() => validateTrialReport(report), /unexpected field/);
  }
});

test("rejects non-finite and negative candidate measurements", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
    assert.throws(
      () => validateTrialReport(makeTrial(1, { go: { p95Ms: value } })),
      /candidates\.go\.p95Ms/,
    );
  }
  assert.throws(
    () => validateTrialReport(makeTrial(1, { go: { exeBytes: 1.5 } })),
    /candidates\.go\.exeBytes/,
  );
});

test("rejects empty cases and non-boolean case values", () => {
  assert.throws(
    () => validateTrialReport(makeTrial(1, { go: { cases: {} } })),
    /candidates\.go\.cases/,
  );
  assert.throws(
    () => validateTrialReport(makeTrial(1, { go: { cases: { manifest: "yes" } } })),
    /candidates\.go\.cases\.manifest/,
  );
});

test("requires exactly the eight frozen mandatory case keys", () => {
  const missing = makeTrial(1);
  delete missing.candidates.go.cases[mandatoryCaseNames[0]];
  assert.throws(() => validateTrialReport(missing), /candidates\.go\.cases/);

  const placeholder = makeTrial(1, { go: { cases: { placeholder: true } } });
  assert.throws(() => validateTrialReport(placeholder), /candidates\.go\.cases/);

  const extra = makeTrial(1, { go: { cases: { ...mandatoryCases(), "as-invoker": true } } });
  assert.throws(() => validateTrialReport(extra), /candidates\.go\.cases/);
});

test("rejects mandatoryPassed values that contradict cases", () => {
  for (const go of [
    { mandatoryPassed: true, cases: mandatoryCases({ "valid-manifest": false }) },
    { mandatoryPassed: false, cases: mandatoryCases() },
  ]) {
    assert.throws(
      () => validateTrialReport(makeTrial(1, { go })),
      /candidates\.go/,
    );
  }
});

test("rejects a zero-byte executable", () => {
  assert.throws(
    () => validateTrialReport(makeTrial(1, { go: { exeBytes: 0 } })),
    /candidates\.go\.exeBytes/,
  );
});

test("requires exactly trials 1, 2, and 3 without duplicates", () => {
  assert.throws(() => decideLauncher(reports().slice(0, 2)), /exactly three/);
  assert.throws(
    () => decideLauncher([makeTrial(1), makeTrial(2), makeTrial(2)]),
    /trials 1, 2, and 3/,
  );
});

test("requires all trials to report the same commit SHA", () => {
  const trialReports = reports();
  trialReports[2].commitSha = "b".repeat(40);
  assert.throws(() => decideLauncher(trialReports), /commitSha/);
});

test("eliminates candidates that fail any mandatory trial", () => {
  const failed = {
    mandatoryPassed: false,
    cases: mandatoryCases({ "valid-manifest": false }),
  };
  const trialReports = reports({ go: failed });
  assert.deepEqual(decideLauncher(trialReports), {
    selected: "dotnet",
    reason: "mandatory-elimination",
    summary: {
      go: { mandatoryPassed: false, p95Ms: 30, exeBytes: 8_000_000 },
      dotnet: { mandatoryPassed: true, p95Ms: 30, exeBytes: 8_000_000 },
    },
  });

  const none = reports({ go: failed, dotnet: failed });
  assert.equal(decideLauncher(none).selected, null);
});

test("uses the p95 median margin before executable size", () => {
  const result = decideLauncher(reports({
    go: { p95Ms: 80, exeBytes: 9_000_000 },
    dotnet: { p95Ms: 100, exeBytes: 4_000_000 },
  }));
  assert.equal(result.selected, "go");
  assert.equal(result.reason, "p95-margin");
});

test("selects the faster candidate at the exact decimal p95 threshold", () => {
  const result = decideLauncher(reports({
    go: { p95Ms: 0.8, exeBytes: 8_000_000 },
    dotnet: { p95Ms: 1, exeBytes: 8_000_000 },
  }));
  assert.equal(result.selected, "go");
  assert.equal(result.reason, "p95-margin");
});

test("tolerates decimal representation error at exact p95 thresholds", () => {
  const boundaries = [
    { better: 0.232, worse: 0.29 },
    ...[0.07, 2.3, 12_345.67].map((worse) => ({
      better: worse * (1 - 0.20),
      worse,
    })),
  ];

  for (const { better, worse } of boundaries) {
    const result = decideLauncher(reports({
      go: { p95Ms: better, exeBytes: 8_000_000 },
      dotnet: { p95Ms: worse, exeBytes: 8_000_000 },
    }));
    assert.equal(result.selected, "go", `${better} vs ${worse}`);
    assert.equal(result.reason, "p95-margin", `${better} vs ${worse}`);
  }
});

test("does not treat a clearly sub-threshold p95 margin as 20 percent", () => {
  const result = decideLauncher(reports({
    go: { p95Ms: 0.24, exeBytes: 8_000_000 },
    dotnet: { p95Ms: 0.29, exeBytes: 8_000_000 },
  }));
  assert.equal(result.selected, "go");
  assert.equal(result.reason, "documented-tie-breaker");
});

test("does not let tolerance turn tiny sub-threshold values into a margin", () => {
  for (const better of [1e-20, 9e-21]) {
    const result = decideLauncher(reports({
      go: { p95Ms: better, exeBytes: 8_000_000 },
      dotnet: { p95Ms: 1e-20, exeBytes: 8_000_000 },
    }));
    assert.equal(result.selected, "go", `${better} vs 1e-20`);
    assert.equal(result.reason, "documented-tie-breaker", `${better} vs 1e-20`);
  }
});

test("recognizes exact p95 thresholds at normal and large scales", () => {
  for (const { better, worse } of [
    { better: 0.8, worse: 1 },
    { better: 80, worse: 100 },
    { better: 8e19, worse: 1e20 },
  ]) {
    const result = decideLauncher(reports({
      go: { p95Ms: better, exeBytes: 8_000_000 },
      dotnet: { p95Ms: worse, exeBytes: 8_000_000 },
    }));
    assert.equal(result.selected, "go", `${better} vs ${worse}`);
    assert.equal(result.reason, "p95-margin", `${better} vs ${worse}`);
  }
});

test("uses the executable median size margin when p95 is within 20 percent", () => {
  const result = decideLauncher(reports({
    go: { p95Ms: 30, exeBytes: 6_000_000 },
    dotnet: { p95Ms: 33, exeBytes: 8_000_000 },
  }));
  assert.equal(result.selected, "go");
  assert.equal(result.reason, "size-margin");
});

test("selects the smaller candidate at the exact integer size threshold", () => {
  const result = decideLauncher(reports({
    go: { p95Ms: 1, exeBytes: 3 },
    dotnet: { p95Ms: 1, exeBytes: 4 },
  }));
  assert.equal(result.selected, "go");
  assert.equal(result.reason, "size-margin");
});

test("does not claim a margin when both compared values are zero", () => {
  const result = decideLauncher(reports({
    go: { p95Ms: 0, exeBytes: 8_000_000 },
    dotnet: { p95Ms: 0, exeBytes: 8_000_000 },
  }));
  assert.equal(result.selected, "go");
  assert.equal(result.reason, "documented-tie-breaker");
});

test("uses Go as deterministic tie breaker", () => {
  const trialReports = reports({
    go: { p95Ms: 30, exeBytes: 8_000_000 },
    dotnet: { p95Ms: 33, exeBytes: 7_000_000 },
  });
  const expected = decideLauncher(trialReports);
  assert.equal(expected.selected, "go");
  assert.equal(expected.reason, "documented-tie-breaker");
  assert.deepEqual(decideLauncher([...trialReports].reverse()), expected);
});

test("schema and runtime accept and reject the same report examples", () => {
  const valid = makeTrial(1);
  const examples = [
    [true, valid],
    [false, { ...valid, unexpected: true }],
    [false, makeTrial(1, { go: { exeBytes: 0 } })],
    [false, makeTrial(1, { go: { cases: {} } })],
    [false, makeTrial(1, { go: { cases: { manifest: "yes" } } })],
    [false, makeTrial(1, {
      go: { mandatoryPassed: true, cases: mandatoryCases({ "valid-manifest": false }) },
    })],
    [false, makeTrial(1, {
      go: { mandatoryPassed: false, cases: mandatoryCases() },
    })],
  ];

  for (const [expected, report] of examples) {
    assert.equal(validateSchema(report), expected, JSON.stringify(validateSchema.errors));
    if (expected) {
      assert.equal(validateTrialReport(report), report);
    } else {
      assert.throws(() => validateTrialReport(report));
    }
  }
});

test("CLI validates reports and writes a decision", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "uclaw-launcher-report-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = await Promise.all(reports().map(async (report, index) => {
    const file = path.join(directory, `trial-${index + 1}.json`);
    await writeFile(file, JSON.stringify(report));
    return file;
  }));

  assert.equal(runCli("validate", files[0]).status, 0);
  assert.equal(runCli("require-mandatory", files[0]).status, 0);

  const invalidFile = path.join(directory, "invalid.json");
  await writeFile(invalidFile, JSON.stringify({ ...makeTrial(1), trial: 4 }));
  const invalid = runCli("validate", invalidFile);
  assert.notEqual(invalid.status, 0);
  assert.equal(
    invalid.stderr,
    "LAUNCHER_BENCHMARK_INVALID_REPORT: report validation failed\n",
  );
  assert.doesNotMatch(invalid.stderr, new RegExp(directory.replaceAll("\\", "\\\\")));

  const output = path.join(directory, "decision.json");
  const decision = runCli("decide", ...files, "--output", output);
  assert.equal(decision.status, 0, decision.stderr);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), decideLauncher(reports()));
});

test("CLI mandatory gate rejects one failed candidate before decision", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "uclaw-launcher-gate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const failed = {
    mandatoryPassed: false,
    cases: mandatoryCases({ "valid-manifest": false }),
  };
  const trialReports = [makeTrial(1, { go: failed }), makeTrial(2), makeTrial(3)];
  const files = await Promise.all(trialReports.map(async (report, index) => {
    const file = path.join(directory, `trial-${index + 1}.json`);
    await writeFile(file, JSON.stringify(report));
    return file;
  }));
  const output = path.join(directory, "decision.json");
  let decisionInvoked = false;

  const gate = runCli("require-mandatory", files[0]);
  if (gate.status === 0) {
    decisionInvoked = true;
    runCli("decide", ...files, "--output", output);
  }

  assert.notEqual(gate.status, 0);
  assert.equal(
    gate.stderr,
    "LAUNCHER_BENCHMARK_MANDATORY_FAILED: mandatory benchmark cases failed\n",
  );
  assert.equal(decisionInvoked, false);
  await assert.rejects(readFile(output, "utf8"), { code: "ENOENT" });

  const invalidFile = path.join(directory, "invalid.json");
  await writeFile(invalidFile, JSON.stringify({ ...makeTrial(1), trial: 4 }));
  assert.equal(
    runCli("require-mandatory", invalidFile).stderr,
    "LAUNCHER_BENCHMARK_INVALID_REPORT: report validation failed\n",
  );
});

test("CLI refuses to overwrite an existing decision", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "uclaw-launcher-report-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = await Promise.all(reports().map(async (report, index) => {
    const file = path.join(directory, `trial-${index + 1}.json`);
    await writeFile(file, JSON.stringify(report));
    return file;
  }));
  const output = path.join(directory, "decision.json");
  await writeFile(output, "keep me");

  const result = runCli("decide", ...files, "--output", output);
  assert.notEqual(result.status, 0);
  assert.equal(
    result.stderr,
    "LAUNCHER_BENCHMARK_OUTPUT_EXISTS: output file already exists\n",
  );
  assert.doesNotMatch(result.stderr, new RegExp(directory.replaceAll("\\", "\\\\")));
  assert.equal(await readFile(output, "utf8"), "keep me");
});

test("CLI redacts malformed JSON and file paths", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "uclaw-launcher-secret-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reportFile = path.join(directory, "private-report.json");
  await writeFile(reportFile, "{ SECRET_JSON_FRAGMENT");

  const result = runCli("validate", reportFile);
  assert.notEqual(result.status, 0);
  assert.equal(
    result.stderr,
    "LAUNCHER_BENCHMARK_INVALID_REPORT: report validation failed\n",
  );
  assert.doesNotMatch(result.stderr, /SECRET_JSON_FRAGMENT|private-report|uclaw-launcher-secret/);
});

test("CLI uses a fixed safe usage error", () => {
  const result = runCli("decide", "private-path.json");
  assert.notEqual(result.status, 0);
  assert.equal(
    result.stderr,
    "LAUNCHER_BENCHMARK_USAGE: invalid command arguments\n",
  );
  assert.doesNotMatch(result.stderr, /private-path/);
});
