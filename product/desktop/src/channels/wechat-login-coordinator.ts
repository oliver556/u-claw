import {
  WechatConnectionSnapshotSchema,
  redactRendererText,
  type ChannelErrorSummary,
  type ChannelStatus,
  type WechatConnectionSnapshot,
  type WechatLoginState,
} from "@uclaw/shared";

type PluginStatus = "installed" | "missing" | "unknown";
type AccountSummary = { displayName?: string; accountIdHint: string };
type RuntimeState = { status: ChannelStatus; loginState: WechatLoginState; account?: AccountSummary };
type QrImage = NonNullable<WechatConnectionSnapshot["qrImage"]>;

export interface WechatPersonalRuntime {
  capability(signal: AbortSignal): Promise<{ available: boolean; pluginStatus: PluginStatus; reason?: string }>;
  status(signal: AbortSignal): Promise<RuntimeState>;
  start(force: boolean, signal: AbortSignal): Promise<{ flowId: string; qrImage: QrImage; qrExpiresAt: string }>;
  poll(flowId: string, signal: AbortSignal): Promise<RuntimeState>;
  refresh(flowId: string, signal: AbortSignal): Promise<{ qrImage: QrImage; qrExpiresAt: string }>;
  cancel(flowId: string, signal: AbortSignal): Promise<void>;
  reconnect(signal: AbortSignal): Promise<RuntimeState>;
  logout(signal: AbortSignal): Promise<void>;
}

export interface WechatLoginCoordinator {
  status(): Promise<WechatConnectionSnapshot>;
  start(force: boolean): Promise<WechatConnectionSnapshot>;
  poll(flowId: string, qrGeneration: number): Promise<WechatConnectionSnapshot>;
  refresh(flowId: string, qrGeneration: number): Promise<WechatConnectionSnapshot>;
  cancel(flowId: string): Promise<WechatConnectionSnapshot>;
  reconnect(): Promise<WechatConnectionSnapshot>;
  logout(): Promise<WechatConnectionSnapshot>;
  dispose(): void;
}

const plugin = { id: "openclaw-weixin", requiredVersion: "2.4.6" } as const;

function mapError(error: unknown): ChannelErrorSummary {
  const message = redactRendererText(error instanceof Error ? error.message : String(error));
  if (/401|403|auth|token|logged.?out|被登出|登录失效/iu.test(message)) {
    return { category: "authentication", code: "WECHAT_LOGGED_OUT", message: "个人微信登录已失效。", retryable: true };
  }
  if (/timeout|timed.?out/iu.test(message)) {
    return { category: "timeout", code: "WECHAT_TIMEOUT", message: "个人微信操作超时。", retryable: true };
  }
  if (/network|fetch|socket|connect|dns|econn/iu.test(message)) {
    return { category: "network", code: "WECHAT_NETWORK_ERROR", message: "个人微信网络连接失败。", retryable: true };
  }
  if (/runtime|gateway/iu.test(message)) {
    return { category: "capability", code: "WECHAT_RUNTIME_UNAVAILABLE", message: "OpenClaw runtime 暂不可用。", retryable: true };
  }
  return { category: "operation", code: "WECHAT_OPERATION_FAILED", message: "个人微信操作失败。", retryable: true };
}

function statusForError(error: ChannelErrorSummary): ChannelStatus {
  if (error.category === "authentication") return "auth-failed";
  if (error.category === "network" || error.category === "timeout") return "network-error";
  return "needs-action";
}

