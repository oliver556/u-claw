import {
  SessionBranchResultSchema,
  SessionCheckpointListResultSchema,
  SessionCheckpointSchema,
  SessionCompactResultSchema,
  SessionFileGetResultSchema,
  SessionFileListResultSchema,
  SessionResetResultSchema,
  SessionRestoreResultSchema,
  SessionSteerResultSchema,
  type SessionAdvancedService,
  type SessionCheckpoint,
} from "@uclaw/shared";
import { z } from "zod";

import { mapSession, RawSessionSchema } from "./mappers/session.js";
import { RpcProtocolError, type JsonValue } from "./transport/rpc-router.js";

export interface SessionAdvancedRouter {
  request<T>(method: string, params: JsonValue, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T>;
}

export interface OpenClawSessionAdvancedOptions {
  router: SessionAdvancedRouter;
  requireMethod(method: string): void;
}

const RawFileSchema = z.object({
  path: z.string(), workspacePath: z.string().optional(), name: z.string(), kind: z.enum(["modified", "read"]),
  missing: z.boolean(), size: z.number().int().nonnegative().optional(), updatedAtMs: z.number().int().nonnegative().optional(), content: z.string().optional(),
});
const RawBrowserEntrySchema = z.object({
  path: z.string(), name: z.string(), kind: z.enum(["file", "directory"]),
  sessionKind: z.enum(["modified", "read", "mixed"]).optional(), size: z.number().int().nonnegative().optional(), updatedAtMs: z.number().int().nonnegative().optional(),
});
const RawBrowserSchema = z.object({
  path: z.string(), parentPath: z.string().optional(), search: z.string().optional(), entries: z.array(RawBrowserEntrySchema), truncated: z.boolean().optional(),
});
const RawFileListSchema = z.object({ sessionKey: z.string().min(1), root: z.string().optional(), files: z.array(RawFileSchema), browser: RawBrowserSchema.optional() });
const RawFileGetSchema = z.object({ sessionKey: z.string().min(1), root: z.string().optional(), file: RawFileSchema });
const RawCheckpointSideSchema = z.object({
  sessionId: z.string().min(1), sessionFile: z.string().min(1).optional(), leafId: z.string().min(1).optional(), entryId: z.string().min(1).optional(),
});
const RawCheckpointSchema = z.object({
  checkpointId: z.string().min(1), sessionId: z.string().min(1), createdAt: z.number().int().nonnegative(),
  reason: z.enum(["manual", "auto-threshold", "overflow-retry", "timeout-retry"]), tokensBefore: z.number().int().nonnegative().optional(),
  tokensAfter: z.number().int().nonnegative().optional(), summary: z.string().optional(), firstKeptEntryId: z.string().min(1).optional(),
  preCompaction: RawCheckpointSideSchema, postCompaction: RawCheckpointSideSchema,
});
const RawCheckpointListSchema = z.object({ ok: z.literal(true), key: z.string().min(1), checkpoints: z.array(RawCheckpointSchema) });
const RawCheckpointGetSchema = z.object({ ok: z.literal(true), key: z.string().min(1), checkpoint: RawCheckpointSchema });
const RawDescribeSchema = z.object({ session: RawSessionSchema.nullable() });
const RawResetSchema = z.object({ ok: z.literal(true), key: z.string().min(1), entry: z.record(z.string(), z.unknown()) });
const RawCompactSchema = z.object({
  ok: z.literal(true), key: z.string().min(1), compacted: z.boolean(), reason: z.string().optional(), kept: z.number().int().nonnegative().optional(), result: z.unknown().optional(), archived: z.string().optional(),
});
const RawBranchSchema = z.object({
  ok: z.literal(true), sourceKey: z.string().min(1), key: z.string().min(1), sessionId: z.string().min(1), checkpoint: RawCheckpointSchema, entry: z.record(z.string(), z.unknown()),
});
const RawRestoreSchema = z.object({
  ok: z.literal(true), key: z.string().min(1), sessionId: z.string().min(1), checkpoint: RawCheckpointSchema, entry: z.record(z.string(), z.unknown()),
});
const RawSteerSchema = z.object({
  runId: z.string().min(1), status: z.string().min(1), interruptedActiveRun: z.boolean().optional(), messageSeq: z.number().int().positive().optional(),
});

function mapCheckpoint(raw: z.infer<typeof RawCheckpointSchema>, sessionKey: string): SessionCheckpoint {
  return SessionCheckpointSchema.parse({
    checkpointId: raw.checkpointId,
    sessionId: sessionKey,
    transcriptId: raw.sessionId,
    createdAt: raw.createdAt,
    reason: raw.reason,
    ...(raw.tokensBefore === undefined ? {} : { tokensBefore: raw.tokensBefore }),
    ...(raw.tokensAfter === undefined ? {} : { tokensAfter: raw.tokensAfter }),
    ...(raw.summary === undefined ? {} : { summary: raw.summary }),
    ...(raw.firstKeptEntryId === undefined ? {} : { firstKeptEntryId: raw.firstKeptEntryId }),
    preCompaction: raw.preCompaction,
    postCompaction: raw.postCompaction,
  });
}

export function createOpenClawSessionAdvancedService(options: OpenClawSessionAdvancedOptions): SessionAdvancedService {
  const call = <T>(method: string, params: JsonValue, schema: z.ZodType<T>): Promise<T> => {
    options.requireMethod(method);
    return options.router.request(method, params, schema);
  };
  const readSession = async (sessionId: string) => {
    const raw = await call("sessions.describe", { key: sessionId, includeDerivedTitles: true, includeLastMessage: true }, RawDescribeSchema);
    if (raw.session === null) throw new RpcProtocolError("sessions.describe");
    const session = mapSession(raw.session);
    if (session.id !== sessionId) throw new RpcProtocolError("sessions.describe");
    return session;
  };
  const params = (values: Record<string, JsonValue | undefined>): JsonValue => Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined),
  );

  return {
    async listFiles(input) {
      const raw = await call("sessions.files.list", params({
        sessionKey: input.sessionId,
        path: input.path,
        search: input.search,
        agentId: input.agentId,
      }), RawFileListSchema);
      if (raw.sessionKey !== input.sessionId) throw new RpcProtocolError("sessions.files.list");
      return SessionFileListResultSchema.parse({ sessionId: raw.sessionKey, files: raw.files, ...(raw.browser === undefined ? {} : { browser: raw.browser }) });
    },
    async getFile(input) {
      const raw = await call("sessions.files.get", params({ sessionKey: input.sessionId, path: input.path, agentId: input.agentId }), RawFileGetSchema);
      if (raw.sessionKey !== input.sessionId) throw new RpcProtocolError("sessions.files.get");
      return SessionFileGetResultSchema.parse({ sessionId: raw.sessionKey, file: raw.file });
    },
    async listCheckpoints(input) {
      const raw = await call("sessions.compaction.list", params({ key: input.sessionId, agentId: input.agentId }), RawCheckpointListSchema);
      if (raw.key !== input.sessionId) throw new RpcProtocolError("sessions.compaction.list");
      return SessionCheckpointListResultSchema.parse({
        sessionId: raw.key,
        checkpoints: raw.checkpoints.map((checkpoint) => mapCheckpoint(checkpoint, raw.key)),
      });
    },
    async reset(input) {
      const raw = await call("sessions.reset", params({ key: input.sessionId, agentId: input.agentId, reason: input.reason }), RawResetSchema);
      if (raw.key !== input.sessionId) throw new RpcProtocolError("sessions.reset");
      return SessionResetResultSchema.parse({ operation: "reset", session: await readSession(raw.key) });
    },
    async compact(input) {
      const raw = await call("sessions.compact", params({ key: input.sessionId, agentId: input.agentId, maxLines: input.maxLines }), RawCompactSchema);
      if (raw.key !== input.sessionId) throw new RpcProtocolError("sessions.compact");
      const checkpoints = await this.listCheckpoints(input);
      const session = await readSession(raw.key);
      return SessionCompactResultSchema.parse({
        operation: "compact", session, compacted: raw.compacted, checkpoints: checkpoints.checkpoints,
        ...(raw.reason === undefined ? {} : { reason: raw.reason }), ...(raw.kept === undefined ? {} : { kept: raw.kept }),
      });
    },
    async branch(input) {
      const raw = await call("sessions.compaction.branch", params({ key: input.sessionId, checkpointId: input.checkpointId, agentId: input.agentId }), RawBranchSchema);
      if (raw.sourceKey !== input.sessionId || raw.checkpoint.checkpointId !== input.checkpointId) throw new RpcProtocolError("sessions.compaction.branch");
      return SessionBranchResultSchema.parse({
        operation: "branch",
        sourceSessionId: raw.sourceKey,
        session: await readSession(raw.key),
        checkpoint: mapCheckpoint(raw.checkpoint, raw.sourceKey),
      });
    },
    async restore(input) {
      const raw = await call("sessions.compaction.restore", params({ key: input.sessionId, checkpointId: input.checkpointId, agentId: input.agentId }), RawRestoreSchema);
      if (raw.key !== input.sessionId || raw.checkpoint.checkpointId !== input.checkpointId) throw new RpcProtocolError("sessions.compaction.restore");
      const readback = await call("sessions.compaction.get", params({ key: input.sessionId, checkpointId: input.checkpointId, agentId: input.agentId }), RawCheckpointGetSchema);
      if (readback.key !== input.sessionId || readback.checkpoint.checkpointId !== input.checkpointId) throw new RpcProtocolError("sessions.compaction.get");
      return SessionRestoreResultSchema.parse({
        operation: "restore",
        session: await readSession(raw.key),
        checkpoint: mapCheckpoint(readback.checkpoint, readback.key),
      });
    },
    async steer(input) {
      const raw = await call("sessions.steer", params({
        key: input.sessionId, message: input.message, agentId: input.agentId,
        thinking: input.thinking, timeoutMs: input.timeoutMs, idempotencyKey: input.idempotencyKey,
      }), RawSteerSchema);
      return SessionSteerResultSchema.parse({ operation: "steer", ...raw, session: await readSession(input.sessionId) });
    },
  };
}
