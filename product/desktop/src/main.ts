import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { createHash, randomUUID, timingSafeEqual, verify } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  UClawErrorSchema,
  type AttachmentImportInput,
  type ActivationResponse,
  type AttachmentService,
  type ClientIpcRequest,
  type MessageEvent,
  type SendMessageInput,
  type UClawClient,
  LOCKED_OPENCLAW_VERSION,
} from "@uclaw/shared";

import { GatewayProcessManager, type GatewayLaunchOptions, type SpawnGateway } from "./gateway/gateway-process.js";
import {
  checkGatewayHealth,
  type GatewayCapabilityProbeResult,
  type GatewayHealthDependencies,
} from "./gateway/health-check.js";
import { selectGatewayPort } from "./gateway/port-selector.js";
import { startGatewayAndCreateWindow, validateGatewayLaunchOptions, waitForGatewayReadiness, type GatewayCapabilityState, type ShowableWindow } from "./gateway/startup.js";
import {
  applyPortableEnvironmentToLaunchOptions,
  type PortableDesktopPaths,
} from "./portable-paths.js";
import type { AuthorizedWebContents, IpcMainLike } from "./ipc/register-ipc.js";
import { registerIpc as registerDesktopIpc } from "./ipc/register-ipc.js";
import { createSessionOrganizerStore } from "./session-organizer/store.js";
import { createChatQueueStore } from "./chat-queue/store.js";
import { createChatQueueDispatcher } from "./chat-queue/dispatcher.js";
import { createProviderStore, type ProviderStore } from "./providers/provider-store.js";
import type { ProviderNetworkService } from "./providers/provider-network.js";
import type { OpenClawProviderConfigBackend } from "./providers/openclaw-provider-config.js";
import { createCommercialOpenClawReadinessGate } from "./providers/commercial-openclaw-lifecycle.js";
import { installBundledCommercialImageExtension } from "./providers/commercial-image-extension-bootstrap.js";
import { createSkillHubClient } from "./skills/skillhub-client.js";
import { createSkillService } from "./skills/skill-service.js";
import { createSkillImportService } from "./skills/skill-import-service.js";
import { createSkillInstallCoordinator } from "./skills/skill-install-coordinator.js";
import type { OpenClawSkillRuntime } from "./skills/openclaw-skill-runtime.js";
import { createLivePluginRegistryClient, createUnavailablePluginRegistryClient } from "./plugins/registry-client.js";
import { createOpenClawCliPluginRuntime } from "./plugins/openclaw-cli-runtime.js";
import { createPluginService } from "./plugins/plugin-service.js";
import type { PluginRuntimeAdapter } from "./plugins/runtime-adapter.js";
import type { OpenClawCapabilityRuntime } from "./capabilities/openclaw-capability-runtime.js";
import { createChannelStore } from "./channels/channel-store.js";
import type { ChannelRuntime } from "./channels/channel-dispatcher.js";
import { createMcpStore } from "./mcp/mcp-store.js";
import { createDataService } from "./data/data-service.js";
import { ProductionRuntimeConsistencyCoordinator } from "./data/production-consistency-coordinator.js";
import { createDiagnosticsService, type DiagnosticsRuntimeInfo } from "./diagnostics/diagnostics-service.js";
import type { GatewayDiagnosticSink } from "./diagnostics/gateway-log-sink.js";
import { createMcpProtocolProbe, createOpenClawMcpRuntime } from "./mcp/mcp-runtime.js";
import { createReleaseDispatcher } from "./release/release-dispatcher.js";
import type { ReleaseService } from "./release/release-service.js";
import { createProductionReleaseService } from "./release/production-release.js";
import { registerActivationIpc } from "./activation/register-ipc.js";
import { createActivationCoordinator, type ActivationCoordinator } from "./activation/coordinator.js";
import { createActivationClient } from "./activation/client.js";
import { createActivationArtifactWriter } from "./activation/artifact-writer.js";
import { readActivationServiceConfiguration } from "./wiring/environment.js";
import {
  createAdvancedConsoleController,
  createMainWindow,
  createWindowControls,
  type BrowserWindowConstructor,
  type DesktopWindow,
} from "./window.js";
import { installGatewayMediaRequestAuth } from "./gateway/media-request-auth.js";
import { createImageOperationService } from "./images/image-operation-service.js";
import { createImageOperationDispatcher } from "./images/image-operation-dispatcher.js";
import { createAttachmentCache } from "./attachments/attachment-cache.js";
import { startAttachmentCleanup } from "./attachments/attachment-cleanup.js";

