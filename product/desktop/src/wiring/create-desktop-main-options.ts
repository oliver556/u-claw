import { spawn as spawnChild } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";

import {
  AttachmentManager,
  AdapterServiceError,
  GatewayWebSocket,
  OpenClawClient,
  type HelloOk,
  type OpenClawTransport,
  type WebSocketLike,
} from "@uclaw/adapter";
import { MessageEventSchema, type MessageEvent, type ProviderConfigEntry, type ProviderNetworkSettings, type SendMessageInput } from "@uclaw/shared";

import { createClientDispatcher } from "../ipc/client-dispatcher.js";
import { createProviderHttpClient } from "../providers/provider-network.js";
import type {
  DesktopDomainRegistry,
  DesktopMainOptions,
  RegisteredDesktopDomain,
} from "../main.js";
import {
  DesktopWiringError,
  readDesktopWiringEnvironment,
} from "./environment.js";
import { composeDesktopDomainModules } from "./domain-modules.js";

const REQUIRED_GATEWAY_METHODS = [
  "sessions.list",
  "sessions.describe",
  "chat.history",
  "chat.send",
] as const;

class ProductionDomainRegistry implements DesktopDomainRegistry {
  private readonly registrations = new Map<string, RegisteredDesktopDomain>();

  register(name: string, registration: RegisteredDesktopDomain): () => void {
    if (!/^[a-z][a-z0-9.-]{0,63}$/.test(name) || this.registrations.has(name)) {
      throw new DesktopWiringError("CONFLICT", "Desktop domain registration is invalid or duplicated.");
    }
    this.registrations.set(name, registration);
    return () => {
      if (this.registrations.get(name) === registration) this.registrations.delete(name);
    };
  }

  resolve<T extends RegisteredDesktopDomain>(name: string): T | undefined {
    return this.registrations.get(name) as T | undefined;
  }

