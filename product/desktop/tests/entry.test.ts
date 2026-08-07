import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { isElectronMainProcess, runElectronEntry } from "../src/entry.js";
import type { DesktopMainOptions } from "../src/main.js";

describe("Electron production entry", () => {
  it("auto-starts only in the Electron browser process", () => {
    expect(isElectronMainProcess({ versions: { electron: "40.4.0" }, type: "browser" })).toBe(true);
    expect(isElectronMainProcess({ versions: { electron: "40.4.0" }, type: "renderer" })).toBe(false);
    expect(isElectronMainProcess({ versions: {}, type: undefined })).toBe(false);
  });

  it("is the package main entry", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(packageJson.main).toBe("dist/entry.js");
  });

  it("loads injected production options and starts Electron exactly once", async () => {
    const options: DesktopMainOptions = {
      spawn: vi.fn(),
      buildGatewayLaunchOptions: vi.fn(),
      requiredMethods: [],
      probeCapabilities: vi.fn(),
      dispatchClient: vi.fn(),
    };
    const startElectronMain = vi.fn(async () => undefined);
    const loadOptions = vi.fn(async () => options);

    await runElectronEntry({
      loadOptions,
      startElectronMain,
    });

    expect(loadOptions).toHaveBeenCalledOnce();
    expect(startElectronMain).toHaveBeenCalledOnce();
    expect(startElectronMain).toHaveBeenCalledWith(options);
  });
});
