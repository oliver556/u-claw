import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  CHANNEL_CONFIG_VERSION,
  ChannelConfigDocumentSchema,
  ChannelDraftSchema,
  ChannelSnapshotSchema,
  UClawErrorSchema,
  type ChannelConfigDocument,
  type ChannelConfigEntry,
  type ChannelDraft,
  type ChannelErrorSummary,
  type ChannelSnapshot,
  type ChannelStatus,
  type ChannelKind,
} from "@uclaw/shared";

export interface ChannelStore {
  list(): Promise<ChannelSnapshot>;
  create(channel: ChannelDraft): Promise<ChannelSnapshot>;
  update(channelId: string, channel: ChannelDraft): Promise<ChannelSnapshot>;
  remove(channelId: string): Promise<ChannelSnapshot>;
  setEnabled(channelId: string, enabled: boolean): Promise<ChannelSnapshot>;
  record(channelId: string, status: ChannelStatus, checkedAt: string, error?: ChannelErrorSummary): Promise<ChannelSnapshot>;
  getForRuntime(channelId: string): Promise<ChannelConfigEntry>;
}

const configFileName = "channel-config.v1.json";
const unavailableReason = "当前便携运行时未打包该 OpenClaw 渠道插件。";

function hint(value: string): string {
  return value.length <= 4 ? "...****" : `...${value.slice(-4)}`;
}

const unavailableError: ChannelErrorSummary = {
  category: "capability", code: "CAPABILITY_UNAVAILABLE",
  message: "当前运行时未提供该渠道能力。", retryable: false,
};

function toSnapshot(document: ChannelConfigDocument, hasCapability: (kind: ChannelKind) => boolean): ChannelSnapshot {
  return ChannelSnapshotSchema.parse({
    schemaVersion: document.schemaVersion,
    channels: document.channels.map(({ credentials, ...channel }) => {
      const capability = hasCapability(channel.kind) ? "available" : "unavailable";
      const credentialHints = Object.fromEntries(Object.entries(credentials).map(([key, value]) => [key, hint(value)]));
      return {
        ...channel,
        configured: Object.keys(credentials).length > 0,
        status: capability === "unavailable" ? "needs-action" : channel.status ?? "pending-verification",
        capability,
        ...(capability === "unavailable" ? { capabilityReason: unavailableReason } : {}),
        ...(capability === "unavailable" ? { error: unavailableError } : {}),
        credentialHints,
      };
    }),
  });
}

async function atomicWrite(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${configFileName}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export function createChannelStore({ dataDir, capability = (kind) => kind === "telegram" }: { dataDir: string; capability?: (kind: ChannelKind) => boolean }): ChannelStore {
  const configPath = join(dataDir, "channels", configFileName);
  let loaded: ChannelConfigDocument | undefined;
  let queue = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const load = async (): Promise<ChannelConfigDocument> => {
    if (loaded) return loaded;
    try { loaded = ChannelConfigDocumentSchema.parse(JSON.parse(await readFile(configPath, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") loaded = { schemaVersion: CHANNEL_CONFIG_VERSION, channels: [] };
      else throw UClawErrorSchema.parse({ code: "OPERATION_FAILED", message: "Channel configuration could not be read.", retryable: true });
    }
    return loaded;
  };
  const commit = async (document: ChannelConfigDocument): Promise<ChannelSnapshot> => {
    const parsed = ChannelConfigDocumentSchema.parse(document);
    try { await atomicWrite(configPath, `${JSON.stringify(parsed, null, 2)}\n`); }
    catch { throw UClawErrorSchema.parse({ code: "OPERATION_FAILED", message: "Channel configuration could not be saved.", retryable: true }); }
    loaded = parsed;
    return toSnapshot(parsed, capability);
  };
  const mutate = (change: (document: ChannelConfigDocument) => void): Promise<ChannelSnapshot> => serialize(async () => {
    const next = structuredClone(await load());
    change(next);
    return commit(next);
  });
  const requireChannel = (document: ChannelConfigDocument, channelId: string): ChannelConfigEntry => {
    const channel = document.channels.find(({ id }) => id === channelId);
    if (!channel) throw UClawErrorSchema.parse({ code: "NOT_FOUND", message: "Channel was not found.", retryable: false });
    return channel;
  };
  return {
    list: () => serialize(async () => toSnapshot(await load(), capability)),
    create: (draft) => mutate((document) => {
      const channel = ChannelDraftSchema.parse(draft);
      if (document.channels.some(({ id }) => id === channel.id)) throw UClawErrorSchema.parse({ code: "CONFLICT", message: "Channel ID already exists.", retryable: false });
      document.channels.push(channel);
    }),
    update: (channelId, draft) => mutate((document) => {
      const index = document.channels.findIndex(({ id }) => id === channelId);
      if (index < 0) throw UClawErrorSchema.parse({ code: "NOT_FOUND", message: "Channel was not found.", retryable: false });
      const channel = ChannelDraftSchema.parse(draft);
      if (channel.id !== channelId && document.channels.some(({ id }) => id === channel.id)) throw UClawErrorSchema.parse({ code: "CONFLICT", message: "Channel ID already exists.", retryable: false });
      document.channels[index] = channel;
    }),
    remove: (channelId) => mutate((document) => {
      const index = document.channels.findIndex(({ id }) => id === channelId);
      if (index < 0) throw UClawErrorSchema.parse({ code: "NOT_FOUND", message: "Channel was not found.", retryable: false });
      document.channels.splice(index, 1);
    }),
    setEnabled: (channelId, enabled) => mutate((document) => {
      const channel = requireChannel(document, channelId);
      channel.enabled = enabled;
      channel.status = enabled ? "connecting" : "disconnected";
      delete channel.error;
    }),
    record: (channelId, status, checkedAt, error) => mutate((document) => {
      const channel = requireChannel(document, channelId);
      channel.status = status;
      channel.lastCheckedAt = checkedAt;
      if (error) channel.error = error; else delete channel.error;
    }),
    getForRuntime: (channelId) => serialize(async () => structuredClone(requireChannel(await load(), channelId))),
  };
}
