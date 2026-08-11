import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  UClawErrorSchema,
  type AttachmentImportInput,
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
import { startGatewayAndCreateWindow, validateGatewayLaunchOptions, waitForGatewayReadiness, type ShowableWindow } from "./gateway/startup.js";
import {
  applyPortableEnvironmentToLaunchOptions,
  type PortableDesktopPaths,
} from "./portable-paths.js";
import type { AuthorizedWebContents, IpcMainLike } from "./ipc/register-ipc.js";
import { registerIpc as registerDesktopIpc } from "./ipc/register-ipc.js";
import { createSessionOrganizerStore } from "./session-organizer/store.js";
import { createProviderStore, type ProviderStore } from "./providers/provider-store.js";
import type { ProviderNetworkService } from "./providers/provider-network.js";
import type { OpenClawProviderConfigBackend } from "./providers/openclaw-provider-config.js";
import { createMainProcessModelRouting, type ExternalModelSourceExecutors } from "./providers/model-source-router.js";
import { createSkillHubClient } from "./skills/skillhub-client.js";
import { createSkillService } from "./skills/skill-service.js";
import { createLivePluginRegistryClient, createUnavailablePluginRegistryClient } from "./plugins/registry-client.js";
import { createOpenClawCliPluginRuntime } from "./plugins/openclaw-cli-runtime.js";
import { createPluginService } from "./plugins/plugin-service.js";
import type { PluginRuntimeAdapter } from "./plugins/runtime-adapter.js";
import { createChannelStore } from "./channels/channel-store.js";
import type { ChannelRuntime } from "./channels/channel-dispatcher.js";
import { createMcpStore } from "./mcp/mcp-store.js";
import { createDataService } from "./data/data-service.js";
import { ProductionRuntimeConsistencyCoordinator } from "./data/production-consistency-coordinator.js";
import { createDiagnosticsService, type DiagnosticsRuntimeInfo } from "./diagnostics/diagnostics-service.js";
import { createMcpProtocolProbe, createOpenClawMcpRuntime } from "./mcp/mcp-runtime.js";
import { createReleaseDispatcher } from "./release/release-dispatcher.js";
import type { ReleaseService } from "./release/release-service.js";
import { createProductionReleaseService } from "./release/production-release.js";
import {
  createAdvancedConsoleController,
  createMainWindow,
  createWindowControls,
  type BrowserWindowConstructor,
  type DesktopWindow,
} from "./window.js";

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
}

