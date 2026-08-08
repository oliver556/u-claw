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

test("accepts a complete trial report", () => {
  const report = makeTrial(1);
  assert.equal(validateTrialReport(report), report);
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
