import { z } from "zod";

import { UClawErrorSchema } from "./errors.js";

export const PROVIDER_CONFIG_VERSION = 1 as const;

export const BUILT_IN_PROVIDER_TEMPLATES = Object.freeze([
  { id: "uclaw-cloud", name: "虾盘云", baseUrl: "https://api.u-claw.org/v1", model: "deepseek-v4-flash", protocol: "openai-compatible" },
  { id: "minimax", name: "MiniMax", baseUrl: "https://api.minimax.chat/v1", model: "MiniMax-M2", protocol: "openai-compatible" },
  { id: "kimi", name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2-turbo-preview", protocol: "openai-compatible" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-flash", protocol: "openai-compatible" },
  { id: "zai", name: "智谱 GLM", baseUrl: null, model: "glm-5", protocol: "openclaw-native" },
  { id: "qwen", name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", protocol: "openai-compatible" },
  { id: "doubao", name: "豆包", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seed-1-6-250615", protocol: "openai-compatible" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-5.4", protocol: "openai-compatible" },
  { id: "anthropic", name: "Claude", baseUrl: "https://api.anthropic.com/v1", model: "claude-opus-4-6", protocol: "openai-compatible" },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", protocol: "openai-compatible" },
  { id: "siliconflow", name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-72B-Instruct", protocol: "openai-compatible" },
] as const);

const BuiltInTemplateIdSchema = z.enum(BUILT_IN_PROVIDER_TEMPLATES.map(({ id }) => id) as [
  (typeof BUILT_IN_PROVIDER_TEMPLATES)[number]["id"],
  ...(typeof BUILT_IN_PROVIDER_TEMPLATES)[number]["id"][],
]);
const ProviderIdSchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/u);
const ProviderNameSchema = z.string().trim().min(1).max(80);
const ProviderModelSchema = z.string().trim().min(1).max(160).refine((value) => !/[\u0000-\u001f]/u.test(value), "Invalid model name");
const ApiKeySchema = z.string().min(1).max(8192).refine((value) => value === value.trim() && !value.includes("\0"), "Invalid API key");

export const ProviderBaseUrlSchema = z.string().trim().min(1).max(2048).superRefine((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "Base URL must be an absolute URL" });
    return;
  }
  if (url.username || url.password || url.search || url.hash) {
    context.addIssue({ code: "custom", message: "Base URL must not contain credentials, query, or fragment" });
  }
  if (url.protocol === "https:") return;
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback) {
    context.addIssue({ code: "custom", message: "Base URL must use HTTPS or loopback HTTP" });
  }
});

export const ProviderDraftSchema = z.object({
  id: ProviderIdSchema,
  templateId: BuiltInTemplateIdSchema.optional(),
  name: ProviderNameSchema,
  enabled: z.boolean(),
  baseUrl: ProviderBaseUrlSchema.nullable(),
  model: ProviderModelSchema,
}).strict().superRefine((provider, context) => {
  if (provider.templateId === undefined && provider.baseUrl === null) {
    context.addIssue({ code: "custom", path: ["baseUrl"], message: "Custom providers require a Base URL" });
  }
});
export type ProviderDraft = z.infer<typeof ProviderDraftSchema>;

export const ProviderConfigEntrySchema = z.object({
  id: ProviderIdSchema,
  templateId: BuiltInTemplateIdSchema.optional(),
  name: ProviderNameSchema,
  enabled: z.boolean(),
  baseUrl: ProviderBaseUrlSchema.nullable(),
  model: ProviderModelSchema,
  apiKey: ApiKeySchema.optional(),
}).strict();
export type ProviderConfigEntry = z.infer<typeof ProviderConfigEntrySchema>;

export const ProviderConfigDocumentSchema = z.object({
  schemaVersion: z.literal(PROVIDER_CONFIG_VERSION),
  selectedProviderId: ProviderIdSchema.nullable(),
  providers: z.array(ProviderConfigEntrySchema).max(100),
}).strict().superRefine((document, context) => {
  const ids = new Set<string>();
  for (const provider of document.providers) {
    if (ids.has(provider.id)) context.addIssue({ code: "custom", path: ["providers"], message: "Provider IDs must be unique" });
    ids.add(provider.id);
  }
  if (document.selectedProviderId !== null) {
    const selected = document.providers.find(({ id }) => id === document.selectedProviderId);
    if (!selected?.enabled) context.addIssue({ code: "custom", path: ["selectedProviderId"], message: "Selected provider must exist and be enabled" });
  }
});
export type ProviderConfigDocument = z.infer<typeof ProviderConfigDocumentSchema>;

