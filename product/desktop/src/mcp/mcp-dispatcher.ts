import {
  McpIpcResponseSchema,
  McpServerDraftSchema,
  UClawErrorSchema,
  type McpIpcRequest,
  type McpIpcResponse,
  type McpServerConfigEntry,
  type McpServerDraft,
  type McpServerUpdatePatch,
  type UClawError,
} from "@uclaw/shared";

import type { McpStore } from "./mcp-store.js";
import type { McpProbeResult } from "./mcp-runtime.js";
import { assessMcpStdioPolicy } from "./stdio-policy.js";

export interface McpRuntime {
  capability(): boolean;
  test(server: McpServerConfigEntry, signal: AbortSignal): Promise<McpProbeResult>;
  configure?(server: McpServerConfigEntry, signal: AbortSignal): Promise<void>;
  remove?(server: McpServerConfigEntry, signal: AbortSignal): Promise<void>;
  start?(server: McpServerConfigEntry, signal: AbortSignal): Promise<void>;
  stop?(server: McpServerConfigEntry, signal: AbortSignal): Promise<void>;
}

export type McpDispatcher = ((request: McpIpcRequest) => Promise<McpIpcResponse>) & { dispose(): void };

function error(code: UClawError["code"], message: string, retryable = false): UClawError {
  return UClawErrorSchema.parse({ code, message, retryable, recoveryActions: retryable ? ["retry"] : [], causeDetails: {} });
}

function resolveUpdate(previous: McpServerConfigEntry, patch: McpServerUpdatePatch): McpServerDraft {
  if (patch.id !== previous.id) throw error("INVALID_ARGUMENT", "MCP server ID cannot be changed.");
  if (patch.transport !== previous.transport) throw error("INVALID_ARGUMENT", "MCP server transport cannot be changed.");
  if (patch.transport === "stdio" && previous.transport === "stdio") {
    return McpServerDraftSchema.parse({
      id: patch.id,
      name: patch.name,
      enabled: patch.enabled,
      transport: patch.transport,
      executableId: patch.executableId,
      args: patch.args ?? previous.args,
      env: patch.env ?? previous.env,
    });
  }
  if (patch.transport !== "stdio" && previous.transport !== "stdio") {
    let authentication = patch.authentication;
    if (authentication.type !== "none" && previous.authentication.type === authentication.type && authentication.secret === undefined) {
      authentication = { ...authentication, secret: previous.authentication.secret };
    }
    return McpServerDraftSchema.parse({
      id: patch.id,
      name: patch.name,
      enabled: patch.enabled,
      transport: patch.transport,
      url: patch.url ?? previous.url,
      authentication,
    });
  }
  throw error("INVALID_ARGUMENT", "MCP server transport cannot be changed.");
}

function requireStdioRuntimeConfirmation(
  server: McpServerDraft | McpServerConfigEntry,
  confirmedRiskFingerprint?: string,
): McpServerConfigEntry {
  if (server.transport !== "stdio") return server as McpServerConfigEntry;
  const assessment = assessMcpStdioPolicy(server);
  if (!assessment.allowed) throw error("FORBIDDEN", "stdio configuration is blocked by policy.");
  if (assessment.confirmationRequired && confirmedRiskFingerprint !== assessment.fingerprint) {
    throw error("CONFIRMATION_REQUIRED", "stdio risk confirmation is required.");
  }
  return {
    ...server,
    ...(confirmedRiskFingerprint ? { confirmedRiskFingerprint } : {}),
  } as McpServerConfigEntry;
}

