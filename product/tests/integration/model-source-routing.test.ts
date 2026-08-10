import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNewApiManagementClient,
  startLocalNewApiManagementServer,
  type LocalNewApiManagementServer,
} from "../../desktop/src/new-api-management/index.js";
import { createMainProcessModelRouting, ModelSourceFailure } from "../../desktop/src/providers/model-source-router.js";
import { createProviderStore } from "../../desktop/src/providers/provider-store.js";

const servers: LocalNewApiManagementServer[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
      idempotencyKey: "route-active-001", status: "active",
    });

    const providers = createProviderStore({ dataDir });
    const builtin = vi.fn(async () => ({ source: "builtin" as const }));
    const domestic = vi.fn(async () => { throw new ModelSourceFailure("domestic", "quota"); });
    const custom = vi.fn(async () => ({ source: "custom" as const }));
    const routing = createMainProcessModelRouting({
      dataDir, providers, allowLoopbackHttp: true, executors: { builtin, domestic, custom },
    });
    const endpoint = new URL("/v1", server.url).href;
    await routing.credentials.provision({ endpoint, model: "builtin-model", mapping, issuedToken });

    await expect(routing.routeChatSend({ prompt: "first" })).resolves.toEqual({ source: "builtin" });
    await providers.setEnabled("deepseek", true);
    const externalError = await routing.routeChatSend({ prompt: "external" }).catch((error: unknown) => error);
    expect(externalError).toMatchObject({ source: "domestic", category: "quota", code: "MODEL_UNAVAILABLE" });
    expect(builtin).toHaveBeenCalledOnce();
    expect(domestic).toHaveBeenCalledOnce();
    expect(custom).not.toHaveBeenCalled();

    const serialized = JSON.stringify(externalError);
    expect(serialized).not.toContain(endpoint);
    expect(serialized).not.toContain(user.username);
    expect(serialized).not.toContain(issuedToken.secret);
  });
});
