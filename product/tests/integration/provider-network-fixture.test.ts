import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createProviderDispatcher } from "../../desktop/src/providers/provider-dispatcher.js";
import { createProviderNetworkService } from "../../desktop/src/providers/provider-network.js";
import { createProviderStore } from "../../desktop/src/providers/provider-store.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((dispose) => dispose())));

describe("provider network fixture mainline", () => {
  it("carries a stored main-process key through a minimal request and returns only a fixed result", async () => {
    const key = "sk-fixture-main-only-12345678";
    const server = createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe(`Bearer ${key}`);
      response.end(JSON.stringify({ choices: [{ message: { content: "private fixture response" } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind");

    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-provider-integration-"));
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
    const store = createProviderStore({ dataDir });
    await store.create({ id: "fixture", name: "Fixture", enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "fixture-model" });
    await store.setApiKey("fixture", key);
    const dispatch = createProviderDispatcher(store, createProviderNetworkService({ verifyTimeoutMs: 500 }));

    const response = await dispatch({ method: "providers.verify", requestId: "fixture-verify", params: { providerId: "fixture" } });
    expect(response).toEqual({
      method: "providers.verify", requestId: "fixture-verify", ok: true,
      result: { state: "succeeded", category: "ok", code: "OK", message: "连接成功。", retryable: false },
    });
    expect(JSON.stringify(response)).not.toMatch(/integration-main-only|private fixture response|authorization|headers|body/iu);
  });
});