interface ElectronWorkspaceShell {
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

export function createProductionDataService(
  paths: Pick<PortableDesktopPaths, "dataDir" | "cacheDir">,
  electronShell?: ElectronWorkspaceShell,
  consistencyCoordinator?: ProductionRuntimeConsistencyCoordinator,
) {
  return createDataService({
    dataDir: paths.dataDir,
    cacheDir: paths.cacheDir,
    acquireConsistencyLease: consistencyCoordinator?.acquireConsistencyLease.bind(consistencyCoordinator),
    mutationCoordinator: consistencyCoordinator,
    workspaceShell: electronShell ? {
      invoke: async (action, target) => {
        await target.verify();
        if (action === "reveal") {
          electronShell.showItemInFolder(target.path);
          return;
        }
        const error = await electronShell.openPath(target.path);
        if (error !== "") throw new Error("Electron shell rejected the controlled workspace target.");
      },
    } : undefined,
  });
}

export interface DesktopAppLike {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  whenReady(): Promise<void>;
  on(event: string, listener: (event?: { preventDefault(): void }) => void): void;
}

export interface AppWindowLike {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

export const ACTIVATION_ONLY_CAPABILITIES = [
  "activation.preflight",
  "activation.submit",
  "activation.commit",
  "activation.cancel",
  "window.close",
] as const;

export type ActivationOnlyCapability = typeof ACTIVATION_ONLY_CAPABILITIES[number];

export function assertActivationOnlyCapabilities(capabilities: readonly string[]): void {
  if (
    capabilities.length !== ACTIVATION_ONLY_CAPABILITIES.length ||
    ACTIVATION_ONLY_CAPABILITIES.some((capability) => !capabilities.includes(capability))
  ) {
    throw new Error("Activation-only IPC capabilities must match the restricted allowlist.");
  }
}

export interface ActivationIpcRegistration {
  capabilities: readonly string[];
  dispose(): void;
}

export interface RegisterActivationOnlyIpcDependencies {
  ipcMain: IpcMainLike;
  authorizedWebContents: AuthorizedWebContents;
  closeWindow(): void;
}

export function registerActivationOnlyIpc({
  ipcMain,
  authorizedWebContents,
  closeWindow,
}: RegisterActivationOnlyIpcDependencies): ActivationIpcRegistration {
  const registered: ActivationOnlyCapability[] = [];
  try {
    for (const capability of ACTIVATION_ONLY_CAPABILITIES) {
      ipcMain.handle(capability, async (event) => {
        const candidate = event as { sender?: unknown; senderFrame?: unknown };
        if (
          candidate.sender !== authorizedWebContents ||
          candidate.senderFrame !== authorizedWebContents.mainFrame
        ) {
          throw new Error("Unauthorized activation IPC sender.");
        }
        if (capability === "window.close") {
          closeWindow();
          return null;
        }
        throw new Error("Activation service is unavailable.");
      });
      registered.push(capability);
    }
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    for (const capability of registered.reverse()) {
      try {
        ipcMain.removeHandler(capability);
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "Activation IPC registration and rollback failed.",
        { cause: error },
      );
    }
    throw error;
  }

  let active = true;
  return {
    capabilities: ACTIVATION_ONLY_CAPABILITIES,
    dispose: () => {
      if (!active) return;
      active = false;
      for (const capability of registered) ipcMain.removeHandler(capability);
    },
  };
}

export interface ActivationWindowLike extends AppWindowLike {
  close(): void;
}

export interface ActivationMainRuntime<TWindow extends ActivationWindowLike> {
  app: DesktopAppLike;
  createWindow(registerIpc: (window: TWindow) => void): Promise<TWindow>;
  registerIpc(window: TWindow): ActivationIpcRegistration;
}

export async function runActivationMain<TWindow extends ActivationWindowLike>(
  runtime: ActivationMainRuntime<TWindow>,
): Promise<TWindow | null> {
  return bootstrapDesktopApp({
    app: runtime.app,
    createWindow: async (registerIpc) => runtime.createWindow((window) => {
      try {
        registerIpc(window);
      } catch (error) {
        window.close();
        throw error;
      }
    }),
    registerIpc: (window) => {
      const registration = runtime.registerIpc(window);
      try {
        assertActivationOnlyCapabilities(registration.capabilities);
      } catch (error) {
        registration.dispose();
        throw error;
      }
      return registration.dispose;
    },
    stopGateway: () => undefined,
  });
}

const LOOPBACK_RENDERER_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function validateRendererUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !LOOPBACK_RENDERER_HOSTS.has(url.hostname) ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new Error();
    }
  } catch {
    throw new Error("Renderer URL must be a credential-free loopback HTTP URL.");
  }
  return value;
}

export interface BootstrapDesktopDependencies<TWindow extends AppWindowLike> {
  app: DesktopAppLike;
  createWindow(registerIpc: (window: TWindow) => (() => void) | void): Promise<TWindow>;
  registerIpc(window: TWindow): (() => void) | void;
  stopGateway(): Promise<void> | void;
  abortStartup?(): void;
  startupSignal?: AbortSignal;
  acquireHostGlobalLock?(): Promise<boolean> | boolean;
}

