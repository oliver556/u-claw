import { spawn as spawnChild } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  AttachmentManager,
  AdapterServiceError,
  GatewayWebSocket,
  OpenClawClient,
  createOpenClawUsageService,
  type HelloOk,
  type OpenClawTransport,
  type WebSocketLike,
} from "@uclaw/adapter";
import { MessageEventSchema, type MessageEvent, type ProviderConfigEntry, type ProviderNetworkSettings, type SendMessageInput } from "@uclaw/shared";

import { createClientDispatcher } from "../ipc/client-dispatcher.js";
import { createOpenClawProviderConfigBackend } from "../providers/openclaw-provider-config.js";
import { createOpenClawProviderExecutor } from "../providers/openclaw-provider-executor.js";
import { createProviderStore, type ProviderStore } from "../providers/provider-store.js";
import {
  applyProviderNetworkEnvironment,
  createProviderHttpClient,
  createProviderNetworkService,
} from "../providers/provider-network.js";
import type {
  DesktopDomainRegistry,
  DesktopMainOptions,
  RegisteredDesktopDomain,
} from "../main.js";
import { createOpenClawCliPluginRuntime } from "../plugins/openclaw-cli-runtime.js";
import { createOpenClawSkillRuntime } from "../skills/openclaw-skill-runtime.js";
import { createUsageDispatcher } from "../usage/usage-dispatcher.js";
import { createUsageDomainRegistration } from "../usage/usage-domain.js";
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
        scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
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

export function createRegisteredProviderExecutor(
  registry: DesktopDomainRegistry,
  source: "domestic" | "custom",
  nativeExecutor?: ProviderExecutor,
): ProviderExecutor {
  return async (input, provider, signal, network) => {
    if (provider.id === "zai" && provider.baseUrl === null && nativeExecutor !== undefined) {
      return nativeExecutor(input, provider, signal, network);
    }
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
  if (provider.baseUrl === null) {
    throw new DesktopWiringError("UNCONFIGURED", "Model provider is not configured.");
  }
  const endpoint = new URL(provider.baseUrl);
  const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
  if (provider.apiKey === undefined && !loopback) throw new DesktopWiringError("UNCONFIGURED", "Model provider is not configured.");
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
        ...(provider.apiKey === undefined ? {} : { authorization: `Bearer ${provider.apiKey}` }),
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

async function resolveExistingSkillRoot(candidate: string): Promise<string | undefined> {
  if (!isAbsolute(candidate) || candidate.includes("\0")) return undefined;
  try {
    const normalized = resolve(candidate);
    const info = await lstat(normalized);
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    return await realpath(normalized);
  } catch {
    return undefined;
  }
}

async function resolveBundledSkillsRoot(env: NodeJS.ProcessEnv): Promise<string> {
  const override = env.UCLAW_PORTABLE_SKILLS_DIR;
  if (override !== undefined) {
    if (!isAbsolute(override) || override.includes("\0")) {
      throw new DesktopWiringError("UNCONFIGURED", "Portable Skill source is not configured.");
    }
    const resolved = await resolveExistingSkillRoot(override);
    if (resolved === undefined) throw new DesktopWiringError("UNAVAILABLE", "Portable Skill source is unavailable.");
    return resolved;
  }

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    ...(resourcesPath === undefined ? [] : [join(resourcesPath, "portable", "skills-cn")]),
    resolve(moduleDir, "../../../../portable/skills-cn"),
  ];
  for (const candidate of candidates) {
    const resolved = await resolveExistingSkillRoot(candidate);
    if (resolved !== undefined) return resolved;
  }
  throw new DesktopWiringError("UNAVAILABLE", "Portable Skill source is unavailable.");
}

export async function createDesktopMainOptions(env: NodeJS.ProcessEnv): Promise<DesktopMainOptions> {
  const environment = await readDesktopWiringEnvironment(env);
  const bundledSkillsRoot = await resolveBundledSkillsRoot(env);
  const domains = new ProductionDomainRegistry();
  const attachments = new AttachmentManager();
  const transport = new PortAwareGatewayTransport(environment.gatewayToken);
  const openClawConfig = createOpenClawProviderConfigBackend({
    request: (method, params) => transport.router.request(method, params as never, z.unknown()),
  });
  const storedProviders = createProviderStore({ dataDir: environment.dataRoot, openClawConfig });
  let providerNetworkSettings = await storedProviders.getNetworkForRuntime();
  const providers: ProviderStore = {
    ...storedProviders,
    setNetwork: async (network) => {
      const snapshot = await storedProviders.setNetwork(network);
      providerNetworkSettings = await storedProviders.getNetworkForRuntime();
      return snapshot;
    },
  };
  const providerNetwork = createProviderNetworkService();
  const pluginRuntime = await createOpenClawCliPluginRuntime({
    runtimeRoot: environment.runtimeRoot,
    executable: environment.nodeExecutable,
    entrypoint: environment.openClawEntry,
    dataDir: environment.dataRoot,
    baseEnvironment: env,
  });
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
  const skillRuntime = createOpenClawSkillRuntime({
    request: (method, params, schema) => transport.router.request(method, params as never, schema),
  });
  const usageDispatcher = createUsageDispatcher({
    openClaw: createOpenClawUsageService({
      request: (method, params) => transport.router.request(method, params as never, z.unknown()),
    }),
  });
  await composeDesktopDomainModules(domains, { client }, [
    {
      name: "provider.executor.openai-compatible",
      register: () => ({ execute: executeOpenAICompatibleProvider, dispose: () => undefined }),
    },
    {
      name: "skills.runtime",
      register: () => ({
        runtime: skillRuntime,
        bundledRoots: [bundledSkillsRoot],
        dispose: () => undefined,
      }),
    },
    {
      name: "usage",
      register: () => createUsageDomainRegistration(usageDispatcher),
    },
  ]);
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
        env: applyProviderNetworkEnvironment({
          ...env,
          ...(environment.electronRunAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
          OPENCLAW_GATEWAY_TOKEN: environment.gatewayToken,
        }, providerNetworkSettings),
      };
    },
    requiredMethods: REQUIRED_GATEWAY_METHODS,
    probeCapabilities: async (_port, signal) => {
      try {
        const capabilities = await withAbort(client.gateway.negotiate(), signal, () => transport.close());
        const methods = capabilities.methods;
        if (!REQUIRED_GATEWAY_METHODS.every((method) => methods.has(method))) {
          throw new DesktopWiringError("UNSUPPORTED", "Gateway is missing required methods.");
        }
        return { helloOk: true, methods: [...methods] };
      } catch (error) {
        normalizeGatewayFailure(error);
      }
    },
    dispatchClient: dispatcher,
    client,
    attachments,
    providers,
    providerNetwork,
    providerConfig: openClawConfig,
    pluginRuntime,
    domainRegistrations: domains,
    modelSourceExecutors: {
      domestic: createOpenClawProviderExecutor(client),
      custom: createOpenClawProviderExecutor(client),
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
