import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SKILL_IPC_CHANNEL } from "../src/ipc/channels.js";
import { installPreloadBridge } from "../src/ipc/preload-bridge.js";
import { registerIpc } from "../src/ipc/register-ipc.js";
import { createFixtureSkillHubClient } from "../src/skills/fixture-client.js";
import { createSkillDispatcher } from "../src/skills/skill-dispatcher.js";
import { createSkillService } from "../src/skills/skill-service.js";

function skillService() {
  return {
    search: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false, mode: "fixture" as const })),
    detail: vi.fn(), installed: vi.fn(async () => []), startInstall: vi.fn(), startUpdate: vi.fn(),
    startUninstall: vi.fn(), setEnabled: vi.fn(), operation: vi.fn(), waitForOperation: vi.fn(),
  };
}

describe("Skill IPC", () => {
  it("projects a non-empty fixture catalog through the strict IPC response schema", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-skill-ipc-"));
    try {
      const dispatch = createSkillDispatcher(await createSkillService({ dataDir, client: createFixtureSkillHubClient() }));
      const response = await dispatch({ method: "skills.search", requestId: "catalog-1", params: { query: "", cursor: null, pageSize: 20 } });
      expect(response.ok).toBe(true);
      if (!response.ok || response.method !== "skills.search") throw new Error("Unexpected Skill IPC response.");
      expect(response.result.items.length).toBeGreaterThan(0);
      expect(response.result.items.every((item) => item.pricingType === "free" && !("manifest" in item))).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("routes validated Skill domain objects on one fixed channel", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const authorizedWebContents = { mainFrame: {} };
    const skills = skillService();
    registerIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: vi.fn() },
      authorizedWebContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(), skills,
    });
    const event = { sender: authorizedWebContents, senderFrame: authorizedWebContents.mainFrame };
    const response = await handlers.get(SKILL_IPC_CHANNEL)!(event, {
      method: "skills.search", requestId: "skills-1", params: { query: "git", cursor: null, pageSize: 20 },
    });
    expect(skills.search).toHaveBeenCalledWith({ query: "git", cursor: null, pageSize: 20 });
    expect(response).toMatchObject({ method: "skills.search", requestId: "skills-1", ok: true });
  });

  it("rejects renderer paths and commands before dispatch", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const authorizedWebContents = { mainFrame: {} };
    const skills = skillService();
    registerIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: vi.fn() },
      authorizedWebContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(), skills,
    });
    await expect(handlers.get(SKILL_IPC_CHANNEL)!({ sender: authorizedWebContents, senderFrame: authorizedWebContents.mainFrame }, {
      method: "skills.install", requestId: "bad", params: { slug: "workspace-reader", confirmation: null, path: "/tmp", command: "run" },
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(skills.startInstall).not.toHaveBeenCalled();
  });

  it("preload exposes only a parsed Skill invoke bridge", async () => {
    let api: Record<string, any> = {};
    const invoke = vi.fn(async (_channel: string, request: any) => ({ method: request.method, requestId: request.requestId, ok: true, result: { items: [], nextCursor: null, hasMore: false, mode: "fixture" } }));
    installPreloadBridge({
      contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
    });
    expect(Object.keys(api.skills)).toEqual(["invoke"]);
    await api.skills.invoke({ method: "skills.search", requestId: "preload-1", params: { query: "", cursor: null, pageSize: 20 } });
    expect(invoke).toHaveBeenCalledWith(SKILL_IPC_CHANNEL, expect.objectContaining({ method: "skills.search" }));
    await expect(api.skills.invoke({ method: "exec", requestId: "bad", params: { command: "whoami" } })).rejects.toThrow();
  });
});
