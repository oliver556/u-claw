import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  return {
    schemaVersion: 1 as const,
    deviceId: `dev_${suffix}`,
    licenseId: `lic_${suffix}`,
    endpoint,
    model: "gpt-5.6-sol",
    deviceToken: `uclaw_dt_${"A".repeat(43)}`,
  };
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
  it("keeps ordinary Electron chat free of model-inference direct clients", async () => {
    const source = await readFile(new URL("../src/providers/model-source-router.ts", import.meta.url), "utf8");

    expect(source).not.toContain("createBuiltinServiceClient");
    expect(source).not.toContain("builtinDataClient.execute");
  });

  it("keeps the typed builtin client inside the main-process boundary", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-main-model-route-"));
    roots.push(dataDir);
    const providers = createProviderStore({ dataDir });
    const bypass = vi.fn(async () => "bypassed-result");
    const executors = { builtin: bypass, domestic: vi.fn(), custom: vi.fn() };
    const routing = createMainProcessModelRouting({
      dataDir,
      providers,
      executors,
    });
    await routing.credentials.provision(typedCredential("https://127.0.0.1:1/v1"));

    await expect(routing.routeChatSend({
      sessionId: "main_builtin_session",
      clientRequestId: "main_builtin_request",
      blocks: [{ type: "text", text: "main", format: "plain" }],
    })).rejects.toMatchObject({ category: "transport", code: "NETWORK_ERROR" });
    expect(bypass).not.toHaveBeenCalled();
  });

  it("fails closed when production builtin endpoint is missing or not HTTPS", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-main-model-unavailable-"));
    roots.push(dataDir);
    const providers = createProviderStore({ dataDir });
    const routing = createMainProcessModelRouting({
      dataDir,
      providers,
      executors: { domestic: vi.fn(), custom: vi.fn() },
    });

    await expect(routing.routeChatSend({
      sessionId: "missing_builtin_session",
      clientRequestId: "missing_builtin_request",
      blocks: [{ type: "text", text: "missing", format: "plain" }],
    })).rejects.toMatchObject({
      source: "builtin", category: "configuration", code: "UNAVAILABLE",
    });
    await expect(routing.credentials.provision(typedCredential())).rejects.toMatchObject({
      code: "BUILTIN_ENDPOINT_INSECURE",
    });
  });

  it.each([
    { blocks: [{ type: "attachment", attachmentId: "attachment_001" }] },
    { blocks: [{ type: "text", text: "", format: "plain" }] },
    { blocks: [{ type: "text", text: "x".repeat(65_537), format: "plain" }] },
  ] as const)("fails closed for builtin chat input that has no bounded text mapping", async ({ blocks }) => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-main-model-invalid-input-"));
    roots.push(dataDir);
    const providers = createProviderStore({ dataDir });
    const routing = createMainProcessModelRouting({
      dataDir,
      providers,
      executors: { domestic: vi.fn(), custom: vi.fn() },
    });
    const credential = typedCredential("https://127.0.0.1:1/v1");
    await routing.credentials.provision(credential);

    const error = await routing.routeChatSend({
      sessionId: "invalid_builtin_session",
      clientRequestId: "invalid_builtin_request",
      blocks: [...blocks],
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ category: "validation", code: "INVALID_REQUEST", retryable: false, causeDetails: {} });
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(credential.endpoint);
    expect(serialized).not.toContain(credential.deviceToken);
  });

  it("uses builtin when no external source is explicitly enabled", async () => {
    const context = await setup();
    await expect(context.router.execute({ prompt: "hello" })).resolves.toBe("builtin-result");
    expect(context.builtin).toHaveBeenCalledOnce();
    expect(context.domestic).not.toHaveBeenCalled();
    expect(context.custom).not.toHaveBeenCalled();
  });

  it("uses activated credentials for ordinary builtin chat", async () => {
    const context = await setup();
    await expect(context.router.execute({ prompt: "active" })).resolves.toBe("builtin-result");
    expect(context.builtin).toHaveBeenCalledWith(
      { prompt: "active" },
      expect.objectContaining({ deviceToken: context.credential.deviceToken, licenseId: context.credential.licenseId }),
      undefined,
    );
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

  it("passes the saved provider network settings to the real executor", async () => {
    const context = await setup();
    const network = {
      httpProxy: null,
      httpsProxy: "https://proxy.example.test:8443",
      noProxy: ["localhost"],
    };
    await context.providers.setNetwork(network);
    await context.providers.create({
      id: "custom-network",
      name: "Custom network",
      enabled: true,
      baseUrl: "https://custom.example.test/v1",
      model: "custom-model",
    });

    await context.router.execute({ prompt: "network" });

    expect(context.custom).toHaveBeenCalledWith(
      { prompt: "network" },
      expect.objectContaining({ id: "custom-network" }),
      undefined,
      network,
    );
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

  it("preserves typed OpenClaw executor errors without fallback", async () => {
    const context = await setup();
    await context.providers.setEnabled("qwen", true);
    const error = Object.assign(new Error("Selected model unavailable"), {
      uclawError: {
        code: "MODEL_UNAVAILABLE",
        message: "Selected model unavailable",
        retryable: false,
        recoveryActions: ["open-settings"],
        causeDetails: { operation: "sessions.patch" },
      },
    });
    context.domestic.mockRejectedValueOnce(error);

    await expect(context.router.execute({ prompt: "typed-error" })).rejects.toBe(error);
    expect(context.builtin).not.toHaveBeenCalled();
  });

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
      builtinToken: context.credential.deviceToken,
    }) });
    expect(serialized).not.toContain(context.credential.endpoint);
    expect(serialized).not.toContain(context.credential.deviceToken);
  });
});
