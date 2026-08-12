import { z } from "zod";

import { RendererSafeTextSchema, UClawErrorSchema } from "./errors.js";

export const MCP_CONFIG_VERSION = 1 as const;

const IdSchema = z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/);
const NameSchema = z.string().trim().min(1).max(120);
const RequestIdSchema = z.string().min(1);
const ServerIdParamsSchema = z.object({ serverId: IdSchema }).strict();
const SafeArgumentSchema = z.string().max(1_024).refine((value) => !value.includes("\0"));
const SafeEnvironmentSchema = z.record(
  z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  z.string().max(2_048).refine((value) => !value.includes("\0")),
).refine((value) => Object.keys(value).length <= 32);

const SafeMcpUrlSchema = z.string().url().max(2_048).refine((value) => {
  let url: URL;
  try { url = new URL(value); }
  catch { return false; }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) return false;
  const octets = url.hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  const privateAddress = a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  return !privateAddress || loopback;
}, "Unsafe MCP URL.");

export const McpTransportSchema = z.enum(["stdio", "http", "streamable-http"]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

const StdioServerDraftSchema = z.object({
  id: IdSchema,
  name: NameSchema,
  enabled: z.boolean(),
  transport: z.literal("stdio"),
  executableId: z.enum(["node", "npx", "python", "uvx"]),
  args: z.array(SafeArgumentSchema).max(64),
  env: SafeEnvironmentSchema.default({}),
}).strict();

const HttpAuthenticationDraftSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("bearer"), secret: z.string().min(1).max(8_192).optional() }).strict(),
  z.object({
    type: z.literal("header"),
    headerName: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/),
    secret: z.string().min(1).max(8_192).optional(),
  }).strict(),
]);

const HttpServerDraftSchema = z.object({
  id: IdSchema,
  name: NameSchema,
  enabled: z.boolean(),
  transport: z.enum(["http", "streamable-http"]),
  url: SafeMcpUrlSchema,
  authentication: HttpAuthenticationDraftSchema.default({ type: "none" }),
}).strict();

export const McpServerDraftSchema = z.discriminatedUnion("transport", [
  StdioServerDraftSchema,
  HttpServerDraftSchema,
]);
export type McpServerDraft = z.infer<typeof McpServerDraftSchema>;

const StdioServerUpdatePatchSchema = StdioServerDraftSchema.omit({ args: true, env: true }).extend({
  args: z.array(SafeArgumentSchema).max(64).optional(),
  env: SafeEnvironmentSchema.optional(),
}).strict();

const HttpServerUpdatePatchSchema = HttpServerDraftSchema.omit({ url: true }).extend({
  url: SafeMcpUrlSchema.optional(),
}).strict();

export const McpServerUpdatePatchSchema = z.discriminatedUnion("transport", [
  StdioServerUpdatePatchSchema,
  HttpServerUpdatePatchSchema,
]);
export type McpServerUpdatePatch = z.infer<typeof McpServerUpdatePatchSchema>;

export const McpServerStatusSchema = z.enum([
  "disabled", "disconnected", "connecting", "connected", "error", "unavailable",
]);

export const McpCapabilitySummarySchema = z.object({
  tools: z.number().int().nonnegative(),
  resources: z.number().int().nonnegative(),
  prompts: z.number().int().nonnegative(),
}).strict();

const StoredStateSchema = z.object({
  status: McpServerStatusSchema.optional(),
  capabilitySummary: McpCapabilitySummarySchema.optional(),
  toolNames: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  resourceSchemes: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  lastCheckedAt: z.string().datetime().optional(),
  lastError: UClawErrorSchema.optional(),
  confirmedRiskFingerprint: z.string().min(1).max(160).optional(),
});

export const McpServerConfigEntrySchema = z.discriminatedUnion("transport", [
  StdioServerDraftSchema.extend(StoredStateSchema.shape).strict(),
  HttpServerDraftSchema.extend(StoredStateSchema.shape).strict(),
]);
export type McpServerConfigEntry = z.infer<typeof McpServerConfigEntrySchema>;