export async function bootstrapDesktopApp<TWindow extends AppWindowLike>({
  app,
  createWindow,
  registerIpc,
  stopGateway,
  abortStartup,
  startupSignal,
  acquireHostGlobalLock,
}: BootstrapDesktopDependencies<TWindow>): Promise<TWindow | null> {
  if (acquireHostGlobalLock && !await acquireHostGlobalLock()) {
    app.quit();
    return null;
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return null;
  }

  let window: TWindow | null = null;
  let disposeIpc: (() => void) | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanupRuntime = (): Promise<void> => cleanupPromise ??= (async () => {
    const failures: unknown[] = [];
    try {
      disposeIpc?.();
    } catch (error) {
      failures.push(error);
    } finally {
      disposeIpc = undefined;
    }
    try {
      await stopGateway();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Desktop shutdown cleanup failed.");
  })();
  app.on("second-instance", () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  let shutdownStarted = false;
  let cleanupDone = false;
  app.on("before-quit", (event) => {
    if (cleanupDone) return;
    event?.preventDefault();
    abortStartup?.();
    if (shutdownStarted) return;
    shutdownStarted = true;
    try {
      void cleanupRuntime().then(
        () => {
          cleanupDone = true;
          app.quit();
        },
        () => {
          cleanupDone = true;
          app.quit();
        },
      );
    } catch {
      cleanupDone = true;
      app.quit();
    }
  });
  app.on("window-all-closed", () => app.quit());

  try {
    await app.whenReady();
    window = await createWindow((createdWindow) => {
      const registered = registerIpc(createdWindow);
      if (!registered) return;
      let active = true;
      const dispose = (): void => {
        if (!active) return;
        active = false;
        registered();
      };
      disposeIpc = dispose;
      return dispose;
    });
    return window;
  } catch (error) {
    try {
      await cleanupRuntime();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Desktop startup failed and gateway cleanup failed.",
        { cause: error },
      );
    }
    if (startupSignal?.aborted) return null;
    throw error;
  }
}

export interface DesktopMainOptions {
  spawn: SpawnGateway;
  buildGatewayLaunchOptions(port: number): unknown;
  requiredMethods: readonly string[];
  probeCapabilities(port: number, signal: AbortSignal): Promise<GatewayCapabilityProbeResult>;
  dispatchClient(request: ClientIpcRequest): Promise<unknown>;
  client?: UClawClient;
  pluginRuntime?: PluginRuntimeAdapter;
  capabilityRuntime?: OpenClawCapabilityRuntime;
  attachments?: AttachmentService;
  referencedAttachmentIds?: () => ReadonlySet<string> | Promise<ReadonlySet<string>>;
  selectAttachments?(): Promise<AttachmentImportInput[]>;
  releaseService?: ReleaseService;
  selectPort?(excludedPorts: readonly number[], signal: AbortSignal): Promise<number>;
  fetch?: GatewayHealthDependencies["fetch"];
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readinessTimeoutMs?: number;
  readinessPollIntervalMs?: number;
  gatewayStopTimeoutMs?: number;
  gatewayKillTimeoutMs?: number;
  gatewayDiagnostics?: GatewayDiagnosticSink;
  consistencyCoordinator?: ProductionRuntimeConsistencyCoordinator;
  providers?: ProviderStore;
  providerNetwork?: ProviderNetworkService;
  providerConfig?: OpenClawProviderConfigBackend;
  commercialProviderBootstrap?(coordinator: ProductionRuntimeConsistencyCoordinator): Promise<void>;
  injectChatMessage?(
    sessionId: string,
    message: string,
    label: "uclaw-local-user-v1" | "uclaw-local-result-v1" | "uclaw-commercial-image-v1",
    signal?: AbortSignal,
  ): Promise<void>;
  domainRegistrations?: DesktopDomainRegistry;
  dispose?(): Promise<void> | void;
  gatewayMediaToken?: string;
  gatewayOrigin?: () => string | undefined;
  imageDataRoot?: string;
  releaseId?: string;
  onGatewayCapabilityState?(state: GatewayCapabilityState): void;
}

export interface RegisteredDesktopDomain {
  installIpc?(context: DesktopDomainIpcContext): (() => void) | void;
  dispose?(): Promise<void> | void;
}

export interface DesktopDomainServiceAccessor {
  get<T>(name: string): T | undefined;
}

export interface DesktopDomainIpcContext {
  ipcMain: IpcMainLike;
  authorizedWebContents: AuthorizedWebContents;
  client: UClawClient;
  services: DesktopDomainServiceAccessor;
}

export interface DesktopDomainRegistry {
  register(name: string, registration: RegisteredDesktopDomain): () => void;
  resolve<T extends RegisteredDesktopDomain>(name: string): T | undefined;
  installIpc(context: DesktopDomainIpcContext): () => void;
  dispose(): Promise<void>;
}

export type SkillRuntimeRegistration = RegisteredDesktopDomain & {
  runtime: OpenClawSkillRuntime;
  bundledRoots: readonly string[];
};

export function resolveSkillRuntimeRegistration(
  registry: DesktopDomainRegistry | undefined,
): SkillRuntimeRegistration | undefined {
  if (registry === undefined) return undefined;
  const registration = registry.resolve<SkillRuntimeRegistration>("skills.runtime");
  if (registration === undefined) throw new Error("Skill runtime is not registered.");
  return registration;
}

export interface DesktopMainRuntime<TWindow extends AppWindowLike & ShowableWindow> {
  app: DesktopAppLike;
  acquireHostGlobalLock?(): Promise<boolean> | boolean;
  createWindow(
    registerIpc: (window: TWindow) => (() => void) | void,
    signal: AbortSignal,
  ): Promise<TWindow>;
  registerIpc(window: TWindow, dispatchClient: DesktopMainOptions["dispatchClient"]): () => void;
}

export function disposeDesktopIpc(
  domainDispose: (() => void) | undefined,
  coreDispose: () => void,
): void {
  const failures: unknown[] = [];
  for (const dispose of [domainDispose, coreDispose]) {
    if (!dispose) continue;
    try {
      dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Desktop IPC cleanup failed.");
}

const defaultSleep = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      cleanup();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });

export async function runDesktopMain<TWindow extends AppWindowLike & ShowableWindow>(
  options: DesktopMainOptions,
  runtime: DesktopMainRuntime<TWindow>,
): Promise<TWindow | null> {
  const gatewayProcess = new GatewayProcessManager({
    spawn: options.spawn,
    stopTimeoutMs: options.gatewayStopTimeoutMs,
    killTimeoutMs: options.gatewayKillTimeoutMs,
    diagnostics: options.gatewayDiagnostics,
    now: options.now,
    releaseId: options.releaseId,
  });
  const fetchHealth = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const now = options.now ?? Date.now;
  const startupController = new AbortController();
  let stopPromise: Promise<void> | undefined;
  const stopGateway = (): Promise<void> => stopPromise ??= (async () => {
    const results = await Promise.allSettled([
      gatewayProcess.stop("application-quit"),
      Promise.resolve(options.dispose?.()),
    ]);
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "Desktop runtime cleanup failed.");
  })();
  let managedPort: number | undefined;
  let managedLaunchOptions: GatewayLaunchOptions | undefined;
  const buildManagedLaunchOptions = (port: number): GatewayLaunchOptions => {
    const launchOptions = validateGatewayLaunchOptions(options.buildGatewayLaunchOptions(port));
    managedPort = port;
    managedLaunchOptions = launchOptions;
    return launchOptions;
  };
  options.consistencyCoordinator?.bindLifecycle({
    stop: async (signal) => {
      signal?.throwIfAborted();
      await gatewayProcess.stop("consistency-restart");
      options.onGatewayCapabilityState?.("local-only");
    },
    start: async (signal) => {
      if (managedPort === undefined || managedLaunchOptions === undefined) throw new Error("Managed Gateway launch state is unavailable.");
      const restartController = new AbortController();
      const restartSignal = signal ? AbortSignal.any([signal, restartController.signal]) : restartController.signal;
      gatewayProcess.setPort(managedPort);
      const identity = gatewayProcess.start(managedLaunchOptions);
      try {
        await waitForGatewayReadiness({
          checkHealth: (port, deadlineMs, currentIdentity, healthSignal) => checkGatewayHealth({
            isProcessAlive: () => gatewayProcess.getOwnedPid() === currentIdentity.pid && gatewayProcess.getOwnedInstanceId() === currentIdentity.instanceId,
            baseUrl: `http://127.0.0.1:${port}`,
            fetch: fetchHealth,
            now,
            deadlineMs,
            signal: healthSignal,
            requiredMethods: options.requiredMethods,
            probeCapabilities: (probeSignal) => options.probeCapabilities(port, probeSignal),
          }),
          now,
          sleep: options.sleep ?? defaultSleep,
          timeoutMs: options.readinessTimeoutMs ?? 30_000,
          pollIntervalMs: options.readinessPollIntervalMs ?? 250,
          signal: restartSignal,
        }, managedPort, identity, () => {
          gatewayProcess.markHealthReady(identity);
          options.onGatewayCapabilityState?.("partial");
        });
        gatewayProcess.markCapabilityReady(identity);
        options.onGatewayCapabilityState?.("full");
      } catch (error) {
        restartController.abort();
        gatewayProcess.markStartupFailed(identity);
        try { await gatewayProcess.stop("startup-rollback"); } catch (stopError) {
          throw new AggregateError([error, stopError], "Managed Gateway restart and cleanup failed.", { cause: error });
        }
        options.onGatewayCapabilityState?.("local-only");
        throw error;
      }
    },
  });

  return bootstrapDesktopApp({
    app: runtime.app,
    stopGateway,
    abortStartup: () => startupController.abort(new DOMException("Desktop shutdown requested.", "AbortError")),
    startupSignal: startupController.signal,
    acquireHostGlobalLock: runtime.acquireHostGlobalLock,
    createWindow: async (registerIpc) => {
      const started = await startGatewayAndCreateWindow({
        attemptId: randomUUID(),
        releaseId: options.releaseId,
        onCapabilityState: options.onGatewayCapabilityState,
        keepShellOnGatewayFailure: true,
        selectPort: options.selectPort ?? ((excludedPorts) => selectGatewayPort({ excludedPorts })),
        gatewayProcess: {
          start: (launchOptions) => gatewayProcess.start(launchOptions),
          stop: (reason) => reason === "startup-rollback" ? gatewayProcess.stop(reason) : stopGateway(),
          setPort: (port) => gatewayProcess.setPort(port),
          markHealthReady: (identity) => gatewayProcess.markHealthReady(identity),
          markCapabilityReady: (identity) => gatewayProcess.markCapabilityReady(identity),
          markStartupFailed: (identity) => gatewayProcess.markStartupFailed(identity),
        },
        buildLaunchOptions: buildManagedLaunchOptions,
        checkHealth: (port, deadlineMs, identity, signal) => checkGatewayHealth({
          isProcessAlive: () =>
            gatewayProcess.getOwnedPid() === identity.pid &&
            gatewayProcess.getOwnedInstanceId() === identity.instanceId,
          baseUrl: `http://127.0.0.1:${port}`,
          fetch: fetchHealth,
          now,
          deadlineMs,
          signal,
          requiredMethods: options.requiredMethods,
          probeCapabilities: (signal) => options.probeCapabilities(port, signal),
        }),
        now,
        sleep: options.sleep ?? defaultSleep,
        timeoutMs: options.readinessTimeoutMs ?? 30_000,
        pollIntervalMs: options.readinessPollIntervalMs ?? 250,
        createWindow: (signal) => runtime.createWindow(registerIpc, signal),
        signal: startupController.signal,
      });
      return started.window;
    },
    registerIpc: (window) => runtime.registerIpc(window, options.dispatchClient),
  });
}

