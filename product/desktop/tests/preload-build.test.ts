import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolvePreloadPath } from "../src/main.js";

describe("sandbox preload build", () => {
  it("bundles a standalone CommonJS preload and wires main to it", () => {
    const desktopDir = fileURLToPath(new URL("..", import.meta.url));
    execFileSync(process.execPath, ["scripts/build-preload.mjs"], { cwd: desktopDir });
    const output = readFileSync(new URL("../dist/preload.cjs", import.meta.url), "utf8");

    expect(output).toContain("require(\"electron\")");
    expect(output).not.toMatch(/\bimport\s+(?:[\w*{]|\()/);
    expect(output).not.toContain("@uclaw/shared");
    expect(resolvePreloadPath("/runtime/desktop/dist")).toBe("/runtime/desktop/dist/preload.cjs");
  });
});
