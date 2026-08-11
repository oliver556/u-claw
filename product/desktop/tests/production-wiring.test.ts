import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDesktopMainOptions,
  createRegisteredProviderExecutor,
} from "../src/wiring/create-desktop-main-options.js";

class ScriptedWebSocket {
  static instances: ScriptedWebSocket[] = [];
  static outcome: "success" | "offline" | "authentication" | "protocol" | "missing-methods" = "success";
  readonly sent: Array<Record<string, unknown>> = [];
  readonly close = vi.fn();
  private readonly listeners = new Map<string, Set<(event: { data?: string }) => void>>();

  constructor(readonly url: string) {
    if (ScriptedWebSocket.outcome === "offline") throw new Error("offline with /private/runtime and token=secret");
    ScriptedWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.emit("open", {});
      this.emit("message", {
        data: JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "nonce-1", ts: 1 },
        }),
      });
    });
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    if (frame.method !== "connect") return;
    if (ScriptedWebSocket.outcome === "authentication") {
      queueMicrotask(() => this.emit("message", {
        data: JSON.stringify({
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: "UNAUTHORIZED", message: "token=secret /private/runtime", retryable: false },
        }),
      }));
      return;
    }
    queueMicrotask(() => this.emit("message", {
      data: JSON.stringify({
        type: "res",
        id: frame.id,
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: ScriptedWebSocket.outcome === "protocol" ? 3 : 4,
          server: { version: "2026.7.1-2" },
          features: {
            methods: ScriptedWebSocket.outcome === "missing-methods"
              ? ["sessions.list", "chat.history", "chat.send"]
              : ["sessions.list", "sessions.describe", "chat.history", "chat.send"],
            events: ["chat"],
          },
          policy: { maxPayload: 1_000_000, maxBufferedBytes: 2_000_000 },
        },
      }),
    }));
  }

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { data?: string }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("production desktop wiring", () => {
  const OriginalWebSocket = globalThis.WebSocket;
  let runtimeRoot: string;
  let openClawEntry: string;
  let dataRoot: string;
  let productionEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    runtimeRoot = await mkdtemp(join(tmpdir(), "uclaw-production-wiring-"));
    openClawEntry = join(runtimeRoot, "openclaw", "openclaw.mjs");
    await mkdir(join(runtimeRoot, "openclaw"), { recursive: true });
    await writeFile(openClawEntry, "// fixture\n");
    await writeFile(join(runtimeRoot, "openclaw", "package.json"), JSON.stringify({ name: "openclaw", version: "2026.7.1-2" }));
    runtimeRoot = await realpath(runtimeRoot);
    openClawEntry = await realpath(openClawEntry);
    dataRoot = await mkdtemp(join(tmpdir(), "uclaw-production-data-"));
    const configPath = join(dataRoot, "openclaw.json");
    await writeFile(configPath, JSON.stringify({ gateway: { auth: { mode: "token", token: "test-gateway-token" } } }));
    productionEnv = {
      UCLAW_RUNTIME_DIR: runtimeRoot,
      UCLAW_OPENCLAW_ENTRY: openClawEntry,
      UCLAW_DATA_DIR: dataRoot,
      OPENCLAW_CONFIG_PATH: configPath,
    };
  });

  afterEach(async () => {
    ScriptedWebSocket.instances = [];
    ScriptedWebSocket.outcome = "success";
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: OriginalWebSocket });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await Promise.all([runtimeRoot, dataRoot].map((path) => rm(path, { recursive: true, force: true })));
  });

  it("returns a diagnostic UClaw error when runtime configuration is missing", async () => {
    await expect(createDesktopMainOptions({})).rejects.toMatchObject({
      code: "UNCONFIGURED",
      retryable: false,
      causeDetails: { operation: "desktop.wiring" },
    });
  });

  it("accepts the existing portable short token without weakening character validation", async () => {
    const configPath = productionEnv.OPENCLAW_CONFIG_PATH!;
    await writeFile(configPath, JSON.stringify({ gateway: { auth: { mode: "token", token: "uclaw" } } }));

    const options = await createDesktopMainOptions(productionEnv);
    const launch = options.buildGatewayLaunchOptions(18790) as { env: NodeJS.ProcessEnv };
    expect(launch.env.OPENCLAW_GATEWAY_TOKEN).toBe("uclaw");
    await options.dispose?.();
  });

  it("skips an OpenClaw filename decoy and resolves the locked package", async () => {
    const decoy = join(runtimeRoot, "aaa-decoy");
    await mkdir(decoy);
    await writeFile(join(decoy, "openclaw.mjs"), "// decoy\n");
    await writeFile(join(decoy, "package.json"), JSON.stringify({ name: "not-openclaw", version: "0.0.0" }));
    delete productionEnv.UCLAW_OPENCLAW_ENTRY;

    const options = await createDesktopMainOptions(productionEnv);
    const launch = options.buildGatewayLaunchOptions(18790) as { args: string[] };
    expect(launch.args[0]).toBe(openClawEntry);
    await options.dispose?.();
  });

  it("selects the fixed node_modules runtime before a decoy inventory exceeding the scan limit", async () => {
    const decoy = join(runtimeRoot, "aaa-decoy");
    await mkdir(decoy);
    await writeFile(join(decoy, "openclaw.mjs"), "// decoy\n");
    await writeFile(join(decoy, "package.json"), JSON.stringify({ name: "not-openclaw", version: "0.0.0" }));
    for (let offset = 0; offset < 20_001; offset += 500) {
      await Promise.all(Array.from(
        { length: Math.min(500, 20_001 - offset) },
        (_, index) => writeFile(join(decoy, `filler-${String(offset + index).padStart(5, "0")}`), ""),
      ));
    }
    const fixedPackage = join(runtimeRoot, "node_modules", "openclaw");
    await mkdir(fixedPackage, { recursive: true });
    const fixedEntry = join(fixedPackage, "openclaw.mjs");
    await writeFile(fixedEntry, "// fixed runtime\n");
    await writeFile(join(fixedPackage, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.7.1-2" }));
    delete productionEnv.UCLAW_OPENCLAW_ENTRY;

    const options = await createDesktopMainOptions(productionEnv);
    const launch = options.buildGatewayLaunchOptions(18790) as { args: string[] };
    expect(launch.args[0]).toBe(await realpath(fixedEntry));
    await options.dispose?.();
  });

  it("rejects an explicit entry whose adjacent package is not the locked OpenClaw version", async () => {
    await writeFile(join(runtimeRoot, "openclaw", "package.json"), JSON.stringify({ name: "openclaw", version: "2025.1.0" }));

    await expect(createDesktopMainOptions(productionEnv)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("rejects an explicit non-entry file inside the locked OpenClaw package", async () => {
    const alternate = join(runtimeRoot, "openclaw", "alternate.mjs");
    await writeFile(alternate, "// not the package entrypoint\n");
    productionEnv.UCLAW_OPENCLAW_ENTRY = alternate;

    await expect(createDesktopMainOptions(productionEnv)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("assembles one authenticated v4 client graph for health, IPC, attachments, and cleanup", async () => {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: ScriptedWebSocket });
    const options = await createDesktopMainOptions(productionEnv);
    const launch = options.buildGatewayLaunchOptions(18791) as {
      executable: string;
      args: string[];
      env: NodeJS.ProcessEnv;
    };

    expect(launch.args).toEqual(expect.arrayContaining([
      openClawEntry, "gateway", "run", "--port", "18791", "--auth", "token",
    ]));
    expect(launch.args.join(" ")).not.toContain("test-gateway-token");
    expect(launch.env.OPENCLAW_GATEWAY_TOKEN).toBe("test-gateway-token");
    expect(options.client?.attachments).toBe(options.attachments);
    expect(options.providerConfig).toBeDefined();
    expect(options.pluginRuntime).toBeDefined();

    await expect(options.probeCapabilities(18791, new AbortController().signal)).resolves.toEqual({
      helloOk: true,
      methods: ["sessions.list", "sessions.describe", "chat.history", "chat.send"],
    });
    const socket = ScriptedWebSocket.instances[0]!;
    expect(socket.url).toBe("ws://127.0.0.1:18791");
    expect(socket.sent[0]).toMatchObject({
      method: "connect",
      params: {
        minProtocol: 4,
        maxProtocol: 4,
        auth: { token: "test-gateway-token" },
        scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
      },
    });

    await expect(options.dispatchClient({
      method: "gateway.negotiate",
      requestId: "wiring-negotiate",
      params: {},
    })).resolves.toMatchObject({ ok: true, result: { protocolVersion: 4 } });
    await options.dispose?.();
    expect(socket.close).toHaveBeenCalled();
  });

  it("injects the production process lifecycle and data-root projection into client status", async () => {
    const options = await createDesktopMainOptions(productionEnv);

    await expect(options.client!.gateway.getStatus()).resolves.toMatchObject({
      connectionState: "idle",
      processAlive: false,
      usb: { state: "available", dataWritable: true },
    });
    await options.dispose?.();
  });

  it("spawns only the configured runtime and supplies a real default provider executor", async () => {
    let requestBody = "";
    let authorization: string | undefined;
    const server = createServer((request, response) => {
      authorization = request.headers.authorization;
      request.on("data", (chunk: Buffer) => { requestBody += chunk; });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: "provider response" } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("provider fixture did not bind");
    const options = await createDesktopMainOptions(productionEnv);
    try {
      const launch = options.buildGatewayLaunchOptions(18792) as { executable: string; args: string[]; env: NodeJS.ProcessEnv };

      expect(typeof options.spawn).toBe("function");
      expect(launch.executable).toBe(process.execPath);
      const stream = await options.modelSourceExecutors!.custom({
        sessionId: "session-1",
        clientRequestId: "request-1",
        blocks: [{ type: "text", text: "hello", format: "plain" }],
      }, {
        id: "custom",
        name: "Custom",
        enabled: true,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "model-1",
        apiKey: "provider-key",
      });
      const events = [];
      for await (const event of stream) events.push(event);
      expect(events).toMatchObject([
        { type: "started", sessionId: "session-1" },
        { type: "delta", text: "provider response" },
        { type: "final", message: { blocks: [{ type: "text", text: "provider response" }] } },
      ]);
      expect(authorization).toBe("Bearer provider-key");
      expect(JSON.parse(requestBody)).toMatchObject({ model: "model-1", max_tokens: 4_096, stream: false });
    } finally {
      await options.dispose?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("allows a loopback OpenAI-compatible local model without an API key", async () => {
    let authorization: string | undefined;
    const server = createServer((request, response) => {
      authorization = request.headers.authorization;
      request.on("data", () => undefined);
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: "local response" } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local provider fixture did not bind");
    const options = await createDesktopMainOptions(productionEnv);
    try {
      const stream = await options.modelSourceExecutors!.custom({
        sessionId: "session-local",
        clientRequestId: "request-local",
        blocks: [{ type: "text", text: "hello", format: "plain" }],
      }, {
        id: "ollama-local",
        name: "Ollama",
        enabled: true,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "llama3.2",
      });
      const events = [];
      for await (const event of stream) events.push(event);
      expect(events).toMatchObject([{ type: "started" }, { type: "delta", text: "local response" }, { type: "final" }]);
      expect(authorization).toBeUndefined();
    } finally {
      await options.dispose?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("routes the ZAI native template through OpenClaw instead of the HTTP executor", async () => {
    const openAiCompatible = vi.fn();
    const native = vi.fn(async () => "native-result");
    const registry = {
      resolve: vi.fn(() => ({ execute: openAiCompatible })),
    } as never;
    const execute = createRegisteredProviderExecutor(registry, "domestic", native as never);

    await expect(execute({} as never, {
      id: "zai",
      templateId: "zai",
      name: "Z.AI",
      enabled: true,
      baseUrl: null,
      model: "glm-5",
      apiKey: "zai-key",
    })).resolves.toBe("native-result");
    expect(native).toHaveBeenCalledOnce();
    expect(openAiCompatible).not.toHaveBeenCalled();
  });

  it("routes the default provider executor through the safe network boundary", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "unsafe response" } }] }),
    }));
    vi.stubGlobal("fetch", fetch);
    const options = await createDesktopMainOptions(productionEnv);

    await expect(options.modelSourceExecutors!.custom({
      sessionId: "session-unsafe",
      clientRequestId: "request-unsafe",
      blocks: [{ type: "text", text: "hello", format: "plain" }],
    }, {
      id: "unsafe",
      name: "Unsafe",
      enabled: true,
      baseUrl: "http://169.254.169.254/v1",
      model: "model-1",
      apiKey: "provider-key",
    })).rejects.toThrow("UNSAFE_TARGET");
    expect(fetch).not.toHaveBeenCalled();
    await options.dispose?.();
  });

  it("shares saved provider proxy settings with the managed Gateway launch", async () => {
    const options = await createDesktopMainOptions(productionEnv);
    expect(options.providers).toBeDefined();

    await options.providers!.setNetwork({
      httpProxy: "http://proxy.example.com:8080",
      httpsProxy: "https://proxy.example.com:8443",
      noProxy: ["localhost", "127.0.0.1", "::1", ".example.com"],
    });

    const launch = options.buildGatewayLaunchOptions(18796) as { env: NodeJS.ProcessEnv };
    expect(launch.env).toMatchObject({
      HTTP_PROXY: "http://proxy.example.com:8080",
      http_proxy: "http://proxy.example.com:8080",
      HTTPS_PROXY: "https://proxy.example.com:8443",
      https_proxy: "https://proxy.example.com:8443",
      NO_PROXY: "localhost,127.0.0.1,::1,.example.com",
      no_proxy: "localhost,127.0.0.1,::1,.example.com",
    });
    await options.dispose?.();
  });

  it("provides a closeable domain registration point for phases 03 through 16", async () => {
    const options = await createDesktopMainOptions(productionEnv);
    const dispose = vi.fn();
    const unregister = options.domainRegistrations!.register("work.sessions", { dispose });

    expect(options.domainRegistrations!.resolve("work.sessions")).toBeDefined();
    unregister();
    expect(options.domainRegistrations!.resolve("work.sessions")).toBeUndefined();
    options.domainRegistrations!.register("work.sessions", { dispose });
    await options.dispose?.();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("installs domain IPC hooks and cleans IPC and registrations in reverse order", async () => {
    const options = await createDesktopMainOptions(productionEnv);
    const calls: string[] = [];
    options.domainRegistrations!.register("work.first", {
      installIpc: () => {
        calls.push("install:first");
        return () => calls.push("uninstall:first");
      },
      dispose: () => { calls.push("dispose:first"); },
    });
    options.domainRegistrations!.register("work.second", {
      installIpc: () => {
        calls.push("install:second");
        return () => calls.push("uninstall:second");
      },
      dispose: () => { calls.push("dispose:second"); },
    });

    const uninstall = options.domainRegistrations!.installIpc({
      ipcMain: {} as never,
      authorizedWebContents: { mainFrame: {} },
      client: options.client!,
      services: { get: () => undefined },
    });
    expect(calls).toEqual(["install:first", "install:second"]);
    uninstall();
    await options.dispose?.();
    expect(calls).toEqual([
      "install:first", "install:second",
      "uninstall:second", "uninstall:first",
      "dispose:second", "dispose:first",
    ]);
  });

  it("continues uninstalling domain IPC hooks after one disposer fails", async () => {
    const options = await createDesktopMainOptions(productionEnv);
    const first = vi.fn();
    const second = vi.fn(() => { throw new Error("second failed"); });
    options.domainRegistrations!.register("work.first", { installIpc: () => first });
    options.domainRegistrations!.register("work.second", { installIpc: () => second });
    const uninstall = options.domainRegistrations!.installIpc({
      ipcMain: {} as never,
      authorizedWebContents: { mainFrame: {} },
      client: options.client!,
      services: { get: () => undefined },
    });

    expect(() => uninstall()).toThrow(AggregateError);
    expect(second).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();
    await options.dispose?.();
  });

  it("preserves module install failure while rolling back every installed IPC hook", async () => {
    const options = await createDesktopMainOptions(productionEnv);
    const rollback = vi.fn(() => { throw new Error("rollback failed"); });
    options.domainRegistrations!.register("work.first", { installIpc: () => rollback });
    options.domainRegistrations!.register("work.second", { installIpc: () => { throw new Error("install failed"); } });

    const error = (() => {
      try {
        options.domainRegistrations!.installIpc({
          ipcMain: {} as never,
          authorizedWebContents: { mainFrame: {} },
          client: options.client!,
          services: { get: () => undefined },
        });
      } catch (caught) {
        return caught;
      }
      throw new Error("install unexpectedly succeeded");
    })();

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toMatchObject([
      { message: "install failed" },
      { message: "rollback failed" },
    ]);
    expect(rollback).toHaveBeenCalledOnce();
    await options.dispose?.();
  });

  it.each([
    ["offline", "OFFLINE"],
    ["authentication", "AUTH_FAILED"],
    ["protocol", "PROTOCOL_ERROR"],
  ] as const)("maps %s startup failures without leaking credentials or paths", async (outcome, code) => {
    ScriptedWebSocket.outcome = outcome;
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: ScriptedWebSocket });
    const options = await createDesktopMainOptions(productionEnv);
    options.buildGatewayLaunchOptions(18793);

    const error = await options.probeCapabilities(18793, new AbortController().signal).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code });
    expect(JSON.stringify(error)).not.toContain("test-gateway-token");
    expect(JSON.stringify(error)).not.toContain(runtimeRoot);
    await options.dispose?.();
  });

  it("preserves unsupported capability as an explicit state", async () => {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: ScriptedWebSocket });
    const options = await createDesktopMainOptions(productionEnv);
    options.buildGatewayLaunchOptions(18794);
    await options.probeCapabilities(18794, new AbortController().signal);

    await expect(options.client!.files.list()).rejects.toMatchObject({
      uclawError: { code: "UNSUPPORTED" },
    });
    await options.dispose?.();
  });

  it("rejects hello immediately when a required gateway method is missing", async () => {
    ScriptedWebSocket.outcome = "missing-methods";
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: ScriptedWebSocket });
    const options = await createDesktopMainOptions(productionEnv);
    options.buildGatewayLaunchOptions(18795);

    await expect(options.probeCapabilities(18795, new AbortController().signal)).rejects.toMatchObject({
      code: "UNSUPPORTED",
      retryable: false,
    });
    await options.dispose?.();
  });
});
