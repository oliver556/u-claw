import { z } from "zod";

import {
  CapabilityToolsSnapshotSchema,
  ExecApprovalPolicySchema,
  ExecApprovalPolicySnapshotSchema,
  PluginSessionActionResultSchema,
  PluginUiDescriptorSchema,
  UClawErrorSchema,
  type CapabilityToolsSnapshot,
  type ExecApprovalPolicy,
  type ExecApprovalPolicySnapshot,
  type PluginSessionActionResult,
  type PluginUiDescriptor,
} from "@uclaw/shared";

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export interface OpenClawCapabilityRuntime {
  tools(input: { agentId: string; sessionKey: string }): Promise<CapabilityToolsSnapshot>;
  approvalsGet(): Promise<ExecApprovalPolicySnapshot>;
  approvalsSet(input: { baseHash: string; policy: ExecApprovalPolicy }): Promise<ExecApprovalPolicySnapshot>;
  pluginDescriptors(): Promise<PluginUiDescriptor[]>;
  pluginSessionAction(input: { pluginId: string; actionId: string; sessionKey?: string; payload?: unknown }): Promise<PluginSessionActionResult>;
}

const CatalogSchema = z.object({
  agentId: z.string().min(1),
  profiles: z.array(z.unknown()).optional(),
  groups: z.array(z.object({
    id: z.string(), label: z.string(), source: z.enum(["core", "plugin"]), pluginId: z.string().optional(),
    tools: z.array(z.object({
      id: z.string(), label: z.string(), description: z.string(), source: z.enum(["core", "plugin"]),
      pluginId: z.string().optional(), optional: z.boolean().optional(), risk: z.enum(["low", "medium", "high"]).optional(),
      tags: z.array(z.string()).optional(), defaultProfiles: z.array(z.enum(["minimal", "coding", "messaging", "full"])),
    }).passthrough()),
  }).passthrough()),
}).passthrough();
const EffectiveSchema = z.object({
  agentId: z.string().min(1), profile: z.string().min(1),
  groups: z.array(z.object({
    id: z.enum(["core", "plugin", "channel", "mcp"]), label: z.string(), source: z.enum(["core", "plugin", "channel", "mcp"]),
    tools: z.array(z.object({
      id: z.string(), label: z.string(), description: z.string(), rawDescription: z.string().optional(),
      source: z.enum(["core", "plugin", "channel", "mcp"]), pluginId: z.string().optional(), channelId: z.string().optional(),
      risk: z.enum(["low", "medium", "high"]).optional(), tags: z.array(z.string()).optional(),
    }).passthrough()),
  }).passthrough()),
  notices: z.array(z.object({ id: z.string(), severity: z.enum(["info", "warning"]), message: z.string() }).passthrough()).optional(),
}).passthrough();
const CommandsSchema = z.object({ commands: z.array(z.object({
  name: z.string(), nativeName: z.string().optional(), textAliases: z.array(z.string()).optional(), description: z.string(),
  category: z.enum(["session", "options", "status", "management", "media", "tools", "docks"]).optional(),
  source: z.enum(["native", "skill", "plugin"]), scope: z.enum(["text", "native", "both"]), acceptsArgs: z.boolean(),
}).passthrough()) }).passthrough();
const DescriptorResponseSchema = z.object({ ok: z.literal(true), descriptors: z.array(PluginUiDescriptorSchema) }).passthrough();
const ApprovalResponseSchema = z.object({
  path: z.string(), exists: z.boolean(), hash: z.string().min(1),
  file: z.object({ version: z.literal(1), defaults: ExecApprovalPolicySchema.optional() }).passthrough(),
}).passthrough();
const ActionResponseSchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown().optional(), continueAgent: z.boolean().optional(), reply: z.unknown().optional() }).passthrough(),
  z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional(), details: z.unknown().optional() }).passthrough(),
]);
const DEFAULT_POLICY: ExecApprovalPolicy = { security: "deny", ask: "always", askFallback: "deny", autoAllowSkills: false };

function unavailable(method: string): never {
  throw UClawErrorSchema.parse({
    code: "UNSUPPORTED", message: `OpenClaw capability unavailable: ${method}.`, retryable: false,
    recoveryActions: [], causeDetails: { capability: method },
  });
}

function approvalConflict(): never {
  throw UClawErrorSchema.parse({
    code: "CONFLICT", message: "OpenClaw approval policy changed; reload and retry.", retryable: true,
    recoveryActions: ["retry"], causeDetails: {},
  });
}

export function createOpenClawCapabilityRuntime(input: {
  methods(): Promise<ReadonlySet<string>>;
  request: Request;
}): OpenClawCapabilityRuntime {
  const call = async <T>(method: string, params: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> => {
    if (!(await input.methods()).has(method)) unavailable(method);
    return schema.parse(await input.request(method, params));
  };
  const projectApproval = (value: z.infer<typeof ApprovalResponseSchema>): ExecApprovalPolicySnapshot =>
    ExecApprovalPolicySnapshotSchema.parse({ exists: value.exists, hash: value.hash, policy: value.file.defaults ?? DEFAULT_POLICY });

  return {
    tools: async ({ agentId, sessionKey }) => {
      const methods = await input.methods();
      const [catalog, commands, effective] = await Promise.all([
        call("tools.catalog", { agentId, includePlugins: true }, CatalogSchema),
        methods.has("commands.list")
          ? call("commands.list", { agentId, scope: "both", includeArgs: false }, CommandsSchema)
          : Promise.resolve({ commands: [] }),
        call("tools.effective", { agentId, sessionKey }, EffectiveSchema),
      ]);
      return CapabilityToolsSnapshotSchema.parse({
        agentId: effective.agentId,
        sessionKey,
        catalog: { groups: catalog.groups.map(({ tools, ...group }) => ({ ...group, tools: tools.map(({ rawDescription: _raw, ...tool }) => tool) })) },
        commands: commands.commands,
        effective: {
          profile: effective.profile,
          groups: effective.groups.map(({ tools, ...group }) => ({ ...group, tools: tools.map(({ rawDescription: _raw, ...tool }) => tool) })),
          notices: effective.notices ?? [],
        },
      });
    },
    approvalsGet: async () => projectApproval(await call("exec.approvals.get", {}, ApprovalResponseSchema)),
    approvalsSet: async ({ baseHash, policy }) => {
      const current = await call("exec.approvals.get", {}, ApprovalResponseSchema);
      if (current.hash !== baseHash) approvalConflict();
      return projectApproval(await call(
        "exec.approvals.set",
        { file: { ...current.file, defaults: ExecApprovalPolicySchema.parse(policy) }, baseHash },
        ApprovalResponseSchema,
      ));
    },
    pluginDescriptors: async () => (await call("plugins.uiDescriptors", {}, DescriptorResponseSchema)).descriptors,
    pluginSessionAction: async (action) => PluginSessionActionResultSchema.parse(await call("plugins.sessionAction", action, ActionResponseSchema)),
  };
}
