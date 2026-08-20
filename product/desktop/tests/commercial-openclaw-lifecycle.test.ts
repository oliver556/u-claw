import { describe, expect, it, vi } from "vitest";

import {
  createCommercialOpenClawReadinessGate,
  fetchCommercialModels,
  rotateCommercialOpenClawCredential,
} from "../src/providers/commercial-openclaw-lifecycle.js";

describe("commercial OpenClaw credential lifecycle", () => {
  it("holds the first chat until Provider bootstrap and gateway reconnect finish", async () => {
    const order: string[] = [];
    let releaseBootstrap: (() => void) | undefined;
    const bootstrapReleased = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
    const readiness = createCommercialOpenClawReadinessGate();
    const bootstrap = readiness.run(async () => {
      order.push("bootstrap-started");
      await bootstrapReleased;
      order.push("bootstrap-ready");
    });
    const firstChat = (async () => {
      await readiness.wait();
      order.push("chat-started");
    })();

    await vi.waitFor(() => expect(order).toEqual(["bootstrap-started"]));
    releaseBootstrap?.();
    await Promise.all([bootstrap, firstChat]);

    expect(order).toEqual(["bootstrap-started", "bootstrap-ready", "chat-started"]);
  });

  it("lets an aborted chat stop waiting without cancelling Provider bootstrap", async () => {
    let releaseBootstrap: (() => void) | undefined;
    const readiness = createCommercialOpenClawReadinessGate();
    const bootstrap = readiness.run(() => new Promise<void>((resolve) => { releaseBootstrap = resolve; }));
    const controller = new AbortController();
    const waiting = readiness.wait(controller.signal);

    controller.abort(new DOMException("Chat cancelled", "AbortError"));
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    releaseBootstrap?.();
    await bootstrap;
    await expect(readiness.wait()).resolves.toBeUndefined();
  });

  it("reads the global model catalog with deviceToken without returning or logging it", async () => {
    const token = `uclaw_dt_${"C".repeat(43)}`;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: "deepseek-chat", name: "DeepSeek" },
      { id: "qwen-max" },
    ] }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(fetchCommercialModels({
      endpoint: new URL("https://commercial.example.test/model-api/"),
      deviceToken: token,
    }, fetch as typeof globalThis.fetch)).resolves.toEqual([
      { id: "deepseek-chat", name: "DeepSeek" },
      { id: "qwen-max", name: "qwen-max" },
    ]);
    expect(fetch).toHaveBeenCalledWith(new URL("https://commercial.example.test/model-api/v1/models"), expect.objectContaining({
      headers: expect.objectContaining({ authorization: `Bearer ${token}` }),
    }));
    expect(JSON.stringify(await fetchCommercialModels({
      endpoint: new URL("https://commercial.example.test/model-api/"),
      deviceToken: token,
    }, fetch as typeof globalThis.fetch))).not.toContain(token);
  });

  it("writes, applies, restarts, reconnects, then reads config and models back", async () => {
    const order: string[] = [];
    const credential = {
      endpoint: new URL("https://commercial.example.test/model-api/v1/"),
      deviceToken: `uclaw_dt_${"N".repeat(43)}`,
    };
    const store = {
      credentialPath: "/portable/data/.uclaw/builtin-model-credential.v1.json",
      provision: vi.fn(async () => { order.push("write"); }),
      loadActive: vi.fn(async () => credential),
    };
    const config = {
      synchronizeCommercial: vi.fn(async () => { order.push("apply"); return true; }),
      readCommercial: vi.fn(async () => { order.push("config.get"); return { configured: true }; }),
    };
    const gateway = { restartManagedGateway: vi.fn(async () => { order.push("restart"); }) };
    const reconnect = vi.fn(async () => { order.push("reconnect"); });
    const listModels = vi.fn(async () => { order.push("models.list"); return [
      { id: "uclaw-commercial/deepseek-chat", available: true },
      { id: "uclaw-commercial/qwen-max", available: true },
    ]; });
    const fetchModels = vi.fn(async () => {
      order.push("catalog");
      return [{ id: "deepseek-chat", name: "DeepSeek" }, { id: "qwen-max", name: "Qwen" }];
    });

    await rotateCommercialOpenClawCredential({
      next: { schemaVersion: 2, deviceId: "device-001", licenseId: "license-001", endpoint: credential.endpoint.href, deviceToken: credential.deviceToken },
      store,
      config,
      gateway,
      reconnect,
      listModels,
      fetchModels,
    });

    expect(order).toEqual(["write", "catalog", "apply", "restart", "reconnect", "config.get", "models.list"]);
    expect(config.synchronizeCommercial).toHaveBeenCalledWith({
      endpoint: credential.endpoint.href,
      credentialPath: store.credentialPath,
      models: [{ id: "deepseek-chat", name: "DeepSeek" }, { id: "qwen-max", name: "Qwen" }],
    });
    expect(JSON.stringify(config.synchronizeCommercial.mock.calls)).not.toContain(credential.deviceToken);
  });

  it("fails closed when authoritative model readback omits an enabled model", async () => {
    const token = `uclaw_dt_${"R".repeat(43)}`;
    await expect(rotateCommercialOpenClawCredential({
      next: { schemaVersion: 2, deviceId: "device-001", licenseId: "license-001", endpoint: "https://commercial.example.test/model-api/v1/", deviceToken: token },
      store: { credentialPath: "/credential.json", provision: async () => undefined, loadActive: async () => ({ endpoint: new URL("https://commercial.example.test/model-api/v1/"), deviceToken: token }) },
      config: { synchronizeCommercial: async () => true, readCommercial: async () => ({ configured: true }) },
      gateway: { restartManagedGateway: async () => undefined },
      reconnect: async () => undefined,
      fetchModels: async () => [{ id: "deepseek-chat", name: "DeepSeek" }],
      listModels: async () => [],
    })).rejects.toThrow("readback");
  });
});
