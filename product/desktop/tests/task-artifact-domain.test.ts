import { describe, expect, it, vi } from "vitest";
import { createTaskArtifactDomainRegistration } from "../src/task-artifacts/task-artifact-domain.js";

describe("Task/Artifact IPC domain", () => {
  it("rejects unauthorized senders and forwards authoritative task events", async () => {
    let handler: ((event: unknown, payload: unknown) => Promise<unknown>) | undefined;
    let listener: ((event: unknown) => void) | undefined;
    const ipcMain = { handle: vi.fn((_channel, next) => { handler = next; }), removeHandler: vi.fn() };
    const webContents = { mainFrame: {}, send: vi.fn() };
    const authority = { watchTasks: vi.fn((next) => { listener = next; return vi.fn(); }) };
    const registration = createTaskArtifactDomainRegistration(authority as never, vi.fn(async () => ({ ok: true })));
    expect(registration.installIpc).toBeTypeOf("function");
    const dispose = registration.installIpc!({ ipcMain, authorizedWebContents: webContents } as never);
    await expect(handler?.({ sender: {}, senderFrame: webContents.mainFrame }, { method: "tasks.list", requestId: "1", params: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
    listener?.({ type: "updated", task: { id: "task-1", title: "Report", status: "running", createdAt: "2026-08-12T08:00:00.000Z", updatedAt: "2026-08-12T08:01:00.000Z" } });
    expect(webContents.send).toHaveBeenCalledWith("uclaw:task-artifact-event", expect.objectContaining({ event: "task" }));
    dispose?.();
  });
});
