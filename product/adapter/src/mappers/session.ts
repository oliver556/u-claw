import { SessionSchema, SessionSummarySchema, type Session, type SessionSummary } from "@uclaw/shared";
import { z } from "zod";

const LegacyRawSessionSchema = z.object({
  sessionKey: z.string().min(1),
  title: z.string(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  lastMessagePreview: z.string().optional(),
  model: z.object({ id: z.string().min(1), label: z.string().min(1), providerId: z.string().min(1).optional() }).strict().optional(),
  pinned: z.boolean(),
  groupId: z.string().nullable().optional(),
  status: z.enum(["idle", "running", "waiting-authorization", "failed"]),
  revision: z.string().optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
}).strict();

export const OpenClawSessionRowSchema = z.object({
  key: z.string().min(1),
  label: z.string().optional(),
  displayName: z.string().optional(),
  derivedTitle: z.string().optional(),
  lastMessagePreview: z.string().optional(),
  updatedAt: z.number().int().nonnegative(),
  pinned: z.boolean().optional(),
  category: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  hasActiveRun: z.boolean().optional(),
  modelProvider: z.string().optional(),
  model: z.string().optional(),
}).passthrough();

export const RawSessionSchema = z.union([LegacyRawSessionSchema, OpenClawSessionRowSchema]);

function mapOpenClawStatus(raw: z.infer<typeof OpenClawSessionRowSchema>): Session["status"] {
  if (raw.hasActiveRun === true || raw.status === "running") return "running";
  if (raw.status === "failed") return "failed";
  return "idle";
}

export function mapSession(payload: z.input<typeof RawSessionSchema>): Session {
  const raw = RawSessionSchema.parse(payload);
  if ("key" in raw) {
    const title = raw.label ?? raw.displayName ?? raw.derivedTitle ?? raw.key;
    return SessionSchema.parse({
      id: raw.key,
      title,
      updatedAt: new Date(raw.updatedAt).toISOString(),
      ...(raw.lastMessagePreview === undefined ? {} : { lastMessagePreview: raw.lastMessagePreview }),
      ...(raw.model === undefined ? {} : {
        model: {
          id: raw.modelProvider === undefined ? raw.model : `${raw.modelProvider}/${raw.model}`,
          label: raw.model,
          ...(raw.modelProvider === undefined ? {} : { providerId: raw.modelProvider }),
        },
      }),
      pinned: raw.pinned ?? false,
      ...(raw.category === undefined ? {} : { groupId: raw.category }),
      status: mapOpenClawStatus(raw),
    });
  }
  return SessionSchema.parse({
    id: raw.sessionKey,
    title: raw.title,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    ...(raw.lastMessagePreview === undefined ? {} : { lastMessagePreview: raw.lastMessagePreview }),
    ...(raw.model === undefined ? {} : { model: raw.model }),
    pinned: raw.pinned,
    ...(raw.groupId === undefined ? {} : { groupId: raw.groupId }),
    status: raw.status,
    ...(raw.revision === undefined ? {} : { revision: raw.revision }),
    ...(raw.metadata === undefined ? {} : { metadata: raw.metadata }),
  });
}

export function mapSessionSummary(payload: z.input<typeof RawSessionSchema>): SessionSummary {
  return SessionSummarySchema.parse(mapSession(payload));
}
