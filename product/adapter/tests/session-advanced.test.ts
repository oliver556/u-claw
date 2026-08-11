import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import { createOpenClawSessionAdvancedService } from "../src/session-advanced.js";
import type { JsonValue } from "../src/transport/rpc-router.js";

class FakeRouter {
  readonly requests: Array<{ method: string; params: JsonValue }> = [];
  readonly responses = new Map<string, JsonValue[]>();

  queue(method: string, ...responses: JsonValue[]): void {
    this.responses.set(method, responses);
  }

  async request<T>(method: string, params: JsonValue, schema: z.ZodType<T>): Promise<T> {
    this.requests.push({ method, params });
    const response = this.responses.get(method)?.shift();
    if (response === undefined) throw new Error(`Missing response for ${method}`);
    return schema.parse(response);
  }
}

const rawSession = (key: string, sessionId: string, updatedAt: number) => ({
  key, sessionId, label: "Authoritative", updatedAt, pinned: false, unknownStoreField: "drop-me",
});

const checkpoint = {
  checkpointId: "cp-1", sessionId: "transcript-before", createdAt: 1786406400000,
  reason: "manual", tokensBefore: 1200, tokensAfter: 300,
  preCompaction: { sessionId: "transcript-before" }, postCompaction: { sessionId: "transcript-after" },
};

describe("OpenClaw session advanced service", () => {
  it("maps session file RPCs and strips unknown and host-root fields", async () => {
    const router = new FakeRouter();
    router.queue("sessions.files.list", {
      sessionKey: "agent:main:main", root: "/private/workspace", extra: "drop-me",
      files: [{ path: "src/index.ts", workspacePath: "src/index.ts", name: "index.ts", kind: "modified", missing: false, secret: "drop-me" }],
      browser: { path: "src", entries: [{ path: "src/index.ts", name: "index.ts", kind: "file", sessionKind: "modified", extra: true }], extra: true },
    });
    router.queue("sessions.files.get", {
      sessionKey: "agent:main:main", root: "/private/workspace", extra: true,
      file: { path: "src/index.ts", workspacePath: "src/index.ts", name: "index.ts", kind: "modified", missing: false, content: "export {};", secret: "drop-me" },
    });
    const service = createOpenClawSessionAdvancedService({ router, requireMethod: vi.fn() });

    await expect(service.listFiles({ sessionId: "agent:main:main", path: "src" })).resolves.toEqual({
      sessionId: "agent:main:main",
      files: [{ path: "src/index.ts", workspacePath: "src/index.ts", name: "index.ts", kind: "modified", missing: false }],
      browser: { path: "src", entries: [{ path: "src/index.ts", name: "index.ts", kind: "file", sessionKind: "modified" }] },
    });
    await expect(service.getFile({ sessionId: "agent:main:main", path: "src/index.ts" })).resolves.toEqual({
      sessionId: "agent:main:main",
      file: { path: "src/index.ts", workspacePath: "src/index.ts", name: "index.ts", kind: "modified", missing: false, content: "export {};" },
    });
    expect(router.requests).toEqual([
      { method: "sessions.files.list", params: { sessionKey: "agent:main:main", path: "src" } },
      { method: "sessions.files.get", params: { sessionKey: "agent:main:main", path: "src/index.ts" } },
    ]);
  });

  it("reads every mutation back from authoritative RPCs after local state is discarded", async () => {
    const router = new FakeRouter();
    router.queue("sessions.reset", { ok: true, key: "agent:main:main", entry: { sessionId: "reset-raw", private: true } });
    router.queue("sessions.compact", { ok: true, key: "agent:main:main", compacted: true, result: { tokensBefore: 1200, tokensAfter: 300 }, private: true });
    router.queue("sessions.compaction.list", { ok: true, key: "agent:main:main", checkpoints: [{ ...checkpoint, private: true }], private: true });
    router.queue("sessions.compaction.branch", { ok: true, sourceKey: "agent:main:main", key: "agent:main:branch", sessionId: "branch-raw", checkpoint, entry: { sessionId: "branch-raw", updatedAt: 1 }, private: true });
    router.queue("sessions.compaction.restore", { ok: true, key: "agent:main:main", sessionId: "restore-raw", checkpoint, entry: { sessionId: "restore-raw", updatedAt: 2 }, private: true });
    router.queue("sessions.compaction.get", { ok: true, key: "agent:main:main", checkpoint: { ...checkpoint, private: true }, private: true });
    router.queue("sessions.steer", { runId: "run-steer", status: "accepted", interruptedActiveRun: true, private: true });
    router.queue(
      "sessions.describe",
      { session: rawSession("agent:main:main", "reset-readback", 10) },
      { session: rawSession("agent:main:main", "compact-readback", 20) },
      { session: rawSession("agent:main:branch", "branch-readback", 30) },
      { session: rawSession("agent:main:main", "restore-readback", 40) },
      { session: rawSession("agent:main:main", "steer-readback", 50) },
    );
    const service = createOpenClawSessionAdvancedService({ router, requireMethod: vi.fn() });

    const reset = await service.reset({ sessionId: "agent:main:main", reason: "reset" });
    const compact = await service.compact({ sessionId: "agent:main:main", maxLines: 200 });
    const branch = await service.branch({ sessionId: "agent:main:main", checkpointId: "cp-1" });
    const restore = await service.restore({ sessionId: "agent:main:main", checkpointId: "cp-1" });
    const steer = await service.steer({ sessionId: "agent:main:main", message: "Continue with constraints", idempotencyKey: "steer-1" });

    expect(reset.session).toMatchObject({ id: "agent:main:main", title: "Authoritative", updatedAt: new Date(10).toISOString() });
    expect(compact.session.updatedAt).toBe(new Date(20).toISOString());
    expect(compact.checkpoints[0].checkpointId).toBe("cp-1");
    expect(compact.checkpoints[0]).toMatchObject({ sessionId: "agent:main:main", transcriptId: "transcript-before" });
    expect(branch.session).toMatchObject({ id: "agent:main:branch", updatedAt: new Date(30).toISOString() });
    expect(restore.session.updatedAt).toBe(new Date(40).toISOString());
    expect(restore.checkpoint.checkpointId).toBe("cp-1");
    expect(steer).toMatchObject({ runId: "run-steer", status: "accepted", session: { id: "agent:main:main", updatedAt: new Date(50).toISOString() } });
    expect(JSON.stringify([reset, compact, branch, restore, steer])).not.toMatch(/private|reset-raw|compact-raw|branch-raw|restore-raw/);
    expect(router.requests.map(({ method }) => method)).toEqual([
      "sessions.reset", "sessions.describe",
      "sessions.compact", "sessions.compaction.list", "sessions.describe",
      "sessions.compaction.branch", "sessions.describe",
      "sessions.compaction.restore", "sessions.compaction.get", "sessions.describe",
      "sessions.steer", "sessions.describe",
    ]);
  });

  it("checks capabilities before RPC and propagates authoritative errors", async () => {
    const router = new FakeRouter();
    const failure = new Error("Gateway rejected reset");
    router.queue("sessions.reset", {});
    router.request = vi.fn(async () => { throw failure; }) as typeof router.request;
    const requireMethod = vi.fn();
    const service = createOpenClawSessionAdvancedService({ router, requireMethod });

    await expect(service.reset({ sessionId: "agent:main:main" })).rejects.toBe(failure);
    expect(requireMethod).toHaveBeenCalledWith("sessions.reset");
  });
});
