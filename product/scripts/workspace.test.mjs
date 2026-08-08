import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rootUrl = new URL("../", import.meta.url);
const rootPackage = JSON.parse(await readFile(new URL("package.json", rootUrl), "utf8"));
const lockfile = JSON.parse(await readFile(new URL("package-lock.json", rootUrl), "utf8"));
const expectedWorkspaces = ["shared", "adapter", "desktop", "frontend"];
const expectedPackages = [
  "@uclaw/shared",
  "@uclaw/adapter",
  "@uclaw/desktop",
  "@uclaw/frontend"
];

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, rootUrl), "utf8"));
}

test("declares the product workspaces", () => {
  assert.deepEqual(rootPackage.workspaces, expectedWorkspaces);
});

test("declares the required Node engine", () => {
  assert.equal(rootPackage.engines.node, "24.15.0");
});

test("uses one audited source for runtime and package-manager versions", async () => {
  const [versions, nodeVersion] = await Promise.all([
    readJson("runtime-versions.json"),
    readFile(new URL(".node-version", rootUrl), "utf8"),
  ]);

  assert.deepEqual(versions, {
    node: "24.15.0",
    npm: "11.12.1",
    electron: "40.10.6",
    openclaw: "2026.7.1-2",
    openclawNpmIntegrity: "sha512-ycF3yPcbjN6bUPeaUx6Mh6vze1hQWoD3CT/wWcmD7a8xaHHHRUaAlaq+lFxMHf1ssEgODVAwjlzYqp2twkYZ7g==",
    runtimeId: "openclaw-2026.7.1-2-win-x64",
    targetPlatform: "win32",
    targetArch: "x64",
  });
  assert.equal(nodeVersion.trim(), versions.node);
  assert.equal(rootPackage.engines.node, versions.node);
  assert.equal(rootPackage.packageManager, `npm@${versions.npm}`);
});

test("pins every direct external dependency and mirrors it in the lockfile", async () => {
  const manifests = await Promise.all([
    Promise.resolve(rootPackage),
    ...expectedWorkspaces.map((workspace) => readJson(`${workspace}/package.json`)),
  ]);
  const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;

  for (const [index, manifest] of manifests.entries()) {
    const lockEntry = lockfile.packages[index === 0 ? "" : expectedWorkspaces[index - 1]];
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, version] of Object.entries(manifest[section] ?? {})) {
        if (name.startsWith("@uclaw/")) continue;
        assert.match(version, exactVersion, `${manifest.name} ${name}`);
        assert.equal(lockEntry[section]?.[name], version, `${manifest.name} lockfile ${name}`);
      }
    }
  }
});

test("pins Electron to the canonical runtime version", async () => {
  const [versions, desktopPackage] = await Promise.all([
    readJson("runtime-versions.json"),
    readJson("desktop/package.json"),
  ]);

  assert.equal(desktopPackage.devDependencies.electron, versions.electron);
  assert.equal(lockfile.packages["node_modules/electron"].version, versions.electron);
  assert.equal(lockfile.packages["node_modules/electron"].integrity, "sha512-TGjlkOU9Lg6K4KjDbsErywCWCIDaNgLh0q+xj0nlpRoQhevI7VBIxBTtJI/V30lypyLAaXMpnP9O9jui1/qRFw==");
});

test("gates install, build, typecheck, and tests on reproducibility verification", () => {
  assert.equal(rootPackage.scripts.preinstall, "node scripts/verify-reproducibility.mjs");
  assert.equal(rootPackage.scripts["verify:reproducible"], "node scripts/verify-reproducibility.mjs");
  for (const script of ["build", "typecheck", "test"]) {
    assert.match(rootPackage.scripts[script], /^npm run verify:reproducible && /u, script);
  }
});

