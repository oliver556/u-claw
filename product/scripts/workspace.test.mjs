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
