import { z } from "zod";
import { UClawErrorSchema } from "@uclaw/shared";
import { SystemNodeIpcEventSchema, type SystemNodeIpcEvent, type SystemNodeService } from "@uclaw/shared/dist/system-node.js";

interface SystemNodeRouter {
  request(method: string, params: unknown, schema: z.ZodType, signal?: AbortSignal): Promise<unknown>;
  onEvent(event: string, listener: (frame: { payload: unknown }) => void): () => void;
}
export interface OpenClawSystemNodeOptions extends Partial<SystemNodeRouter> {
  router?: SystemNodeRouter;
  requireMethod(method: string): void;
}

const AnyResponse = z.unknown();
const RESULT_FIELDS: Record<string, ReadonlySet<string>> = {
  "device.pair.list": new Set(["pending", "paired", "requestId", "deviceId", "displayName", "role", "roles", "scopes", "createdAtMs", "approvedAtMs"]),
  "device.pair.approve": new Set(["requestId", "deviceId", "displayName", "role", "roles", "scopes", "approvedAtMs"]),
  "device.pair.reject": new Set(["requestId", "deviceId", "rejected", "status"]),
  "device.pair.remove": new Set(["deviceId", "removed", "status"]),
  "device.token.rotate": new Set(["deviceId", "role", "scopes", "rotatedAtMs"]),
  "device.token.revoke": new Set(["deviceId", "role", "revoked", "status"]),
  "node.list": new Set(["nodes", "nodeId", "displayName", "connected", "platform", "version", "deviceFamily", "caps", "commands", "connectedAtMs", "lastConnectedAtMs"]),
  "node.describe": new Set(["nodeId", "displayName", "connected", "platform", "version", "deviceFamily", "caps", "commands", "connectedAtMs", "lastConnectedAtMs"]),
  "node.rename": new Set(["nodeId", "displayName", "renamed", "status"]),
  "node.pair.list": new Set(["pending", "paired", "requestId", "nodeId", "displayName", "platform", "status", "createdAtMs", "approvedAtMs"]),
  "node.pair.approve": new Set(["requestId", "nodeId", "displayName", "platform", "status", "approvedAtMs"]),
  "node.pair.reject": new Set(["requestId", "nodeId", "rejected", "status"]),
  "node.pair.remove": new Set(["nodeId", "removed", "status"]),
  "node.invoke": new Set(["ok", "nodeId", "command"]),
  "environments.list": new Set(["environments", "id", "type", "label", "status", "nodeId", "platform", "version"]),
  "environments.status": new Set(["id", "type", "label", "status", "nodeId", "platform", "version", "nodeVersion"]),
  "worktrees.list": new Set(["worktrees", "id", "name", "path", "branch", "repoRoot", "baseRef", "status", "dirty", "createdAt", "lastActiveAt", "removedAt", "snapshotRef"]),
  "worktrees.create": new Set(["id", "name", "path", "branch", "repoRoot", "baseRef", "status", "dirty", "createdAt", "lastActiveAt"]),
  "worktrees.remove": new Set(["id", "removed", "status", "removedAt", "snapshotRef"]),
  "worktrees.restore": new Set(["id", "name", "path", "branch", "repoRoot", "baseRef", "status", "dirty", "createdAt", "lastActiveAt"]),
  "worktrees.gc": new Set(["removed", "pruned", "status"]),
  "terminal.list": new Set(["sessions", "sessionId", "agentId", "cwd", "shell", "cols", "rows", "attached", "createdAtMs", "updatedAtMs"]),
  "terminal.open": new Set(["sessionId", "agentId", "cwd", "shell", "cols", "rows", "attached", "createdAtMs", "updatedAtMs"]),
  "terminal.input": new Set(["ok", "sessionId"]),
  "terminal.resize": new Set(["ok", "sessionId", "cols", "rows"]),
  "terminal.close": new Set(["ok", "sessionId", "closed"]),
  "terminal.attach": new Set(["sessionId", "buffer", "agentId", "cwd", "shell", "cols", "rows", "attached"]),
  "terminal.text": new Set(["sessionId", "text"]),
};
function rendererSafeResult(method: string, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => rendererSafeResult(method, entry));
  if (!value || typeof value !== "object") return value;
  const fields = RESULT_FIELDS[method];
  if (!fields) throw new Error(`Missing renderer result projection for ${method}.`);
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => fields.has(key) ? [[key, rendererSafeResult(method, entry)]] : []));
}
function invalid(message: string) {
  return UClawErrorSchema.parse({ code: "INVALID_ARGUMENT", message, retryable: false, recoveryActions: [], causeDetails: {} });
}

