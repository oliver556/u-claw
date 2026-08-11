import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  isElectronMainProcess,
  loadProductionDesktopOptions,
  reportStartupFailure,
  runElectronEntry,
  startupDiagnosticCode,
} from "../src/entry.js";
import { DesktopWiringError } from "../src/wiring/environment.js";
import type { DesktopMainOptions } from "../src/main.js";
import type { PortableDesktopPaths } from "../src/portable-paths.js";

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
    const calls: string[] = [];
    const portablePaths = {} as PortableDesktopPaths;
    const preparePortableDesktop = vi.fn(async () => {
      calls.push("portable");
      return portablePaths;
    });
    const loadOptions = vi.fn(async () => {
      calls.push("wiring");
      return options;
    });

    await runElectronEntry({
      preparePortableDesktop,
      loadOptions,
      startElectronMain,
    });

    expect(loadOptions).toHaveBeenCalledOnce();
    expect(startElectronMain).toHaveBeenCalledOnce();
    expect(startElectronMain).toHaveBeenCalledWith(options, portablePaths);
    expect(calls).toEqual(["portable", "wiring"]);
  });

  it("uses the repository production factory when no test wiring module is configured", async () => {
    await expect(loadProductionDesktopOptions({})).rejects.toMatchObject({
      code: "UNCONFIGURED",
      causeDetails: { operation: "desktop.wiring" },
    });
  });

  it("rejects an absolute wiring module outside controlled runtime roots", async () => {
    const outsideDesktopRoot = new URL("../../shared/dist/index.js", import.meta.url);
    await expect(loadProductionDesktopOptions({
      UCLAW_DESKTOP_WIRING_MODULE: fileURLToPath(outsideDesktopRoot),
    })).rejects.toThrow("outside controlled runtime roots");
  });

  it("loads the fixed factory export from a real module under the packaged desktop root", async () => {
    const fixture = new URL("./fixtures/production-wiring.mjs", import.meta.url);
    const options = await loadProductionDesktopOptions({
      UCLAW_DESKTOP_WIRING_MODULE: fileURLToPath(fixture),
    });

    expect(options.requiredMethods).toEqual(["gateway.get-status"]);
    expect(typeof options.spawn).toBe("function");
    expect(typeof options.dispatchClient).toBe("function");
  });

  it.each([
    "UNCONFIGURED",
    "AUTH_FAILED",
    "PROTOCOL_ERROR",
    "UNSUPPORTED",
    "OFFLINE",
  ] as const)("preserves the safe startup diagnostic code %s", (code) => {
    expect(startupDiagnosticCode(new DesktopWiringError(code, "sensitive detail"))).toBe(code);
  });

  it("maps process launch and untyped startup failures to OFFLINE", () => {
    expect(startupDiagnosticCode(Object.assign(new Error("spawn failed"), { code: "ENOENT" })))
      .toBe("OFFLINE");
    expect(startupDiagnosticCode(new Error("gateway readiness timed out"))).toBe("OFFLINE");
  });

  it("reports only a structured startup code and suppresses sensitive error details", async () => {
    const stderr = vi.fn();
    const quit = vi.fn(async () => undefined);
    const showErrorBox = vi.fn();
    const previousExitCode = process.exitCode;
    const secret = "secret-token-value";
    const sensitivePath = "/Users/private/runtime/openclaw.mjs";

    try {
      await reportStartupFailure(
        new DesktopWiringError("AUTH_FAILED", `${secret} at ${sensitivePath}`),
        { stderr, quit, showErrorBox },
      );

      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledOnce();
      expect(stderr).toHaveBeenCalledWith(JSON.stringify({
        event: "desktop-startup-failed",
        code: "AUTH_FAILED",
      }));
      expect(stderr.mock.calls[0]?.[0]).not.toContain(secret);
      expect(stderr.mock.calls[0]?.[0]).not.toContain(sensitivePath);
      expect(showErrorBox).toHaveBeenCalledOnce();
      expect(showErrorBox).toHaveBeenCalledWith(
        "U-Claw 启动失败",
        "OpenClaw 鉴权失败，请检查桌面运行配置。（错误代码：AUTH_FAILED）",
      );
      expect(JSON.stringify(showErrorBox.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(showErrorBox.mock.calls)).not.toContain(sensitivePath);
      expect(quit).toHaveBeenCalledOnce();
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
