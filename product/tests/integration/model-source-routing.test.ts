import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MessageEvent, SendMessageInput } from "@uclaw/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNewApiManagementClient,
  startLocalNewApiManagementServer,
  type LocalNewApiManagementServer,
} from "../../desktop/src/new-api-management/index.js";
import { createBuiltinServiceClient } from "../../desktop/src/providers/builtin-service-client.js";
import { createMainProcessModelRouting, ModelSourceFailure } from "../../desktop/src/providers/model-source-router.js";
import { createProviderStore } from "../../desktop/src/providers/provider-store.js";

const servers: LocalNewApiManagementServer[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function collectEvents(stream: AsyncIterable<MessageEvent> | Promise<AsyncIterable<MessageEvent>>): Promise<MessageEvent[]> {
  const events: MessageEvent[] = [];
  for await (const event of await stream) events.push(event);
  return events;
}

function externalEvents(sessionId: string, source: "domestic" | "custom"): AsyncIterable<MessageEvent> {
  const runId = `run_${source}_fixture`;
  return (async function* (): AsyncIterable<MessageEvent> {
    yield { type: "started", runId, sessionId };
    yield { type: "delta", runId, mode: "append", text: source };
    yield {
      type: "final",
      runId,
      message: {
        id: `msg_${source}_fixture`, sessionId, runId, role: "assistant", status: "completed",
        blocks: [{ id: `block_${source}_fixture`, type: "text", text: source, format: "plain" }],
        createdAt: "2026-08-11T00:00:00.000Z",
      },
    };
  })();
}

describe("typed New API model source routing integration", () => {
  it("keeps builtin quota and credentials isolated when an external source is active", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-routing-integration-"));
    roots.push(dataDir);
    const server = await startLocalNewApiManagementServer({ managementCredential: "fixture-management-credential" });
    servers.push(server);
    const management = createNewApiManagementClient({
      endpoint: server.url, managementCredential: "fixture-management-credential", allowLoopbackHttp: true,
    });
    const user = await management.createUser({ idempotencyKey: "route-user-001", deviceId: "route_device", username: "route_user" });
    const policy = {
      quota: { unit: "tokens" as const, limit: 100_000, period: "monthly" as const },
      rateLimit: { requestsPerMinute: 60, concurrentRequests: 2 },
      allowedModels: ["builtin-model"], disabled: false,
    };
    await management.updatePolicy(user.id, policy);
    const policyDigest = createHash("sha256").update("uclaw-new-api-policy-v1\0").update(JSON.stringify(policy)).digest("hex");
    const issuedToken = await management.createToken({
      idempotencyKey: "route-token-001", userId: user.id, name: "device",
      channelId: "channel_builtin_001", policyDigest, generation: 1,
    });
    const provisioning = await management.createDeviceMapping({
      idempotencyKey: "route-device-001", deviceId: "route_device", licenseId: "route_license",
      startupSecretHash: "a".repeat(64), startupSecretSalt: "b".repeat(32), usbFingerprint: "c".repeat(64),
      newApiUserId: user.id, newApiUsername: user.username, newApiTokenId: issuedToken.token.id, status: "provisioning",
      channelId: "channel_builtin_001", policyDigest, generation: 1, previousTokenId: null,
    });
    const mapping = await management.updateDeviceStatus(provisioning.deviceId, {
      idempotencyKey: "route-active-001", status: "active", expectedStatus: "provisioning",
      expectedGeneration: 1, expectedLicenseId: provisioning.licenseId, expectedTokenId: issuedToken.token.id,
    });
    const activeToken = await management.activateToken(issuedToken.token.id, {
      idempotencyKey: "route-token-active-001", deviceId: provisioning.deviceId,
    });

    const providers = createProviderStore({ dataDir });
    const domestic = vi.fn(async () => { throw new ModelSourceFailure("domestic", "quota"); });
    const custom = vi.fn(async (input: SendMessageInput) => externalEvents(input.sessionId, "custom"));
    const routing = createMainProcessModelRouting({
      dataDir, providers, allowLoopbackHttp: true, executors: { domestic, custom },
    });
    const endpoint = new URL("/v1", server.url).href;
    await routing.credentials.provision({
      schemaVersion: 1,
      endpoint,
      model: "builtin-model",
      deviceId: mapping.deviceId,
      licenseId: mapping.licenseId,
      deviceToken: `uclaw_dt_${"F".repeat(43)}`,
    });

    const loadActive = vi.spyOn(routing.credentials, "loadActive");
    await providers.setEnabled("deepseek", true);
    const externalError = await routing.routeChatSend({
      sessionId: "route_external_session",
      clientRequestId: "route_external_request",
      blocks: [{ type: "text", text: "external", format: "plain" }],
    }).catch((error: unknown) => error);
    expect(externalError).toMatchObject({ source: "domestic", category: "quota", code: "MODEL_UNAVAILABLE" });
    expect(loadActive).not.toHaveBeenCalled();
    expect(domestic).toHaveBeenCalledOnce();
    expect(custom).not.toHaveBeenCalled();

    const serialized = JSON.stringify(externalError);
    expect(serialized).not.toContain(endpoint);
    expect(serialized).not.toContain(user.username);
    expect(serialized).not.toContain(issuedToken.secret);
  });

  it("routes lifecycle changes through the production credential, client, and event path", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-routing-lifecycle-"));
    roots.push(dataDir);
    type ProxyState = "active" | "degraded" | "service-unavailable" | "device-revoked";
    let proxyState: ProxyState = "active";
    let upstreamCalls = 0;
    const proxyRequests: Array<{ authorization: string; body: unknown }> = [];
    const deviceToken = `uclaw_dt_${"L".repeat(43)}`;
    const proxyFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const authorization = headers.get("authorization") ?? "";
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
      proxyRequests.push({ authorization, body });
      if (authorization !== `Bearer ${deviceToken}` || proxyState === "device-revoked") {
        return Response.json({ code: "AUTHENTICATION_FAILED", message: "Device credential rejected.", requestId: "route-auth-rejected" }, { status: 401 });
      }
      if (proxyState === "service-unavailable") {
        return Response.json({ code: "SERVICE_UNAVAILABLE", message: "Builtin service unavailable.", requestId: "route-service-unavailable" }, { status: 503 });
      }
      upstreamCalls += 1;
      return Response.json({
        id: "route-chat-001", object: "chat.completion", created: 1, model: "builtin-model",
        choices: [{ index: 0, message: { role: "assistant", content: "builtin-answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
    const providers = createProviderStore({ dataDir });
    const domestic = vi.fn(async (input: SendMessageInput) => externalEvents(input.sessionId, "domestic"));
    const custom = vi.fn(async (input: SendMessageInput) => externalEvents(input.sessionId, "custom"));
    const routing = createMainProcessModelRouting({
      dataDir, providers, allowLoopbackHttp: true, executors: { domestic, custom },
      builtinDataClient: createBuiltinServiceClient({ allowLoopbackHttp: true, fetch: proxyFetch }),
    });
    await routing.credentials.provision({
      schemaVersion: 1, deviceId: "route_lifecycle_device", licenseId: "route_lifecycle_license",
      endpoint: "http://127.0.0.1/model-api/", model: "builtin-model", deviceToken,
    });
    let requestSequence = 0;
    const routeBuiltin = (signal?: AbortSignal) => routing.routeChatSend({
      sessionId: "route_lifecycle_session",
      clientRequestId: `route_lifecycle_request_${++requestSequence}`,
      blocks: [
        { type: "text", text: "hello", format: "plain" },
        { type: "text", text: "world", format: "markdown" },
      ],
    } satisfies SendMessageInput, signal);

    const initialEvents = await collectEvents(routeBuiltin());
    expect(initialEvents).toMatchObject([
      { type: "started", sessionId: "route_lifecycle_session" },
      { type: "delta", mode: "append", text: "builtin-answer" },
      { type: "final", message: { status: "completed", role: "assistant" } },
    ]);
    expect(initialEvents[0]).toMatchObject({ runId: expect.stringMatching(/^run_[a-f0-9]{32}$/u) });
    expect(initialEvents[2]).toMatchObject({
      runId: expect.stringMatching(/^run_[a-f0-9]{32}$/u),
      message: {
        id: expect.stringMatching(/^msg_[a-f0-9]{32}$/u),
        blocks: [expect.objectContaining({ id: expect.stringMatching(/^block_[a-f0-9]{32}$/u) })],
      },
    });
    const serializedEvents = JSON.stringify(initialEvents);
    expect(serializedEvents).not.toContain("http://127.0.0.1/model-api/");
    expect(serializedEvents).not.toContain(deviceToken);
    expect(serializedEvents).not.toContain("builtin-model");
    expect(proxyRequests[0]).toEqual({
      authorization: `Bearer ${deviceToken}`,
      body: { model: "builtin-model", messages: [{ role: "user", content: "hello\n\nworld" }], max_tokens: 4_096, stream: false },
    });
    const aborted = new AbortController();
    aborted.abort();
    await expect(routeBuiltin(aborted.signal)).rejects.toMatchObject({
      category: "cancelled", code: "OPERATION_CANCELLED", retryable: false,
    });
    proxyState = "degraded";
    await expect(collectEvents(routeBuiltin())).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "delta", text: "builtin-answer" }),
    ]));

    proxyState = "service-unavailable";
    await expect(routeBuiltin()).rejects.toMatchObject({ category: "unavailable", code: "SERVICE_UNAVAILABLE", retryable: true });
    const callsBeforeExternal = upstreamCalls;
    const loadActive = vi.spyOn(routing.credentials, "loadActive");
    await providers.setApiKey("deepseek", randomBytes(24).toString("hex"));
    await providers.setEnabled("deepseek", true);
    await expect(collectEvents(routeBuiltin())).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "delta", text: "domestic" }),
    ]));
    expect(upstreamCalls).toBe(callsBeforeExternal);
    expect(loadActive).not.toHaveBeenCalled();
    await providers.create({
      id: "route-lifecycle-custom",
      name: "Lifecycle custom",
      enabled: true,
      baseUrl: "https://custom.example.test/v1",
      model: "custom-model",
    });
    await providers.setApiKey("route-lifecycle-custom", randomBytes(24).toString("hex"));
    await expect(collectEvents(routeBuiltin())).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "delta", text: "custom" }),
    ]));
    expect(upstreamCalls).toBe(callsBeforeExternal);
    expect(loadActive).not.toHaveBeenCalled();
    loadActive.mockRestore();
    await providers.remove("route-lifecycle-custom");
    await providers.setEnabled("deepseek", false);
    proxyState = "active";
    await expect(collectEvents(routeBuiltin())).resolves.toHaveLength(3);
    proxyState = "device-revoked";
    const revokedError = await routeBuiltin().catch((error: unknown) => error);
    expect(revokedError).toMatchObject({ category: "authentication", code: "AUTHENTICATION_FAILED" });
    expect(JSON.stringify(revokedError)).not.toContain(deviceToken);
    proxyState = "active";
    await expect(collectEvents(routeBuiltin())).resolves.toHaveLength(3);
    expect(domestic).toHaveBeenCalledOnce();
    expect(custom).toHaveBeenCalledOnce();
  });
});