  installIpc(context: Parameters<DesktopDomainRegistry["installIpc"]>[0]): () => void {
    const disposers: Array<() => void> = [];
    try {
      for (const registration of this.registrations.values()) {
        const disposer = registration.installIpc?.(context);
        if (disposer) disposers.push(disposer);
      }
    } catch (error) {
      const failures: unknown[] = [error];
      for (const disposer of disposers.reverse()) {
        try {
          disposer();
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (failures.length > 1) throw new AggregateError(failures, "Desktop domain IPC install failed and cleanup failed.");
      throw error;
    }
    let installed = true;
    return () => {
      if (!installed) return;
      installed = false;
      const failures: unknown[] = [];
      for (const disposer of disposers.reverse()) {
        try {
          disposer();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, "Desktop domain IPC cleanup failed.");
    };
  }

  async dispose(): Promise<void> {
    const registrations = [...this.registrations.values()].reverse();
    this.registrations.clear();
    const failures: unknown[] = [];
    for (const registration of registrations) {
      try {
        await registration.dispose?.();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Desktop domain cleanup failed.");
  }
}

class PortAwareGatewayTransport implements OpenClawTransport {
  private port: number | undefined;
  private active: GatewayWebSocket | undefined;
  private hello: HelloOk | undefined;

  constructor(private readonly token: string) {}

  get state(): OpenClawTransport["state"] {
    return this.active?.state ?? "idle";
  }

  get router(): OpenClawTransport["router"] {
    if (!this.active) throw new DesktopWiringError("GATEWAY_DISCONNECTED", "Gateway is not connected.", true);
    return this.active.router;
  }

  setPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new DesktopWiringError("INVALID_ARGUMENT", "Gateway port is invalid.");
    }
    this.close();
    this.port = port;
  }

  async connect(): Promise<HelloOk> {
    if (this.hello) return this.hello;
    if (this.port === undefined) {
      throw new DesktopWiringError("GATEWAY_STARTING", "Gateway port is not available yet.", true);
    }
    this.active ??= new GatewayWebSocket({
      url: `ws://127.0.0.1:${this.port}`,
      webSocketFactory: (url) => new (globalThis.WebSocket as unknown as new (url: string) => WebSocketLike)(url),
      connectParams: () => ({
        client: { id: "u-claw-desktop", mode: "desktop" },
        role: "operator",
        scopes: ["operator.read", "operator.write", "operator.approvals"],
        caps: ["protocol-v4"],
        auth: { token: this.token },
      }),
    });
    this.hello = await this.active.connect();
    return this.hello;
  }

  close(): void {
    const active = this.active;
    this.active = undefined;
    this.hello = undefined;
    active?.close();
  }
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal, abort: () => void): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      abort();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function normalizeGatewayFailure(error: unknown): never {
  const code = error instanceof AdapterServiceError ? error.uclawError.code : undefined;
  if (code === "UNAUTHORIZED" || code === "FORBIDDEN") {
    throw new DesktopWiringError("AUTH_FAILED", "Gateway authentication failed.");
  }
  if (code === "PROTOCOL_MAPPING_FAILED" || code === "CONTRACT_INCOMPATIBLE") {
    throw new DesktopWiringError("PROTOCOL_ERROR", "Gateway protocol negotiation failed.");
  }
  if (code === "GATEWAY_DISCONNECTED" || code === "TIMEOUT") {
    throw new DesktopWiringError("OFFLINE", "Gateway is offline.", true);
  }
  throw error;
}

type ProviderExecutor = (
  input: SendMessageInput,
  provider: ProviderConfigEntry,
  signal?: AbortSignal,
  network?: ProviderNetworkSettings,
) => Promise<AsyncIterable<MessageEvent>>;

const providerHttpClient = createProviderHttpClient();

function registeredProviderExecutor(registry: DesktopDomainRegistry, source: "domestic" | "custom"): ProviderExecutor {
  return async (input, provider, signal, network) => {
    const registration = registry.resolve<RegisteredDesktopDomain & { execute?: ProviderExecutor }>(`provider.executor.${source}`) ??
      registry.resolve<RegisteredDesktopDomain & { execute?: ProviderExecutor }>("provider.executor.openai-compatible");
    if (typeof registration?.execute !== "function") {
      throw new DesktopWiringError("UNCONFIGURED", "External model provider executor is not registered.");
    }
    return registration.execute(input, provider, signal, network);
  };
}

async function executeOpenAICompatibleProvider(
  input: SendMessageInput,
  provider: ProviderConfigEntry,
  signal?: AbortSignal,
  network?: ProviderNetworkSettings,
): Promise<AsyncIterable<MessageEvent>> {
  if (provider.baseUrl === null || provider.apiKey === undefined) {
    throw new DesktopWiringError("UNCONFIGURED", "Model provider is not configured.");
  }
  if (input.blocks.some((block) => block.type !== "text")) {
    throw new DesktopWiringError("UNSUPPORTED", "External provider attachments are not supported.");
  }
  const prompt = input.blocks.map((block) => block.type === "text" ? block.text : "").join("\n\n");
  const payload = await providerHttpClient.requestJson({
    url: `${provider.baseUrl.replace(/\/+$/u, "")}/chat/completions`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4_096,
        stream: false,
      }),
      signal,
    },
    ...(network === undefined ? {} : { network }),
  });
  const content = typeof payload === "object" && payload !== null &&
    "choices" in payload && Array.isArray(payload.choices) &&
    typeof payload.choices[0] === "object" && payload.choices[0] !== null &&
    "message" in payload.choices[0] && typeof payload.choices[0].message === "object" && payload.choices[0].message !== null &&
    "content" in payload.choices[0].message && typeof payload.choices[0].message.content === "string"
    ? payload.choices[0].message.content
    : undefined;
  if (content === undefined) throw new Error("External model provider response failed validation.");