export const McpConfigDocumentSchema = z.object({
  schemaVersion: z.literal(MCP_CONFIG_VERSION),
  servers: z.array(McpServerConfigEntrySchema).max(100),
}).strict().superRefine((document, context) => {
  const ids = new Set<string>();
  for (const [index, server] of document.servers.entries()) {
    if (ids.has(server.id)) context.addIssue({ code: "custom", path: ["servers", index, "id"], message: "Duplicate MCP server ID." });
    ids.add(server.id);
  }
});
export type McpConfigDocument = z.infer<typeof McpConfigDocumentSchema>;

const McpAuthenticationSummarySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none"), configured: z.literal(false) }).strict(),
  z.object({ type: z.literal("bearer"), configured: z.boolean(), hint: z.string().max(16).optional() }).strict(),
  z.object({ type: z.literal("header"), headerName: z.string(), configured: z.boolean(), hint: z.string().max(16).optional() }).strict(),
]);

const McpServerSummaryBaseSchema = z.object({
  id: IdSchema,
  name: NameSchema,
  enabled: z.boolean(),
  status: McpServerStatusSchema,
  capabilitySummary: McpCapabilitySummarySchema,
  toolNames: z.array(z.string().trim().min(1).max(120)).max(100),
  resourceSchemes: z.array(z.string().trim().min(1).max(120)).max(100),
  lastCheckedAt: z.string().datetime().optional(),
  lastError: UClawErrorSchema.optional(),
});

export const ManagedMcpServerSummarySchema = z.discriminatedUnion("transport", [
  McpServerSummaryBaseSchema.extend({
    transport: z.literal("stdio"),
    executableId: z.enum(["node", "npx", "python", "uvx"]),
    risk: z.enum(["none", "confirmation-required", "confirmed"]),
    riskFingerprint: z.string().min(1).max(160).optional(),
  }).strict(),
  McpServerSummaryBaseSchema.extend({
    transport: z.enum(["http", "streamable-http"]),
    endpointHint: z.string().trim().min(1).max(253),
    authentication: McpAuthenticationSummarySchema,
  }).strict(),
]);
export type ManagedMcpServerSummary = z.infer<typeof ManagedMcpServerSummarySchema>;

export const McpSnapshotSchema = z.object({
  schemaVersion: z.literal(MCP_CONFIG_VERSION),
  storage: z.discriminatedUnion("state", [
    z.object({ state: z.literal("healthy") }).strict(),
    z.object({ state: z.literal("degraded"), message: z.string().min(1).max(240) }).strict(),
  ]).default({ state: "healthy" }),
  runtime: z.discriminatedUnion("state", [
    z.object({ state: z.literal("available") }).strict(),
    z.object({ state: z.literal("unavailable"), reason: z.literal("locked-runtime-no-mcp-rpc") }).strict(),
  ]),
  servers: z.array(ManagedMcpServerSummarySchema),
}).strict();
export type McpSnapshot = z.infer<typeof McpSnapshotSchema>;

