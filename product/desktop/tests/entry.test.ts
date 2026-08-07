import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  isElectronMainProcess,
  loadProductionDesktopOptions,
  runElectronEntry,
} from "../src/entry.js";
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

  it("fails with a stable error when production wiring is not configured", async () => {
    await expect(loadProductionDesktopOptions({})).rejects.toThrow(
      "Desktop production wiring is not configured.",
    );
  });

  it("rejects an absolute wiring module outside controlled runtime roots", async () => {
    const outsideDesktopRoot = new URL("../../shared/dist/index.js", import.meta.url);
    await expect(loadProductionDesktopOptions({
      UCLAW_DESKTOP_WIRING_MODULE: outsideDesktopRoot.pathname,
    })).rejects.toThrow("outside controlled runtime roots");
  });

  it("loads the fixed factory export from a real module under the packaged desktop root", async () => {
    const fixture = new URL("./fixtures/production-wiring.mjs", import.meta.url);
    const options = await loadProductionDesktopOptions({
      UCLAW_DESKTOP_WIRING_MODULE: fixture.pathname,
    });

    expect(options.requiredMethods).toEqual(["gateway.get-status"]);
    expect(typeof options.spawn).toBe("function");
    expect(typeof options.dispatchClient).toBe("function");
  });
});