export function createOpenClawSystemNodeService(options: OpenClawSystemNodeOptions): SystemNodeService {
  const request = options.request ?? options.router?.request.bind(options.router);
  const onEvent = options.onEvent ?? options.router?.onEvent.bind(options.router);
  if (!request || !onEvent) throw new Error("System node Gateway router is required.");
  const call = async (method: string, params: unknown) => { options.requireMethod(method); return rendererSafeResult(method, await request(method, params, AnyResponse)); };
  const mutateReadback = async (method: string, params: unknown, readMethod: string, readParams: unknown) => {
    const mutation = await call(method, params);
    const authority = await call(readMethod, readParams);
    return { mutation, authority };
  };
  return {
    listDevices: () => call("device.pair.list", {}),
    approveDevice: (input) => mutateReadback("device.pair.approve", input, "device.pair.list", {}),
    rejectDevice: (input) => mutateReadback("device.pair.reject", input, "device.pair.list", {}),
    removeDevice: (input) => mutateReadback("device.pair.remove", input, "device.pair.list", {}),
    rotateDeviceToken: (input) => mutateReadback("device.token.rotate", input, "device.pair.list", {}),
    revokeDeviceToken: (input) => mutateReadback("device.token.revoke", input, "device.pair.list", {}),
    listNodes: () => call("node.list", {}),
    describeNode: (input) => call("node.describe", input),
    renameNode: (input) => mutateReadback("node.rename", input, "node.describe", { nodeId: input.nodeId }),
    listNodePairs: () => call("node.pair.list", {}),
    approveNodePair: (input) => mutateReadback("node.pair.approve", input, "node.pair.list", {}),
    rejectNodePair: (input) => mutateReadback("node.pair.reject", input, "node.pair.list", {}),
    removeNodePair: (input) => mutateReadback("node.pair.remove", input, "node.pair.list", {}),
    invokeNode: (input) => {
      if (input.command !== "system.info") return Promise.reject(invalid("Node command is not allowed."));
      if (input.params && ("approved" in input.params || "approvalDecision" in input.params || "rawCommand" in input.params)) return Promise.reject(invalid("Node approval controls are not accepted from the renderer."));
      return call("node.invoke", input);
    },
    listEnvironments: () => call("environments.list", {}),
    getEnvironmentStatus: (input) => call("environments.status", input),
    listWorktrees: () => call("worktrees.list", {}),
    createWorktree: (input) => mutateReadback("worktrees.create", input, "worktrees.list", {}),
    removeWorktree: (input) => mutateReadback("worktrees.remove", input, "worktrees.list", {}),
    restoreWorktree: (input) => mutateReadback("worktrees.restore", input, "worktrees.list", {}),
    gcWorktrees: () => mutateReadback("worktrees.gc", {}, "worktrees.list", {}),
    listTerminals: () => call("terminal.list", {}),
    openTerminal: (input) => mutateReadback("terminal.open", input, "terminal.list", {}),
    inputTerminal: (input) => call("terminal.input", input),
    resizeTerminal: (input) => call("terminal.resize", input),
    closeTerminal: (input) => mutateReadback("terminal.close", input, "terminal.list", {}),
    attachTerminal: (input) => call("terminal.attach", input),
    getTerminalText: (input) => call("terminal.text", input),
    subscribe: (listener) => {
      const removers = ["device.pair.requested", "device.pair.resolved", "node.pair.requested", "node.pair.resolved", "terminal.data", "terminal.exit"].map((event) => onEvent(event, (frame) => {
        const parsed = SystemNodeIpcEventSchema.safeParse({ event, payload: frame.payload });
        if (parsed.success) listener(parsed.data as SystemNodeIpcEvent);
      }));
      return () => removers.reverse().forEach((remove) => remove());
    },
  };
}