export function createWechatLoginCoordinator(
  runtime: WechatPersonalRuntime,
  options: { now?: () => Date; timeoutMs?: number; createFlowId?: () => string } = {},
): WechatLoginCoordinator {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 30_000;
  const createFlowId = options.createFlowId ?? (() => crypto.randomUUID());
  let current: WechatConnectionSnapshot = WechatConnectionSnapshotSchema.parse({
    channelId: "wechat-personal",
    status: "not-configured",
    loginState: "idle",
    capability: "unavailable",
    plugin: { ...plugin, status: "unknown" },
  });
  let queue = Promise.resolve();
  let runtimeDrain = Promise.resolve();
  let disposed = false;
  let resolveDisposed!: () => void;
  const disposedPromise = new Promise<void>((resolve) => { resolveDisposed = resolve; });
  let activePoll: { flowId: string; controller: AbortController } | undefined;
  let runtimeFlowId: string | undefined;
  const activeControllers = new Set<AbortController>();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = async () => {
      if (!disposed) await Promise.race([runtimeDrain, disposedPromise]);
      return disposed ? current as T : operation();
    };
    const result = queue.then(run, run);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const withDeadline = async <T>(operation: (signal: AbortSignal, controller: AbortController) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    activeControllers.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    });
    let raw: Promise<T>;
    try { raw = Promise.resolve(operation(signal, controller)); }
    catch (error) { raw = Promise.reject(error); }
    raw = raw.then((value) => {
      if (signal.aborted) throw signal.reason;
      return value;
    });
    const drain = raw.then(() => undefined, () => undefined).finally(() => {
      signal.removeEventListener("abort", onAbort);
      activeControllers.delete(controller);
    });
    runtimeDrain = drain;
    return Promise.race([raw, aborted]);
  };
  const withControlDeadline = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    activeControllers.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    });
    let raw: Promise<T>;
    try { raw = Promise.resolve(operation(signal)); }
    catch (error) { raw = Promise.reject(error); }
    raw = raw.then((value) => {
      if (signal.aborted) throw signal.reason;
      return value;
    });
    void raw.then(() => undefined, () => undefined).finally(() => {
      signal.removeEventListener("abort", onAbort);
      activeControllers.delete(controller);
    });
    return Promise.race([raw, aborted]);
  };
  const checkedAt = (): string => now().toISOString();
  const commit = (snapshot: Omit<WechatConnectionSnapshot, "channelId" | "plugin"> & { pluginStatus?: PluginStatus }): WechatConnectionSnapshot => {
    const { pluginStatus = current.plugin.status, ...rest } = snapshot;
    current = WechatConnectionSnapshotSchema.parse({
      channelId: "wechat-personal",
      plugin: { ...plugin, status: pluginStatus },
      ...rest,
    });
    return current;
  };
  const unavailable = (pluginStatus: PluginStatus, reason?: string): WechatConnectionSnapshot => {
    const missing = pluginStatus === "missing";
    const error: ChannelErrorSummary = {
      category: "capability",
      code: missing ? "WECHAT_PLUGIN_MISSING" : "WECHAT_CAPABILITY_UNAVAILABLE",
      message: missing ? "个人微信插件未安装。" : "当前 OpenClaw 契约不支持安全扫码登录。",
      retryable: false,
    };
    return commit({
      status: "needs-action", loginState: "error", capability: "unavailable",
      capabilityReason: redactRendererText(reason ?? error.message), pluginStatus, error,
      lastCheckedAt: checkedAt(),
    });
  };
  const checkCapability = async (signal: AbortSignal): Promise<boolean> => {
    const capability = await runtime.capability(signal);
    if (signal.aborted) throw signal.reason;
    if (!capability.available) {
      unavailable(capability.pluginStatus, capability.reason);
      return false;
    }
    current = WechatConnectionSnapshotSchema.parse({ ...current, capability: "available", plugin: { ...plugin, status: capability.pluginStatus }, capabilityReason: undefined, error: undefined });
    return true;
  };
  const fail = (error: unknown): WechatConnectionSnapshot => {
    if (disposed) return current;
    const summary = mapError(error);
    return commit({
      status: statusForError(summary), loginState: "error", capability: current.capability,
      pluginStatus: current.plugin.status, lastCheckedAt: checkedAt(), error: summary,
    });
  };
  const staleQr = (code: "WECHAT_QR_EXPIRED" | "WECHAT_QR_STALE"): WechatConnectionSnapshot => commit({
    status: "needs-action", loginState: "expired", capability: current.capability,
    pluginStatus: current.plugin.status, flowId: current.flowId, qrGeneration: current.qrGeneration,
    lastCheckedAt: checkedAt(),
    error: { category: "timeout", code, message: code === "WECHAT_QR_EXPIRED" ? "二维码已过期，请刷新。" : "二维码已更新，请使用最新二维码。", retryable: true },
  });
  const staleQrRequest = (): WechatConnectionSnapshot => current;
  const activeMatches = (flowId: string, generation?: number): boolean => current.flowId === flowId && (generation === undefined || current.qrGeneration === generation);

  return {
    status: () => serialize(async () => {
      try {
        return await withDeadline(async (signal) => {
          if (!(await checkCapability(signal))) return current;
          if (current.flowId) return current;
          const result = await runtime.status(signal);
          if (signal.aborted) throw signal.reason;
          return commit({ ...result, capability: "available", pluginStatus: current.plugin.status, lastCheckedAt: checkedAt() });
        });
      } catch (error) { return fail(error); }
    }),
    start: (force) => serialize(async () => {
      try {
        if (current.flowId && !force) return current;
        return await withDeadline(async (signal) => {
          if (!(await checkCapability(signal))) return current;
          if (runtimeFlowId) await runtime.cancel(runtimeFlowId, signal);
          if (signal.aborted) throw signal.reason;
          const result = await runtime.start(force, signal);
          if (signal.aborted) throw signal.reason;
          runtimeFlowId = result.flowId;
          return commit({
            status: "pending-verification", loginState: "awaiting-scan", capability: "available",
            pluginStatus: current.plugin.status, flowId: createFlowId(), qrGeneration: 1,
            qrImage: result.qrImage, qrExpiresAt: result.qrExpiresAt, lastCheckedAt: checkedAt(),
          });
        });
      } catch (error) { return fail(error); }
    }),
    poll: (flowId, qrGeneration) => serialize(async () => {
      if (!activeMatches(flowId, qrGeneration)) return staleQrRequest();
      if (current.qrExpiresAt && new Date(current.qrExpiresAt).getTime() <= now().getTime()) return staleQr("WECHAT_QR_EXPIRED");
      try {
        if (!runtimeFlowId) return staleQrRequest();
        return await withDeadline(async (signal, controller) => {
          activePoll = { flowId, controller };
          const result = await runtime.poll(runtimeFlowId!, signal);
          if (signal.aborted) throw signal.reason;
          if (result.loginState === "connected") {
            runtimeFlowId = undefined;
            return commit({ ...result, capability: "available", pluginStatus: current.plugin.status, lastCheckedAt: checkedAt() });
          }
          return commit({ ...current, ...result, capability: "available", pluginStatus: current.plugin.status, lastCheckedAt: checkedAt(), error: undefined });
        });
      } catch (error) {
        if (activePoll?.controller.signal.aborted && !/timeout/iu.test(String(activePoll.controller.signal.reason))) {
          runtimeFlowId = undefined;
          return commit({ status: "disconnected", loginState: "cancelled", capability: current.capability, pluginStatus: current.plugin.status, lastCheckedAt: checkedAt() });
        }
        return fail(error);
      } finally {
        if (activePoll?.flowId === flowId) activePoll = undefined;
      }
    }),
    refresh: (flowId, qrGeneration) => serialize(async () => {
      if (!activeMatches(flowId)) return staleQrRequest();
      if (current.qrGeneration !== qrGeneration) return current;
      try {
        if (!runtimeFlowId) return staleQrRequest();
        return await withDeadline(async (signal) => {
          const result = await runtime.refresh(runtimeFlowId!, signal);
          if (signal.aborted) throw signal.reason;
          return commit({
            status: "pending-verification", loginState: "awaiting-scan", capability: "available",
            pluginStatus: current.plugin.status, flowId, qrGeneration: qrGeneration + 1,
            qrImage: result.qrImage, qrExpiresAt: result.qrExpiresAt, lastCheckedAt: checkedAt(),
          });
        });
      } catch (error) { return fail(error); }
    }),
    cancel: (flowId) => {
      const shouldCancel = activeMatches(flowId) || activePoll?.flowId === flowId;
      const runtimeTarget = runtimeFlowId;
      if (activePoll?.flowId === flowId) activePoll.controller.abort(new Error("WeChat login cancelled"));
      if (!shouldCancel || !runtimeTarget) return serialize(async () => current);
      return (async () => {
        try { await withControlDeadline((signal) => runtime.cancel(runtimeTarget, signal)); }
        catch (error) { return fail(error); }
        runtimeDrain = Promise.resolve();
        runtimeFlowId = undefined;
        return commit({ status: "disconnected", loginState: "cancelled", capability: current.capability, pluginStatus: current.plugin.status, lastCheckedAt: checkedAt() });
      })();
    },
    reconnect: () => serialize(async () => {
      try {
        return await withDeadline(async (signal) => {
          if (!(await checkCapability(signal))) return current;
          const result = await runtime.reconnect(signal);
          if (signal.aborted) throw signal.reason;
          return commit({ ...result, capability: "available", pluginStatus: current.plugin.status, lastCheckedAt: checkedAt() });
        });
      } catch (error) { return fail(error); }
    }),
    logout: () => serialize(async () => {
      try {
        await withDeadline((signal) => runtime.logout(signal));
        runtimeFlowId = undefined;
        return commit({ status: "not-configured", loginState: "logged-out", capability: "available", pluginStatus: current.plugin.status, lastCheckedAt: checkedAt() });
      } catch (error) { return fail(error); }
    }),
    dispose: () => {
      disposed = true;
      resolveDisposed();
      const runtimeTarget = runtimeFlowId;
      for (const controller of activeControllers) controller.abort(new Error("WeChat login coordinator disposed"));
      activeControllers.clear();
      activePoll = undefined;
      runtimeFlowId = undefined;
      if (runtimeTarget) void runtime.cancel(runtimeTarget, AbortSignal.timeout(timeoutMs)).catch(() => undefined);
      current = WechatConnectionSnapshotSchema.parse({
        channelId: "wechat-personal", status: "disconnected", loginState: "cancelled",
        capability: "unavailable", plugin: { ...plugin, status: current.plugin.status },
      });
    },
  };
}