export function resolvePreloadPath(moduleDir: string): string {
  return join(moduleDir, "preload.cjs");
}

export function requireElectronClient(client: UClawClient | undefined): UClawClient {
  if (!client) throw new Error("Desktop production wiring must provide a real UClawClient.");
  return client;
}

export function requireChannelRuntime(client: UClawClient): ChannelRuntime {
  const runtime = client.channels as unknown as Partial<ChannelRuntime>;
  const methods: ReadonlyArray<keyof ChannelRuntime> = [
    "capability", "configure", "remove", "status", "test", "start", "stop", "logout", "send", "action", "poll",
  ];
  if (methods.some((method) => typeof runtime[method] !== "function")) {
    throw new Error("Desktop production wiring must provide a real channel runtime.");
  }
  return runtime as ChannelRuntime;
}

const ATTACHMENT_MEDIA_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".webp": "image/webp",
};

export interface ReadSelectedAttachmentsOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  concurrency?: number;
  stat?(path: string): Promise<{ isFile(): boolean; size: number }>;
  lstat?(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean; size: number }>;
  readFile?(path: string): Promise<Buffer>;
}

export async function readSelectedAttachments(
  paths: readonly string[],
  options: ReadSelectedAttachmentsOptions = {},
): Promise<AttachmentImportInput[]> {
  const maxFiles = options.maxFiles ?? MAX_ATTACHMENTS_PER_MESSAGE;
  const maxFileBytes = options.maxFileBytes ?? MAX_ATTACHMENT_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_ATTACHMENT_TOTAL_BYTES;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, maxFiles));
  const inspect = options.lstat ?? options.stat ?? lstat;
  const read = options.readFile ?? readFile;
  if (paths.length > maxFiles) {
    throw UClawErrorSchema.parse({ code: "INVALID_ARGUMENT", message: `一次最多选择 ${maxFiles} 个附件。`, retryable: false });
  }
  const inspected = await Promise.all(paths.map(async (path) => {
    const info = await inspect(path);
    if ("isSymbolicLink" in info && typeof info.isSymbolicLink === "function" && info.isSymbolicLink()) {
      throw UClawErrorSchema.parse({ code: "FILE_OUTSIDE_ALLOWED_ROOT", message: "不允许选择符号链接附件。", retryable: false });
    }
    if (!info.isFile()) throw UClawErrorSchema.parse({ code: "INVALID_ARGUMENT", message: "选择项不是文件。", retryable: false });
    if (info.size > maxFileBytes) throw UClawErrorSchema.parse({ code: "FILE_TOO_LARGE", message: `附件超过大小限制（${info.size} > ${maxFileBytes} bytes）。`, retryable: false });
    return info;
  }));
  const inspectedTotal = inspected.reduce((total, info) => total + info.size, 0);
  if (inspectedTotal > maxTotalBytes) {
    throw UClawErrorSchema.parse({ code: "FILE_TOO_LARGE", message: "附件累计大小超过选择限制。", retryable: false });
  }

  const results = new Array<AttachmentImportInput>(paths.length);
  let nextIndex = 0;
  let actualTotal = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= paths.length) return;
      const path = paths[index];
      const content = await read(path);
      if (content.byteLength > maxFileBytes) {
        throw UClawErrorSchema.parse({ code: "FILE_TOO_LARGE", message: `附件读取后超过大小限制（${content.byteLength} > ${maxFileBytes} bytes）。`, retryable: false });
      }
      actualTotal += content.byteLength;
      if (actualTotal > maxTotalBytes) {
        throw UClawErrorSchema.parse({ code: "FILE_TOO_LARGE", message: "附件读取后累计大小超过选择限制。", retryable: false });
      }
      results[index] = {
        name: basename(path),
        mediaType: ATTACHMENT_MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
        size: content.byteLength,
        contentBase64: content.toString("base64"),
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, () => worker()));
  return results;
}