export async function bootstrapDesktopApp<TWindow extends AppWindowLike>({
  app,
  createWindow,
  registerIpc,
  stopGateway,
  abortStartup,
  startupSignal,
}: BootstrapDesktopDependencies<TWindow>): Promise<TWindow | null> {
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
  attachments?: AttachmentService;
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
  consistencyCoordinator?: ProductionRuntimeConsistencyCoordinator;
  providers?: ProviderStore;
  providerNetwork?: ProviderNetworkService;
  providerConfig?: OpenClawProviderConfigBackend;
  modelSourceExecutors?: ExternalModelSourceExecutors<SendMessageInput, AsyncIterable<MessageEvent>>;
  domainRegistrations?: DesktopDomainRegistry;
  dispose?(): Promise<void> | void;
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

export interface DesktopMainRuntime<TWindow extends AppWindowLike & ShowableWindow> {
  app: DesktopAppLike;
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
  });
  const fetchHealth = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const now = options.now ?? Date.now;
  const startupController = new AbortController();
  let stopPromise: Promise<void> | undefined;
  const stopGateway = (): Promise<void> => stopPromise ??= (async () => {
    const results = await Promise.allSettled([
      gatewayProcess.stop(),
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
      await gatewayProcess.stop();
    },
    start: async (signal) => {
      if (managedPort === undefined || managedLaunchOptions === undefined) throw new Error("Managed Gateway launch state is unavailable.");
      const restartController = new AbortController();
      const restartSignal = signal ? AbortSignal.any([signal, restartController.signal]) : restartController.signal;
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
        }, managedPort, identity);
      } catch (error) {
        restartController.abort();
        try { await gatewayProcess.stop(); } catch (stopError) {
          throw new AggregateError([error, stopError], "Managed Gateway restart and cleanup failed.", { cause: error });
        }
        throw error;
      }
    },
  });

  return bootstrapDesktopApp({
    app: runtime.app,
    stopGateway,
    abortStartup: () => startupController.abort(new DOMException("Desktop shutdown requested.", "AbortError")),
    startupSignal: startupController.signal,
    createWindow: async (registerIpc) => {
      const started = await startGatewayAndCreateWindow({
        selectPort: options.selectPort ?? ((excludedPorts) => selectGatewayPort({ excludedPorts })),
        gatewayProcess: {
          start: (launchOptions) => gatewayProcess.start(launchOptions),
          stop: stopGateway,
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

export function requireModelSourceExecutors(
  executors: DesktopMainOptions["modelSourceExecutors"],
): ExternalModelSourceExecutors<SendMessageInput, AsyncIterable<MessageEvent>> {
  if (!executors) throw new Error("Desktop production wiring must provide model source executors.");
  return executors;
}

export function requireChannelRuntime(client: UClawClient): ChannelRuntime {
  const runtime = client.channels as unknown as Partial<ChannelRuntime>;
  const methods: ReadonlyArray<keyof ChannelRuntime> = ["capability", "configure", "remove", "test", "start", "stop"];
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
  const inspect = options.stat ?? stat;
  const read = options.readFile ?? readFile;
  if (paths.length > maxFiles) {
    throw UClawErrorSchema.parse({ code: "INVALID_ARGUMENT", message: `一次最多选择 ${maxFiles} 个附件。`, retryable: false });
  }
  const inspected = await Promise.all(paths.map(async (path) => {
    const info = await inspect(path);
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
  const modelSourceExecutors = requireModelSourceExecutors(options.modelSourceExecutors);
  const { app, BrowserWindow, dialog, ipcMain, shell } = await import("electron");
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const client = requireElectronClient(options.client);
  const consistencyCoordinator = new ProductionRuntimeConsistencyCoordinator();
  const organizer = createSessionOrganizerStore(portablePaths.dataDir);
  const attachments = options.attachments ?? client.attachments;
  const providers = options.providers ?? createProviderStore({ dataDir: portablePaths.dataDir });
  const modelRouting = createMainProcessModelRouting({
    dataDir: portablePaths.dataDir,
    providers,
    executors: modelSourceExecutors,
  });
  const skills = await createSkillService({
    dataDir: portablePaths.dataDir,
    client: createSkillHubClient(),
    runMutation: (operation) => consistencyCoordinator.runTrackedWrite(operation),
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
  let gatewayPort: number | undefined;
  const openAdvancedConsole = createAdvancedConsoleController({
    BrowserWindow: BrowserWindow as unknown as BrowserWindowConstructor,
    getGatewayPort: () => {
      if (gatewayPort === undefined) throw new Error("Gateway port is unavailable.");
      return gatewayPort;
    },
    openExternal: (url) => shell.openExternal(url),
  });
  const runtimeOptions: DesktopMainOptions = {
    ...options,
    consistencyCoordinator,
    buildGatewayLaunchOptions: (port) => {
      gatewayPort = port;
      diagnosticsRuntime.gatewayPort = port;
      return applyPortableEnvironmentToLaunchOptions(options.buildGatewayLaunchOptions(port), portablePaths);
    },
  };
  const domainServices = new Map<string, unknown>([
    ["organizer", organizer],
    ["attachments", attachments],
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
      return createMainWindow({
        BrowserWindow: BrowserWindow as unknown as BrowserWindowConstructor,
        preloadPath: resolvePreloadPath(moduleDir),
        rendererUrl: validateRendererUrl(process.env.UCLAW_RENDERER_URL),
        rendererFile: join(moduleDir, "../../frontend/dist/index.html"),
        openExternal: (url) => shell.openExternal(url),
        showWhenReady: false,
        beforeLoad: registerIpc,
      });
    },
    registerIpc: (window, dispatchClient) => {
      diagnosticsRuntime.gatewayStatus = "ready";
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
      providers,
      providerNetwork: options.providerNetwork,
      providerConfig: options.providerConfig,
      routeChatSend: modelRouting.routeChatSend,
      skills,
      plugins,
      channels,
      channelRuntime,
      mcp,
      mcpRuntime,
      dispatchData: data.dispatch,
      dispatchDiagnostics: diagnostics.dispatch,
      dispatchRelease: createReleaseDispatcher(release),
      coordinateWrite: (operation) => consistencyCoordinator.runTrackedWrite(operation),
      selectAttachments: options.selectAttachments ?? (attachments === undefined ? undefined : async () => {
        const selected = await dialog.showOpenDialog({
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "Supported attachments", extensions: ["png", "jpg", "jpeg", "gif", "webp", "txt", "pdf"] }],
        });
        return selected.canceled ? [] : readSelectedAttachments(selected.filePaths);
      }),
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