  const digest = createHash("sha256")
    .update("uclaw-external-chat-v1\0")
    .update(input.sessionId)
    .update("\0")
    .update(input.clientRequestId)
    .digest("hex");
  const runId = `run_${digest.slice(0, 32)}`;
  const events = [
    MessageEventSchema.parse({ type: "started", runId, sessionId: input.sessionId }),
    MessageEventSchema.parse({ type: "delta", runId, mode: "append", text: content }),
    MessageEventSchema.parse({
      type: "final",
      runId,
      message: {
        id: `msg_${digest.slice(0, 32)}`,
        sessionId: input.sessionId,
        runId,
        role: "assistant",
        status: "completed",
        blocks: [{ id: `block_${digest.slice(0, 32)}`, type: "text", text: content, format: "markdown" }],
        createdAt: new Date().toISOString(),
      },
    }),
  ];
  return (async function* (): AsyncIterable<MessageEvent> {
    yield* events;
  })();
}

export async function createDesktopMainOptions(env: NodeJS.ProcessEnv): Promise<DesktopMainOptions> {
  const environment = await readDesktopWiringEnvironment(env);
  const domains = new ProductionDomainRegistry();
  const attachments = new AttachmentManager();
  const transport = new PortAwareGatewayTransport(environment.gatewayToken);
  let gatewayProcessAlive = false;
  const client = new OpenClawClient({
    transport,
    attachments,
    statusProjection: () => {
      if (!existsSync(environment.dataRoot)) {
        return { processAlive: gatewayProcessAlive, usb: { state: "missing", dataWritable: false } };
      }
      try {
        accessSync(environment.dataRoot, constants.W_OK);
        return { processAlive: gatewayProcessAlive, usb: { state: "available", dataWritable: true } };
      } catch {
        return { processAlive: gatewayProcessAlive, usb: { state: "read-only", dataWritable: false } };
      }
    },
  });
  await composeDesktopDomainModules(domains, { client }, [{
    name: "provider.executor.openai-compatible",
    register: () => ({ execute: executeOpenAICompatibleProvider, dispose: () => undefined }),
  }]);
  const dispatcher = createClientDispatcher({ client, sendEvent: () => undefined });
  let disposed = false;

  return {
    spawn: (executable, args, options) => {
      const child = spawnChild(executable, [...args], options) as unknown as ReturnType<DesktopMainOptions["spawn"]>;
      gatewayProcessAlive = child.pid !== undefined && child.exitCode === null;
      child.on("error", () => { gatewayProcessAlive = false; });
      child.once("exit", () => { gatewayProcessAlive = false; });
      child.once("close", () => { gatewayProcessAlive = false; });
      return child;
    },
    buildGatewayLaunchOptions: (port) => {
      transport.setPort(port);
      return {
        executable: environment.nodeExecutable,
        args: [environment.openClawEntry, "gateway", "run", "--port", String(port), "--auth", "token", "--ws-log", "compact"],
        cwd: environment.runtimeRoot,
        env: {
          ...env,
          ...(environment.electronRunAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
          OPENCLAW_GATEWAY_TOKEN: environment.gatewayToken,
        },
      };
    },
    requiredMethods: REQUIRED_GATEWAY_METHODS,
    probeCapabilities: async (_port, signal) => {
      try {
        const hello = await withAbort(transport.connect(), signal, () => transport.close());
        const methods = new Set(hello.features.methods);
        if (!REQUIRED_GATEWAY_METHODS.every((method) => methods.has(method))) {
          throw new DesktopWiringError("UNSUPPORTED", "Gateway is missing required methods.");
        }
        return { helloOk: true, methods: hello.features.methods };
      } catch (error) {
        normalizeGatewayFailure(error);
      }
    },
    dispatchClient: dispatcher,
    client,
    attachments,
    domainRegistrations: domains,
    modelSourceExecutors: {
      domestic: registeredProviderExecutor(domains, "domestic"),
      custom: registeredProviderExecutor(domains, "custom"),
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      dispatcher.dispose();
      transport.close();
      await domains.dispose();
    },
  };
}
