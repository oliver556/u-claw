import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NewApiDeviceMapping, NewApiIssuedToken } from "@uclaw/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { redactAdapterRecord } from "../../adapter/src/redaction.js";
import { createBuiltinCredentialStore } from "../src/providers/builtin-credential-store.js";
import { BuiltinServiceClientError } from "../src/providers/builtin-service-client.js";
import { ModelSourceFailure, createMainProcessModelRouting, createModelSourceRouter } from "../src/providers/model-source-router.js";
import { createProviderStore } from "../src/providers/provider-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function typedCredential(endpoint = "http://127.0.0.1:18091/v1") {
  const suffix = randomUUID().replaceAll("-", "");
  const timestamp = new Date().toISOString();
  const userId = `usr_${suffix}`;
  const tokenId = `tok_${suffix}`;
  const mapping: NewApiDeviceMapping = {
    deviceId: `dev_${suffix}`, licenseId: `lic_${suffix}`,
    startupSecretHash: "a".repeat(64), startupSecretSalt: "b".repeat(32), usbFingerprint: "c".repeat(64),
    newApiUserId: userId, newApiUsername: `user_${suffix}`, newApiTokenId: tokenId,
    channelId: "channel_builtin_001", policyDigest: "d".repeat(64), generation: 1, previousTokenId: null,
    status: "active", failure: null, createdAt: timestamp, updatedAt: timestamp,
  };
  const issuedToken: NewApiIssuedToken = {
    token: {
      id: tokenId, userId, name: "device", channelId: mapping.channelId,
      policyDigest: mapping.policyDigest, generation: mapping.generation,
      status: "active", createdAt: timestamp, updatedAt: timestamp,
    },
    secret: randomBytes(32).toString("base64url"),
  };
  return { endpoint, model: "builtin-model", mapping, issuedToken };
}

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "uclaw-model-router-"));
  roots.push(dataDir);
  const providers = createProviderStore({ dataDir });
  const credentials = createBuiltinCredentialStore({ dataDir, allowLoopbackHttp: true });
  const credential = typedCredential();
  await credentials.provision(credential);
  const builtin = vi.fn(async () => "builtin-result");
  const domestic = vi.fn(async () => "domestic-result");
  const custom = vi.fn(async () => "custom-result");
  const router = createModelSourceRouter({ providers, credentials, executors: { builtin, domestic, custom } });
  return { providers, credentials, credential, router, builtin, domestic, custom };
}

