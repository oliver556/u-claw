import { describe, expect, it } from "vitest";

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
});
