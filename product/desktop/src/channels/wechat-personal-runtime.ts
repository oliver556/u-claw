import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { z } from "zod";
import { LOCKED_OPENCLAW_VERSION } from "@uclaw/shared";

import type { WechatPersonalRuntime } from "./wechat-login-coordinator.js";

const PLUGIN_ID = "openclaw-weixin";
const PLUGIN_VERSION = "2.4.6";
const PLUGIN_PACKAGE = "@tencent-weixin/openclaw-weixin";
const semver = createRequire(import.meta.url)("semver") as { validRange(value: string): string | null; satisfies(version: string, range: string, options: { includePrerelease: boolean }): boolean };
const API_BASE_URL = "https://ilinkai.weixin.qq.com";
const FLOW_TTL_MS = 5 * 60_000;

const PluginManifestSchema = z.object({
  id: z.literal(PLUGIN_ID),
}).passthrough();
const PluginPackageSchema = z.object({
  name: z.literal(PLUGIN_PACKAGE),
  version: z.string(),
}).passthrough();
const PluginBuildManifestSchema = z.object({
  schemaVersion: z.literal(1),
  plugins: z.array(z.object({
    id: z.literal(PLUGIN_ID),
    package: z.literal(PLUGIN_PACKAGE),
    version: z.literal(PLUGIN_VERSION),
    npmIntegrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+=*$/u),
    openclawVersionRange: z.string().refine((range) => semver.validRange(range) !== null),
    files: z.array(z.object({
      path: z.string().min(1).refine((value) => !value.startsWith("/") && !value.includes("..") && !value.includes("\\")),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })).min(3),
  })).min(1),
});
const QrResponseSchema = z.object({
  qrcode: z.string().min(1).max(4_096),
  qrcode_img_content: z.string().min(1).max(4_096),
}).passthrough();
const PollResponseSchema = z.object({
  status: z.string().min(1).max(80),
  redirect_host: z.string().min(1).max(255).optional(),
  ilink_bot_id: z.string().min(1).max(256).optional(),
  ilink_user_id: z.string().min(1).max(256).optional(),
  bot_token: z.string().min(1).max(8_192).optional(),
  baseurl: z.string().url().max(2_048).optional(),
}).passthrough();
const GatewayStatusSchema = z.object({
  channelOrder: z.array(z.string()),
  channels: z.record(z.string(), z.object({ configured: z.boolean().optional() }).passthrough()),
  channelAccounts: z.record(z.string(), z.array(z.object({
    accountId: z.string().min(1),
    enabled: z.boolean().optional(),
    configured: z.boolean().optional(),
    running: z.boolean().optional(),
    connected: z.boolean().optional(),
    lastError: z.string().optional(),
  }).passthrough())),
  channelDefaultAccountId: z.record(z.string(), z.string()).optional(),
}).passthrough();
const ConfigGetSchema = z.object({ hash: z.string().min(1), valid: z.boolean() }).passthrough();
const AccountIndexSchema = z.array(z.string().min(1).max(128));

type GatewayRequest = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
type ActiveFlow = {
  id: string;
  qrcode: string;
  qrImage: { kind: "data-url"; value: string };
  expiresAt: number;
  pollBaseUrl: string;
};

export interface WechatPersonalRuntimeOptions {
  dataDir: string;
  pluginDir: string;
  startupCapabilityFailure?: { pluginStatus: "installed" | "missing"; reason: string };
  requestGateway: GatewayRequest;
  renderQr(value: string): Promise<string>;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  createFlowId?: () => string;
}

function normalizedAccountId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]/gu, "-").slice(0, 128);
  if (normalized.length === 0) throw new Error("WeChat account identifier is invalid");
  return normalized;
}

function accountHint(accountId: string): string {
  return `...${accountId.slice(-4)}`;
}

function safeRedirectBase(host: string): string {
  const normalized = host.toLowerCase();
  if (!/^[a-z0-9.-]+$/u.test(normalized) || (!normalized.endsWith(".weixin.qq.com") && normalized !== "weixin.qq.com")) {
    throw new Error("WeChat redirect host is invalid");
  }
  return `https://${normalized}`;
}