const CapabilityIdSchema = z.string().trim().min(1).max(160);
const CapabilityTextSchema = z.string().trim().min(1).max(500);
const CapabilityRiskSchema = z.enum(["low", "medium", "high"]);
const CapabilitySourceSchema = z.enum(["core", "plugin", "channel", "mcp"]);
const ToolCatalogEntrySchema = z.object({
  id: CapabilityIdSchema,
  label: RendererSafeTextSchema.pipe(CapabilityTextSchema),
  description: RendererSafeTextSchema.pipe(z.string().max(1_000)),
  source: z.enum(["core", "plugin"]),
  pluginId: CapabilityIdSchema.optional(),
  optional: z.boolean().optional(),
  risk: CapabilityRiskSchema.optional(),
  tags: z.array(RendererSafeTextSchema.pipe(CapabilityIdSchema)).max(32).optional(),
  defaultProfiles: z.array(z.enum(["minimal", "coding", "messaging", "full"])).max(4),
}).strict();
const EffectiveToolEntrySchema = z.object({
  id: CapabilityIdSchema,
  label: RendererSafeTextSchema.pipe(CapabilityTextSchema),
  description: RendererSafeTextSchema.pipe(z.string().max(1_000)),
  source: CapabilitySourceSchema,
  pluginId: CapabilityIdSchema.optional(),
  channelId: CapabilityIdSchema.optional(),
  risk: CapabilityRiskSchema.optional(),
  tags: z.array(RendererSafeTextSchema.pipe(CapabilityIdSchema)).max(32).optional(),
}).strict();
export const CapabilityToolsSnapshotSchema = z.object({
  agentId: CapabilityIdSchema,
  sessionKey: z.string().trim().min(1).max(500),
  catalog: z.object({
    groups: z.array(z.object({
      id: CapabilityIdSchema,
      label: RendererSafeTextSchema.pipe(CapabilityTextSchema),
      source: z.enum(["core", "plugin"]),
      pluginId: CapabilityIdSchema.optional(),
      tools: z.array(ToolCatalogEntrySchema).max(500),
    }).strict()).max(100),
  }).strict(),
  commands: z.array(z.object({
    name: CapabilityIdSchema,
    nativeName: CapabilityIdSchema.optional(),
    textAliases: z.array(CapabilityIdSchema).max(32).optional(),
    description: RendererSafeTextSchema.pipe(z.string().max(1_000)),
    category: z.enum(["session", "options", "status", "management", "media", "tools", "docks"]).optional(),
    source: z.enum(["native", "skill", "plugin"]),
    scope: z.enum(["text", "native", "both"]),
    acceptsArgs: z.boolean(),
  }).strict()).max(500),
  effective: z.object({
    profile: z.string().trim().min(1).max(120),
    groups: z.array(z.object({
      id: CapabilitySourceSchema,
      label: RendererSafeTextSchema.pipe(CapabilityTextSchema),
      source: CapabilitySourceSchema,
      tools: z.array(EffectiveToolEntrySchema).max(500),
    }).strict()).max(100),
    notices: z.array(z.object({
      id: CapabilityIdSchema,
      severity: z.enum(["info", "warning"]),
      message: RendererSafeTextSchema.pipe(z.string().min(1).max(1_000)),
    }).strict()).max(100),
  }).strict(),
}).strict();
export type CapabilityToolsSnapshot = z.infer<typeof CapabilityToolsSnapshotSchema>;

export const ExecApprovalPolicySchema = z.object({
  security: z.enum(["deny", "allowlist", "full"]),
  ask: z.enum(["off", "on-miss", "always"]),
  askFallback: z.enum(["deny", "allowlist", "full"]),
  autoAllowSkills: z.boolean(),
}).strict();
export type ExecApprovalPolicy = z.infer<typeof ExecApprovalPolicySchema>;
export const ExecApprovalPolicySnapshotSchema = z.object({
  exists: z.boolean(),
  hash: z.string().min(1).max(256),
  policy: ExecApprovalPolicySchema,
}).strict();
export type ExecApprovalPolicySnapshot = z.infer<typeof ExecApprovalPolicySnapshotSchema>;

