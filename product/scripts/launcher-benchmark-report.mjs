import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const reportFields = [
  "schemaVersion",
  "trial",
  "measurementKind",
  "commitSha",
  "runner",
  "candidates",
];
const runnerFields = ["os", "arch", "cpu"];
const candidateIds = ["go", "dotnet"];
const candidateFields = [
  "exeBytes",
  "buildMs",
  "p50Ms",
  "p95Ms",
  "mandatoryPassed",
  "cases",
  "toolchainVersion",
];

function requireObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
}

function rejectUnknownFields(value, allowed, field) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new Error(`${field}.${unknown} is an unexpected field`);
  }
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function validateCandidate(candidate, field) {
  requireObject(candidate, field);
  rejectUnknownFields(candidate, candidateFields, field);

  for (const measurement of ["exeBytes", "buildMs", "p50Ms", "p95Ms"]) {
    const value = candidate[measurement];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${field}.${measurement} must be a finite non-negative number`);
    }
  }
  if (!Number.isInteger(candidate.exeBytes)) {
    throw new Error(`${field}.exeBytes must be an integer`);
  }
  if (typeof candidate.mandatoryPassed !== "boolean") {
    throw new Error(`${field}.mandatoryPassed must be a boolean`);
  }

  requireObject(candidate.cases, `${field}.cases`);
  if (Object.keys(candidate.cases).length === 0) {
    throw new Error(`${field}.cases must not be empty`);
  }
  for (const [name, passed] of Object.entries(candidate.cases)) {
    if (typeof passed !== "boolean") {
      throw new Error(`${field}.cases.${name} must be a boolean`);
    }
  }
  requireNonEmptyString(candidate.toolchainVersion, `${field}.toolchainVersion`);
}

export function validateTrialReport(report) {
  requireObject(report, "report");
  rejectUnknownFields(report, reportFields, "report");

  if (report.schemaVersion !== 1) {
    throw new Error("schemaVersion must be 1");
  }
  if (!Number.isInteger(report.trial) || report.trial < 1 || report.trial > 3) {
    throw new Error("trial must be an integer from 1 through 3");
  }
  if (report.measurementKind !== "hosted-runner-process-start") {
    throw new Error("measurementKind must be hosted-runner-process-start");
  }
  if (typeof report.commitSha !== "string" || !/^[0-9a-f]{40}$/.test(report.commitSha)) {
    throw new Error("commitSha must be a 40-character lowercase hexadecimal SHA");
  }

  requireObject(report.runner, "runner");
  rejectUnknownFields(report.runner, runnerFields, "runner");
  for (const field of runnerFields) {
    requireNonEmptyString(report.runner[field], `runner.${field}`);
  }

  requireObject(report.candidates, "candidates");
  rejectUnknownFields(report.candidates, candidateIds, "candidates");
  for (const id of candidateIds) {
    validateCandidate(report.candidates[id], `candidates.${id}`);
  }
  return report;
}

function median(values) {
  return [...values].sort((a, b) => a - b)[1];
}

function marginDecision(summary, eligible, field, threshold, reason) {
  const [better, worse] = [...eligible].sort((left, right) => {
    const difference = summary[left][field] - summary[right][field];
    return difference || left.localeCompare(right);
  });
  const worseValue = summary[worse][field];
  if (worseValue === 0) {
    return null;
  }
  const meetsThreshold = summary[better][field] <= worseValue * (1 - threshold);
  return meetsThreshold ? { selected: better, reason, summary } : null;
}

export function decideLauncher(reports) {
  if (!Array.isArray(reports) || reports.length !== 3) {
    throw new Error("exactly three trial reports are required");
  }
  reports.forEach(validateTrialReport);
  const trials = [...reports].map((report) => report.trial).sort((a, b) => a - b);
  if (trials.some((trial, index) => trial !== index + 1)) {
    throw new Error("reports must contain trials 1, 2, and 3 exactly once");
  }

  const summary = Object.fromEntries(candidateIds.map((id) => [id, {
    mandatoryPassed: reports.every((report) => report.candidates[id].mandatoryPassed),
    p95Ms: median(reports.map((report) => report.candidates[id].p95Ms)),
    exeBytes: median(reports.map((report) => report.candidates[id].exeBytes)),
  }]));
  const eligible = candidateIds.filter((id) => summary[id].mandatoryPassed);

  if (eligible.length === 0) {
    return { selected: null, reason: "mandatory-failure", summary };
  }
  if (eligible.length === 1) {
    return { selected: eligible[0], reason: "mandatory-elimination", summary };
  }
  return marginDecision(summary, eligible, "p95Ms", 0.20, "p95-margin")
    ?? marginDecision(summary, eligible, "exeBytes", 0.25, "size-margin")
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
    if (args.length !== 5 || outputIndex !== 3 || args[4].length === 0) {
      throw new Error("decide requires three reports and --output <file>");
    }
    const reports = await Promise.all(args.slice(0, 3).map(async (file) => (
      JSON.parse(await readFile(file, "utf8"))
    )));
    const decision = decideLauncher(reports);
    await writeFile(args[4], `${JSON.stringify(decision, null, 2)}\n`, { flag: "wx" });
    return;
  }
  throw new Error("usage: validate <report> | decide <r1> <r2> <r3> --output <file>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