export async function startElectronMain(
  options: DesktopMainOptions,
  portablePaths: PortableDesktopPaths,
): Promise<void> {
  const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, session: electronSession, shell } = await import("electron");
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const commercialImageExtensionSourceDir = basename(moduleDir) === "src"
    ? resolve(moduleDir, "../../openclaw-extensions/uclaw-commercial-image")
    : join(moduleDir, "openclaw-extensions", "uclaw-commercial-image");
  await installBundledCommercialImageExtension({
    sourceDir: commercialImageExtensionSourceDir,
    targetDir: join(portablePaths.openClawState, "extensions", "uclaw-commercial-image"),
  });
  const client = requireElectronClient(options.client);
  const consistencyCoordinator = new ProductionRuntimeConsistencyCoordinator();
  const organizer = createSessionOrganizerStore(portablePaths.dataDir);
  const attachments = options.attachments ?? createAttachmentCache({ dataDir: portablePaths.dataDir });
  const chatQueue = createChatQueueStore(portablePaths.dataDir);
  const attachmentCleanup = startAttachmentCleanup({
    dataDir: portablePaths.dataDir,
    referencedAttachmentIds: async () => {
      const referenced = new Set(await chatQueue.referencedAttachmentIds());
      for (const attachmentId of await attachments.referencedAttachmentIds?.() ?? []) referenced.add(attachmentId);
      for (const attachmentId of await options.referencedAttachmentIds?.() ?? []) referenced.add(attachmentId);
      return referenced;
    },
  });
  await attachmentCleanup.started;
  const providers = options.providers ?? createProviderStore({ dataDir: portablePaths.dataDir });
  const commercialProviderReadiness = createCommercialOpenClawReadinessGate();
  const routeChatSend = async (input: SendMessageInput, signal: AbortSignal) => {
    await commercialProviderReadiness.wait(signal);
    return client.chat.send(input, signal);
  };
  const chatQueueDispatcher = createChatQueueDispatcher({
    store: chatQueue,
    send: (input) => routeChatSend(input, new AbortController().signal),
    isGatewayAvailable: async () => (await client.gateway.getStatus()).businessAvailable,
  });
  const queueGatewayWatchController = new AbortController();
  void (async () => {
    try {
      for await (const status of client.gateway.watchStatus(queueGatewayWatchController.signal)) {
        if (status.businessAvailable) await chatQueueDispatcher.gatewayAvailable();
      }
    } catch {
      // Gateway watch is best effort; normal IPC status handling remains authoritative.
    }
  })();
  const skillRuntimeRegistration = resolveSkillRuntimeRegistration(options.domainRegistrations);
  const skills = await createSkillService({
    dataDir: portablePaths.dataDir,
    client: createSkillHubClient(),
    runtime: skillRuntimeRegistration?.runtime,
    bundledRoots: skillRuntimeRegistration?.bundledRoots ?? [],
    managedRoot: join(portablePaths.openClawState, "skills"),
    workspaceRoot: join(portablePaths.workspace, "skills"),
    runMutation: (operation) => consistencyCoordinator.runTrackedWrite(operation),
  });
  const skillImports = createSkillImportService({
    dataDir: portablePaths.dataDir,
    selectZip: async () => {
      const selected = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [{ name: "Skill ZIP", extensions: ["zip"] }],
      });
      return selected.canceled ? null : selected.filePaths[0] ?? null;
    },
  });
  const skillInstallCoordinator = createSkillInstallCoordinator({
    imports: skillImports,
    skills,
    openExternal: (url) => shell.openExternal(url),
  });
  const pluginRuntime = options.pluginRuntime ?? await createOpenClawCliPluginRuntime({
    runtimeRoot: process.env.UCLAW_RUNTIME_DIR ?? "",
    executable: process.execPath,
    dataDir: portablePaths.dataDir,
  });
  const plugins = await createPluginService({
    dataDir: portablePaths.dataDir,
    client: process.env.UCLAW_PLUGIN_REGISTRY_URL
      ? createLivePluginRegistryClient({ baseUrl: process.env.UCLAW_PLUGIN_REGISTRY_URL })
      : createUnavailablePluginRegistryClient("Plugin registry is not configured."),
    runtime: pluginRuntime,
    runMutation: (operation) => consistencyCoordinator.runTrackedWrite(operation),
  });
  const channelRuntime = requireChannelRuntime(client);
  const channels = createChannelStore({ dataDir: portablePaths.dataDir, capability: channelRuntime.capability });
  const mcpProbe = createMcpProtocolProbe({
    runtimeRoot: process.env.UCLAW_RUNTIME_DIR ?? "",
    executables: { node: process.execPath },
  });
  const mcpRuntime = createOpenClawMcpRuntime(client.mcp, mcpProbe);
  const mcp = createMcpStore({ dataDir: portablePaths.dataDir, runtimeAvailable: mcpRuntime.capability });
  const data = createProductionDataService(portablePaths, shell, consistencyCoordinator);
  const diagnosticsRuntime: DiagnosticsRuntimeInfo = {
    productVersion: "0.1.0",
    openClawVersion: LOCKED_OPENCLAW_VERSION,
    gatewayStatus: "starting",
  };
  const diagnostics = createDiagnosticsService({
    dataDir: portablePaths.dataDir,
    logsDir: portablePaths.logs,
    configPath: portablePaths.openClawConfig,
    diagnostics: client.diagnostics,
    runtime: diagnosticsRuntime,
    doctorRepairActions: { "gateway-restart": (signal) => consistencyCoordinator.restartManagedGateway(signal) },
    auditDoctorRepair: (event) => console.info("U-Claw Doctor repair audit", JSON.stringify(event)),
  });
  const release = options.releaseService ?? createProductionReleaseService(
    portablePaths,
    process.env,
    fetch,
    (operation) => consistencyCoordinator.runTrackedWrite(operation),
  );
  const devTools = !app.isPackaged;
  let gatewayPort: number | undefined;
  let commercialProviderBootstrapState: "idle" | "running" | "done" = "idle";
  const openAdvancedConsole = createAdvancedConsoleController({
    BrowserWindow: BrowserWindow as unknown as BrowserWindowConstructor,
    getGatewayPort: () => {
      if (gatewayPort === undefined) throw new Error("Gateway port is unavailable.");
      return gatewayPort;
    },
    openExternal: (url) => shell.openExternal(url),
    devTools,
  });
  const runtimeOptions: DesktopMainOptions = {
    ...options,
    dispose: async () => {
      attachmentCleanup.dispose();
      queueGatewayWatchController.abort();
      await options.dispose?.();
    },
    consistencyCoordinator,
    onGatewayCapabilityState: (state) => {
      diagnosticsRuntime.gatewayStatus = state === "full"
        ? "ready"
        : state === "partial" ? "degraded" : "offline";
      options.onGatewayCapabilityState?.(state);
      if (state === "full" && options.commercialProviderBootstrap && commercialProviderBootstrapState === "idle") {
        commercialProviderBootstrapState = "running";
        void commercialProviderReadiness.run(() => options.commercialProviderBootstrap!(consistencyCoordinator)).then(
          () => { commercialProviderBootstrapState = "done"; },
          async () => {
            commercialProviderBootstrapState = "idle";
            diagnosticsRuntime.gatewayStatus = "degraded";
            await options.gatewayDiagnostics?.append({ event: "commercial-provider-bootstrap-failed" });
          },
        );
      }
    },
    buildGatewayLaunchOptions: (port) => {
      gatewayPort = port;
      diagnosticsRuntime.gatewayPort = port;
      return applyPortableEnvironmentToLaunchOptions(options.buildGatewayLaunchOptions(port), portablePaths);
    },
  };
  const domainServices = new Map<string, unknown>([
    ["organizer", organizer],
    ["attachments", attachments],
    ["chatQueue", chatQueue],
    ["chatQueueDispatcher", chatQueueDispatcher],
    ["providers", providers],
    ["skills", skills],
    ["plugins", plugins],
    ["channels", channels],
    ["channelRuntime", channelRuntime],
    ["mcp", mcp],
    ["mcpRuntime", mcpRuntime],
    ["data", data],
    ["diagnostics", diagnostics],
    ["release", release],
    ["consistencyCoordinator", consistencyCoordinator],
  ]);
  const services: DesktopDomainServiceAccessor = {
    get: <T>(name: string) => domainServices.get(name) as T | undefined,
  };
  await runDesktopMain<DesktopWindow>(runtimeOptions, {
    app,
    createWindow: (registerIpc, signal) => {
      signal.throwIfAborted();
      if (gatewayPort === undefined || options.gatewayMediaToken === undefined) throw new Error("Gateway media authentication is unavailable.");
      const disposeMediaAuth = installGatewayMediaRequestAuth(
        electronSession.defaultSession.webRequest as unknown as Parameters<typeof installGatewayMediaRequestAuth>[0],
        gatewayPort,
        options.gatewayMediaToken,
      );
      return createMainWindow({
        BrowserWindow: BrowserWindow as unknown as BrowserWindowConstructor,
        startupMode: "normal",
        preloadPath: resolvePreloadPath(moduleDir),
        rendererUrl: validateRendererUrl(process.env.UCLAW_RENDERER_URL),
        rendererFile: join(moduleDir, "../../frontend/dist/index.html"),
        openExternal: (url) => shell.openExternal(url),
        devTools,
        showWhenReady: false,
        beforeLoad: (window) => {
          const disposeIpc = registerIpc(window);
          return () => {
            disposeIpc?.();
            disposeMediaAuth();
          };
        },
      });
    },
    registerIpc: (window, dispatchClient) => {
      if (options.gatewayMediaToken === undefined || options.gatewayOrigin === undefined || options.imageDataRoot === undefined) throw new Error("Gateway image authority is unavailable.");
      const images = createImageOperationDispatcher(createImageOperationService({
        gatewayOrigin: () => {
          const origin = options.gatewayOrigin!();
          if (origin === undefined) throw new Error("Gateway origin is unavailable.");
          return origin;
        },
        gatewayToken: options.gatewayMediaToken,
        fetch,
        nativeImage: nativeImage as unknown as Parameters<typeof createImageOperationService>[0]["nativeImage"],
        clipboard: clipboard as unknown as Parameters<typeof createImageOperationService>[0]["clipboard"],
        showSaveDialog: (dialogOptions) => dialog.showSaveDialog(dialogOptions),
        dataRoot: options.imageDataRoot,
        realpath,
      }));
      const coreDispose = registerDesktopIpc({
      ipcMain: ipcMain as unknown as IpcMainLike,
      authorizedWebContents: window.webContents,
      windowControls: {
        ...createWindowControls(window),
        openAdvancedConsole,
      },
      dispatchClient,
      client,
      organizer,
      attachments,
      chatQueue,
      chatQueueDispatcher,
      providers,
      providerNetwork: options.providerNetwork,
      providerConfig: options.providerConfig,
      routeChatSend: async function* (input, signal) {
        const releaseActivity = await chatQueueDispatcher.acquireSessionActivity(input.sessionId);
        let terminal = false;
        try {
          for await (const event of await routeChatSend(input, signal)) {
            if (event.type === "final" || event.type === "aborted" || event.type === "error") terminal = true;
            yield event;
          }
        } finally {
          releaseActivity();
        }
        if (terminal) void chatQueueDispatcher.sessionIdle(input.sessionId).catch(() => undefined);
      },
      skills,
      skillInstallCoordinator,
      plugins,
      channels,
      channelRuntime,
      mcp,
      mcpRuntime,
      capabilityRuntime: options.capabilityRuntime,
      sessionAdvanced: client.sessionAdvanced,
      dispatchData: data.dispatch,
      dispatchDiagnostics: diagnostics.dispatch,
      dispatchRelease: createReleaseDispatcher(release),
      dispatchImage: images,
      coordinateWrite: (operation) => consistencyCoordinator.runTrackedWrite(operation),
      selectAttachments: options.selectAttachments,
      importSelectedAttachments: options.selectAttachments === undefined ? async () => {
        const selected = await dialog.showOpenDialog({
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "Supported attachments", extensions: ["png", "jpg", "jpeg", "gif", "webp", "mp4", "mov", "webm", "txt", "pdf"] }],
        });
        return selected.canceled ? [] : Promise.all(selected.filePaths.map((path) => {
          if (!("importFile" in attachments) || typeof attachments.importFile !== "function") {
            return readSelectedAttachments([path]).then(([input]) => attachments.import(input));
          }
          return attachments.importFile(path) as Promise<import("@uclaw/shared").Attachment>;
        }));
      } : undefined,
      });
      let domainDispose: (() => void) | undefined;
      try {
        domainDispose = options.domainRegistrations?.installIpc({
          ipcMain: ipcMain as unknown as IpcMainLike,
          authorizedWebContents: window.webContents,
          client,
          services,
        });
      } catch (error) {
        coreDispose();
        throw error;
      }
      return () => {
        disposeDesktopIpc(domainDispose, coreDispose);
      };
    },
  });
}

