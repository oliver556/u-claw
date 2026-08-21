import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalApplicationRouter } from "../src/local-actions/application-router.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "uclaw-app-index-"));
  roots.push(root);
  await mkdir(join(root, "WPS Office.app"));
  await writeFile(join(root, "微信.lnk"), "shortcut");
  return root;
}

describe("createLocalApplicationRouter", () => {
  it("opens an indexed application and records the turn without using the model fallback", async () => {
    const root = await fixture();
    const openPath = vi.fn(async () => "");
    const inject = vi.fn(async () => undefined);
    const fallback = vi.fn();
    const router = createLocalApplicationRouter({ roots: [root], cachePath: join(root, "cache.json"), openPath, inject, platform: "darwin" });

    const events = [];
    for await (const event of await router.route({
      sessionId: "session-1", clientRequestId: "request-1",
      blocks: [{ type: "text", text: "帮我打开 WPS", format: "plain" }],
    }, fallback)) events.push(event);

    expect(openPath).toHaveBeenCalledWith(await realpath(join(root, "WPS Office.app")));
    expect(inject).toHaveBeenNthCalledWith(1, "session-1", "帮我打开 WPS", "uclaw-local-user-v1", undefined);
    expect(inject).toHaveBeenNthCalledWith(2, "session-1", "WPS Office 已打开。", "uclaw-local-result-v1", undefined);
    expect(events.map((event) => event.type)).toEqual(["started", "final"]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("rescans after a miss so newly installed applications are discovered", async () => {
    const root = await fixture();
    const openPath = vi.fn(async () => "");
    const router = createLocalApplicationRouter({
      roots: [root], cachePath: join(root, "cache.json"), openPath,
      inject: vi.fn(async () => undefined), platform: "darwin",
    });
    await router.refresh();
    await mkdir(join(root, "New App.app"));

    for await (const _event of await router.route({
      sessionId: "session-1", clientRequestId: "request-2",
      blocks: [{ type: "text", text: "打开 New App", format: "plain" }],
    }, vi.fn())) { /* consume */ }

    expect(openPath).toHaveBeenCalledWith(await realpath(join(root, "New App.app")));
  });

  it.each(["在 WPS 里写一份合同", "打开 WPS 然后新建文档", "打开 WPS 发消息", "WPS 怎么打开", "打开 /Applications/WPS.app"])(
    "falls back for non-trivial instruction: %s",
    async (text) => {
      const root = await fixture();
      const fallbackStream = (async function* () { yield { type: "started" as const, runId: "fallback", sessionId: "session-1" }; })();
      const fallback = vi.fn(async () => fallbackStream);
      const router = createLocalApplicationRouter({
        roots: [root], cachePath: join(root, "cache.json"), openPath: vi.fn(), inject: vi.fn(), platform: "darwin",
      });

      expect(await router.route({ sessionId: "session-1", clientRequestId: "request", blocks: [{ type: "text", text, format: "plain" }] }, fallback)).toBe(fallbackStream);
      expect(fallback).toHaveBeenCalledOnce();
    },
  );

  it("coalesces concurrent refreshes before serving the first request", async () => {
    const root = await fixture();
    const openPath = vi.fn(async () => "");
    const router = createLocalApplicationRouter({
      roots: [root], cachePath: join(root, "cache.json"), openPath,
      inject: vi.fn(async () => undefined), platform: "darwin",
    });

    await Promise.all([
      router.refresh(),
      router.refresh(),
      (async () => {
        for await (const _event of await router.route({
          sessionId: "session-1", clientRequestId: "request-concurrent",
          blocks: [{ type: "text", text: "打开 WPS", format: "plain" }],
        }, vi.fn())) { /* consume */ }
      })(),
    ]);

    expect(openPath).toHaveBeenCalledOnce();
  });

  it("falls back when an indexed target no longer exists", async () => {
    const root = await fixture();
    const router = createLocalApplicationRouter({
      roots: [root], cachePath: join(root, "cache.json"), openPath: vi.fn(), inject: vi.fn(), platform: "darwin",
    });
    await router.refresh();
    await rm(join(root, "WPS Office.app"), { recursive: true });
    const fallbackStream = (async function* () { yield { type: "started" as const, runId: "fallback", sessionId: "session-1" }; })();
    const fallback = vi.fn(async () => fallbackStream);

    expect(await router.route({
      sessionId: "session-1", clientRequestId: "request",
      blocks: [{ type: "text", text: "打开 WPS", format: "plain" }],
    }, fallback)).toBe(fallbackStream);
  });

  it("rejects a cache entry whose display name does not match the target basename", async () => {
    const root = await fixture();
    const cachePath = join(root, "cache.json");
    await writeFile(cachePath, JSON.stringify({
      schemaVersion: 1,
      applications: [{ name: "WPS", path: await realpath(join(root, "微信.lnk")) }],
    }));
    const fallback = vi.fn();
    const openPath = vi.fn(async () => "");
    const router = createLocalApplicationRouter({ roots: [root], cachePath, openPath, inject: vi.fn(async () => undefined), platform: "darwin" });

    for await (const _event of await router.route({
      sessionId: "session-1", clientRequestId: "request",
      blocks: [{ type: "text", text: "打开 WPS", format: "plain" }],
    }, fallback)) { /* consume */ }
    expect(openPath).toHaveBeenCalledWith(await realpath(join(root, "WPS Office.app")));
    expect(openPath).not.toHaveBeenCalledWith(await realpath(join(root, "微信.lnk")));
    expect(fallback).not.toHaveBeenCalled();
  });
});
