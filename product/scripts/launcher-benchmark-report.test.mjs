import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { decideLauncher, validateTrialReport } from "./launcher-benchmark-report.mjs";

const scriptPath = fileURLToPath(new URL("./launcher-benchmark-report.mjs", import.meta.url));

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

test("requires exactly trials 1, 2, and 3 without duplicates", () => {
  assert.throws(() => decideLauncher(reports().slice(0, 2)), /exactly three/);
  assert.throws(
    () => decideLauncher([makeTrial(1), makeTrial(2), makeTrial(2)]),
    /trials 1, 2, and 3/,
  );
});

test("eliminates candidates that fail any mandatory trial", () => {
  const trialReports = reports({ go: { mandatoryPassed: false } });
  assert.deepEqual(decideLauncher(trialReports), {
    selected: "dotnet",
    reason: "mandatory-elimination",
    summary: {
      go: { mandatoryPassed: false, p95Ms: 30, exeBytes: 8_000_000 },
      dotnet: { mandatoryPassed: true, p95Ms: 30, exeBytes: 8_000_000 },
    },
  });

  const none = reports({ go: { mandatoryPassed: false }, dotnet: { mandatoryPassed: false } });
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

test("uses the executable median size margin when p95 is within 20 percent", () => {
  const result = decideLauncher(reports({
    go: { p95Ms: 30, exeBytes: 6_000_000 },
    dotnet: { p95Ms: 33, exeBytes: 8_000_000 },
  }));
  assert.equal(result.selected, "go");
  assert.equal(result.reason, "size-margin");
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

test("schema locks the same closed report contract", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../tests/windows/launcher-benchmark.schema.json", import.meta.url),
    "utf8",
  ));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "schemaVersion", "trial", "measurementKind", "commitSha", "runner", "candidates",
  ]);
  assert.equal(schema.properties.commitSha.pattern, "^[0-9a-f]{40}$");
  assert.equal(schema.$defs.candidate.properties.cases.minProperties, 1);
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
  assert.match(invalid.stderr, /trial/);

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
  assert.match(result.stderr, /exist|EEXIST/i);
  assert.equal(await readFile(output, "utf8"), "keep me");
});
