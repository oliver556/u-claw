import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { bootstrapDesktopApp, createProductionDataService, disposeDesktopIpc, requireChannelRuntime, requireElectronClient, requireModelSourceExecutors, runDesktopMain, validateRendererUrl } from "../src/main.js";
import { ProductionRuntimeConsistencyCoordinator } from "../src/data/production-consistency-coordinator.js";

describe("Electron client wiring", () => {
  it("always removes core IPC when a domain IPC disposer fails", () => {
    const domain = vi.fn(() => { throw new Error("domain cleanup failed"); });
    const core = vi.fn();

    expect(() => disposeDesktopIpc(domain, core)).toThrow(AggregateError);
    expect(domain).toHaveBeenCalledOnce();
    expect(core).toHaveBeenCalledOnce();
  });

  it("uses production capability clients instead of fixture catalogs", async () => {
    const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(source).toContain("createSkillHubClient()");
    expect(source).toContain("UCLAW_PLUGIN_REGISTRY_URL");
    expect(source).toContain("createUnavailablePluginRegistryClient");
    expect(source).toContain("createMcpProtocolProbe({");
    expect(source).toContain("runtimeRoot: process.env.UCLAW_RUNTIME_DIR ?? \"\"");
    expect(source).toContain("executables: { node: process.execPath }");
    expect(source).toContain("createOpenClawMcpRuntime(client.mcp, mcpProbe)");
    expect(source).not.toContain("createFixtureSkillHubClient");
    expect(source).not.toContain("createFixturePluginRegistryClient");
  });

  it("rejects production startup without a real UClawClient", () => {
    expect(() => requireElectronClient(undefined)).toThrow("UClawClient");
  });

  it("fails closed when production model-source executors are missing", () => {
    expect(() => requireModelSourceExecutors(undefined)).toThrow("model source executors");
  });

  it("does not expose the loopback HTTP test policy through production options", async () => {
    const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(source).not.toContain("allowBuiltinLoopbackHttp");
  });

  it("requires real channel lifecycle methods from production client", () => {
    expect(() => requireChannelRuntime({ channels: { list: vi.fn() } } as any)).toThrow("channel runtime");
    const runtime = {
      capability: vi.fn(), configure: vi.fn(), remove: vi.fn(), test: vi.fn(), start: vi.fn(), stop: vi.fn(),
    };
    expect(requireChannelRuntime({ channels: runtime } as any)).toBe(runtime);
  });

  it("coordinates production backup, restore, and factory reset with the managed Gateway lifecycle", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-main-data-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "uclaw-main-cache-"));
    const cacheDir = join(cacheRoot, "runtime");
    await mkdir(join(dataDir, "uclaw"), { recursive: true });
    await mkdir(join(dataDir, "workspace", "memory"), { recursive: true });
    await mkdir(join(cacheDir, "electron"), { recursive: true });
    await writeFile(join(dataDir, "uclaw", "settings.json"), "owned");
    await writeFile(join(dataDir, "workspace", "memory", "note.md"), "before");
    await writeFile(join(cacheDir, "electron", "entry.bin"), "cache");
    await writeFile(join(cacheRoot, ".uclaw-cache.json"), `${JSON.stringify({ schemaVersion: 1, product: "U-Claw", purpose: "rebuildable-cache" })}\n`);
    try {
      const stop = vi.fn(async () => undefined);
      const start = vi.fn(async () => undefined);
      const coordinator = new ProductionRuntimeConsistencyCoordinator({ stop, start });
      const service = createProductionDataService({ dataDir, cacheDir }, undefined, coordinator);
      const waitForTerminal = async (operationId: string) => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const response = await service.dispatch({ method: "maintenance.operation-get", requestId: `operation-${attempt}`, params: { operationId } });
          if (response.ok && response.method === "maintenance.operation-get" && ["completed", "failed", "cancelled", "needs-recovery"].includes(response.result.state)) return response.result;
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        throw new Error("maintenance operation did not finish");
      };

      const backupPreview = await service.dispatch({ method: "backup.preview", requestId: "backup-preview", params: { collectionIds: ["openclaw-memory"], trigger: "manual", retainLatest: 3 } });
      if (!backupPreview.ok || backupPreview.method !== "backup.preview") throw new Error("backup preview failed");
      expect(backupPreview.result.consistency).toBe("coordinated");
      const backup = await service.dispatch({ method: "backup.create", requestId: "backup-create", params: { collectionIds: ["openclaw-memory"], previewToken: backupPreview.result.previewToken, trigger: "manual", retainLatest: 3, confirmed: true } });
      if (!backup.ok || backup.method !== "backup.create") throw new Error("backup create failed");
      expect(await waitForTerminal(backup.result.id)).toMatchObject({ state: "completed" });
      const backups = await service.dispatch({ method: "backup.list", requestId: "backup-list", params: {} });
      if (!backups.ok || backups.method !== "backup.list") throw new Error("backup list failed");
      await writeFile(join(dataDir, "workspace", "memory", "note.md"), "after");
      const restorePreview = await service.dispatch({ method: "backup.restore-preview", requestId: "restore-preview", params: { backupId: backups.result.items[0]!.id, collectionIds: ["openclaw-memory"] } });
      if (!restorePreview.ok || restorePreview.method !== "backup.restore-preview") throw new Error("restore preview failed");
      const restore = await service.dispatch({ method: "backup.restore", requestId: "restore", params: { backupId: backups.result.items[0]!.id, collectionIds: ["openclaw-memory"], previewToken: restorePreview.result.previewToken, confirmed: true } });
      if (!restore.ok || restore.method !== "backup.restore") throw new Error("restore failed");
      expect(await waitForTerminal(restore.result.id)).toMatchObject({ state: "completed" });
      expect(await readFile(join(dataDir, "workspace", "memory", "note.md"), "utf8")).toBe("before");

      const preview = await service.dispatch({ method: "factory-reset.preview", requestId: "reset-preview", params: {} });
      if (!preview.ok || preview.method !== "factory-reset.preview") throw new Error("preview failed");
      expect(preview.result).toMatchObject({ consistency: "coordinated" });

      const reset = await service.dispatch({
        method: "factory-reset.execute", requestId: "reset-execute",
        params: { previewToken: preview.result.previewToken, confirmation: "RESET U-CLAW", confirmed: true },
      });
      if (!reset.ok || reset.method !== "factory-reset.execute") throw new Error("factory reset failed");
      expect(await waitForTerminal(reset.result.id)).toMatchObject({ state: "completed" });
      await expect(readFile(join(dataDir, "uclaw", "settings.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(cacheDir, "electron", "entry.bin"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(stop).toHaveBeenCalledTimes(3);
      expect(start).toHaveBeenCalledTimes(3);
    } finally {
      await Promise.all([dataDir, cacheRoot].map((path) => rm(path, { recursive: true, force: true })));
    }
  });

  it("wires production workspace open and reveal to the controlled Electron shell", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-main-shell-data-"));
    const cacheDir = await mkdtemp(join(tmpdir(), "uclaw-main-shell-cache-"));
    await mkdir(join(dataDir, "workspace"), { recursive: true });
    await writeFile(join(dataDir, "workspace", "result.txt"), "result", "utf8");
    const openPath = vi.fn(async () => "");
    const showItemInFolder = vi.fn();
    try {
      const service = createProductionDataService({ dataDir, cacheDir }, { openPath, showItemInFolder });
      await expect(service.dispatch({
        method: "workspace.open", requestId: "open", params: { entryId: "result.txt" },
      })).resolves.toMatchObject({ ok: true, result: null });
      await expect(service.dispatch({
        method: "workspace.reveal", requestId: "reveal", params: { entryId: "result.txt" },
      })).resolves.toMatchObject({ ok: true, result: null });
      expect(openPath).toHaveBeenCalledWith(join(dataDir, "workspace", "result.txt"));
      expect(showItemInFolder).toHaveBeenCalledWith(join(dataDir, "workspace", "result.txt"));
    } finally {
      await Promise.all([dataDir, cacheDir].map((path) => rm(path, { recursive: true, force: true })));
    }
  });
});

