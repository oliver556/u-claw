import {
  ChannelIpcResponseSchema,
  UClawErrorSchema,
  redactRendererText,
  type ChannelConfigEntry,
  type ChannelErrorSummary,
  type ChannelIpcRequest,
  type ChannelIpcResponse,
  type ChannelKind,
  type ChannelOperationResult,
  type ChannelStatus,
} from "@uclaw/shared";

import type { ChannelStore } from "./channel-store.js";
import { createWechatLoginCoordinator, type WechatPersonalRuntime } from "./wechat-login-coordinator.js";

export interface ChannelRuntime {
  capability(kind: ChannelKind): boolean;
  configure?(channel: ChannelConfigEntry, signal: AbortSignal): Promise<void>;
  remove?(channel: ChannelConfigEntry, signal: AbortSignal): Promise<void>;
  test?(channel: ChannelConfigEntry, signal: AbortSignal): Promise<{ status: ChannelStatus; error?: ChannelErrorSummary }>;
  start?(channel: ChannelConfigEntry, signal: AbortSignal): Promise<void>;
  stop?(channel: ChannelConfigEntry, signal: AbortSignal): Promise<void>;
  wechat?: WechatPersonalRuntime;
}

export type ChannelDispatcher = ((request: ChannelIpcRequest) => Promise<ChannelIpcResponse>) & { dispose(): void };

const capabilityError: ChannelErrorSummary = { category: "capability", code: "CAPABILITY_UNAVAILABLE", message: "当前运行时未提供该渠道能力。", retryable: false };

function operationError(error: unknown): ChannelErrorSummary {
  const raw = redactRendererText(error instanceof Error ? error.message : String(error));
  if (/401|403|unauthor|forbidden|token|secret|credential/iu.test(raw)) return { category: "authentication", code: "AUTHENTICATION_FAILED", message: "渠道鉴权失败。", retryable: false };
  if (/429|rate.?limit/iu.test(raw)) return { category: "rate-limit", code: "RATE_LIMITED", message: "渠道请求被限流。", retryable: true };
  if (/timeout|timed out/iu.test(raw)) return { category: "timeout", code: "TIMEOUT", message: "渠道操作超时。", retryable: true };
  if (/network|fetch|socket|connect|dns|econn/iu.test(raw)) return { category: "network", code: "NETWORK_ERROR", message: "渠道网络连接失败。", retryable: true };
  return { category: "operation", code: "OPERATION_FAILED", message: "渠道操作失败。", retryable: true };
}

function statusForError(error: ChannelErrorSummary): ChannelStatus {
  if (error.category === "authentication") return "auth-failed";
  if (error.category === "rate-limit") return "rate-limited";
  if (error.category === "network" || error.category === "timeout") return "network-error";
  return "needs-action";
}

