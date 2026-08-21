import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  buildReleaseArtifacts,
  promoteReleaseArtifacts,
  runFinalRuntimeSmoke,
  uploadReleaseArtifacts,
  verifyCdnReadback,
  verifyPromotionDigests,
  writePointerSwitchAuthorization,
} from "./release-gate.mjs";

export async function runReleaseGateCli(argv = process.argv.slice(2)) {
  const command = argv[0];
  const { values } = parseArgs({
    args: argv.slice(1),
    strict: true,
    options: {
      "repo-root": { type: "string" },
      runtime: { type: "string" },
      launcher: { type: "string" },
      output: { type: "string" },
      source: { type: "string" },
      candidate: { type: "string" },
      acceptance: { type: "string" },
      production: { type: "string" },
      manifest: { type: "string" },
      evidence: { type: "string" },
      artifacts: { type: "string" },
      "base-url": { type: "string" },
      "build-evidence": { type: "string" },
      "smoke-evidence": { type: "string" },
      "promotion-evidence": { type: "string" },
      "upload-evidence": { type: "string" },
      "cdn-evidence": { type: "string" },
      "commit-sha": { type: "string" },
      "product-version": { type: "string" },
      "release-id": { type: "string" },
      "release-sequence": { type: "string" },
      "runtime-id": { type: "string" },
      entrypoint: { type: "string" },
      "entry-arg": { type: "string", multiple: true, default: [] },
      "key-id": { type: "string" },
      "private-key": { type: "string" },
      "signed-at": { type: "string" },
      "expires-at": { type: "string" },
    },
  });
  let result;
  if (command === "build") {
    result = await buildReleaseArtifacts({
      repoRoot: required(values, "repo-root"),
      runtimeDir: required(values, "runtime"),
      launcherPath: required(values, "launcher"),
      outputDir: required(values, "output"),
      productVersion: required(values, "product-version"),
      releaseId: required(values, "release-id"),
      releaseSequence: positiveInteger(required(values, "release-sequence"), "release-sequence"),
      runtimeId: required(values, "runtime-id"),
      entrypoint: required(values, "entrypoint"),
      entryArgs: values["entry-arg"],
      keyId: required(values, "key-id"),
      privateKey: await readFile(required(values, "private-key"), "utf8"),
      signedAt: required(values, "signed-at"),
      expiresAt: required(values, "expires-at"),
    });
    result = {
      releaseId: required(values, "release-id"),
      releaseSequence: positiveInteger(required(values, "release-sequence"), "release-sequence"),
      completedAt: new Date().toISOString(),
      artifacts: result.artifacts,
    };
  } else if (command === "smoke") {
    const manifest = JSON.parse(await readFile(required(values, "manifest"), "utf8"));
    result = {
      ...await runFinalRuntimeSmoke({ repoRoot: required(values, "repo-root"), runtimeDir: required(values, "runtime"), manifest }),
      completedAt: new Date().toISOString(),
    };
  } else if (command === "promote") {
    await promoteReleaseArtifacts(required(values, "source"), required(values, "output"));
    result = { completedAt: new Date().toISOString() };
  } else if (command === "verify-promotions") {
    result = {
      completedAt: new Date().toISOString(),
      artifacts: await verifyPromotionDigests({
        candidate: required(values, "candidate"),
        acceptance: required(values, "acceptance"),
        production: required(values, "production"),
      }),
    };
  } else if (command === "verify-cdn") {
    const expected = await readArtifactRecords(required(values, "artifacts"));
    const verified = await verifyCdnReadback(required(values, "base-url"), expected, { releaseId: values["release-id"] });
    result = {
      completedAt: new Date().toISOString(),
      artifacts: verified,
    };
  } else if (command === "upload") {
    const expected = await readArtifactRecords(required(values, "artifacts"));
    result = {
      completedAt: new Date().toISOString(),
      artifacts: await uploadReleaseArtifacts(
        required(values, "base-url"),
        required(values, "source"),
        expected,
        { token: process.env.UCLAW_CDN_UPLOAD_TOKEN, releaseId: values["release-id"] },
      ),
    };
  } else if (command === "authorize") {
    const evidence = values.evidence
      ? JSON.parse(await readFile(values.evidence, "utf8"))
      : {
          releaseId: required(values, "release-id"),
          releaseSequence: positiveInteger(required(values, "release-sequence"), "release-sequence"),
          commitSha: required(values, "commit-sha"),
          build: JSON.parse(await readFile(required(values, "build-evidence"), "utf8")),
          smoke: JSON.parse(await readFile(required(values, "smoke-evidence"), "utf8")),
          promotions: JSON.parse(await readFile(required(values, "promotion-evidence"), "utf8")),
          upload: JSON.parse(await readFile(required(values, "upload-evidence"), "utf8")),
          cdnReadback: JSON.parse(await readFile(required(values, "cdn-evidence"), "utf8")),
        };
    return writePointerSwitchAuthorization(required(values, "output"), evidence, {
      keyId: required(values, "key-id"),
      privateKey: await readFile(required(values, "private-key"), "utf8"),
    });
  } else {
    throw new Error("usage: release-gate-cli.mjs build|smoke|promote|verify-promotions|upload|verify-cdn|authorize");
  }
  if (values.output && command !== "build" && command !== "promote") {
    await writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  }
  return result;
}

function required(values, name) {
  const value = values[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive safe integer`);
  return parsed;
}

async function readArtifactRecords(file) {
  const value = JSON.parse(await readFile(file, "utf8"));
  return value.artifacts ?? value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReleaseGateCli().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`release gate blocked: ${error.message}\n`);
    process.exitCode = 1;
  });
}