export const McpIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("mcp.list"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("mcp.create"), requestId: RequestIdSchema, params: z.object({ server: McpServerDraftSchema }).strict() }).strict(),
  z.object({ method: z.literal("mcp.update"), requestId: RequestIdSchema, params: z.object({ serverId: IdSchema, server: McpServerUpdatePatchSchema }).strict() }).strict(),
  z.object({ method: z.literal("mcp.remove"), requestId: RequestIdSchema, params: ServerIdParamsSchema.extend({ confirmed: z.literal(true) }).strict() }).strict(),
  z.object({ method: z.literal("mcp.set-enabled"), requestId: RequestIdSchema, params: ServerIdParamsSchema.extend({ enabled: z.boolean() }).strict() }).strict(),
  z.object({ method: z.literal("mcp.test"), requestId: RequestIdSchema, params: ServerIdParamsSchema }).strict(),
  z.object({ method: z.literal("mcp.reconnect"), requestId: RequestIdSchema, params: ServerIdParamsSchema }).strict(),
  z.object({ method: z.literal("mcp.confirm-risk"), requestId: RequestIdSchema, params: ServerIdParamsSchema.extend({ fingerprint: z.string().min(1).max(160), confirmed: z.literal(true) }).strict() }).strict(),
  z.object({ method: z.literal("mcp.cancel"), requestId: RequestIdSchema, params: z.object({ operationRequestId: RequestIdSchema }).strict() }).strict(),
  z.object({ method: z.literal("capabilities.tools"), requestId: RequestIdSchema, params: z.object({
    agentId: CapabilityIdSchema,
    sessionKey: z.string().trim().min(1).max(500),
  }).strict() }).strict(),
  z.object({ method: z.literal("capabilities.approvals-get"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("capabilities.approvals-set"), requestId: RequestIdSchema, params: z.object({
    baseHash: z.string().min(1).max(256),
    policy: ExecApprovalPolicySchema,
  }).strict() }).strict(),
]);
export type McpIpcRequest = z.infer<typeof McpIpcRequestSchema>;

const McpSuccessResponseSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("mcp.list"), requestId: RequestIdSchema, ok: z.literal(true), result: McpSnapshotSchema }).strict(),
  z.object({ method: z.literal("mcp.create"), requestId: RequestIdSchema, ok: z.literal(true), result: McpSnapshotSchema }).strict(),
  z.object({ method: z.literal("mcp.update"), requestId: RequestIdSchema, ok: z.literal(true), result: McpSnapshotSchema }).strict(),
  z.object({ method: z.literal("mcp.remove"), requestId: RequestIdSchema, ok: z.literal(true), result: McpSnapshotSchema }).strict(),
  z.object({ method: z.literal("mcp.set-enabled"), requestId: RequestIdSchema, ok: z.literal(true), result: McpSnapshotSchema }).strict(),
  z.object({ method: z.literal("mcp.confirm-risk"), requestId: RequestIdSchema, ok: z.literal(true), result: McpSnapshotSchema }).strict(),
  z.object({ method: z.literal("mcp.test"), requestId: RequestIdSchema, ok: z.literal(true), result: ManagedMcpServerSummarySchema }).strict(),
  z.object({ method: z.literal("mcp.reconnect"), requestId: RequestIdSchema, ok: z.literal(true), result: ManagedMcpServerSummarySchema }).strict(),
  z.object({ method: z.literal("mcp.cancel"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  z.object({ method: z.literal("capabilities.tools"), requestId: RequestIdSchema, ok: z.literal(true), result: CapabilityToolsSnapshotSchema }).strict(),
  z.object({ method: z.literal("capabilities.approvals-get"), requestId: RequestIdSchema, ok: z.literal(true), result: ExecApprovalPolicySnapshotSchema }).strict(),
  z.object({ method: z.literal("capabilities.approvals-set"), requestId: RequestIdSchema, ok: z.literal(true), result: ExecApprovalPolicySnapshotSchema }).strict(),
]);

const McpFailureResponseSchema = z.object({
  method: z.enum(["mcp.list", "mcp.create", "mcp.update", "mcp.remove", "mcp.set-enabled", "mcp.test", "mcp.reconnect", "mcp.confirm-risk", "mcp.cancel", "capabilities.tools", "capabilities.approvals-get", "capabilities.approvals-set"]),
  requestId: RequestIdSchema,
  ok: z.literal(false),
  error: UClawErrorSchema,
}).strict();

export const McpIpcResponseSchema = z.union([McpSuccessResponseSchema, McpFailureResponseSchema]);
export type McpIpcResponse = z.infer<typeof McpIpcResponseSchema>;
