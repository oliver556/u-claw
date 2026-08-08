import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
const fixtureUrl = new URL(
  "../tests/packaging/fixtures/launcher-trial.example.json",
  import.meta.url,
);
const reportSchema = JSON.parse(await readFile(schemaUrl, "utf8"));
const validateSchema = new Ajv2020({ allErrors: true }).compile(reportSchema);

function candidate(overrides = {}) {
  return {
    exeBytes: 8_000_000,
    buildMs: 1_000,
    p50Ms: 20,
    p95Ms: 30,
    mandatoryPassed: true,
    cases: { "valid-manifest": true },
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
  assert.match(source, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(source, /GITHUB_SHA/);
  assert.match(source, /rev-parse[\s\S]{0,80}HEAD/);
  assert.match(source, /JsonReaderWriterFactory\.CreateJsonReader/);
  assert.match(source, /members\.ContainsKey/);
  assert.match(source, /Add-Type/);
  assert.match(source, /function Initialize-BuildMetadataParser/);
  assert.match(source, /try\s*\{[\s\S]{0,600}Initialize-BuildMetadataParser[\s\S]{0,600}LauncherBuildMetadataParser\]::Parse/);
  assert.match(source, /JsonReaderWriterFactory\]\.Assembly\.Location/);
  assert.match(source, /XElement\]\.Assembly\.Location/);
  assert.doesNotMatch(source, /'System\.Runtime\.Serialization\.dll'|'System\.Xml\.Linq\.dll'/);
  assert.doesNotMatch(source, /ReadAllText\([^\r\n]*\)\s*\|\s*ConvertFrom-Json/);
  assert.doesNotMatch(source, /LastWriteTime|CreationTime|buildMs\s*=\s*0\b/);
});

test("PowerShell harness stays compatible with Windows PowerShell 5.1", async () => {
  const source = await readFile(harnessUrl, "utf8");
  assert.match(source, /function ConvertTo-WindowsCommandLineArgument/);
  assert.match(source, /\.Arguments\s*=\s*\[string\]::Join/);
  assert.match(source, /\.EnvironmentVariables\[['"]PATH['"]\]/);
  assert.match(source, /\[Security\.Cryptography\.SHA256\]::Create\(\)/);
  assert.match(source, /\[BitConverter\]::ToString/);
  assert.match(source, /\$backslashes \* 2 \+ 1/);
  assert.match(source, /\$backslashes \* 2/);
  assert.doesNotMatch(source, /GetFullPath\(\$InputPath\s*,|\.ArgumentList\b|\.Environment\[['"]PATH['"]\]|\.Kill\(\$true\)|SHA256\]::HashData|\[Convert\]::ToHexString/);
});

test("future Windows harness workflow must gate PowerShell 5.1 and pwsh", async (t) => {
  const directoryUrl = new URL("../../.github/workflows/", import.meta.url);
  const workflowNames = (await readdir(directoryUrl)).filter((name) => name.endsWith(".yml"));
  const workflowSource = (await Promise.all(
    workflowNames.map((name) => readFile(new URL(name, directoryUrl), "utf8")),
  )).join("\n");
  if (!workflowSource.includes("launcher-benchmark.ps1")) {
    t.skip("Task 5 has not wired the Windows behavior gate yet");
    return;
  }
  assert.match(workflowSource, /shell:\s*powershell\b/);
  assert.match(workflowSource, /shell:\s*pwsh\b/);
});

test("PowerShell harness uses exact process capture, timeout, cleanup, and PATH restoration", async () => {
  const source = await readFile(harnessUrl, "utf8");
  assert.match(source, /UseShellExecute\s*=\s*\$false/i);
  assert.match(source, /RedirectStandardOutput\s*=\s*\$true/i);
  assert.match(source, /RedirectStandardError\s*=\s*\$true/i);
  assert.match(source, /ReadToEndAsync\(\)/);
  assert.match(source, /WaitForExit\(\$TimeoutMs\)/);
  assert.match(source, /taskkill\.exe/);
  assert.match(source, /\/PID[\s\S]{0,100}\/T[\s\S]{0,100}\/F/);
  assert.match(source, /LAUNCHER_BENCHMARK_PROCESS_KILL_FAILED/);
  assert.match(source, /WaitForExit\(\$KillTimeoutMs\)/);
  assert.match(source, /\[Threading\.Tasks\.Task\]::WaitAll\([^\r\n]*\$CaptureTimeoutMs\)/);
  assert.doesNotMatch(source, /WaitForExit\(\s*\)/);
  assert.match(source, /PROCESS_CAPTURE_TIMEOUT[\s\S]{0,240}Stop-TimedOutProcess|Stop-TimedOutProcess[\s\S]{0,240}PROCESS_CAPTURE_TIMEOUT/);
  assert.match(source, /\[Diagnostics\.Stopwatch\]::StartNew\(\)/);
  assert.match(source, /finally[\s\S]{0,240}Remove-Item\s+-LiteralPath/i);
  assert.match(source, /finally[\s\S]{0,180}\$env:PATH\s*=\s*\$originalPath/i);
  assert.doesNotMatch(source, /&\s*\$[^\r\n]*2>&1|Invoke-Expression|\.\.\//i);
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

test("rejects mandatoryPassed values that contradict cases", () => {
  for (const go of [
    { mandatoryPassed: true, cases: { manifest: false } },
    { mandatoryPassed: false, cases: { manifest: true, checksum: true } },
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
  const failed = { mandatoryPassed: false, cases: { "valid-manifest": false } };
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
    [false, makeTrial(1, { go: { mandatoryPassed: true, cases: { manifest: false } } })],
    [false, makeTrial(1, { go: { mandatoryPassed: false, cases: { manifest: true } } })],
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
