import { describe, expect, it } from "vitest";

import { SessionOrganizerDocumentSchema, organizeSessions } from "../src/session-organizer.js";

const sessions = [
  { id: "old", title: "发布检查", createdAt: "2026-08-08T07:00:00.000Z", updatedAt: "2026-08-08T08:00:00.000Z", pinned: false, status: "idle" as const, lastMessagePreview: "检查 U 盘" },
  { id: "new", title: "知识库调研", createdAt: "2026-08-08T08:00:00.000Z", updatedAt: "2026-08-08T09:00:00.000Z", pinned: false, status: "idle" as const, lastMessagePreview: "整理文档" },
  { id: "pinned", title: "版本发布", createdAt: "2026-08-08T06:00:00.000Z", updatedAt: "2026-08-08T06:00:00.000Z", pinned: false, status: "idle" as const },
];

describe("session organizer contract", () => {
  it("accepts only schema v1 organizer fields", () => {
    const document = { schemaVersion: 1, groups: [{ id: "release", name: "发布" }], sessions: [{ sessionId: "pinned", pinned: true, groupId: "release" }] };
    expect(SessionOrganizerDocumentSchema.parse(document)).toEqual(document);
    expect(() => SessionOrganizerDocumentSchema.parse({ ...document, schemaVersion: 2 })).toThrow();
    expect(() => SessionOrganizerDocumentSchema.parse({ ...document, path: "C:\\escape" })).toThrow();
    expect(() => SessionOrganizerDocumentSchema.parse({ ...document, sessions: [{ ...document.sessions[0], title: "copied OpenClaw data" }] })).toThrow();
  });

  it("searches title and preview, then sorts pinned first and newest first", () => {
    const document = SessionOrganizerDocumentSchema.parse({ schemaVersion: 1, groups: [{ id: "release", name: "发布" }], sessions: [{ sessionId: "pinned", pinned: true, groupId: "release" }] });
    expect(organizeSessions(sessions, document, "").map((item) => item.id)).toEqual(["pinned", "new", "old"]);
    expect(organizeSessions(sessions, document, "文档").map((item) => item.id)).toEqual(["new"]);
    expect(organizeSessions(sessions, document, "  知识库  ").map((item) => item.id)).toEqual(["new"]);
    expect(organizeSessions(sessions, document, "发布").map((item) => item.id)).toEqual(["pinned", "old"]);
    expect(organizeSessions(sessions, document, "")[0]).toMatchObject({ pinned: true, groupId: "release" });
  });
});
