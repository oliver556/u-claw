import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const productUrl = new URL("../", import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, productUrl), "utf8"));
}

export function assertExactNodeVersion(actual, expected = "24.15.0") {
  if (actual !== expected) {
    throw new Error(`Node.js ${expected} required; found ${actual}`);
  }
}

export function assertExactNpmVersion(userAgent, expected = "11.12.1") {
  const actual = /^npm\/([^\s]+)/u.exec(userAgent ?? "")?.[1] ?? "unknown";
  if (actual !== expected) {
    throw new Error(`npm ${expected} required; found ${actual}`);
  }
}

export async function verifyWorkspacePins() {
  const [versions, rootPackage, lockfile, nodeVersion, npmConfig, rootOpenClaw, portableOpenClaw] = await Promise.all([
    readJson("runtime-versions.json"),
    readJson("package.json"),
    readJson("package-lock.json"),
    readFile(new URL(".node-version", productUrl), "utf8"),
    readFile(new URL(".npmrc", productUrl), "utf8"),
    readFile(new URL("../OPENCLAW_VERSION", productUrl), "utf8"),
    readFile(new URL("../portable/OPENCLAW_VERSION", productUrl), "utf8"),
  ]);
  const workspaces = rootPackage.workspaces ?? [];
  const manifests = await Promise.all([
    Promise.resolve(["", rootPackage]),
    ...workspaces.map(async (workspace) => [workspace, await readJson(`${workspace}/package.json`)]),
  ]);
  const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;

  assertEqual(nodeVersion.trim(), versions.node, ".node-version");
  assertEqual(rootPackage.engines?.node, versions.node, "package.json engines.node");
  assertEqual(rootPackage.packageManager, `npm@${versions.npm}`, "package.json packageManager");
  assertEqual(rootOpenClaw.trim(), versions.openclaw, "OPENCLAW_VERSION");
  assertEqual(portableOpenClaw.trim(), versions.openclaw, "portable/OPENCLAW_VERSION");
  for (const setting of ["engine-strict=true", "package-lock=true", "save-exact=true"]) {
    if (!npmConfig.split(/\r?\n/u).includes(setting)) throw new Error(`.npmrc missing ${setting}`);
  }

  for (const [workspace, manifest] of manifests) {
    const lockEntry = lockfile.packages?.[workspace];
    if (!lockEntry) throw new Error(`package-lock.json missing workspace ${workspace || "root"}`);
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, version] of Object.entries(manifest[section] ?? {})) {
        if (!name.startsWith("@uclaw/") && !exactVersion.test(version)) {
          throw new Error(`${manifest.name} ${name} must use an exact version; found ${version}`);
        }
        assertEqual(lockEntry[section]?.[name], version, `package-lock.json ${workspace || "root"} ${name}`);
      }
    }
  }

  const desktop = manifests.find(([workspace]) => workspace === "desktop")[1];
  assertEqual(desktop.devDependencies?.electron, versions.electron, "desktop Electron pin");
  assertEqual(lockfile.packages?.["node_modules/electron"]?.version, versions.electron, "locked Electron version");
  const windowsArtifacts = versions.windowsArtifacts ?? {};
  assertEqual(
    windowsArtifacts.electron?.url,
    `https://github.com/electron/electron/releases/download/v${versions.electron}/electron-v${versions.electron}-win32-x64.zip`,
    "Windows Electron artifact URL",
  );
  assertLowercaseSha256(windowsArtifacts.electron?.sha256, "Windows Electron artifact SHA-256");
  assertEqual(
    windowsArtifacts.node?.url,
    `https://nodejs.org/dist/v${versions.node}/node-v${versions.node}-win-x64.zip`,
    "Windows Node artifact URL",
  );
  assertLowercaseSha256(windowsArtifacts.node?.sha256, "Windows Node artifact SHA-256");
  assertEqual(
    windowsArtifacts.openclaw?.url,
    `https://registry.npmjs.org/openclaw/-/openclaw-${versions.openclaw}.tgz`,
    "Windows OpenClaw artifact URL",
  );
  assertEqual(
    windowsArtifacts.openclaw?.integrity,
    versions.openclawNpmIntegrity,
    "Windows OpenClaw artifact integrity",
  );
  const provenance = await readJson(`adapter/fixtures/openclaw-${versions.openclaw}/provenance.json`);
  assertEqual(provenance.openClawVersion, versions.openclaw, "OpenClaw fixture version");
  assertEqual(provenance.npmTarballIntegrity, versions.openclawNpmIntegrity, "OpenClaw npm integrity");
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} must be ${expected}; found ${actual}`);
}

function assertLowercaseSha256(value, label) {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase 64-character SHA-256 digest`);
  }
}

async function runCLI() {
  const versions = await readJson("runtime-versions.json");
  assertExactNodeVersion(process.versions.node, versions.node);
  assertExactNpmVersion(process.env.npm_config_user_agent, versions.npm);
  await verifyWorkspacePins();
  process.stdout.write(`Reproducibility pins verified for Node.js ${versions.node}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCLI().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