describe("model source router", () => {
  it("assembles credential storage and routing inside the main-process boundary", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-main-model-route-"));
    roots.push(dataDir);
    const providers = createProviderStore({ dataDir });
    const builtin = vi.fn(async () => "builtin-result");
    const routing = createMainProcessModelRouting({
      dataDir,
      providers,
      allowLoopbackHttp: true,
      executors: { builtin, domestic: vi.fn(), custom: vi.fn() },
    });
    await routing.credentials.provision(typedCredential());
    await expect(routing.routeChatSend({ prompt: "main" })).resolves.toBe("builtin-result");
    expect(builtin).toHaveBeenCalledOnce();
  });

  it("uses builtin when no external source is explicitly enabled", async () => {
    const context = await setup();
    await expect(context.router.execute({ prompt: "hello" })).resolves.toBe("builtin-result");
    expect(context.builtin).toHaveBeenCalledOnce();
    expect(context.domestic).not.toHaveBeenCalled();
    expect(context.custom).not.toHaveBeenCalled();
  });

  it("rejects provisioning credentials for ordinary builtin chat", async () => {
    const context = await setup();
    await context.credentials.provision({
      ...context.credential,
      mapping: { ...context.credential.mapping, status: "provisioning" },
      issuedToken: {
        ...context.credential.issuedToken,
        token: { ...context.credential.issuedToken.token, status: "provisioning" },
      },
    });

    await expect(context.router.execute({ prompt: "not-active" })).rejects.toMatchObject({
      source: "builtin", category: "configuration",
    });
    expect(context.builtin).not.toHaveBeenCalled();
  });

  it("routes only to the last explicitly enabled domestic or custom source", async () => {
    const context = await setup();
    await context.providers.setApiKey("deepseek", randomBytes(24).toString("hex"));
    await context.providers.setEnabled("deepseek", true);
    await expect(context.router.execute({ prompt: "domestic" })).resolves.toBe("domestic-result");

    await context.providers.create({
      id: "custom-main", name: "Custom", enabled: true,
      baseUrl: "https://custom.example.test/v1", model: "custom-model",
    });
    await context.providers.setApiKey("custom-main", randomBytes(24).toString("hex"));
    await context.providers.setEnabled("custom-main", true);
    await expect(context.router.execute({ prompt: "custom" })).resolves.toBe("custom-result");

    await context.providers.setEnabled("deepseek", true);
    await expect(context.router.execute({ prompt: "domestic-again" })).resolves.toBe("domestic-result");
    expect(context.builtin).not.toHaveBeenCalled();
    expect(context.domestic).toHaveBeenCalledTimes(2);
    expect(context.custom).toHaveBeenCalledOnce();
  });

  it("returns to builtin when the active external source is disabled or removed", async () => {
    const context = await setup();
    await context.providers.setEnabled("kimi", true);
    await context.providers.setEnabled("kimi", false);
    await expect(context.router.execute({ prompt: "after-disable" })).resolves.toBe("builtin-result");

    await context.providers.create({
      id: "custom-clear", name: "Custom", enabled: true,
      baseUrl: "https://custom.example.test/v1", model: "custom-model",
    });
    await context.providers.remove("custom-clear");
    await expect(context.router.execute({ prompt: "after-remove" })).resolves.toBe("builtin-result");
    expect(context.builtin).toHaveBeenCalledTimes(2);
  });

  it.each(["authentication", "quota", "rate-limit", "network"] as const)(
    "reports external %s failure without invoking builtin",
    async (category) => {
      const context = await setup();
      await context.providers.setEnabled("qwen", true);
      context.domestic.mockRejectedValueOnce(new ModelSourceFailure("domestic", category));
      await expect(context.router.execute({ prompt: category })).rejects.toMatchObject({ source: "domestic", category });
      expect(context.builtin).not.toHaveBeenCalled();
    },
  );

  it("preserves typed builtin failure classification without retry or external fallback", async () => {
    const context = await setup();
    const failure = new BuiltinServiceClientError(
      "unavailable",
      "SERVICE_MAINTENANCE",
      "Builtin service is unavailable.",
      false,
    );
    context.builtin.mockRejectedValueOnce(failure);

    await expect(context.router.execute({ prompt: "maintenance" })).rejects.toBe(failure);
    expect(context.builtin).toHaveBeenCalledOnce();
    expect(context.domestic).not.toHaveBeenCalled();
    expect(context.custom).not.toHaveBeenCalled();
  });

  it("keeps external requests and quota isolated from builtin", async () => {
    const context = await setup();
    const loadActive = vi.spyOn(context.credentials, "loadActive");
    await context.providers.setEnabled("minimax", true);
    await context.router.execute({ prompt: "external-only" });
    expect(context.domestic).toHaveBeenCalledOnce();
    expect(context.builtin).not.toHaveBeenCalled();
    expect(loadActive).not.toHaveBeenCalled();

    await context.providers.create({
      id: "custom-isolated",
      name: "Custom isolated",
      enabled: true,
      baseUrl: "https://custom.example.test/v1",
      model: "custom-model",
    });
    await context.providers.setApiKey("custom-isolated", randomBytes(24).toString("hex"));
    await context.router.execute({ prompt: "custom-only" });
    expect(context.custom).toHaveBeenCalledOnce();
    expect(context.builtin).not.toHaveBeenCalled();
    expect(loadActive).not.toHaveBeenCalled();
  });

  it("fails closed without builtin credential and never projects secrets into errors or redaction output", async () => {
    const context = await setup();
    await context.credentials.clear();
    const error = await context.router.execute({ prompt: "missing" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      source: "builtin", category: "configuration", code: "UNAVAILABLE",
      retryable: false, recoveryActions: [], causeDetails: {},
    });
    const serialized = JSON.stringify({ error, log: redactAdapterRecord({
      builtinEndpoint: context.credential.endpoint,
      newApiUsername: context.credential.mapping.newApiUsername,
      builtinToken: context.credential.issuedToken.secret,
    }) });
    expect(serialized).not.toContain(context.credential.endpoint);
    expect(serialized).not.toContain(context.credential.mapping.newApiUsername);
    expect(serialized).not.toContain(context.credential.issuedToken.secret);
  });
});