export const ProviderVerificationSchema = z.object({ state: z.literal("unverified") }).strict();
export type ProviderVerification = z.infer<typeof ProviderVerificationSchema>;

export const ProviderConfigSummarySchema = ProviderConfigEntrySchema.omit({ apiKey: true }).extend({
  apiKeyConfigured: z.boolean(),
  apiKeyHint: z.string().regex(/^\.\.\..{1,4}$/u).optional(),
  verification: ProviderVerificationSchema,
}).strict();
export type ProviderConfigSummary = z.infer<typeof ProviderConfigSummarySchema>;

export const ProviderSnapshotSchema = z.object({
  schemaVersion: z.literal(PROVIDER_CONFIG_VERSION),
  selectedProviderId: ProviderIdSchema.nullable(),
  providers: z.array(ProviderConfigSummarySchema),
}).strict();
export type ProviderSnapshot = z.infer<typeof ProviderSnapshotSchema>;

const EmptyParamsSchema = z.object({}).strict();
const RequestIdSchema = z.string().min(1);
const ProviderIdParamsSchema = z.object({ providerId: ProviderIdSchema }).strict();
const ProviderMethodSchema = z.enum([
  "providers.list", "providers.create", "providers.update", "providers.remove", "providers.set-enabled",
  "providers.move", "providers.select", "providers.set-api-key", "providers.clear-api-key", "providers.verify",
]);

export const ProviderIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("providers.list"), requestId: RequestIdSchema, params: EmptyParamsSchema }).strict(),
  z.object({ method: z.literal("providers.create"), requestId: RequestIdSchema, params: z.object({ provider: ProviderDraftSchema }).strict() }).strict(),
  z.object({ method: z.literal("providers.update"), requestId: RequestIdSchema, params: z.object({ providerId: ProviderIdSchema, provider: ProviderDraftSchema }).strict() }).strict(),
  z.object({ method: z.literal("providers.remove"), requestId: RequestIdSchema, params: ProviderIdParamsSchema }).strict(),
  z.object({ method: z.literal("providers.set-enabled"), requestId: RequestIdSchema, params: z.object({ providerId: ProviderIdSchema, enabled: z.boolean() }).strict() }).strict(),
  z.object({ method: z.literal("providers.move"), requestId: RequestIdSchema, params: z.object({ providerId: ProviderIdSchema, direction: z.enum(["up", "down"]) }).strict() }).strict(),
  z.object({ method: z.literal("providers.select"), requestId: RequestIdSchema, params: ProviderIdParamsSchema }).strict(),
  z.object({ method: z.literal("providers.set-api-key"), requestId: RequestIdSchema, params: z.object({ providerId: ProviderIdSchema, apiKey: ApiKeySchema }).strict() }).strict(),
  z.object({ method: z.literal("providers.clear-api-key"), requestId: RequestIdSchema, params: ProviderIdParamsSchema }).strict(),
  z.object({ method: z.literal("providers.verify"), requestId: RequestIdSchema, params: ProviderIdParamsSchema }).strict(),
]);
export type ProviderIpcRequest = z.infer<typeof ProviderIpcRequestSchema>;

const ProviderSnapshotMethodSchema = z.enum([
  "providers.list", "providers.create", "providers.update", "providers.remove", "providers.set-enabled",
  "providers.move", "providers.select", "providers.set-api-key", "providers.clear-api-key",
]);
const ProviderIpcSuccessResponseSchema = z.union([
  z.object({ method: ProviderSnapshotMethodSchema, requestId: RequestIdSchema, ok: z.literal(true), result: ProviderSnapshotSchema }).strict(),
  z.object({ method: z.literal("providers.verify"), requestId: RequestIdSchema, ok: z.literal(true), result: ProviderVerificationSchema }).strict(),
]);
const ProviderIpcFailureResponseSchema = z.object({
  method: ProviderMethodSchema,
  requestId: RequestIdSchema,
  ok: z.literal(false),
  error: UClawErrorSchema,
}).strict();

export const ProviderIpcResponseSchema = z.union([ProviderIpcSuccessResponseSchema, ProviderIpcFailureResponseSchema]);
export type ProviderIpcResponse = z.infer<typeof ProviderIpcResponseSchema>;