export async function startActivationMain(
  portablePaths: PortableDesktopPaths,
): Promise<void> {
  const { app, BrowserWindow, ipcMain, shell } = await import("electron");
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const devTools = !app.isPackaged;
  const coordinator = createProductionActivationCoordinator(portablePaths, process.env, {
    exit: (code) => { process.exitCode = code; app.quit(); },
  });
  await startActivationMainWithRuntime(portablePaths, {
    app, ipcMain: ipcMain as unknown as IpcMainLike, coordinator,
    createWindow: (registerIpc) => createMainWindow({
      BrowserWindow: BrowserWindow as unknown as BrowserWindowConstructor,
      startupMode: "activation-only",
      preloadPath: resolvePreloadPath(moduleDir),
      rendererUrl: validateRendererUrl(process.env.UCLAW_RENDERER_URL),
      rendererFile: join(moduleDir, "../../frontend/dist/index.html"),
      openExternal: (url) => shell.openExternal(url),
      devTools,
      showWhenReady: true,
      beforeLoad: registerIpc,
    }),
  });
}

export function createProductionActivationCoordinator(
  portablePaths: PortableDesktopPaths,
  env: NodeJS.ProcessEnv,
  options: { exit(code: number): void },
): ActivationCoordinator {
  const configuration = readActivationServiceConfiguration(env);
  const fingerprintScheme = env.UCLAW_USB_FINGERPRINT_SCHEME;
  const fingerprint = env.UCLAW_USB_FINGERPRINT_SHA256;
  const clientVersion = env.UCLAW_CLIENT_VERSION;
  const packageRoot = env.UCLAW_PACKAGE_ROOT;
  if (fingerprintScheme !== "uclaw-usb-v1" || !fingerprint || !/^[a-f0-9]{64}$/u.test(fingerprint) || !clientVersion || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(clientVersion)
      || !packageRoot || resolve(packageRoot) !== dirname(resolve(portablePaths.dataDir))) {
    throw new Error("Activation USB identity and client version are not configured.");
  }
  const client = createActivationClient({ endpoint: configuration.endpoint });
  const writer = createActivationArtifactWriter({ packageRoot, dataDir: portablePaths.dataDir });
  return createActivationCoordinator({
    preflight: async () => {
      const [packageInfo, dataInfo] = await Promise.all([lstat(packageRoot), lstat(portablePaths.dataDir)]);
      await writer.preflight();
      return { usbPresent: packageInfo.isDirectory() && !packageInfo.isSymbolicLink() && dataInfo.isDirectory() && !dataInfo.isSymbolicLink() };
    }, client, writer,
    usbFingerprint: { version: "uclaw-usb-v1", sha256: fingerprint },
    clientVersion,
    randomUUID,
    verifyLicense: async (response) => verifyActivationResponse(response, fingerprint, configuration.trustedPublicKeys, new Date()),
    commitRemote: (activationId, idempotencyKey, generation, signal) => client.commit(activationId, { idempotencyKey, artifactGeneration: generation }, signal),
    exit: options.exit,
  });
}

