import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  isElectronMainProcess,
  loadDevelopmentEnvironment,
  loadProductionDesktopOptions,
  reportStartupFailure,
  runElectronEntry,
  startupDiagnosticCode,
  runtimeStartupFailureCode,
  runtimeStartupFailureName,
} from "../src/entry.js";
import { DesktopWiringError } from "../src/wiring/environment.js";
import type { DesktopMainOptions } from "../src/main.js";
import type { PortableDesktopPaths } from "../src/portable-paths.js";

describe("Electron production entry", () => {
  it("loads only development Provider keys from root .env without overriding the process", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-entry-env-"));
    await writeFile(join(root, ".env"), [
      "UCLAW_TEST_PROVIDER_BASE_URL=https://provider.example/v1",
      "UCLAW_TEST_PROVIDER_API_KEY=file-secret",
      "UCLAW_TEST_PROVIDER_MODEL=gpt-5.6-sol",
      "UNRELATED_SECRET=must-not-load",
      "",
    ].join("\n"));
    try {
      await expect(loadDevelopmentEnvironment({
        UCLAW_TEST_PROVIDER_API_KEY: "process-secret",
      }, root)).resolves.toMatchObject({
        UCLAW_TEST_PROVIDER_BASE_URL: "https://provider.example/v1",
        UCLAW_TEST_PROVIDER_API_KEY: "process-secret",
        UCLAW_TEST_PROVIDER_MODEL: "gpt-5.6-sol",
      });
      expect((await loadDevelopmentEnvironment({}, root)).UNRELATED_SECRET).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a missing development .env", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-entry-env-missing-"));
    try {
      await expect(loadDevelopmentEnvironment({ EXISTING: "value" }, root)).resolves.toEqual({ EXISTING: "value" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
      argv: ["electron", "app", "--uclaw-startup-mode=normal"],
      preparePortableDesktop,
      loadOptions,
      startActivationMain: vi.fn(),
      startElectronMain,
    });

    expect(loadOptions).toHaveBeenCalledOnce();
    expect(startElectronMain).toHaveBeenCalledOnce();
    expect(startElectronMain).toHaveBeenCalledWith(options, portablePaths);
    expect(calls).toEqual(["portable", "wiring"]);
  });

  it("starts activation-only without loading normal desktop options", async () => {
    const portablePaths = { dataDir: "/portable/data" } as PortableDesktopPaths;
    const loadOptions = vi.fn();
    const startElectronMain = vi.fn();
    const startActivationMain = vi.fn(async () => undefined);

    await runElectronEntry({
      argv: ["electron", "app", "--uclaw-startup-mode=activation-only"],
      preparePortableDesktop: vi.fn(async () => portablePaths),
      loadOptions,
      startElectronMain,
      startActivationMain,
    });

    expect(startActivationMain).toHaveBeenCalledWith(portablePaths);
    expect(loadOptions).not.toHaveBeenCalled();
    expect(startElectronMain).not.toHaveBeenCalled();
  });

  it("records a safe load-options failure without replacing the root error", async () => {
    const portablePaths = { dataDir: "/portable/data" } as PortableDesktopPaths;
    const root = new DesktopWiringError("UNAVAILABLE", "secret path");
    const recordStartupFailure = vi.fn(async () => undefined);

    await expect(runElectronEntry({
      argv: ["electron", "app", "--uclaw-startup-mode=normal"],
      preparePortableDesktop: vi.fn(async () => portablePaths),
      loadOptions: vi.fn(async (onWiringStage) => {
        onWiringStage?.("plugin-runtime");
        throw root;
      }),
      startElectronMain: vi.fn(),
      startActivationMain: vi.fn(),
      recordStartupFailure,
    })).rejects.toBe(root);

    expect(recordStartupFailure).toHaveBeenCalledWith(portablePaths, {
      stage: "load-options",
      wiringStage: "plugin-runtime",
      code: "UNAVAILABLE",
      name: "DesktopWiringError",
    });
    expect(runtimeStartupFailureCode(Object.assign(new Error("private"), { code: "ERR_MODULE_NOT_FOUND" }))).toBe("ERR_MODULE_NOT_FOUND");
    expect(runtimeStartupFailureCode(Object.assign(new Error("private"), { code: "ENOENT" }))).toBe("UNKNOWN");
    expect(runtimeStartupFailureCode({ code: "ERR_PRIVATE_SECRET" })).toBe("UNKNOWN");
    expect(runtimeStartupFailureName(new TypeError("private"))).toBe("TypeError");
    expect(runtimeStartupFailureName({ name: "TypeError", message: "private" })).toBe("TypeError");
    expect(runtimeStartupFailureName({ name: "PrivateRuntimeError", message: "private" })).toBe("UnknownError");
    const crossRealmError = runInNewContext("new TypeError('private')") as unknown;
    expect(crossRealmError).not.toBeInstanceOf(Error);
    expect(runtimeStartupFailureName(crossRealmError)).toBe("TypeError");
    const hostile = Object.defineProperty({}, "name", { get: () => { throw new Error("private"); } });
    expect(runtimeStartupFailureName(hostile)).toBe("UnknownError");
  });

  it("does not statically load normal production wiring from the entry module", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../src/entry.ts", import.meta.url), "utf8"));

    expect(source).not.toMatch(/^import .*create-desktop-main-options/m);
    expect(source).toContain("await import(\"./wiring/create-desktop-main-options.js\")");
  });

  it("fails closed before preparing runtime when Launcher mode is missing", async () => {
    const preparePortableDesktop = vi.fn();

    await expect(runElectronEntry({
      argv: ["electron", "app"],
      preparePortableDesktop,
      loadOptions: vi.fn(),
      startElectronMain: vi.fn(),
      startActivationMain: vi.fn(),
    })).rejects.toThrow("missing");

    expect(preparePortableDesktop).not.toHaveBeenCalled();
  });

  it("uses the repository production factory when no test wiring module is configured", async () => {
    const stages: string[] = [];
    await expect(loadProductionDesktopOptions({}, (stage) => stages.push(stage))).rejects.toMatchObject({
      code: "UNCONFIGURED",
      causeDetails: { operation: "desktop.wiring" },
    });
    expect(stages).toEqual(["development-environment", "production-module", "environment"]);
  });

  it("records production-module before a controlled dynamic import fails", async () => {
    const stages: string[] = [];
    await expect(loadProductionDesktopOptions({
      UCLAW_DESKTOP_WIRING_MODULE: fileURLToPath(new URL("../package.json", import.meta.url)),
    }, (stage) => stages.push(stage))).rejects.toBeDefined();
    expect(stages).toEqual(["development-environment", "production-module"]);
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
    const secret = ["secret", "token", "value"].join("-");
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
