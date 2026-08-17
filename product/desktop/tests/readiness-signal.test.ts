import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { clearRuntimeReadiness, writeRuntimeReadiness } from "../src/runtime/readiness-signal.js";

describe("runtime readiness signal", () => {
  const roots: string[] = [];

  async function createDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-ready-"));
    roots.push(dataDir);
    return dataDir;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("atomically writes a path-free real runtime readiness record", async () => {
    const dataDir = await createDataDir();

    await writeRuntimeReadiness(dataDir, {
      productVersion: "0.1.0",
      runtimeVersion: "2026.7.1-2",
      gatewayReady: true,
      token: "must-not-leak",
      endpoint: "https://private.example.test",
      platform: process.platform,
    } as Parameters<typeof writeRuntimeReadiness>[1]);

    const path = join(dataDir, "diagnostics", "runtime-ready.json");
    const body = await readFile(path, "utf8");
    expect(body.endsWith("\n")).toBe(true);
    expect(body.trimEnd().includes("\n")).toBe(false);
    expect(JSON.parse(body)).toEqual({
      schemaVersion: 1,
      productVersion: "0.1.0",
      runtimeVersion: "2026.7.1-2",
      gatewayReady: true,
    });
    expect(body).not.toContain(dataDir);
    expect(body).not.toContain("must-not-leak");
    expect(body).not.toContain("private.example.test");
    expect(body).not.toContain(process.platform);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dataDir, "diagnostics"))).toEqual(["runtime-ready.json"]);
  });

  it("replaces an old readiness record", async () => {
    const dataDir = await createDataDir();
    await mkdir(join(dataDir, "diagnostics"));
    await writeFile(join(dataDir, "diagnostics", "runtime-ready.json"), "old\n");

    await writeRuntimeReadiness(dataDir, {
      productVersion: "0.2.0",
      runtimeVersion: "2026.7.1-2",
      gatewayReady: true,
    });

    expect(JSON.parse(await readFile(join(dataDir, "diagnostics", "runtime-ready.json"), "utf8")))
      .toMatchObject({ productVersion: "0.2.0", gatewayReady: true });
  });

  it("cleans the temporary file when replacement fails", async () => {
    const dataDir = await createDataDir();
    const diagnostics = join(dataDir, "diagnostics");
    await mkdir(join(diagnostics, "runtime-ready.json"), { recursive: true });

    await expect(writeRuntimeReadiness(dataDir, {
      productVersion: "0.1.0",
      runtimeVersion: "2026.7.1-2",
      gatewayReady: true,
    })).rejects.toThrow();

    expect(await readdir(diagnostics)).toEqual(["runtime-ready.json"]);
  });

  it("leaves no temporary files after concurrent writes", async () => {
    const dataDir = await createDataDir();

    await Promise.all(Array.from({ length: 12 }, (_, index) => writeRuntimeReadiness(dataDir, {
      productVersion: `0.1.${index}`,
      runtimeVersion: "2026.7.1-2",
      gatewayReady: true,
    })));

    const diagnostics = join(dataDir, "diagnostics");
    expect(await readdir(diagnostics)).toEqual(["runtime-ready.json"]);
    expect(JSON.parse(await readFile(join(diagnostics, "runtime-ready.json"), "utf8")))
      .toMatchObject({ schemaVersion: 1, gatewayReady: true });
  });

  it("validates versions and a true Gateway readiness result", async () => {
    const dataDir = await createDataDir();
    const valid = { productVersion: "0.1.0", runtimeVersion: "2026.7.1-2", gatewayReady: true as const };

    await expect(writeRuntimeReadiness(dataDir, { ...valid, productVersion: "version from /private/data" }))
      .rejects.toThrow("version");
    await expect(writeRuntimeReadiness(dataDir, { ...valid, runtimeVersion: "latest" }))
      .rejects.toThrow("version");
    await expect(writeRuntimeReadiness(dataDir, { ...valid, gatewayReady: false as true }))
      .rejects.toThrow("ready");
    await expect(readdir(dataDir)).resolves.toEqual([]);
  });

  it("rejects symlink and non-directory data paths", async () => {
    const dataDir = await createDataDir();
    const parent = await createDataDir();
    const linked = join(parent, "linked-data");
    const file = join(parent, "data-file");
    await symlink(dataDir, linked, "dir");
    await writeFile(file, "not a directory");
    const value = { productVersion: "0.1.0", runtimeVersion: "2026.7.1-2", gatewayReady: true as const };

    await expect(writeRuntimeReadiness(linked, value)).rejects.toThrow(/directory|symlink/i);
    await expect(writeRuntimeReadiness(file, value)).rejects.toThrow(/directory|symlink/i);
  });

  it("clears only an existing readiness record", async () => {
    const dataDir = await createDataDir();
    const diagnostics = join(dataDir, "diagnostics");
    await mkdir(diagnostics);
    await writeFile(join(diagnostics, "runtime-ready.json"), "old\n");
    await writeFile(join(diagnostics, "keep.json"), "keep\n");

    await clearRuntimeReadiness(dataDir);

    expect(await readdir(diagnostics)).toEqual(["keep.json"]);
    await expect(clearRuntimeReadiness(dataDir)).resolves.toBeUndefined();
  });

  it("rejects an unsafe diagnostics directory", async () => {
    const dataDir = await createDataDir();
    const outside = await createDataDir();
    await chmod(outside, 0o700);
    await symlink(outside, join(dataDir, "diagnostics"), "dir");

    await expect(writeRuntimeReadiness(dataDir, {
      productVersion: "0.1.0",
      runtimeVersion: "2026.7.1-2",
      gatewayReady: true,
    })).rejects.toThrow(/directory|symlink/i);
    await expect(clearRuntimeReadiness(dataDir)).rejects.toThrow(/directory|symlink/i);
    await expect(readdir(outside)).resolves.toEqual([]);
  });
});