export function verifyActivationResponse(
  response: ActivationResponse,
  trustedFingerprint: string,
  trustedPublicKeys: Readonly<Record<string, string>>,
  now: Date,
): boolean {
  const { license, startupCredential, builtinCredential } = response;
  if (
    license.deviceId !== response.deviceId || startupCredential.deviceId !== response.deviceId || builtinCredential.deviceId !== response.deviceId ||
    license.licenseId !== response.licenseId || startupCredential.licenseId !== response.licenseId || builtinCredential.licenseId !== response.licenseId ||
    license.usbFingerprint.scheme !== "uclaw-usb-v1" || license.usbFingerprint.sha256 !== trustedFingerprint
  ) return false;
  const notBefore = Date.parse(license.notBefore);
  const expiresAt = Date.parse(license.expiresAt);
  if (!Number.isFinite(notBefore) || !Number.isFinite(expiresAt) || expiresAt <= notBefore || now.getTime() < notBefore || now.getTime() >= expiresAt) return false;
  try {
    const salt = Buffer.from(license.startupSecretProof.startupSecretSalt, "hex");
    if (salt.toString("hex") !== license.startupSecretProof.startupSecretSalt) return false;
    const actualSecretHash = createHash("sha256")
      .update(Buffer.from("uclaw-startup-secret-v1\0", "utf8"))
      .update(salt)
      .update(Buffer.from([0]))
      .update(Buffer.from(startupCredential.startupSecret, "utf8"))
      .digest();
    const expectedSecretHash = Buffer.from(license.startupSecretProof.startupSecretHash, "hex");
    if (expectedSecretHash.length !== actualSecretHash.length || !timingSafeEqual(actualSecretHash, expectedSecretHash)) return false;
    const key = trustedPublicKeys[license.signature.keyId];
    if (!key) return false;
    const payload = [
      "uclaw-startup-license-v1", license.schemaVersion, license.signature.keyId, license.usernameId,
      license.deviceId, license.licenseId,
      license.usbFingerprint.scheme, license.usbFingerprint.sha256,
      license.startupSecretProof.startupSecretSalt, license.startupSecretProof.startupSecretHash,
      license.notBefore, license.expiresAt, license.revision,
    ];
    return verify(null, Buffer.from(JSON.stringify(payload), "utf8"), key, Buffer.from(license.signature.value, "base64"));
  } catch {
    return false;
  }
}

export async function startActivationMainWithRuntime(
  _portablePaths: PortableDesktopPaths,
  runtime: { app: DesktopAppLike; createWindow(registerIpc: (window: DesktopWindow) => void): Promise<DesktopWindow>; ipcMain: IpcMainLike; coordinator: ActivationCoordinator },
): Promise<void> {
  await runActivationMain({
    app: runtime.app,
    createWindow: runtime.createWindow,
    registerIpc: (window) => registerActivationIpc({
      ipcMain: runtime.ipcMain,
      authorizedWebContents: window.webContents,
      coordinator: runtime.coordinator,
      closeWindow: () => window.close(),
    }),
  });
}
