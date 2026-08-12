import { describe, expect, it, vi } from "vitest";

import {
  createProductAuthorityReader,
  PRODUCT_SERVICES_IPC_CHANNEL,
  createProductionProductDomainModule,
  createProductionProductServices,
  readProductionProductServiceConfig,
} from "../src/product-services/production-product-services.js";
import { composeDesktopDomainModules } from "../src/wiring/domain-modules.js";

describe("production product services", () => {
  it("reads license, device, user, controls, service, and usage from authorities", async () => {
    const policy = {
      quota: { unit: "tokens" as const, limit: 100, period: "monthly" as const },
      rateLimit: { requestsPerMinute: 60, concurrentRequests: 2 },
      allowedModels: ["builtin/model"], disabled: false,
    };
    const journal = {
      stage: "active",
      generation: 2,
      binding: {
        deviceId: "dev_001", licenseId: "lic_001", newApiUserId: "usr_001",
        newApiTokenId: "tok_001", newApiUsername: "uclaw_001",
      },
    } as never;
    const reader = createProductAuthorityReader({
      artifactWriter: { readJournal: async () => journal } as never,
      licenseClient: { getLicenseStatus: async () => ({ status: { licenseId: "lic_001", deviceId: "dev_001", status: "active" } }) } as never,
      newApiClient: {
        getDeviceMapping: async () => ({ deviceId: "dev_001", licenseId: "lic_001", newApiUserId: "usr_001", newApiTokenId: "tok_001", generation: 2, status: "active" }),
        getUser: async () => ({ id: "usr_001", deviceId: "dev_001", status: "active", policy }),
        getDeviceControls: async () => ({ deviceId: "dev_001", userId: "usr_001", licenseId: "lic_001", tokenId: "tok_001", generation: 2, policy }),
        getServiceStatus: async () => ({ schemaVersion: 1, state: "enabled", revision: 1, reasonCode: "OPERATOR_ENABLED", updatedAt: "2026-08-12T00:00:00.000Z" }),
        getUsage: async () => ({ userId: "usr_001", consumed: 25, remaining: 75, resetAt: null, updatedAt: "2026-08-12T00:00:00.000Z" }),
      } as never,
    });

    await expect(reader.read()).resolves.toMatchObject({
      license: { status: { status: "active" } },
      mapping: { status: "active", generation: 2 },
      user: { status: "active", policy },
      controls: { policy },
      service: { state: "enabled" },
      usage: { consumed: 25, remaining: 75 },
    });
  });

  it("keeps desktop startup available when remote product services are absent", async () => {
    const services = createProductionProductServices({
      dataDir: "/portable-authority",
      environment: {},
    });

    await expect(services.licenseClient.getLicenseStatus("lic_missing_001"))
      .rejects.toMatchObject({ code: "ENDPOINT_NOT_CONFIGURED", retryable: false });
    await expect(services.newApiClient.getUser("usr_missing_001"))
      .rejects.toMatchObject({ code: "ENDPOINT_NOT_CONFIGURED", retryable: false });
    await expect(services.provisioning.provision({} as never))
      .rejects.toMatchObject({ code: "PRODUCT_SERVICES_NOT_CONFIGURED", retryable: false });
  });

  it("requires complete remote service configuration without exposing credentials", () => {
    expect(() => readProductionProductServiceConfig({
      UCLAW_LICENSE_SERVICE_URL: "https://license.example.com/v1/",
      UCLAW_LICENSE_MANAGEMENT_CREDENTIAL: "license-management-secret",
    })).toThrow("Product service configuration is incomplete.");

    expect(() => readProductionProductServiceConfig({
      UCLAW_LICENSE_SERVICE_URL: "http://127.0.0.1:18001/",
      UCLAW_LICENSE_MANAGEMENT_CREDENTIAL: "license-management-secret",
      UCLAW_NEW_API_MANAGEMENT_URL: "https://management.example.com/v1/",
      UCLAW_NEW_API_MANAGEMENT_CREDENTIAL: "new-api-management-secret",
    })).toThrow("Product service configuration is invalid.");
  });

  it("assembles HTTPS License and New API clients for production", () => {
    const options = {
      dataDir: "/portable-authority",
      environment: {
        UCLAW_LICENSE_SERVICE_URL: "https://license.example.com/v1/",
        UCLAW_LICENSE_MANAGEMENT_CREDENTIAL: "license-management-secret",
        UCLAW_NEW_API_MANAGEMENT_URL: "https://management.example.com/v1/",
        UCLAW_NEW_API_MANAGEMENT_CREDENTIAL: "new-api-management-secret",
      },
      artifactWriter: {
        acquireLock: async () => async () => undefined,
        recoverPendingArtifacts: async () => undefined,
        commitArtifacts: async () => undefined,
        writeJournal: async () => undefined,
        readJournal: async () => null,
        writeArtifacts: async () => undefined,
        finalizeCredential: async () => undefined,
        verifyArtifacts: async () => undefined,
        cleanupArtifacts: async () => undefined,
      },
    };
    const services = createProductionProductServices(options);

    expect(services.licenseClient).toBeDefined();
    expect(services.newApiClient).toBeDefined();
    expect(services.provisioning).toBeDefined();
    expect(createProductionProductDomainModule(options).name).toBe("product-services");
  });

  it("registers product services through the production domain extension point", async () => {
    const registrations = new Map<string, unknown>();
    const registry = {
      register: (name: string, value: unknown) => { registrations.set(name, value); return () => undefined; },
      resolve: (name: string) => registrations.get(name),
    } as never;

    await composeDesktopDomainModules(registry, {
      client: {} as never,
      productServices: { dataDir: "/portable-authority", environment: {} },
    }, []);

    expect(registrations.get("product-services")).toMatchObject({
      services: { licenseClient: expect.any(Object), newApiClient: expect.any(Object), provisioning: expect.any(Object) },
    });
  });

  it("installs an authorized typed lifecycle consumer without returning secrets", async () => {
    const services = createProductionProductServices({ dataDir: "/portable-authority", environment: {} });
    const registration = await createProductionProductDomainModule({
      dataDir: "/portable-authority", environment: {}, services,
    }).register({ client: {} as never });
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const authorized = { mainFrame: {} };
    registration.installIpc?.({
      ipcMain: {
        handle: (channel, handler) => { handlers.set(channel, handler); },
        removeHandler: (channel) => { handlers.delete(channel); },
      },
      authorizedWebContents: authorized,
      client: {} as never,
      services: { get: () => undefined },
    });

    const response = await handlers.get(PRODUCT_SERVICES_IPC_CHANNEL)!({
      sender: authorized, senderFrame: authorized.mainFrame,
    }, { method: "product.authority.read", requestId: "product-read-1", params: {} });
    expect(response).toMatchObject({ ok: false, error: { code: expect.any(String) } });
    expect(JSON.stringify(response)).not.toMatch(/management-secret|startupSecret|tokenSecret/u);
  });

  it("projects renderer authority status without stable identifiers or credentials", async () => {
    const services = {
      authority: { read: async () => ({
        license: { status: { licenseId: "lic_secret", deviceId: "dev_secret", status: "active", revision: 3, notBefore: "2026-08-01T00:00:00.000Z", expiresAt: "2027-08-01T00:00:00.000Z", replacementLicenseId: null, updatedAt: "2026-08-12T00:00:00.000Z" }, receipt: { value: "signed-secret-receipt" } },
        mapping: { deviceId: "dev_secret", licenseId: "lic_secret", newApiUserId: "usr_secret", newApiTokenId: "tok_secret", generation: 3, status: "active" },
        user: { id: "usr_secret", deviceId: "dev_secret", username: "private_user", status: "active", policy: { quota: { unit: "tokens", limit: 100, period: "monthly" }, rateLimit: { requestsPerMinute: 60, concurrentRequests: 2 }, allowedModels: ["builtin/model"], disabled: false } },
        controls: { deviceId: "dev_secret", userId: "usr_secret", licenseId: "lic_secret", tokenId: "tok_secret", generation: 3, policy: { quota: { unit: "tokens", limit: 100, period: "monthly" }, rateLimit: { requestsPerMinute: 60, concurrentRequests: 2 }, allowedModels: ["builtin/model"], disabled: false } },
        service: { state: "enabled", revision: 2, reasonCode: "OPERATOR_ENABLED", updatedAt: "2026-08-12T00:00:00.000Z" },
        usage: { userId: "usr_secret", consumed: 25, remaining: 75, resetAt: null, updatedAt: "2026-08-12T00:00:00.000Z" },
      }) },
      provisioning: {}, licenseClient: {}, newApiClient: {},
    } as never;
    const registration = await createProductionProductDomainModule({ dataDir: "/portable-authority", services }).register({ client: {} as never });
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const authorized = { mainFrame: {} };
    registration.installIpc?.({ ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler: () => undefined }, authorizedWebContents: authorized, client: {} as never, services: { get: () => undefined } });
    const response = await handlers.get(PRODUCT_SERVICES_IPC_CHANNEL)!({ sender: authorized, senderFrame: authorized.mainFrame }, { method: "product.authority.read", requestId: "product-safe", params: {} });
    expect(response).toMatchObject({ ok: true, result: { license: { status: "active" }, product: { status: "active" }, service: { state: "enabled" }, usage: { consumed: 25, remaining: 75 } } });
    expect(JSON.stringify(response)).not.toMatch(/lic_secret|dev_secret|usr_secret|tok_secret|private_user|signed-secret-receipt/u);
  });

  it("rejects provisioning and lifecycle writes at the main-process IPC boundary", async () => {
    const provision = vi.fn();
    const applyLifecycle = vi.fn();
    const registration = await createProductionProductDomainModule({
      dataDir: "/portable-authority",
      services: { authority: { read: vi.fn() }, provisioning: { provision, applyLifecycle }, licenseClient: {}, newApiClient: {} } as never,
    }).register({ client: {} as never });
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const authorized = { mainFrame: {} };
    registration.installIpc?.({ ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler: () => undefined }, authorizedWebContents: authorized, client: {} as never, services: { get: () => undefined } });
    const binding = { deviceId: "dev_fixture_001", usbFingerprint: "a".repeat(64), licenseId: "lic_fixture_001", newApiUserId: "usr_fixture_001", newApiUsername: "uclaw_fixture", newApiTokenId: "tok_fixture_001", channelId: "channel_builtin_001" };
    const provisionParams = { idempotencyKey: "provision-device-001", deviceId: binding.deviceId, usbFingerprint: binding.usbFingerprint, username: binding.newApiUsername, channelId: binding.channelId, endpoint: "https://models.example.test/v1/", model: "built-in-model", notBefore: "2026-08-10T00:00:00.000Z", expiresAt: "2027-08-10T00:00:00.000Z" };
    await expect(handlers.get(PRODUCT_SERVICES_IPC_CHANNEL)!({ sender: authorized, senderFrame: authorized.mainFrame }, { method: "product.provision", requestId: "product-write", params: provisionParams })).rejects.toThrow();
    await expect(handlers.get(PRODUCT_SERVICES_IPC_CHANNEL)!({ sender: authorized, senderFrame: authorized.mainFrame }, { method: "product.lifecycle", requestId: "product-lifecycle", params: { action: "revoke", idempotencyKey: "lifecycle-revoke-001", binding } })).rejects.toThrow();
    expect(provision).not.toHaveBeenCalled();
    expect(applyLifecycle).not.toHaveBeenCalled();
  });
});
