import { SessionSchema, SessionSummarySchema, type Session, type SessionSummary } from "@uclaw/shared";
import { z } from "zod";

export const RawSessionSchema = z.object({
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

export function mapSession(payload: z.input<typeof RawSessionSchema>): Session {
  const raw = RawSessionSchema.parse(payload);
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