describe("bootstrapDesktopApp", () => {
  it("quits immediately when another instance owns the lock", async () => {
    const quit = vi.fn();
    const createWindow = vi.fn();

    const result = await bootstrapDesktopApp({
      app: {
        requestSingleInstanceLock: () => false,
        quit,
        whenReady: vi.fn(async () => undefined),
        on: vi.fn(),
      },
      createWindow,
      registerIpc: vi.fn(),
      stopGateway: vi.fn(),
    });

    expect(result).toBeNull();
    expect(quit).toHaveBeenCalledOnce();
    expect(createWindow).not.toHaveBeenCalled();
  });

  it("restores and focuses its window on a second-instance event", async () => {
    const listeners = new Map<string, () => void>();
    const restore = vi.fn();
    const focus = vi.fn();
    const window = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore,
      focus,
    };

    await bootstrapDesktopApp({
      app: {
        requestSingleInstanceLock: () => true,
        quit: vi.fn(),
        whenReady: vi.fn(async () => undefined),
        on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
      },
      createWindow: vi.fn(async () => window),
      registerIpc: vi.fn(),
      stopGateway: vi.fn(),
    });

    listeners.get("second-instance")?.();
    expect(restore).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("holds the first quit until gateway cleanup completes", async () => {
    const listeners = new Map<string, (event?: { preventDefault(): void }) => void>();
    const quit = vi.fn();
    const preventDefault = vi.fn();
    let finishStop: (() => void) | undefined;
    const stopGateway = vi.fn(() => new Promise<void>((resolve) => { finishStop = resolve; }));

    await bootstrapDesktopApp({
      app: {
        requestSingleInstanceLock: () => true,
        quit,
        whenReady: vi.fn(async () => undefined),
        on: vi.fn((event: string, listener: (event?: { preventDefault(): void }) => void) => {
          listeners.set(event, listener);
        }),
      },
      createWindow: vi.fn(async (registerIpc) => {
        const window = {
          isDestroyed: () => false,
          isMinimized: () => false,
          restore: vi.fn(),
          focus: vi.fn(),
        };
        registerIpc(window);
        return window;
      }),
      registerIpc: vi.fn(),
      stopGateway,
    });

    listeners.get("before-quit")?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopGateway).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();

    finishStop?.();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
  });

  it("uninstalls IPC before disposing gateway-backed services on quit", async () => {
    const listeners = new Map<string, (event?: { preventDefault(): void }) => void>();
    const calls: string[] = [];
    const quit = vi.fn();
    await bootstrapDesktopApp({
      app: {
        requestSingleInstanceLock: () => true,
        quit,
        whenReady: vi.fn(async () => undefined),
        on: vi.fn((event: string, listener: (event?: { preventDefault(): void }) => void) => listeners.set(event, listener)),
      },
      createWindow: vi.fn(async (registerIpc) => {
        const window = { isDestroyed: () => false, isMinimized: () => false, restore: vi.fn(), focus: vi.fn() };
        registerIpc(window);
        return window;
      }),
      registerIpc: vi.fn(() => () => { calls.push("ipc"); }),
      stopGateway: vi.fn(async () => { calls.push("services"); }),
    });

    listeners.get("before-quit")?.({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(calls).toEqual(["ipc", "services"]);
  });

  it("prevents every quit attempt until cleanup completes", async () => {
    const listeners = new Map<string, (event?: { preventDefault(): void }) => void>();
    const quit = vi.fn();
    let finishStop: (() => void) | undefined;
    const stopGateway = vi.fn(() => new Promise<void>((resolve) => { finishStop = resolve; }));
    await bootstrapDesktopApp({
      app: {
        requestSingleInstanceLock: () => true,
        quit,
        whenReady: vi.fn(async () => undefined),
        on: vi.fn((event: string, listener: (event?: { preventDefault(): void }) => void) => {
          listeners.set(event, listener);
        }),
      },
      createWindow: vi.fn(async () => ({
        isDestroyed: () => false,
        isMinimized: () => false,
        restore: vi.fn(),
        focus: vi.fn(),
      })),
      registerIpc: vi.fn(),
      stopGateway,
    });
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };

    listeners.get("before-quit")?.(first);
    listeners.get("before-quit")?.(second);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(stopGateway).toHaveBeenCalledOnce();

    finishStop?.();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    listeners.get("before-quit")?.({ preventDefault: vi.fn() });
    expect(quit).toHaveBeenCalledOnce();
  });

  it("rolls back the gateway once when window creation fails", async () => {
    const stopGateway = vi.fn(async () => undefined);
    await expect(bootstrapDesktopApp({
      app: {
        requestSingleInstanceLock: () => true,
        quit: vi.fn(),
        whenReady: vi.fn(async () => undefined),
        on: vi.fn(),
      },
      createWindow: vi.fn(async () => { throw new Error("window failed"); }),
      registerIpc: vi.fn(),
      stopGateway,
    })).rejects.toThrow("window failed");
    expect(stopGateway).toHaveBeenCalledOnce();
  });

  it("rolls back the gateway once when IPC registration fails", async () => {
    const stopGateway = vi.fn(async () => undefined);
    await expect(bootstrapDesktopApp({
      app: {
        requestSingleInstanceLock: () => true,
        quit: vi.fn(),
        whenReady: vi.fn(async () => undefined),
        on: vi.fn(),
      },
      createWindow: vi.fn(async (registerIpc) => {
        const window = {
          isDestroyed: () => false,
          isMinimized: () => false,
          restore: vi.fn(),
          focus: vi.fn(),
        };
        registerIpc(window);
        return window;
      }),
      registerIpc: vi.fn(() => { throw new Error("IPC failed"); }),
      stopGateway,
    })).rejects.toThrow("IPC failed");
    expect(stopGateway).toHaveBeenCalledOnce();
  });

  it("preserves a window startup error when gateway cleanup also fails", async () => {
    const startupError = new Error("window startup failed");
    const cleanupError = new Error("gateway cleanup failed");
    const caught = await bootstrapDesktopApp({
      app: {
        requestSingleInstanceLock: () => true,
        quit: vi.fn(),
        whenReady: vi.fn(async () => undefined),
        on: vi.fn(),
      },
      createWindow: vi.fn(async () => { throw startupError; }),
      registerIpc: vi.fn(),
      stopGateway: vi.fn(async () => { throw cleanupError; }),
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([startupError, cleanupError]);
    expect((caught as Error & { cause?: unknown }).cause).toBe(startupError);
  });
});

describe("validateRendererUrl", () => {
  it("allows loopback development URLs", () => {
    expect(validateRendererUrl("http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173");
    expect(validateRendererUrl("http://localhost:5173/app")).toBe("http://localhost:5173/app");
  });

  it("rejects remote, credential-bearing, and non-HTTP renderer URLs", () => {
    expect(() => validateRendererUrl("https://example.com/app")).toThrow("loopback");
    expect(() => validateRendererUrl("http://user:pass@localhost:5173")).toThrow("loopback");
    expect(() => validateRendererUrl("file:///tmp/renderer.html")).toThrow("loopback");
  });
});

describe("runDesktopMain", () => {
  afterEach(() => vi.useRealTimers());

  it("wires the injected gateway lifecycle through readiness and app shutdown", async () => {
    class FakeChild extends EventEmitter {
      pid = 8123;
      exitCode: number | null = null;
      killed = false;
      kill = vi.fn(() => true);
    }
    const child = new FakeChild();
    const listeners = new Map<string, (event?: { preventDefault(): void }) => void>();
    const show = vi.fn();
    const window = {
      show,
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      focus: vi.fn(),
    };
    const buildGatewayLaunchOptions = vi.fn((port: number) => ({
      executable: "/runtime/node.exe",
      args: ["openclaw.js", "gateway", "--port", String(port)],
      env: { UCLAW_GATEWAY_PORT: String(port) },
    }));
    const probeCapabilities = vi.fn(async () => ({
      helloOk: true,
      methods: ["chat.send", "sessions.list"],
    }));
    const registerIpc = vi.fn();

    await runDesktopMain({
      spawn: vi.fn(() => child),
      buildGatewayLaunchOptions,
      requiredMethods: ["chat.send", "sessions.list"],
      probeCapabilities,
      dispatchClient: vi.fn(),
      selectPort: vi.fn(async () => 18791),
      fetch: vi.fn(async () => ({ ok: true })),
      now: () => 0,
      sleep: vi.fn(async () => undefined),
    }, {
      app: {
        requestSingleInstanceLock: () => true,
        quit: vi.fn(),
        whenReady: vi.fn(async () => undefined),
        on: vi.fn((event: string, listener: (event?: { preventDefault(): void }) => void) => {
          listeners.set(event, listener);
        }),
      },
      createWindow: vi.fn(async (registerIpc) => {
        registerIpc(window);
        return window;
      }),
      registerIpc,
    });

    expect(buildGatewayLaunchOptions).toHaveBeenCalledWith(18791);
    expect(probeCapabilities).toHaveBeenCalledWith(18791, expect.any(AbortSignal));
    expect(show).toHaveBeenCalledOnce();
    expect(registerIpc).toHaveBeenCalledWith(window, expect.any(Function));

    listeners.get("before-quit")?.({ preventDefault: vi.fn() });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.exitCode = 0;
    child.emit("exit", 0, null);
  });

  it("restarts the owned Gateway through the production consistency coordinator", async () => {
    class FakeChild extends EventEmitter {
      exitCode: number | null = null;
      killed = false;
      constructor(readonly pid: number) { super(); }
      kill = vi.fn(() => {
        queueMicrotask(() => {
          this.exitCode = 0;
          this.emit("exit", 0, null);
        });
        return true;
      });
    }
    const children = [new FakeChild(8201), new FakeChild(8202)];
    const spawn = vi.fn(() => children[spawn.mock.calls.length - 1]!);
    const coordinator = new ProductionRuntimeConsistencyCoordinator();
    await runDesktopMain({
      spawn,
      consistencyCoordinator: coordinator,
      buildGatewayLaunchOptions: (port) => ({ executable: "node", args: [String(port)] }),
      requiredMethods: [],
      probeCapabilities: async () => ({ helloOk: true, methods: [] }),
      dispatchClient: vi.fn(),
      selectPort: async () => 18794,
      fetch: async () => ({ ok: true }),
      now: () => 0,
      sleep: async () => undefined,
    }, {
      app: { requestSingleInstanceLock: () => true, quit: vi.fn(), whenReady: async () => undefined, on: vi.fn() },
      createWindow: async () => ({ show: vi.fn(), isDestroyed: () => false, isMinimized: () => false, restore: vi.fn(), focus: vi.fn() }),
      registerIpc: vi.fn(),
    });

    await coordinator.restartManagedGateway();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(coordinator.getState()).toEqual({ phase: "idle" });
  });

  it("times out a hanging health request and rolls back the gateway", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    class FakeChild extends EventEmitter {
      pid = 8124;
      exitCode: number | null = null;
      killed = false;
      kill = vi.fn((signal?: NodeJS.Signals | number) => {
        if (signal === "SIGTERM") {
          setTimeout(() => {
            this.exitCode = 0;
            this.emit("exit", 0, null);
          }, 1);
        }
        return true;
      });
    }
    const child = new FakeChild();
    const pending = runDesktopMain({
      spawn: () => child,
      buildGatewayLaunchOptions: () => ({ executable: "node", args: [] }),
      requiredMethods: [],
      probeCapabilities: vi.fn(),
      dispatchClient: vi.fn(),
      selectPort: async () => 18792,
      fetch: () => new Promise<never>(() => undefined),
      now: Date.now,
      sleep: vi.fn(async () => undefined),
      readinessTimeoutMs: 100,
    }, {
      app: {
        requestSingleInstanceLock: () => true,
        quit: vi.fn(),
        whenReady: vi.fn(async () => undefined),
        on: vi.fn(),
      },
      createWindow: vi.fn(),
      registerIpc: vi.fn(),
    });
    const rejected = expect(pending).rejects.toThrow("readiness timed out");

    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not create a window when the owned gateway exits during health fetch", async () => {
    class FakeChild extends EventEmitter {
      pid = 8125;
      exitCode: number | null = null;
      killed = false;
      kill = vi.fn(() => true);
    }
    const child = new FakeChild();
    const selectPort = vi.fn(async (excluded: readonly number[]) => {
      if (excluded.length > 0) throw new Error("no other candidate");
      return 18793;
    });
    const createWindow = vi.fn();

    await expect(runDesktopMain({
      spawn: vi.fn(() => child),
      buildGatewayLaunchOptions: () => ({ executable: "node", args: [] }),
      requiredMethods: [],
      probeCapabilities: vi.fn(),
      dispatchClient: vi.fn(),
      selectPort,
      fetch: vi.fn(async () => {
        child.exitCode = 1;
        child.emit("exit", 1, null);
        return { ok: true };
      }),
      now: () => 0,
      sleep: vi.fn(),
    }, {
      app: {
        requestSingleInstanceLock: () => true,
        quit: vi.fn(),
        whenReady: vi.fn(async () => undefined),
        on: vi.fn(),
      },
      createWindow,
      registerIpc: vi.fn(),
    })).rejects.toThrow("exited before readiness");

    expect(createWindow).not.toHaveBeenCalled();
    expect(selectPort).toHaveBeenCalledTimes(1);
    expect(selectPort).toHaveBeenNthCalledWith(1, [], expect.any(AbortSignal));
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("aborts readiness on quit without spawning another port or creating a window", async () => {
    class FakeChild extends EventEmitter {
      pid: number;
      exitCode: number | null = null;
      killed = false;
      kill = vi.fn((signal?: NodeJS.Signals | number) => {
        if (signal === "SIGTERM") {
          queueMicrotask(() => {
            this.exitCode = 0;
            this.emit("exit", 0, null);
          });
        }
        return true;
      });
      constructor(pid: number) {
        super();
        this.pid = pid;
      }
    }
    const children = [new FakeChild(8130), new FakeChild(8131)];
    const spawn = vi.fn(() => children[spawn.mock.calls.length - 1]!);
    const listeners = new Map<string, (event?: { preventDefault(): void }) => void>();
    let finishFetch: ((value: { ok: boolean }) => void) | undefined;
    let fetchSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init: { signal: AbortSignal }) => {
      fetchSignal = init.signal;
      return new Promise<{ ok: boolean }>((resolve) => { finishFetch = resolve; });
    });
    const createWindow = vi.fn(async () => ({
      show: vi.fn(),
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      focus: vi.fn(),
    }));
    const pending = runDesktopMain({
      spawn,
      buildGatewayLaunchOptions: (port) => ({ executable: "node", args: [String(port)] }),
      requiredMethods: [],
      probeCapabilities: vi.fn(async () => ({ helloOk: true, methods: [] })),
      dispatchClient: vi.fn(),
      selectPort: async (excluded) => excluded.length === 0 ? 18789 : 18790,
      fetch,
      now: () => 0,
      sleep: vi.fn(async () => undefined),
    }, {
      app: {
        requestSingleInstanceLock: () => true,
        quit: vi.fn(),
        whenReady: vi.fn(async () => undefined),
        on: vi.fn((event: string, listener: (event?: { preventDefault(): void }) => void) => {
          listeners.set(event, listener);
        }),
      },
      createWindow,
      registerIpc: vi.fn(() => vi.fn()),
    });
    while (fetch.mock.calls.length === 0) await Promise.resolve();

    const quitEvent = { preventDefault: vi.fn() };
    listeners.get("before-quit")?.(quitEvent);
    finishFetch?.({ ok: true });

    await expect(pending).resolves.toBeNull();
    expect(quitEvent.preventDefault).toHaveBeenCalledOnce();
    expect(fetchSignal?.aborted).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(createWindow).not.toHaveBeenCalled();
  });
});
