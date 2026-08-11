import { describe, expect, it } from "vitest";

import {
  SessionAdvancedIpcRequestSchema,
  SessionAdvancedIpcResponseSchema,
  SessionFileListResultSchema,
} from "../src/session-advanced.js";

describe("session advanced contracts", () => {
  it("accepts every controlled method and rejects unknown renderer fields", () => {
    const requests = [
      ["sessions.files.list", { sessionId: "agent:main:main", path: "src", search: "test" }],
      ["sessions.files.get", { sessionId: "agent:main:main", path: "src/index.ts" }],
      ["sessions.checkpoints.list", { sessionId: "agent:main:main" }],
      ["sessions.reset", { sessionId: "agent:main:main", reason: "reset" }],
      ["sessions.compact", { sessionId: "agent:main:main", maxLines: 200 }],
      ["sessions.branch", { sessionId: "agent:main:main", checkpointId: "cp-1" }],
      ["sessions.restore", { sessionId: "agent:main:main", checkpointId: "cp-1" }],
      ["sessions.steer", { sessionId: "agent:main:main", message: "Use the new constraint", idempotencyKey: "steer-1" }],
    ] as const;

    for (const [method, params] of requests) {
      expect(SessionAdvancedIpcRequestSchema.parse({ method, requestId: `request-${method}`, params })).toMatchObject({ method, params });
      expect(() => SessionAdvancedIpcRequestSchema.parse({ method, requestId: "bad", params: { ...params, raw: "forbidden" } })).toThrow();
    }
  });

  it("rejects absolute and traversal paths", () => {
    for (const path of ["../secret", "/etc/passwd", "C:\\secret.txt", "src/../../secret"]) {
      expect(() => SessionAdvancedIpcRequestSchema.parse({
        method: "sessions.files.get", requestId: "bad-path", params: { sessionId: "agent:main:main", path },
      })).toThrow();
    }
  });

  it("keeps renderer results strict and host-root free", () => {
    const result = {
      sessionId: "agent:main:main",
      files: [{ path: "src/index.ts", workspacePath: "src/index.ts", name: "index.ts", kind: "modified", missing: false }],
    };
    expect(SessionFileListResultSchema.parse(result)).toEqual(result);
    expect(() => SessionFileListResultSchema.parse({ ...result, root: "/private/workspace" })).toThrow();
    expect(() => SessionAdvancedIpcResponseSchema.parse({
      method: "sessions.files.list", requestId: "files-1", ok: true, result: { ...result, upstreamSecret: "hidden" },
    })).toThrow();
  });
});
