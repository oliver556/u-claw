import { describe, expect, it, vi } from "vitest";
import { AUTOMATION_IPC_CHANNEL } from "@uclaw/shared/dist/automation.js";
import { createAutomationDomainRegistration } from "../src/automation/automation-domain.js";

describe("automation IPC domain", () => {
  it("allows only the authorized renderer and validates input", async () => {
    let handler: ((event: unknown, payload: unknown) => Promise<unknown>) | undefined;
    const sender = { mainFrame: {} };
    const ipcMain = { handle: vi.fn((channel: string, fn: typeof handler) => { expect(channel).toBe(AUTOMATION_IPC_CHANNEL); handler = fn; }), removeHandler: vi.fn() };
    createAutomationDomainRegistration(vi.fn(async () => ({ ok: true }))).installIpc?.({ ipcMain, authorizedWebContents: sender, client: {} as never, services: { get: () => undefined } });
    await expect(handler?.({ sender: {}, senderFrame: sender.mainFrame }, { method: "agents.list", requestId: "x", params: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(handler?.({ sender, senderFrame: sender.mainFrame }, { method: "agents.files.get", requestId: "x", params: { agentId: "main", path: "../secret" } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