export function createChannelDispatcher(store: ChannelStore, runtime: ChannelRuntime, options: { timeoutMs?: number; now?: () => Date } = {}): ChannelDispatcher {
  const timeoutMs = options.timeoutMs ?? 12_000;
  const now = options.now ?? (() => new Date());
  const active = new Map<string, AbortController>();
  const queues = new Map<string, Promise<void>>();
  const unavailableWechatRuntime: WechatPersonalRuntime = {
    capability: async () => ({ available: false, pluginStatus: "unknown", reason: "OpenClaw 2026.7.1-2 未提供可安全定向个人微信的扫码与退出 RPC。" }),
    status: async () => { throw new Error("WeChat runtime unavailable"); },
    start: async () => { throw new Error("WeChat runtime unavailable"); },
    poll: async () => { throw new Error("WeChat runtime unavailable"); },
    refresh: async () => { throw new Error("WeChat runtime unavailable"); },
    cancel: async () => { throw new Error("WeChat runtime unavailable"); },
    reconnect: async () => { throw new Error("WeChat runtime unavailable"); },
    logout: async () => { throw new Error("WeChat runtime unavailable"); },
  };
  const wechat = createWechatLoginCoordinator(runtime.wechat ?? unavailableWechatRuntime, { now, timeoutMs });
  const serialize = <T>(
    requestId: string,
    channelId: string,
    operation: (signal: AbortSignal) => Promise<T>,
    onAbort?: (reason: unknown) => T | Promise<T>,
  ): Promise<T> => {
    if (active.has(requestId)) return Promise.reject(UClawErrorSchema.parse({ code: "CONFLICT", message: "Channel operation request ID is already active.", retryable: false }));
    const controller = new AbortController();
    active.set(requestId, controller);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let resolved = false;
    let resolveVisible!: (value: T) => void;
    let rejectVisible!: (reason: unknown) => void;
    const visible = new Promise<T>((resolve, reject) => { resolveVisible = resolve; rejectVisible = reject; });
    const settleVisible = (success: boolean, value: unknown): void => {
      if (resolved) return;
      resolved = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (active.get(requestId) === controller) active.delete(requestId);
      if (success) resolveVisible(value as T); else rejectVisible(value);
    };
    const abortVisible = (): void => {
      const reason = controller.signal.reason ?? new DOMException("Aborted", "AbortError");
      if (onAbort === undefined) settleVisible(false, reason);
      else Promise.resolve(onAbort(reason)).then((value) => settleVisible(true, value), (error) => settleVisible(false, error));
    };
    controller.signal.addEventListener("abort", abortVisible, { once: true });

    const previous = queues.get(channelId) ?? Promise.resolve();
    let drain!: Promise<void>;
    drain = previous.catch(() => undefined).then(async () => {
      if (controller.signal.aborted) return;
      timeout = setTimeout(() => controller.abort(new Error("Channel operation timed out")), timeoutMs);
      let raw: Promise<T>;
      try { raw = Promise.resolve(operation(controller.signal)); }
      catch (error) { raw = Promise.reject(error); }
      raw.then((value) => settleVisible(true, value), (error) => settleVisible(false, error));
      await raw.then(() => undefined, () => undefined);
    }).finally(() => {
      controller.signal.removeEventListener("abort", abortVisible);
      if (queues.get(channelId) === drain) queues.delete(channelId);
    });
    queues.set(channelId, drain);
    return visible;
  };
  const run = async (channelId: string, checkedAt: string, signal: AbortSignal, operation: (channel: ChannelConfigEntry, signal: AbortSignal) => Promise<{ status: ChannelStatus; error?: ChannelErrorSummary }>): Promise<ChannelOperationResult> => {
    try {
      const channel = await store.getForRuntime(channelId);
      if (!runtime.capability(channel.kind)) {
        await store.record(channelId, "needs-action", checkedAt, capabilityError);
        return { channelId, status: "needs-action", checkedAt, error: capabilityError };
      }
      const result = await operation(channel, signal);
      if (signal.aborted) throw signal.reason;
      await store.record(channelId, result.status, checkedAt, result.error);
      return { channelId, checkedAt, ...result };
    } catch (error) {
      const summary = operationError(signal.aborted ? signal.reason : error);
      const status = statusForError(summary);
      await store.record(channelId, status, checkedAt, summary).catch(() => undefined);
      return { channelId, status, checkedAt, error: summary };
    }
  };
  const dispatch = async (request: ChannelIpcRequest): Promise<ChannelIpcResponse> => {
    let result: unknown;
    switch (request.method) {
      case "channels.list-managed": result = await store.list(); break;
      case "channels.create": result = await serialize(request.requestId, request.params.channel.id, async (signal) => {
        const existing = await store.list();
        if (existing.channels.some(({ id }) => id === request.params.channel.id)) throw UClawErrorSchema.parse({ code: "CONFLICT", message: "Channel ID already exists.", retryable: false });
        const channel = request.params.channel as ChannelConfigEntry;
        const configured = runtime.capability(channel.kind) && runtime.configure !== undefined;
        if (configured) await runtime.configure!(channel, signal);
        try { return await store.create(request.params.channel); }
        catch (error) {
          if (configured && runtime.remove) await runtime.remove(channel, signal).catch(() => undefined);
          throw error;
        }
      }); break;
      case "channels.update": result = await serialize(request.requestId, request.params.channelId, async (signal) => {
        if (request.params.channel.id !== request.params.channelId) throw UClawErrorSchema.parse({ code: "INVALID_ARGUMENT", message: "Channel ID cannot be changed.", retryable: false });
        const previous = await store.getForRuntime(request.params.channelId);
        const channel = request.params.channel as ChannelConfigEntry;
        const configured = runtime.capability(channel.kind) && runtime.configure !== undefined;
        if (configured) await runtime.configure!(channel, signal);
        try { return await store.update(request.params.channelId, request.params.channel); }
        catch (error) {
          if (configured) await runtime.configure!(previous, signal).catch(() => undefined);
          throw error;
        }
      }); break;
      case "channels.remove": result = await serialize(request.requestId, request.params.channelId, async (signal) => {
        const channel = await store.getForRuntime(request.params.channelId);
        const removed = runtime.capability(channel.kind) && runtime.remove !== undefined;
        if (removed) await runtime.remove!(channel, signal);
        try { return await store.remove(request.params.channelId); }
        catch (error) {
          if (removed && runtime.configure) {
            await runtime.configure(channel, signal).catch(() => undefined);
            if (channel.enabled && runtime.start) await runtime.start(channel, signal).catch(() => undefined);
          }
          throw error;
        }
      }); break;
      case "channels.set-enabled": result = await serialize(request.requestId, request.params.channelId, async (signal) => {
        const channel = await store.getForRuntime(request.params.channelId);
        const prospective = { ...channel, enabled: request.params.enabled } as ChannelConfigEntry;
        if (runtime.capability(channel.kind)) {
          if (request.params.enabled && runtime.start) await runtime.start(prospective, signal);
          if (!request.params.enabled && runtime.stop) await runtime.stop(prospective, signal);
        }
        try { return await store.setEnabled(request.params.channelId, request.params.enabled); }
        catch (error) {
          if (runtime.capability(channel.kind)) {
            if (request.params.enabled && runtime.stop) await runtime.stop(channel, signal).catch(() => undefined);
            if (!request.params.enabled && runtime.start) await runtime.start(channel, signal).catch(() => undefined);
          }
          throw error;
        }
      }); break;
      case "channels.test": {
        const checkedAt = now().toISOString();
        result = await serialize(request.requestId, request.params.channelId, (signal) => run(request.params.channelId, checkedAt, signal, async (channel, runtimeSignal) => runtime.test ? runtime.test(channel, runtimeSignal) : { status: "needs-action", error: capabilityError }), async (reason) => {
          const error = operationError(reason); const status = statusForError(error);
          await store.record(request.params.channelId, status, checkedAt, error).catch(() => undefined);
          return { channelId: request.params.channelId, status, checkedAt, error };
        });
        break;
      }
      case "channels.reconnect": {
        const checkedAt = now().toISOString();
        result = await serialize(request.requestId, request.params.channelId, (signal) => run(request.params.channelId, checkedAt, signal, async (channel, runtimeSignal) => {
        await runtime.stop?.(channel, runtimeSignal);
        await runtime.start?.(channel, runtimeSignal);
        return { status: "connecting" };
        }), async (reason) => {
          const error = operationError(reason); const status = statusForError(error);
          await store.record(request.params.channelId, status, checkedAt, error).catch(() => undefined);
          return { channelId: request.params.channelId, status, checkedAt, error };
        });
        break;
      }
      case "channels.cancel": active.get(request.params.operationRequestId)?.abort(new Error("Channel operation cancelled")); result = null; break;
      case "channels.wechat-status": result = await wechat.status(); break;
      case "channels.wechat-login-start": result = await wechat.start(request.params.force ?? false); break;
      case "channels.wechat-login-poll": result = await wechat.poll(request.params.flowId, request.params.qrGeneration); break;
      case "channels.wechat-login-refresh": result = await wechat.refresh(request.params.flowId, request.params.qrGeneration); break;
      case "channels.wechat-login-cancel": result = await wechat.cancel(request.params.flowId); break;
      case "channels.wechat-reconnect": result = await wechat.reconnect(); break;
      case "channels.wechat-logout": result = await wechat.logout(); break;
    }
    return ChannelIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result });
  };
  return Object.assign(dispatch, {
    dispose: (): void => {
      wechat.dispose();
      for (const controller of active.values()) controller.abort(new Error("Channel dispatcher disposed"));
      active.clear();
    },
  });
}
