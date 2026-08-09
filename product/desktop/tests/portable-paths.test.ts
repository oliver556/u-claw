import { lstat, mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  applyPortableEnvironmentToLaunchOptions,
  configurePortableDesktopPaths,
  resolvePortableDesktopPaths,
} from "../src/portable-paths.js";

describe("portable desktop paths", () => {
  it("keeps durable state on USB and rebuildable paths in owned host cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-portable-"));
    const dataDir = join(root, "usb", ".uclaw", "data");
    const cacheDir = join(root, "host", "U-Claw", "cache");
    const setPath = vi.fn();
    const appendSwitch = vi.fn();
    const environment: NodeJS.ProcessEnv = {
      UCLAW_DATA_DIR: dataDir,
      UCLAW_CACHE_DIR: cacheDir,
    };

    const paths = await configurePortableDesktopPaths({ setPath, commandLine: { appendSwitch } }, environment);

    expect(paths).toEqual(resolvePortableDesktopPaths(dataDir, cacheDir));
    expect(setPath.mock.calls).toEqual([
      ["userData", join(dataDir, "desktop", "user-data")],
      ["sessionData", join(dataDir, "desktop", "session-data")],
      ["temp", join(cacheDir, "temp")],
      ["logs", join(dataDir, "diagnostics", "desktop-logs")],
      ["crashDumps", join(dataDir, "diagnostics", "crash-dumps")],
    ]);
    expect(appendSwitch).toHaveBeenCalledWith("disk-cache-dir", join(cacheDir, "electron"));
    expect(environment).toMatchObject({
      OPENCLAW_HOME: dataDir,
      OPENCLAW_STATE_DIR: join(dataDir, ".openclaw"),
      OPENCLAW_CONFIG_PATH: join(dataDir, ".openclaw", "openclaw.json"),
      OPENCLAW_WORKSPACE_DIR: join(dataDir, "workspace"),
      NODE_COMPILE_CACHE: join(cacheDir, "node-compile"),
      TEMP: join(cacheDir, "temp"),
      TMP: join(cacheDir, "temp"),
    });
    const marker = JSON.parse(await readFile(join(cacheDir, "..", ".uclaw-cache.json"), "utf8"));
    expect(marker).toEqual({ schemaVersion: 1, product: "U-Claw", purpose: "rebuildable-cache" });
    expect((await lstat(paths.userData)).isDirectory()).toBe(true);
  });

  it("rejects missing, relative, overlapping, and NUL paths", () => {
    const absolute = join(tmpdir(), "uclaw-data");
    for (const [dataDir, cacheDir] of [
      ["", absolute],
      ["relative", absolute],
      [absolute, "relative"],
      [absolute, join(absolute, "cache")],
      [absolute + "\0escape", join(tmpdir(), "cache")],
    ]) {
      expect(() => resolvePortableDesktopPaths(dataDir, cacheDir)).toThrow(/portable path/i);
    }
  });

  it("forces the gateway to inherit USB state paths", () => {
    const dataDir = join(tmpdir(), "usb", ".uclaw", "data");
    const cacheDir = join(tmpdir(), "host", "U-Claw", "cache");
    const paths = resolvePortableDesktopPaths(dataDir, cacheDir);
    expect(applyPortableEnvironmentToLaunchOptions({
      executable: "openclaw.exe",
      args: ["gateway"],
      env: { CUSTOM: "kept", OPENCLAW_HOME: "C:\\Users\\wrong" },
    }, paths)).toMatchObject({
      env: {
        CUSTOM: "kept",
        OPENCLAW_HOME: dataDir,
        OPENCLAW_STATE_DIR: join(dataDir, ".openclaw"),
        OPENCLAW_CONFIG_PATH: join(dataDir, ".openclaw", "openclaw.json"),
        OPENCLAW_WORKSPACE_DIR: join(dataDir, "workspace"),
      },
    });
  });

  it("rejects a host cache root junction or symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-cache-link-"));
    const outside = join(root, "outside");
    const cacheRoot = join(root, "U-Claw");
    await mkdir(outside);
    await symlink(outside, cacheRoot, "dir");
    const environment = {
      UCLAW_DATA_DIR: join(root, "usb", ".uclaw", "data"),
      UCLAW_CACHE_DIR: join(cacheRoot, "cache"),
    };
    expect(() => configurePortableDesktopPaths({
      setPath: vi.fn(),
      commandLine: { appendSwitch: vi.fn() },
    }, environment)).toThrow(/cache root/i);
    await expect(lstat(join(outside, ".uclaw-cache.json"))).rejects.toThrow();
  });
});
