import { describe, expect, it, vi } from "vitest";

import { createSessionAdvancedDispatcher } from "../src/sessions/session-advanced-dispatcher.js";

describe("session advanced dispatcher", () => {
  it("exposes fixed IPC operations and rejects unknown payload fields before service calls", async () => {
    const service = {
      listFiles: vi.fn(async () => ({ sessionId: "agent:main:main", files: [] })),
      getFile: vi.fn(), listCheckpoints: vi.fn(), reset: vi.fn(), compact: vi.fn(), branch: vi.fn(), restore: vi.fn(), steer: vi.fn(),
    };
    const dispatch = createSessionAdvancedDispatcher(service as never);

    await expect(dispatch({ method: "sessions.files.list", requestId: "list-1", params: { sessionId: "agent:main:main" } }))
      .resolves.toEqual({ method: "sessions.files.list", requestId: "list-1", ok: true, result: { sessionId: "agent:main:main", files: [] } });
    await expect(dispatch({ method: "sessions.files.list", requestId: "bad-1", params: { sessionId: "agent:main:main", raw: true } }))
      .rejects.toThrow();
    expect(service.listFiles).toHaveBeenCalledOnce();
  });

  it("routes advanced mutations without retaining a local result cache", async () => {
    const readback = { session: { id: "agent:main:main", title: "Read back", updatedAt: "2026-08-11T00:00:00.000Z", pinned: false, status: "idle" } };
    const service = {
      listFiles: vi.fn(), getFile: vi.fn(), listCheckpoints: vi.fn(),
      reset: vi.fn(async () => ({ operation: "reset", ...readback })),
      compact: vi.fn(), branch: vi.fn(), restore: vi.fn(), steer: vi.fn(),
    };
    const dispatch = createSessionAdvancedDispatcher(service as never);
    const request = { method: "sessions.reset", requestId: "reset-1", params: { sessionId: "agent:main:main" } };

    await expect(dispatch(request)).resolves.toMatchObject({ ok: true, result: { operation: "reset", session: { title: "Read back" } } });
    await expect(dispatch({ ...request, requestId: "reset-2" })).resolves.toMatchObject({ ok: true });
    expect(service.reset).toHaveBeenCalledTimes(2);
  });
});
