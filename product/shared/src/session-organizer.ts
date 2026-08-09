import { z } from "zod";

import type { SessionSummary } from "./chat.js";

const DomainIdSchema = z.string().trim().min(1).max(512).refine((value) => !/[\0-\x1f\x7f]/.test(value), "Invalid domain id.");

export const SessionGroupSchema = z.object({
  id: DomainIdSchema,
  name: z.string().trim().min(1).max(80),
}).strict();
export type SessionGroup = z.infer<typeof SessionGroupSchema>;

export const SessionOrganizerEntrySchema = z.object({
  sessionId: DomainIdSchema,
  pinned: z.boolean(),
  groupId: DomainIdSchema.optional(),
}).strict();
export type SessionOrganizerEntry = z.infer<typeof SessionOrganizerEntrySchema>;

export const SessionOrganizerDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  groups: z.array(SessionGroupSchema),
  sessions: z.array(SessionOrganizerEntrySchema),
}).strict().superRefine((document, context) => {
  const groupIds = new Set<string>();
  for (const [index, group] of document.groups.entries()) {
    if (groupIds.has(group.id)) context.addIssue({ code: "custom", path: ["groups", index, "id"], message: "Duplicate group id." });
    groupIds.add(group.id);
  }
  const sessionIds = new Set<string>();
  for (const [index, session] of document.sessions.entries()) {
    if (sessionIds.has(session.sessionId)) context.addIssue({ code: "custom", path: ["sessions", index, "sessionId"], message: "Duplicate session id." });
    sessionIds.add(session.sessionId);
    if (session.groupId !== undefined && !groupIds.has(session.groupId)) {
      context.addIssue({ code: "custom", path: ["sessions", index, "groupId"], message: "Unknown group id." });
    }
  }
});
export type SessionOrganizerDocument = z.infer<typeof SessionOrganizerDocumentSchema>;

export const emptySessionOrganizer = (): SessionOrganizerDocument => ({ schemaVersion: 1, groups: [], sessions: [] });

export interface SessionOrganizerService {
  get(): Promise<SessionOrganizerDocument>;
  setPinned(sessionId: string, pinned: boolean): Promise<SessionOrganizerDocument>;
  createGroup(name: string): Promise<SessionOrganizerDocument>;
  renameGroup(groupId: string, name: string): Promise<SessionOrganizerDocument>;
  assignGroup(sessionId: string, groupId: string | null): Promise<SessionOrganizerDocument>;
}

export function organizeSessions(
  sessions: SessionSummary[],
  organizer: SessionOrganizerDocument,
  query: string,
): SessionSummary[] {
  const metadata = new Map(organizer.sessions.map((entry) => [entry.sessionId, entry]));
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  return sessions
    .map((session) => {
      const { pinned: _sourcePinned, groupId: _sourceGroupId, ...source } = session;
      const entry = metadata.get(session.id);
      return {
        ...source,
        pinned: entry?.pinned ?? false,
        ...(entry?.groupId === undefined ? {} : { groupId: entry.groupId }),
      };
    })
    .filter((session) => normalizedQuery === "" || `${session.title} ${session.lastMessagePreview ?? ""}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id));
}