async function atomicWrite(path: string, content: string, mode = 0o600): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function createWechatPersonalRuntime(options: WechatPersonalRuntimeOptions): WechatPersonalRuntime {
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const createFlowId = options.createFlowId ?? randomUUID;
  const stateDir = join(options.dataDir, PLUGIN_ID);
  const accountsDir = join(stateDir, "accounts");
  const accountsPath = join(stateDir, "accounts.json");
  const flows = new Map<string, ActiveFlow>();

  const existingDirectory = async (path: string): Promise<boolean> => {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("WeChat state directory must be a real directory");
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  };

  const ensureStateDirectory = async (): Promise<void> => {
    if (!await existingDirectory(stateDir)) await mkdir(stateDir, { mode: 0o700 });
  };

  const ensureAccountsDirectory = async (): Promise<void> => {
    await ensureStateDirectory();
    if (!await existingDirectory(accountsDir)) await mkdir(accountsDir, { mode: 0o700 });
  };

  const pluginCapability = async () => {
    if (options.startupCapabilityFailure !== undefined) {
      return { available: false as const, ...options.startupCapabilityFailure };
    }
    try {
      PluginManifestSchema.parse(JSON.parse(await readFile(join(options.pluginDir, "openclaw.plugin.json"), "utf8")));
    } catch {
      return { available: false as const, pluginStatus: "missing" as const, reason: "需要安装并启用个人微信插件 2.4.6。" };
    }
    try {
      const packageJson = PluginPackageSchema.parse(JSON.parse(await readFile(join(options.pluginDir, "package.json"), "utf8")));
      const buildManifest = PluginBuildManifestSchema.parse(JSON.parse(await readFile(join(options.pluginDir, ".uclaw-plugin-manifest.json"), "utf8")));
      const locked = buildManifest.plugins[0];
      const actualFiles: string[] = [];
      const inventory = async (relativeDir = ""): Promise<void> => {
        const children = await readdir(join(options.pluginDir, ...relativeDir.split("/").filter(Boolean)), { withFileTypes: true });
        children.sort((left, right) => left.name.localeCompare(right.name, "en"));
        for (const child of children) {
          const relative = relativeDir ? `${relativeDir}/${child.name}` : child.name;
          if (relative === ".uclaw-plugin-manifest.json") continue;
          const info = await lstat(join(options.pluginDir, ...relative.split("/")));
          if (info.isSymbolicLink()) throw new Error("WeChat plugin symlink is forbidden");
          if (info.isDirectory()) await inventory(relative);
          else if (info.isFile()) actualFiles.push(relative);
          else throw new Error("WeChat plugin entry is unsupported");
        }
      };
      await inventory();
      const filesValid = await Promise.all(locked.files.map(async (file) => {
        const absolute = join(options.pluginDir, ...file.path.split("/"));
        const info = await lstat(absolute);
        if (info.isSymbolicLink() || !info.isFile() || info.size !== file.bytes) return false;
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(absolute)) hash.update(chunk);
        return hash.digest("hex") === file.sha256;
      }));
      const expectedFiles = locked.files.map((file) => file.path).sort((left, right) => left.localeCompare(right, "en"));
      if (packageJson.version === PLUGIN_VERSION && filesValid.every(Boolean) && JSON.stringify(actualFiles) === JSON.stringify(expectedFiles) && semver.satisfies(LOCKED_OPENCLAW_VERSION, locked.openclawVersionRange, { includePrerelease: true })) {
        return { available: true as const, pluginStatus: "installed" as const };
      }
    } catch {
      // The plugin exists, but its package identity cannot be verified.
    }
    return { available: false as const, pluginStatus: "installed" as const, reason: `个人微信插件必须为锁定版本 ${PLUGIN_VERSION} 且兼容当前 OpenClaw。` };
  };

  const requireCapability = async () => {
    const capability = await pluginCapability();
    if (!capability.available) throw new Error("WeChat plugin is unavailable");
  };

  const readAccounts = async (): Promise<string[]> => {
    if (!await existingDirectory(stateDir)) return [];
    try {
      const info = await lstat(accountsPath);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("WeChat account index must be a regular file");
      const parsed = AccountIndexSchema.parse(JSON.parse(await readFile(accountsPath, "utf8")) as unknown);
      return parsed
        .map(normalizedAccountId)
        .filter((value, index, values) => values.indexOf(value) === index);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  };

  const accountFiles = async (): Promise<string[]> => {
    if (!await existingDirectory(stateDir) || !await existingDirectory(accountsDir)) return [];
    const accountIds: string[] = [];
    for (const entry of await readdir(accountsDir, { withFileTypes: true })) {
      if (!entry.name.endsWith(".json")) continue;
      if (!entry.isFile()) throw new Error("WeChat account credential must be a regular file");
      const rawId = entry.name.slice(0, -5);
      const accountId = normalizedAccountId(rawId);
      if (accountId !== rawId) throw new Error("WeChat account credential name is invalid");
      accountIds.push(accountId);
    }
    return accountIds;
  };

  const requestJson = async <T>(url: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> => {
    const response = await fetch(url, { headers: { "iLink-App-ClientVersion": "1" }, signal });
    if (!response.ok) throw new Error(`WeChat network request failed (${response.status})`);
    return schema.parse(await response.json());
  };

  const createQr = async (signal: AbortSignal): Promise<Omit<ActiveFlow, "id">> => {
    const response = await requestJson(
      `${API_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`,
      QrResponseSchema,
      signal,
    );
    const value = await options.renderQr(response.qrcode_img_content);
    return {
      qrcode: response.qrcode,
      qrImage: { kind: "data-url", value },
      expiresAt: now().getTime() + FLOW_TTL_MS,
      pollBaseUrl: API_BASE_URL,
    };
  };

  const status = async (signal: AbortSignal, preferredAccountId?: string) => {
    const accountIds = await readAccounts();
    if (accountIds.length === 0) return { status: "not-configured" as const, loginState: "idle" as const };
    const raw = await options.requestGateway("channels.status", { channel: PLUGIN_ID, probe: false }, signal);
    const runtime = GatewayStatusSchema.parse(raw);
    const gatewayAccounts = runtime.channelAccounts[PLUGIN_ID] ?? [];
    const defaultAccountId = runtime.channelDefaultAccountId?.[PLUGIN_ID];
    const accountId = preferredAccountId && accountIds.includes(preferredAccountId)
      ? preferredAccountId
      : gatewayAccounts.find((candidate) => accountIds.includes(candidate.accountId) && candidate.connected === true)?.accountId
        ?? (defaultAccountId && accountIds.includes(defaultAccountId) ? defaultAccountId : accountIds[0]!);
    const account = gatewayAccounts.find((candidate) => candidate.accountId === accountId);
    if (account?.connected === true && account.running !== false) {
      return { status: "connected" as const, loginState: "connected" as const, account: { accountIdHint: accountHint(accountId) } };
    }
    if (account?.lastError && /401|403|auth|token|logged.?out|登录/iu.test(account.lastError)) {
      return { status: "auth-failed" as const, loginState: "error" as const, account: { accountIdHint: accountHint(accountId) } };
    }
    return { status: "disconnected" as const, loginState: "error" as const, account: { accountIdHint: accountHint(accountId) } };
  };

  const stageAccount = async (result: z.infer<typeof PollResponseSchema>): Promise<string> => {
    if (!result.ilink_bot_id || !result.bot_token) throw new Error("WeChat authentication response is incomplete");
    const accountId = normalizedAccountId(result.ilink_bot_id);
    await ensureAccountsDirectory();
    const account = {
      token: result.bot_token.trim(),
      ...(result.baseurl ? { baseUrl: result.baseurl.trim() } : {}),
      ...(result.ilink_user_id ? { userId: result.ilink_user_id.trim() } : {}),
    };
    await atomicWrite(join(accountsDir, `${accountId}.json`), JSON.stringify(account, null, 2));
    return accountId;
  };

  const commitAccount = async (accountId: string): Promise<void> => {
    await atomicWrite(accountsPath, JSON.stringify([accountId], null, 2));
  };

  const enableAndStart = async (accountId: string, signal: AbortSignal): Promise<void> => {
    const config = ConfigGetSchema.parse(await options.requestGateway("config.get", {}, signal));
    await options.requestGateway("config.patch", {
      raw: JSON.stringify({ plugins: { entries: { [PLUGIN_ID]: { enabled: true } } } }),
      baseHash: config.hash,
    }, signal);
    await options.requestGateway("channels.start", { channel: PLUGIN_ID, accountId }, signal);
  };

  return {
    capability: async (signal) => {
      if (signal.aborted) throw signal.reason;
      return pluginCapability();
    },
    status: async (signal) => {
      await requireCapability();
      return status(signal);
    },
    start: async (force, signal) => {
      await requireCapability();
      const existing = flows.values().next().value as ActiveFlow | undefined;
      if (existing && !force && existing.expiresAt > now().getTime()) {
        return { flowId: existing.id, qrImage: existing.qrImage, qrExpiresAt: new Date(existing.expiresAt).toISOString() };
      }
      flows.clear();
      const flow = { id: createFlowId(), ...(await createQr(signal)) };
      flows.set(flow.id, flow);
      return { flowId: flow.id, qrImage: flow.qrImage, qrExpiresAt: new Date(flow.expiresAt).toISOString() };
    },
    poll: async (flowId, signal) => {
      const flow = flows.get(flowId);
      if (!flow) throw new Error("WeChat login flow expired");
      if (flow.expiresAt <= now().getTime()) {
        flows.delete(flowId);
        return { status: "needs-action", loginState: "expired" };
      }
      const result = await requestJson(
        `${flow.pollBaseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(flow.qrcode)}`,
        PollResponseSchema,
        signal,
      );
      if (result.status === "scaned_but_redirect") {
        if (result.redirect_host) flow.pollBaseUrl = safeRedirectBase(result.redirect_host);
        return { status: "pending-verification", loginState: "awaiting-confirmation" };
      }
      if (result.status === "scaned" || result.status === "scanned") {
        return { status: "pending-verification", loginState: "awaiting-confirmation" };
      }
      if (result.status === "wait") return { status: "pending-verification", loginState: "awaiting-scan" };
      if (result.status === "expired") {
        flows.delete(flowId);
        return { status: "needs-action", loginState: "expired" };
      }
      if (result.status !== "confirmed") throw new Error("WeChat login failed");
      const previousAccounts = await readAccounts();
      const fallback = () => previousAccounts[0]
        ? { status: "disconnected" as const, loginState: "error" as const, account: { accountIdHint: accountHint(previousAccounts[0]) } }
        : undefined;
      if (!result.ilink_bot_id || !result.bot_token) {
        flows.delete(flowId);
        const snapshot = fallback();
        if (snapshot) return snapshot;
        throw new Error("WeChat authentication response is incomplete");
      }
      let accountId: string;
      try {
        accountId = await stageAccount(result);
      } catch (error) {
        flows.delete(flowId);
        const snapshot = fallback();
        if (snapshot) return snapshot;
        throw error;
      }
      try {
        for (const previousAccountId of previousAccounts) {
          if (previousAccountId !== accountId) {
            await options.requestGateway("channels.stop", { channel: PLUGIN_ID, accountId: previousAccountId }, signal);
          }
        }
        await commitAccount(accountId);
      } catch (error) {
        if (!previousAccounts.includes(accountId)) await rm(join(accountsDir, `${accountId}.json`), { force: true }).catch(() => undefined);
        flows.delete(flowId);
        if (signal.aborted) throw signal.reason;
        const snapshot = fallback();
        if (snapshot) return snapshot;
        throw error;
      }
      for (const previousAccountId of previousAccounts) {
        if (previousAccountId !== accountId) {
          await rm(join(accountsDir, `${previousAccountId}.json`), { force: true }).catch(() => undefined);
        }
      }
      flows.delete(flowId);
      try {
        await enableAndStart(accountId, signal);
        return await status(signal, accountId);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        return { status: "disconnected", loginState: "error", account: { accountIdHint: accountHint(accountId) } };
      }
    },
    refresh: async (flowId, signal) => {
      if (!flows.has(flowId)) throw new Error("WeChat login flow expired");
      const refreshed = { id: flowId, ...(await createQr(signal)) };
      flows.set(flowId, refreshed);
      return { qrImage: refreshed.qrImage, qrExpiresAt: new Date(refreshed.expiresAt).toISOString() };
    },
    cancel: async (flowId) => {
      flows.delete(flowId);
    },
    reconnect: async (signal) => {
      const accountIds = await readAccounts();
      if (accountIds.length === 0) return { status: "not-configured", loginState: "idle" };
      const accountId = accountIds[0]!;
      await options.requestGateway("channels.stop", { channel: PLUGIN_ID, accountId }, signal);
      await options.requestGateway("channels.start", { channel: PLUGIN_ID, accountId }, signal);
      return status(signal);
    },
    logout: async (signal) => {
      const indexedAccounts = await readAccounts().catch(() => []);
      const accountIds = [...new Set([...indexedAccounts, ...await accountFiles()])];
      for (const accountId of accountIds) {
        await options.requestGateway("channels.stop", { channel: PLUGIN_ID, accountId }, signal);
      }
      for (const accountId of accountIds) await rm(join(accountsDir, `${accountId}.json`), { force: true });
      await ensureStateDirectory();
      await atomicWrite(accountsPath, "[]");
      const remaining = await readAccounts();
      if (remaining.length !== 0 || (await accountFiles()).length !== 0) throw new Error("WeChat logout readback failed");
    },
  };
}