test("pins product CI actions and runs the full clean-install gate", async () => {
  const workflowPaths = [
    "product.yml",
    "portable-launcher.yml",
    "launcher-benchmark.yml",
    "phase1-windows-acceptance.yml",
  ];
  const sources = await Promise.all(
    workflowPaths.map((path) => readFile(new URL(`../.github/workflows/${path}`, rootUrl), "utf8")),
  );
  for (const [index, source] of sources.entries()) {
    for (const action of source.matchAll(/uses:\s*([^\s]+)/gu)) {
      assert.match(action[1], /@[0-9a-f]{40}$/u, `${workflowPaths[index]} ${action[1]}`);
    }
  }

  const productWorkflow = sources[0];
  assert.match(productWorkflow, /matrix:\s*\n\s*os:\s*\[ubuntu-24\.04, windows-2022\]/u);
  assert.match(productWorkflow, /runs-on:\s*\$\{\{ matrix\.os \}\}/u);
  assert.match(productWorkflow, /node-version-file:\s*['"]product\/\.node-version['"]/u);
  assert.match(productWorkflow, /run:\s*npm ci --prefix product/u);
  assert.doesNotMatch(productWorkflow, /npm ci[^\n]*--ignore-scripts/u);
  assert.match(productWorkflow, /npm run build --prefix product/u);
  assert.match(productWorkflow, /npm run typecheck --prefix product/u);
  assert.match(productWorkflow, /npm test --prefix product/u);
});

test("declares the required workspace package names", async () => {
  const names = await Promise.all(
    expectedWorkspaces.map(async (workspace) => {
      const contents = await readFile(new URL(`${workspace}/package.json`, rootUrl), "utf8");
      return JSON.parse(contents).name;
    })
  );

  assert.deepEqual(names, expectedPackages);
});

test("runs every workspace test from the root", () => {
  assert.match(rootPackage.scripts.test, /npm run test:contract/);
  assert.match(rootPackage.scripts.test, /npm run test --workspaces --if-present/);
});

test("runs workspace smoke checks after builds", () => {
  assert.match(rootPackage.scripts.build, /npm run smoke:dist/);
  assert.equal(
    rootPackage.scripts["smoke:dist"],
    "node shared/dist/index.js && node adapter/dist/index.js && node desktop/dist/index.js && npm run smoke:file -w @uclaw/frontend"
  );
});

test("uses NodeNext for Node workspaces and Bundler for frontend", async () => {
  const [shared, adapter, desktop, frontend] = await Promise.all(
    expectedWorkspaces.map((workspace) => readJson(`${workspace}/tsconfig.json`))
  );

  for (const config of [shared, adapter, desktop]) {
    assert.equal(config.compilerOptions.module, "NodeNext");
    assert.equal(config.compilerOptions.moduleResolution, "NodeNext");
  }
  assert.equal(frontend.compilerOptions.module, "ESNext");
  assert.equal(frontend.compilerOptions.moduleResolution, "Bundler");
});

test("typechecks Node workspace tests without emitting them from builds", async () => {
  for (const workspace of ["shared", "adapter", "desktop"]) {
    const [workspacePackage, typecheckConfig, buildConfig] = await Promise.all([
      readJson(`${workspace}/package.json`),
      readJson(`${workspace}/tsconfig.json`),
      readJson(`${workspace}/tsconfig.build.json`)
    ]);

    assert.equal(typecheckConfig.compilerOptions.noEmit, true);
    assert.deepEqual(typecheckConfig.include, ["src", "tests"]);
    assert.equal(buildConfig.compilerOptions.noEmit, false);
    assert.deepEqual(buildConfig.include, ["src"]);
    assert.match(workspacePackage.scripts.build, /tsconfig\.build\.json/);
  }
});

test("typechecks frontend tests without emitting them from builds", async () => {
  const [frontendPackage, frontendConfig, frontendBuildConfig] = await Promise.all([
    readJson("frontend/package.json"),
    readJson("frontend/tsconfig.json"),
    readJson("frontend/tsconfig.build.json")
  ]);

  assert.equal(frontendConfig.compilerOptions.noEmit, true);
  assert.deepEqual(frontendConfig.include, ["src", "tests"]);
  assert.deepEqual(frontendBuildConfig.include, ["src"]);
  assert.match(frontendPackage.scripts.build, /tsconfig\.build\.json/);
});
