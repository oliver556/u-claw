import { createHash, timingSafeEqual } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { validateRuntimeManifest } from "../scripts/runtime-manifest.mjs";

const layoutFixture = JSON.parse(
  await readFile(new URL("../tests/fixtures/dual-system-usb-layout-v1.json", import.meta.url), "utf8"),
);
const acceptanceMatrixFixture = JSON.parse(
  await readFile(new URL("../tests/fixtures/dual-system-usb-acceptance-matrix-v1.json", import.meta.url), "utf8"),
);

export const dualSystemUsbTargets = Object.freeze(["win-x64", "macos-arm64"]);

export function dualSystemUsbLayoutContract() {
  validateDualSystemUsbFixtures(layoutFixture, acceptanceMatrixFixture);
  return structuredClone(layoutFixture);
}

export async function buildDualSystemUsb(options) {
  const layout = options.layoutFixture ?? dualSystemUsbLayoutContract();
  validateDualSystemUsbFixtures(layout, options.acceptanceMatrixFixture ?? acceptanceMatrixFixture);

  const outputDir = path.resolve(options.outputDir);
  await requireMissing(outputDir, "dual-system USB output already exists");
  const winLauncherPath = path.resolve(options.winLauncherPath);
  const macosAppPath = path.resolve(options.macosAppPath);
  await requireRegularFile(winLauncherPath, "Windows launcher entry");
  await requireRealDirectory(macosAppPath, "macOS app entry");

  const installedAt = new Date(options.installedAt ?? Date.now()).toISOString();
  const targetRecords = {};
  for (const target of dualSystemUsbTargets) {
    const input = options.targets?.[target];
    if (!input) throw new Error(`missing ${target} runtime package input`);
    const packagePath = path.resolve(input.packagePath);
    const packageInfo = await requireRegularFile(packagePath, `${target} runtime package`);
    const manifest = validateRuntimeManifest(input.manifest);
    if (manifest.target !== target) throw new Error(`${target} runtime manifest target is required`);
    if (manifest.runtimeArchive !== "runtime.pkg") throw new Error(`${target} runtime archive must be runtime.pkg`);
    if (manifest.runtimeBytes !== packageInfo.size || !await digestMatches(packagePath, manifest.runtimeSha256)) {
      throw new Error(`${target} runtime package does not match manifest`);
    }
    targetRecords[target] = { packagePath, manifest };
  }

  const outputParent = path.dirname(outputDir);
  await mkdir(outputParent, { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(outputParent, ".uclaw-dual-system-usb-"));
  let committed = false;
  const current = {};
  const installState = {};
  try {
    await copyFile(winLauncherPath, path.join(temporaryRoot, layout.usbManifest.targets["win-x64"].entry), constants.COPYFILE_EXCL);
    await cp(macosAppPath, path.join(temporaryRoot, layout.usbManifest.targets["macos-arm64"].entry), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await writeJson(path.join(temporaryRoot, "app", "usb-manifest.json"), layout.usbManifest);

    for (const target of dualSystemUsbTargets) {
      const paths = layout.usbManifest.targets[target];
      const { packagePath, manifest } = targetRecords[target];
      await mkdir(path.dirname(path.join(temporaryRoot, paths.package)), { recursive: true });
      await copyFile(packagePath, path.join(temporaryRoot, paths.package), constants.COPYFILE_EXCL);
      await writeJson(path.join(temporaryRoot, paths.manifest), manifest);

      current[target] = {
        schemaVersion: 1,
        target,
        releaseId: manifest.releaseId,
        releaseSequence: manifest.releaseSequence,
        runtimeId: manifest.runtimeId,
        manifest: paths.manifest,
        package: paths.package,
        installedAt,
      };
      installState[target] = {
        schemaVersion: 1,
        target,
        transactionId: `dual-system-${target}-${manifest.releaseSequence}`,
        state: "completed",
        releaseId: manifest.releaseId,
        releaseSequence: manifest.releaseSequence,
        manifest: paths.manifest,
        package: paths.package,
        updatedAt: installedAt,
      };
      await writeJson(path.join(temporaryRoot, paths.current), current[target]);
      await writeJson(path.join(temporaryRoot, paths.installState), installState[target]);
    }

    for (const relative of layout.sharedData.requiredSubdirs) {
      await mkdir(path.join(temporaryRoot, relative), { recursive: true });
    }
    await mkdir(path.join(temporaryRoot, layout.licenseIdentity.root), { recursive: true });

    await rename(temporaryRoot, outputDir);
    committed = true;
  } finally {
    if (!committed) await rm(temporaryRoot, { recursive: true, force: true });
  }

  return {
    outputDir,
    usbManifest: layout.usbManifest,
    runtimeManifests: Object.fromEntries(dualSystemUsbTargets.map((target) => [target, targetRecords[target].manifest])),
    current,
    installState,
  };
}

function validateDualSystemUsbFixtures(layout, matrix) {
  if (layout?.contractVersion !== 1 || matrix?.contractVersion !== 1) {
    throw new Error("dual-system USB fixture contract version must be 1");
  }
  for (const target of dualSystemUsbTargets) {
    const paths = layout.usbManifest?.targets?.[target];
    if (!paths) throw new Error(`dual-system USB fixture missing ${target}`);
    for (const field of ["package", "manifest", "current", "installState"]) {
      if (!paths[field]?.includes(target)) throw new Error(`${target} fixture ${field} path must be target-local`);
    }
  }
  for (const required of ["win-runtime-target-files", "macos-runtime-target-files", "win-update-does-not-touch-macos", "macos-update-does-not-touch-win"]) {
    if (!matrix.cases?.some((entry) => entry.id === required)) {
      throw new Error(`dual-system USB acceptance matrix missing ${required}`);
    }
  }
}

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function requireRegularFile(target, label) {
  const info = await lstat(target).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return info;
}

async function requireRealDirectory(target, label) {
  const info = await lstat(target).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  return info;
}

async function requireMissing(target, message) {
  try {
    await lstat(target);
    throw new Error(message);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function digestMatches(file, expected) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const actual = Buffer.from(hash.digest("hex"), "ascii");
  return actual.length === expected.length && timingSafeEqual(actual, Buffer.from(expected.toLowerCase(), "ascii"));
}

async function runCLI() {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      "win-launcher": { type: "string" },
      "macos-app": { type: "string" },
      "win-package": { type: "string" },
      "win-manifest": { type: "string" },
      "macos-package": { type: "string" },
      "macos-manifest": { type: "string" },
      "installed-at": { type: "string" },
    },
  });
  const result = await buildDualSystemUsb({
    outputDir: values.output,
    winLauncherPath: values["win-launcher"],
    macosAppPath: values["macos-app"],
    installedAt: values["installed-at"],
    targets: {
      "win-x64": {
        packagePath: values["win-package"],
        manifest: JSON.parse(await readFile(values["win-manifest"], "utf8")),
      },
      "macos-arm64": {
        packagePath: values["macos-package"],
        manifest: JSON.parse(await readFile(values["macos-manifest"], "utf8")),
      },
    },
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCLI().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
