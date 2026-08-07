import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rootUrl = new URL("../", import.meta.url);
const rootPackage = JSON.parse(await readFile(new URL("package.json", rootUrl), "utf8"));
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
