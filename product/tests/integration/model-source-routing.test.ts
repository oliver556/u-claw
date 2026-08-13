import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BuiltinModelRequest, MessageEvent, SendMessageInput } from "@uclaw/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNewApiManagementClient,
  startLocalNewApiManagementServer,
  type LocalNewApiManagementServer,
} from "../../desktop/src/new-api-management/index.js";
import { BuiltinServiceClientError } from "../../desktop/src/providers/builtin-service-client.js";
import { createMainProcessModelRouting, createModelSourceRouter, ModelSourceFailure } from "../../desktop/src/providers/model-source-router.js";
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

  it("applies authoritative service and device lifecycle changes without builtin fallback or reprovisioning", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-routing-lifecycle-"));
    roots.push(dataDir);
    let licenseState: "active" | "revoked" | "disabled" | "expired" | "reissued" = "active";
    let licenseRevision = 1;
    let upstreamCalls = 0;
    const upstreamRequests: BuiltinModelRequest[] = [];
    const server = await startLocalNewApiManagementServer({
      managementCredential: "fixture-lifecycle-management-credential",
      now: () => new Date("2026-08-11T00:00:00.000Z"),
      builtin: {
        readLicenseStatus: async (licenseId) => ({
          licenseId,
          deviceId: "route_lifecycle_device",
          status: licenseState,
          revision: licenseRevision,
          notBefore: "2026-08-10T00:00:00.000Z",
          expiresAt: "2027-08-10T00:00:00.000Z",
          replacementLicenseId: licenseState === "reissued" ? "route_replacement_license" : null,
          updatedAt: "2026-08-11T00:00:00.000Z",
        }),
        execute: async (request) => {
          upstreamCalls += 1;
          upstreamRequests.push(request);
          return { output: "builtin-answer", usage: { inputTokens: 1, outputTokens: 1 } };
        },
      },
    });
    servers.push(server);
    const management = createNewApiManagementClient({
      endpoint: server.url,
      managementCredential: "fixture-lifecycle-management-credential",
      allowLoopbackHttp: true,
    });
    const user = await management.createUser({
      idempotencyKey: "route-lifecycle-user",
      deviceId: "route_lifecycle_device",
      username: "route_lifecycle_user",
    });
    const policy = {
      quota: { unit: "requests" as const, limit: 100, period: "daily" as const },
      rateLimit: { requestsPerMinute: 60, concurrentRequests: 2 },
      allowedModels: ["builtin-model"],
      disabled: false,
    };
    await management.updatePolicy(user.id, policy);
    const policyDigest = createHash("sha256").update("uclaw-new-api-policy-v1\0").update(JSON.stringify(policy)).digest("hex");
    const issued = await management.createToken({
      idempotencyKey: "route-lifecycle-token",
      userId: user.id,
      name: "device",
      channelId: "route_lifecycle_channel",
      policyDigest,
      generation: 1,
    });
    const provisioning = await management.createDeviceMapping({
      idempotencyKey: "route-lifecycle-mapping",
      deviceId: "route_lifecycle_device",
      licenseId: "route_lifecycle_license",
      startupSecretHash: "a".repeat(64),
      startupSecretSalt: "b".repeat(32),
      usbFingerprint: "c".repeat(64),
      newApiUserId: user.id,
      newApiUsername: user.username,
      newApiTokenId: issued.token.id,
      channelId: "route_lifecycle_channel",
      policyDigest,
      generation: 1,
      previousTokenId: null,
      status: "provisioning",
    });
    const mapping = await management.updateDeviceStatus(provisioning.deviceId, {
      idempotencyKey: "route-lifecycle-mapping-active",
      status: "active",
      expectedStatus: "provisioning",
      expectedGeneration: 1,
      expectedLicenseId: provisioning.licenseId,
      expectedTokenId: issued.token.id,
    });
    const activeToken = await management.activateToken(issued.token.id, {
      idempotencyKey: "route-lifecycle-token-active",
      deviceId: mapping.deviceId,
    });
    await management.updateServiceStatus({
      idempotencyKey: "route-lifecycle-service-enable",
      expectedRevision: 1,
      state: "enabled",
      reasonCode: "OPERATOR_ENABLED",
    });

    const providers = createProviderStore({ dataDir });
    const domestic = vi.fn(async (input: SendMessageInput) => externalEvents(input.sessionId, "domestic"));
    const custom = vi.fn(async (input: SendMessageInput) => externalEvents(input.sessionId, "custom"));
    // Legacy New API fixture uses its issued token directly. Formal persisted
    // device credentials are covered by activation-model-proxy.test.ts.
    const credential = {
      endpoint: new URL(server.dataUrl),
      model: "builtin-model",
      deviceId: mapping.deviceId,
      licenseId: mapping.licenseId,
      deviceToken: issued.secret,
    };
    const credentials = {
      pinnedFilesystem: false,
      provision: async () => undefined,
      loadActive: async () => credential,
      loadForConnectivityCheck: async () => credential,
      clear: async () => undefined,
    };
    const router = createModelSourceRouter({
      providers,
      credentials,
      executors: {
        domestic,
        custom,
        builtin: async (input: SendMessageInput, activeCredential, signal) => {
          if (signal?.aborted) throw new BuiltinServiceClientError("cancelled", "OPERATION_CANCELLED", "Builtin request was cancelled.", false);
          const prompt = input.blocks.map((block) => block.type === "text" ? block.text : "").join("\n\n");
          const modelRequest = {
            schemaVersion: 1,
            requestId: `req_${createHash("sha256").update(input.clientRequestId).digest("hex").slice(0, 32)}`,
            model: activeCredential.model,
            prompt,
            maxOutputTokens: 4_096,
          } as const;
          const legacyResponse = await fetch(new URL("models/respond", activeCredential.endpoint), {
            method: "POST",
            headers: { authorization: `Bearer ${activeCredential.deviceToken}`, "content-type": "application/json" },
            body: JSON.stringify(modelRequest),
            signal,
          });
          const response = await legacyResponse.json() as {
            output?: string;
            error?: { category?: ConstructorParameters<typeof BuiltinServiceClientError>[0]; code?: string; retryable?: boolean };
          };
          if (!legacyResponse.ok) {
            const failure = response.error ?? {};
            throw new BuiltinServiceClientError(
              failure.category ?? "invalid-response",
              failure.code ?? "INVALID_ERROR_BODY",
              "Legacy builtin fixture rejected request.",
              failure.retryable ?? false,
            );
          }
          return (async function* (): AsyncIterable<MessageEvent> {
            const runId = `run_${createHash("sha256").update(input.clientRequestId).digest("hex").slice(0, 32)}`;
            yield { type: "started", runId, sessionId: input.sessionId };
            yield { type: "delta", runId, mode: "append", text: response.output ?? "" };
            yield { type: "final", runId, message: { id: `msg_${runId.slice(4)}`, sessionId: input.sessionId, runId, role: "assistant", status: "completed", blocks: [{ id: `block_${runId.slice(4)}`, type: "text", text: response.output ?? "", format: "markdown" }], createdAt: "2026-08-11T00:00:00.000Z" } };
          })();
        },
      },
    });
    const routing = { credentials, routeChatSend: router.execute };
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
    expect(serializedEvents).not.toContain(server.dataUrl);
    expect(serializedEvents).not.toContain(issued.secret);
    expect(serializedEvents).not.toContain("builtin-model");
    expect(upstreamRequests[0]).toMatchObject({
      schemaVersion: 1,
      model: "builtin-model",
      prompt: "hello\n\nworld",
      maxOutputTokens: 4_096,
    });
    expect(upstreamRequests[0]?.requestId).toMatch(/^req_[a-f0-9]{32}$/u);
    const aborted = new AbortController();
    aborted.abort();
    await expect(routeBuiltin(aborted.signal)).rejects.toMatchObject({
      category: "cancelled", code: "OPERATION_CANCELLED", retryable: false,
    });
    await management.updateServiceStatus({
      idempotencyKey: "route-lifecycle-service-degraded",
      expectedRevision: 2,
      state: "degraded",
      reasonCode: "DEGRADED_HEALTH",
    });
    await expect(collectEvents(routeBuiltin())).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "delta", text: "builtin-answer" }),
    ]));

    await management.updateServiceStatus({
      idempotencyKey: "route-lifecycle-service-maintenance",
      expectedRevision: 3,
      state: "maintenance",
      reasonCode: "SCHEDULED_MAINTENANCE",
    });
    await expect(routeBuiltin()).rejects.toMatchObject({ category: "unavailable", code: "SERVICE_MAINTENANCE", retryable: false });
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
    await management.updateServiceStatus({
      idempotencyKey: "route-lifecycle-service-disable",
      expectedRevision: 4,
      state: "disabled",
      reasonCode: "OPERATOR_DISABLED",
    });
    await expect(routeBuiltin()).rejects.toMatchObject({ category: "unavailable", code: "SERVICE_DISABLED", retryable: false });
    await management.updateServiceStatus({
      idempotencyKey: "route-lifecycle-service-reenable",
      expectedRevision: 5,
      state: "enabled",
      reasonCode: "RECOVERY_COMPLETE",
    });

    const controls = await management.getDeviceControls({ deviceId: mapping.deviceId });
    await management.updateDeviceControls({ deviceId: mapping.deviceId }, {
      idempotencyKey: "route-lifecycle-policy-disable",
      expectedRevision: controls.revision,
      expectedGeneration: controls.generation,
      expectedLicenseId: controls.licenseId,
      expectedTokenId: controls.tokenId,
      policy: { ...controls.policy, disabled: true },
    });
    await expect(routeBuiltin()).rejects.toMatchObject({ category: "disabled", code: "DEVICE_DISABLED" });
    const disabledControls = await management.getDeviceControls({ deviceId: mapping.deviceId });
    await management.updateDeviceControls({ deviceId: mapping.deviceId }, {
      idempotencyKey: "route-lifecycle-policy-reenable",
      expectedRevision: disabledControls.revision,
      expectedGeneration: disabledControls.generation,
      expectedLicenseId: disabledControls.licenseId,
      expectedTokenId: disabledControls.tokenId,
      policy,
    });
    await expect(collectEvents(routeBuiltin())).resolves.toHaveLength(3);

    for (const state of ["revoked", "disabled", "expired", "reissued"] as const) {
      licenseState = state;
      licenseRevision += 1;
      await expect(routeBuiltin()).rejects.toMatchObject({ category: "authentication", code: "AUTHENTICATION_FAILED" });
    }
    licenseState = "active";
    licenseRevision += 1;
    await expect(collectEvents(routeBuiltin())).resolves.toHaveLength(3);

    await management.updateDeviceStatus(mapping.deviceId, {
      idempotencyKey: "route-lifecycle-mapping-disable",
      status: "disabled",
      expectedStatus: "active",
      expectedGeneration: mapping.generation,
      expectedLicenseId: mapping.licenseId,
      expectedTokenId: mapping.newApiTokenId,
    });
    await expect(routeBuiltin()).rejects.toMatchObject({ category: "authentication", code: "AUTHENTICATION_FAILED" });
    await management.updateDeviceStatus(mapping.deviceId, {
      idempotencyKey: "route-lifecycle-mapping-reenable",
      status: "active",
      expectedStatus: "disabled",
      expectedGeneration: mapping.generation,
      expectedLicenseId: mapping.licenseId,
      expectedTokenId: mapping.newApiTokenId,
    });
    await expect(collectEvents(routeBuiltin())).resolves.toHaveLength(3);

    await management.revokeToken(issued.token.id, { idempotencyKey: "route-lifecycle-token-revoke" });
    await expect(routeBuiltin()).rejects.toMatchObject({ category: "authentication", code: "AUTHENTICATION_FAILED" });
    expect(domestic).toHaveBeenCalledOnce();
    expect(custom).toHaveBeenCalledOnce();
  });
});