export function createMcpDispatcher(store: McpStore, runtime: McpRuntime): McpDispatcher {
  const operations = new Map<string, AbortController>();
  const serverQueues = new Map<string, Promise<void>>();
  let disposed = false;

  const serializeServer = <T>(serverId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = serverQueues.get(serverId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    serverQueues.set(serverId, tail);
    void tail.then(() => { if (serverQueues.get(serverId) === tail) serverQueues.delete(serverId); });
    return result;
  };

  const operate = async (
    request: Extract<McpIpcRequest, { method: "mcp.test" | "mcp.reconnect" }>,
    controller: AbortController,
  ) => {
    if (disposed) throw error("UNAVAILABLE", "MCP dispatcher is unavailable.");
    if (controller.signal.aborted) throw error("CANCELLED", "MCP operation cancelled.", true);
    const server = await store.getForRuntime(request.params.serverId);
    requireStdioRuntimeConfirmation(server, server.confirmedRiskFingerprint);
    if (request.method === "mcp.reconnect" && !server.enabled) throw error("INVALID_ARGUMENT", "Disabled MCP server cannot reconnect.");
    if (!runtime.capability()) {
      return store.record(server.id, {
        status: "unavailable",
        lastCheckedAt: new Date().toISOString(),
        lastError: error("UNAVAILABLE", "Runtime MCP RPC unavailable."),
      });
    }
    if (request.method === "mcp.reconnect") {
      if (!runtime.configure || !runtime.stop || !runtime.start) throw error("UNAVAILABLE", "Runtime MCP lifecycle RPC unavailable.");
      await runtime.configure(server, controller.signal);
      await runtime.stop(server, controller.signal);
      try { await runtime.start(server, controller.signal); }
      catch (runtimeError) {
        try { await runtime.start(server, controller.signal); }
        catch {
          await store.record(server.id, {
            status: "error",
            lastCheckedAt: new Date().toISOString(),
            lastError: error("OPERATION_FAILED", "MCP server reconnect failed.", true),
          }).catch(() => undefined);
        }
        throw runtimeError;
      }
    }
    const result = await runtime.test(server, controller.signal);
    if (result.status === "connected") {
      return store.record(server.id, {
        status: "connected",
        lastCheckedAt: new Date().toISOString(),
        capabilitySummary: result.capabilitySummary,
        toolNames: result.toolNames,
        resourceSchemes: result.resourceSchemes,
        lastError: undefined,
      });
    }
    return store.record(server.id, {
      status: result.error.code === "CANCELLED" ? "disconnected" : "error",
      lastCheckedAt: new Date().toISOString(),
      lastError: result.error,
    });
  };

  const dispatchUnlocked = async (request: McpIpcRequest): Promise<McpIpcResponse> => {
    let result: unknown;
    if (request.method === "mcp.list") result = await store.list();
    if (request.method === "mcp.create") {
      let server = request.params.server as McpServerConfigEntry;
      if (server.transport === "stdio") {
        const assessment = assessMcpStdioPolicy(server);
        if (!assessment.allowed) throw error("FORBIDDEN", "stdio configuration is blocked by policy.");
        if (assessment.confirmationRequired) {
          server = { ...server, enabled: false };
          result = await store.create(server);
          return McpIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result });
        }
      }
      const controller = new AbortController();
      if (runtime.capability() && server.enabled) {
        if (!runtime.configure || !runtime.remove || !runtime.start || !runtime.stop) throw error("UNAVAILABLE", "Runtime MCP lifecycle RPC unavailable.");
        await runtime.configure(server, controller.signal);
        try { await runtime.start(server, controller.signal); }
        catch (runtimeError) {
          await runtime.remove(server, controller.signal).catch(() => undefined);
          throw runtimeError;
        }
      }
      try { result = await store.create(request.params.server); }
      catch (storeError) {
        if (runtime.capability() && server.enabled) {
          await runtime.stop!(server, controller.signal).catch(() => undefined);
          await runtime.remove!(server, controller.signal).catch(() => undefined);
        }
        throw storeError;
      }
    }
    if (request.method === "mcp.update") {
      const previous = await store.getForRuntime(request.params.serverId);
      const draft = resolveUpdate(previous, request.params.server);
      if (draft.transport === "stdio") {
        const assessment = assessMcpStdioPolicy(draft);
        if (!assessment.allowed) throw error("FORBIDDEN", "stdio configuration is blocked by policy.");
        if (assessment.confirmationRequired && previous.confirmedRiskFingerprint !== assessment.fingerprint) {
          const disabled = { ...draft, enabled: false };
          const controller = new AbortController();
          if (runtime.capability()) {
            if (!runtime.stop || !runtime.remove || !runtime.configure || !runtime.start) throw error("UNAVAILABLE", "Runtime MCP lifecycle RPC unavailable.");
            if (previous.enabled) await runtime.stop(previous, controller.signal);
            await runtime.remove(previous, controller.signal);
          }
          try { result = await store.update(request.params.serverId, disabled); }
          catch (storeError) {
            if (runtime.capability()) {
              await runtime.configure!(previous, controller.signal).catch(() => undefined);
              if (previous.enabled) await runtime.start!(previous, controller.signal).catch(() => undefined);
            }
            throw storeError;
          }
          return McpIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result });
        }
      }
      const server = requireStdioRuntimeConfirmation(draft, previous.confirmedRiskFingerprint);
      const controller = new AbortController();
      if (runtime.capability()) {
        if (!runtime.configure || !runtime.start || !runtime.stop) throw error("UNAVAILABLE", "Runtime MCP lifecycle RPC unavailable.");
        await runtime.configure(server, controller.signal);
        try { await (server.enabled ? runtime.start : runtime.stop)(server, controller.signal); }
        catch (runtimeError) {
          await runtime.configure(previous, controller.signal).catch(() => undefined);
          await (previous.enabled ? runtime.start : runtime.stop)(previous, controller.signal).catch(() => undefined);
          throw runtimeError;
        }
      }
      try { result = await store.update(request.params.serverId, draft); }
      catch (storeError) {
        if (runtime.capability()) {
          await runtime.configure!(previous, controller.signal).catch(() => undefined);
          await (previous.enabled ? runtime.start! : runtime.stop!)(previous, controller.signal).catch(() => undefined);
        }
        throw storeError;
      }
    }
    if (request.method === "mcp.remove") {
      const previous = await store.getForRuntime(request.params.serverId);
      const controller = new AbortController();
      if (runtime.capability()) {
        if (!runtime.remove || !runtime.configure || (previous.enabled && !runtime.start)) throw error("UNAVAILABLE", "Runtime MCP lifecycle RPC unavailable.");
        await runtime.remove(previous, controller.signal);
      }
      try { result = await store.remove(request.params.serverId); }
      catch (storeError) {
        if (runtime.capability()) {
          await runtime.configure!(previous, controller.signal).catch(() => undefined);
          if (previous.enabled) await runtime.start!(previous, controller.signal).catch(() => undefined);
        }
        throw storeError;
      }
    }
    if (request.method === "mcp.set-enabled") {
      const previous = await store.getForRuntime(request.params.serverId);
      const server = request.params.enabled ? requireStdioRuntimeConfirmation(previous, previous.confirmedRiskFingerprint) : previous;
      const controller = new AbortController();
      const action = request.params.enabled ? runtime.start : runtime.stop;
      const compensate = request.params.enabled ? runtime.stop : runtime.start;
      if (runtime.capability()) {
        if (!action || !compensate) throw error("UNAVAILABLE", "Runtime MCP lifecycle RPC unavailable.");
        if (request.params.enabled) {
          if (!runtime.configure) throw error("UNAVAILABLE", "Runtime MCP lifecycle RPC unavailable.");
          await runtime.configure(server, controller.signal);
        }
        try { await action(server, controller.signal); }
        catch (runtimeError) {
          if (request.params.enabled) await runtime.stop?.(server, controller.signal).catch(() => undefined);
          throw runtimeError;
        }
      }
      try { result = await store.setEnabled(request.params.serverId, request.params.enabled); }
      catch (storeError) {
        if (runtime.capability()) await compensate!(server, controller.signal).catch(() => undefined);
        throw storeError;
      }
    }
    if (request.method === "mcp.confirm-risk") result = await store.confirmRisk(request.params.serverId, request.params.fingerprint);
    if (request.method === "mcp.cancel") {
      operations.get(request.params.operationRequestId)?.abort(new DOMException("MCP operation cancelled.", "AbortError"));
      result = null;
    }
    return McpIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result });
  };
  const dispatch = (async (request: McpIpcRequest): Promise<McpIpcResponse> => {
    if (request.method === "mcp.test" || request.method === "mcp.reconnect") {
      if (disposed) throw error("UNAVAILABLE", "MCP dispatcher is unavailable.");
      const controller = new AbortController();
      operations.set(request.requestId, controller);
      try {
        return await serializeServer(request.params.serverId, () => operate(request, controller)
          .then((result) => McpIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result })));
      } finally {
        if (operations.get(request.requestId) === controller) operations.delete(request.requestId);
      }
    }
    const serverId = request.method === "mcp.create"
      ? request.params.server.id
      : request.method === "mcp.list" || request.method === "mcp.cancel"
        ? undefined
        : request.params.serverId;
    return serverId === undefined ? dispatchUnlocked(request) : serializeServer(serverId, () => dispatchUnlocked(request));
  }) as McpDispatcher;
  dispatch.dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const controller of operations.values()) controller.abort(new DOMException("MCP dispatcher disposed.", "AbortError"));
    operations.clear();
  };
  return dispatch;
}
