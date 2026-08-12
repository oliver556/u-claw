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
  UClawUnsupportedError,
  createOpenClawAutomationService,
  createOpenClawTaskArtifactService,
  createOpenClawUsageService,
  type EventFrame,
  type HelloOk,
  type OpenClawTransport,
  type WebSocketLike,
} from "@uclaw/adapter";
import { MessageEventSchema, type MessageEvent, type ProviderConfigEntry, type ProviderNetworkSettings, type SendMessageInput } from "@uclaw/shared";

import { createClientDispatcher } from "../ipc/client-dispatcher.js";
import { createWechatPersonalRuntime } from "../channels/wechat-personal-runtime.js";
import { createOpenClawQrRenderer } from "../channels/wechat-qr-renderer.js";
import { createOpenClawProviderConfigBackend } from "../providers/openclaw-provider-config.js";
import { createOpenClawProviderExecutor } from "../providers/openclaw-provider-executor.js";
import {
  bootstrapDevelopmentProvider,
  readDevelopmentProvider,
} from "../providers/development-provider-bootstrap.js";
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
import { createOpenClawCapabilityRuntime } from "../capabilities/openclaw-capability-runtime.js";
import { createOpenClawSkillRuntime } from "../skills/openclaw-skill-runtime.js";
import { createUsageDispatcher } from "../usage/usage-dispatcher.js";
import { createUsageDomainRegistration } from "../usage/usage-domain.js";
import { createAutomationDispatcher } from "../automation/automation-dispatcher.js";
import { createAutomationDomainRegistration } from "../automation/automation-domain.js";
import { createTaskArtifactDispatcher } from "../task-artifacts/task-artifact-dispatcher.js";
import { createTaskArtifactDomainRegistration } from "../task-artifacts/task-artifact-domain.js";
import { createTaskArtifactFileService } from "../task-artifacts/task-artifact-files.js";
import { createProductionSystemNodeDomain } from "../system-node/production-system-node.js";
import { createProductionSystemVoiceDomain, createProductionTalkRunBridge, playSecureTemporaryAudio } from "../system-voice/production-system-voice.js";
import type { AuthorizedWebContents } from "../ipc/register-ipc.js";
import { createProductionProductServices } from "../product-services/production-product-services.js";
import { createDesktopLogSink } from "../diagnostics/desktop-log-sink.js";
import { createOpenClawDoctorRuntime } from "../diagnostics/openclaw-doctor-runtime.js";
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

const GATEWAY_ENV_KEYS = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
  "OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR",
] as const;

function createGatewayEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(GATEWAY_ENV_KEYS.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]]));
}

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
  private readonly eventListeners = new Map<string, Set<(frame: EventFrame) => void>>();
  private readonly disconnectListeners = new Set<() => void>();
  private eventDisposers: Array<() => void> = [];

  constructor(private readonly token: string) {}

  get state(): OpenClawTransport["state"] {
    return this.active?.state ?? "idle";
  }

  get router(): OpenClawTransport["router"] {
    if (!this.active) throw new DesktopWiringError("GATEWAY_DISCONNECTED", "Gateway is not connected.", true);
    return this.active.router;
  }

  get serverVersion(): string | undefined {
    return this.hello?.server.version;
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
    this.attachEventListeners();
    return this.hello;
  }

  onEvent(event: string, listener: (frame: EventFrame) => void): () => void {
    const listeners = this.eventListeners.get(event) ?? new Set();
    listeners.add(listener);
    this.eventListeners.set(event, listeners);
    this.attachEventListeners();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.eventListeners.delete(event);
      this.attachEventListeners();
    };
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    this.attachEventListeners();
    return () => {
      this.disconnectListeners.delete(listener);
      this.attachEventListeners();
    };
  }

  private attachEventListeners(): void {
    for (const dispose of this.eventDisposers.splice(0)) dispose();
    if (!this.active) return;
    for (const listener of this.disconnectListeners) this.eventDisposers.push(this.active.router.onClose(listener));
    for (const [event, listeners] of this.eventListeners) {
      for (const listener of listeners) this.eventDisposers.push(this.active.router.onEvent(event, listener));
    }
  }

  close(): void {
    const active = this.active;
    this.active = undefined;
    this.hello = undefined;
    for (const dispose of this.eventDisposers.splice(0)) dispose();
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
  if (input.skillId !== undefined) {
    throw new DesktopWiringError("UNSUPPORTED", "External model providers do not support Skills.");
  }
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
  const developmentProvider = readDevelopmentProvider(env);
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
  const openClawStateDir = dirname(environment.openClawConfig);
  const wechatPluginDir = join(openClawStateDir, "extensions", "openclaw-weixin");
  const wechatRuntime = createWechatPersonalRuntime({
    dataDir: openClawStateDir,
    pluginDir: wechatPluginDir,
    requestGateway: (method, params, signal) => transport.router.request(method, params as never, z.unknown(), signal),
    renderQr: createOpenClawQrRenderer(environment.runtimeRoot, wechatPluginDir),
  });
  const client = new OpenClawClient({
    transport,
    attachments,
    wechatRuntime,
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
  client.diagnostics.doctor = createOpenClawDoctorRuntime({
    executable: environment.nodeExecutable,
    entrypoint: environment.openClawEntry,
    stateDir: openClawStateDir,
    baseEnvironment: env,
  });
  const desktopLog = createDesktopLogSink({ dataDir: environment.dataRoot, logsDir: join(environment.dataRoot, "diagnostics", "desktop-logs") });
  void desktopLog.append("desktop-started").catch(() => undefined);
  const skillRuntime = createOpenClawSkillRuntime({
    request: (method, params, schema) => transport.router.request(method, params as never, schema),
  });
  const capabilityRuntime = createOpenClawCapabilityRuntime({
    methods: async () => (await client.gateway.negotiate()).methods,
    request: (method, params) => transport.router.request(method, params as never, z.unknown()),
  });
  let gatewayMethods: ReadonlySet<string> = new Set();
  let taskArtifactContractAvailable = false;
  const automationDispatcher = createAutomationDispatcher(createOpenClawAutomationService({
    request: (method, params, schema) => transport.router.request(method, params, schema),
    requireMethod: (method) => { if (!gatewayMethods.has(method)) throw new UClawUnsupportedError(method); },
  }));
  const taskArtifactAuthority = createOpenClawTaskArtifactService({
    request: (method, params, schema) => transport.router.request(method, params, schema),
    onEvent: (event, listener) => transport.onEvent(event, listener),
    requireMethod: (method) => { if (!taskArtifactContractAvailable || !gatewayMethods.has(method)) throw new UClawUnsupportedError(method); },
  });
  const taskArtifactFiles = createTaskArtifactFileService({
    dataRoot: environment.dataRoot,
    shell: { openPath: async (path) => (await import("electron")).shell.openPath(path) },
    selectExportTarget: async (suggestedName) => {
      const selected = await (await import("electron")).dialog.showSaveDialog({ defaultPath: suggestedName });
      return selected.canceled ? undefined : selected.filePath;
    },
  });
  const taskArtifactDispatcher = createTaskArtifactDispatcher(taskArtifactAuthority, taskArtifactFiles);
  const systemNodeDomain = createProductionSystemNodeDomain({
    request: (method, params, schema, signal) => transport.router.request(method, params as never, schema, signal),
    onEvent: (event, listener) => transport.onEvent(event, listener),
    requireMethod: (method) => { if (!gatewayMethods.has(method)) throw new UClawUnsupportedError(method); },
  });
  let systemVoiceWebContents: AuthorizedWebContents | undefined;
  const requireSystemVoiceWebContents = () => {
    if (typeof systemVoiceWebContents?.executeJavaScript !== "function") {
      throw new DesktopWiringError("UNCONFIGURED", "Authorized Electron voice authority is unavailable.");
    }
    return systemVoiceWebContents;
  };
  const executeSystemVoice = (source: string, userGesture = false) => requireSystemVoiceWebContents().executeJavaScript!(source, userGesture);
  const talkRunBridge = createProductionTalkRunBridge({
    request: (method, params, schema) => transport.router.request(method, params as never, schema),
    onEvent: (event, listener) => transport.onEvent(event, listener as never),
  });
  const systemVoiceDomain = createProductionSystemVoiceDomain({
    request: (method, params, schema, signal) => transport.router.request(method, params as never, schema, signal),
    requireMethod: (method) => { if (!gatewayMethods.has(method)) throw new UClawUnsupportedError(method); },
    permissions: { get: async () => {
      if (typeof systemVoiceWebContents?.executeJavaScript !== "function") return { microphone: "unknown", notifications: "restricted" };
      const { systemPreferences, Notification } = await import("electron");
      const microphone = process.platform === "darwin" || process.platform === "win32"
        ? systemPreferences.getMediaAccessStatus("microphone")
        : "unknown";
      const notificationPermission = await executeSystemVoice("globalThis.Notification?.permission ?? 'unsupported'");
      const notifications = Notification.isSupported() && ["granted", "denied", "default"].includes(String(notificationPermission))
        ? notificationPermission === "default" ? "not-determined" : notificationPermission as "granted" | "denied"
        : "restricted";
      return { microphone, notifications };
    } },
    pushSubscription: {
      get: async () => {
        const value = await executeSystemVoice("navigator.serviceWorker?.ready.then(r => r.pushManager.getSubscription()).then(s => s?.toJSON() ?? null) ?? null");
        return z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }).strict() }).strict().nullable().parse(value);
      },
      subscribe: async (vapidPublicKey) => {
        const encodedKey = JSON.stringify(vapidPublicKey);
        const value = await executeSystemVoice(`navigator.serviceWorker.ready.then(r => r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: ${encodedKey} })).then(s => s.toJSON())`, true);
        return z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }).strict() }).strict().parse(value);
      },
      unsubscribe: async () => { await executeSystemVoice("navigator.serviceWorker?.ready.then(r => r.pushManager.getSubscription()).then(s => s?.unsubscribe()) ?? false", true); },
    },
    audioOutput: { play: async ({ audioBase64 }) => {
      if (process.platform !== "darwin") throw new DesktopWiringError("UNAVAILABLE", "Secure TTS audio output is unavailable on this platform.");
      await playSecureTemporaryAudio(audioBase64, { cacheRoot: environment.cacheRoot, play: (path) => new Promise<void>((resolve, reject) => {
        const child = spawnChild("/usr/bin/afplay", [path], { stdio: "ignore" });
        child.once("error", () => reject(new DesktopWiringError("UNAVAILABLE", "Secure TTS audio output failed.")));
        child.once("close", (code) => code === 0 ? resolve() : reject(new DesktopWiringError("OPERATION_FAILED", "Secure TTS audio output failed.")));
      })
      });
    } },
    waitForTalkRun: talkRunBridge.waitForTalkRun,
    abortTalkRun: talkRunBridge.abortTalkRun,
  }, {
    bindAuthorizedWebContents: (webContents) => { systemVoiceWebContents = webContents; },
    onTalkEvent: (listener) => transport.onEvent("talk.event", (frame) => listener(frame.payload)),
    onDisconnect: (listener) => transport.onDisconnect(listener),
    clearPendingTalkRuns: talkRunBridge.clearPending,
  });
  const productServices = createProductionProductServices({ dataDir: environment.dataRoot, environment: env });
  const newApiUsageConfigured = [
    env.UCLAW_LICENSE_SERVICE_URL,
    env.UCLAW_LICENSE_MANAGEMENT_CREDENTIAL,
    env.UCLAW_NEW_API_MANAGEMENT_URL,
    env.UCLAW_NEW_API_MANAGEMENT_CREDENTIAL,
  ].every((value) => value !== undefined);
  const usageDispatcher = createUsageDispatcher({
    openClaw: createOpenClawUsageService({
      request: (method, params) => transport.router.request(method, params as never, z.unknown()),
    }),
    ...(newApiUsageConfigured ? { newApiUsage: () => productServices.authority.readUsage() } : {}),
  });
  await composeDesktopDomainModules(domains, {
    client,
    productServices: { dataDir: environment.dataRoot, environment: env, services: productServices },
  }, [
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
    {
      name: "automation",
      register: () => createAutomationDomainRegistration(automationDispatcher),
    },
    {
      name: "task-artifacts",
      register: () => createTaskArtifactDomainRegistration(taskArtifactAuthority, taskArtifactDispatcher),
    },
    {
      name: "system-node",
      register: () => systemNodeDomain,
    },
    {
      name: "system-voice",
      register: () => systemVoiceDomain,
    },
  ]);
  const dispatcher = createClientDispatcher({ client, sendEvent: () => undefined });
  let disposed = false;
  let developmentProviderReady = false;

  return {
    spawn: (executable, args, options) => {
      const child = spawnChild(executable, [...args], options) as unknown as ReturnType<DesktopMainOptions["spawn"]>;
      gatewayProcessAlive = child.pid !== undefined && child.exitCode === null;
      void desktopLog.append(gatewayProcessAlive ? "gateway-started" : "gateway-failed").catch(() => undefined);
      child.on("error", () => { gatewayProcessAlive = false; void desktopLog.append("gateway-failed").catch(() => undefined); });
      child.once("exit", () => { gatewayProcessAlive = false; void desktopLog.append("gateway-stopped").catch(() => undefined); });
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
          ...createGatewayEnvironment(env),
          ...(environment.electronRunAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        }, providerNetworkSettings),
      };
    },
    requiredMethods: REQUIRED_GATEWAY_METHODS,
    probeCapabilities: async (_port, signal) => {
      try {
        const capabilities = await withAbort(client.gateway.negotiate(), signal, () => transport.close());
        const methods = capabilities.methods;
        gatewayMethods = methods;
        taskArtifactContractAvailable = transport.serverVersion !== "2026.7.1-2";
        if (!REQUIRED_GATEWAY_METHODS.every((method) => methods.has(method))) {
          throw new DesktopWiringError("UNSUPPORTED", "Gateway is missing required methods.");
        }
        if (!developmentProviderReady) {
          await bootstrapDevelopmentProvider(providers, developmentProvider);
          developmentProviderReady = true;
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
    capabilityRuntime,
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
