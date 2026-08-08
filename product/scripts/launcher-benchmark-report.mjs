import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const candidateIds = ["go", "dotnet"];
const schemaUrl = new URL("../tests/windows/launcher-benchmark.schema.json", import.meta.url);
const reportSchema = JSON.parse(readFileSync(schemaUrl, "utf8"));
const validateReportSchema = new Ajv2020({ allErrors: true }).compile(reportSchema);

function errorField(error) {
  const path = error.instancePath.replaceAll("/", ".").replace(/^\./, "");
  const suffix = error.keyword === "required"
    ? error.params.missingProperty
    : error.keyword === "additionalProperties"
      ? error.params.additionalProperty
      : "";
  return [path, suffix].filter(Boolean).join(".") || "report";
}

export function validateTrialReport(report) {
  if (!validateReportSchema(report)) {
    const fields = [...new Set(validateReportSchema.errors.map(errorField))].join(", ");
    const hasUnexpected = validateReportSchema.errors.some(
      (error) => error.keyword === "additionalProperties",
    );
    throw new Error(`${fields}: ${hasUnexpected ? "unexpected field" : "invalid report field"}`);
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
  const betterValue = summary[better][field];
  const boundary = worseValue * (1 - threshold);
  const scale = Math.max(Math.abs(betterValue), Math.abs(worseValue), Math.abs(boundary));
  const tolerance = Number.EPSILON * scale * 4;
  const meetsThreshold = betterValue <= boundary + tolerance;
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
  if (reports.some((report) => report.commitSha !== reports[0].commitSha)) {
    throw new Error("all trial reports must have the same commitSha");
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

class CliError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage);
    this.code = code;
  }
}

async function readTrialReport(file) {
  try {
    const report = JSON.parse(await readFile(file, "utf8"));
    return validateTrialReport(report);
  } catch {
    throw new CliError("LAUNCHER_BENCHMARK_INVALID_REPORT", "report validation failed");
  }
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === "validate" && args.length === 1) {
    await readTrialReport(args[0]);
    return;
  }
  if (command === "decide") {
    const outputIndex = args.indexOf("--output");
    if (args.length !== 5 || outputIndex !== 3 || args[4].length === 0) {
      throw new CliError("LAUNCHER_BENCHMARK_USAGE", "invalid command arguments");
    }
    const reports = await Promise.all(args.slice(0, 3).map(readTrialReport));
    let decision;
    try {
      decision = decideLauncher(reports);
    } catch {
      throw new CliError("LAUNCHER_BENCHMARK_INVALID_REPORT", "report validation failed");
    }
    try {
      await writeFile(args[4], `${JSON.stringify(decision, null, 2)}\n`, { flag: "wx" });
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new CliError("LAUNCHER_BENCHMARK_OUTPUT_EXISTS", "output file already exists");
      }
      throw new CliError("LAUNCHER_BENCHMARK_IO_ERROR", "file operation failed");
    }
    return;
  }
  throw new CliError("LAUNCHER_BENCHMARK_USAGE", "invalid command arguments");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    const safeError = error instanceof CliError
      ? error
      : new CliError("LAUNCHER_BENCHMARK_INTERNAL_ERROR", "operation failed");
    console.error(`${safeError.code}: ${safeError.message}`);
    process.exitCode = 1;
  });
}
