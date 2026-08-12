import {
  PRODUCT_SERVICES_IPC_CHANNEL,
  ProductAuthorityIpcRequestSchema,
  type LicenseLifecycleClient,
  type NewApiManagementClient,
} from "@uclaw/shared";
import { z } from "zod";

import {
  createLicenseLifecycleClient,
  createUnavailableLicenseLifecycleClient,
} from "../license-lifecycle/client.js";
import {
  createNewApiManagementClient,
  createUnavailableNewApiManagementClient,
} from "../new-api-management/client.js";
import { createBuiltinCredentialStore } from "../providers/builtin-credential-store.js";
import {
  createProvisioningArtifactWriter,
  type ProvisioningArtifactWriter,
} from "../provisioning/artifact-writer.js";
import {
  createProvisioningCoordinator,
  type ProvisioningCoordinator,
} from "../provisioning/coordinator.js";
import type { DesktopDomainModule } from "../wiring/domain-modules.js";
import { toRendererSafeError } from "../ipc/client-dispatcher.js";

export { PRODUCT_SERVICES_IPC_CHANNEL } from "@uclaw/shared";

const ProductionProductServiceConfigSchema = z.object({
  licenseEndpoint: z.string().url(),
  licenseCredential: z.string().min(12).max(512),
  newApiEndpoint: z.string().url(),
  newApiCredential: z.string().min(12).max(512),
}).strict();

interface ProductionProductServiceConfig {
  licenseEndpoint: string;
  licenseCredential: string;
  newApiEndpoint: string;
  newApiCredential: string;
}

export interface ProductionProductServices {
  licenseClient: LicenseLifecycleClient;
  newApiClient: NewApiManagementClient;
  provisioning: ProvisioningCoordinator;
  authority: ProductAuthorityReader;
}

export interface ProductAuthorityReader {
  readUsage(): Promise<Awaited<ReturnType<NewApiManagementClient["getUsage"]>>>;
  read(): Promise<{
    license: Awaited<ReturnType<LicenseLifecycleClient["getLicenseStatus"]>>;
    mapping: Awaited<ReturnType<NewApiManagementClient["getDeviceMapping"]>>;
    user: Awaited<ReturnType<NewApiManagementClient["getUser"]>>;
    controls: Awaited<ReturnType<NewApiManagementClient["getDeviceControls"]>>;
    service: Awaited<ReturnType<NewApiManagementClient["getServiceStatus"]>>;
    usage: Awaited<ReturnType<NewApiManagementClient["getUsage"]>>;
  }>;
}

export function createProductAuthorityReader(options: {
  artifactWriter: Pick<ProvisioningArtifactWriter, "readJournal">;
  licenseClient: Pick<LicenseLifecycleClient, "getLicenseStatus">;
  newApiClient: Pick<NewApiManagementClient,
    "getDeviceMapping" | "getUser" | "getDeviceControls" | "getServiceStatus" | "getUsage">;
}): ProductAuthorityReader {
  return {
    async readUsage() {
      const journal = await options.artifactWriter.readJournal();
      const userId = journal?.stage === "active" ? journal.binding.newApiUserId : undefined;
      if (!userId) {
        throw Object.assign(new Error("Product authority is not active."), { code: "PRODUCT_AUTHORITY_UNAVAILABLE" });
      }
      const usage = await options.newApiClient.getUsage(userId);
      if (usage.userId !== userId) {
        throw Object.assign(new Error("Product authority binding mismatch."), { code: "PRODUCT_AUTHORITY_MISMATCH" });
      }
      return usage;
    },
    async read() {
      const journal = await options.artifactWriter.readJournal();
      if (journal?.stage !== "active") {
        throw Object.assign(new Error("Product authority is not active."), { code: "PRODUCT_AUTHORITY_UNAVAILABLE" });
      }
      const binding = journal.binding;
      if (!binding.licenseId || !binding.newApiUserId || !binding.newApiTokenId) {
        throw Object.assign(new Error("Product authority binding is incomplete."), { code: "PRODUCT_AUTHORITY_MISMATCH" });
      }
      const [license, mapping, user, controls, service, usage] = await Promise.all([
        options.licenseClient.getLicenseStatus(binding.licenseId),
        options.newApiClient.getDeviceMapping(binding.deviceId),
        options.newApiClient.getUser(binding.newApiUserId),
        options.newApiClient.getDeviceControls({ deviceId: binding.deviceId }),
        options.newApiClient.getServiceStatus(),
        options.newApiClient.getUsage(binding.newApiUserId),
      ]);
      if (license.status.licenseId !== binding.licenseId || license.status.deviceId !== binding.deviceId
          || mapping.deviceId !== binding.deviceId || mapping.licenseId !== binding.licenseId
          || mapping.newApiUserId !== binding.newApiUserId || mapping.newApiTokenId !== binding.newApiTokenId
          || mapping.generation !== journal.generation || user.id !== binding.newApiUserId
          || user.deviceId !== binding.deviceId || controls.deviceId !== binding.deviceId
          || controls.userId !== binding.newApiUserId || controls.licenseId !== binding.licenseId
          || controls.tokenId !== binding.newApiTokenId || controls.generation !== journal.generation
          || usage.userId !== binding.newApiUserId) {
        throw Object.assign(new Error("Product authority binding mismatch."), { code: "PRODUCT_AUTHORITY_MISMATCH" });
      }
      return { license, mapping, user, controls, service, usage };
    },
  };
}

export interface CreateProductionProductServicesOptions {
  dataDir: string;
  environment?: NodeJS.ProcessEnv;
  artifactWriter?: ProvisioningArtifactWriter;
  fetch?: typeof fetch;
}

export interface CreateProductionProductDomainModuleOptions extends CreateProductionProductServicesOptions {
  services?: ProductionProductServices;
}

function rendererAuthoritySummary(authority: Awaited<ReturnType<ProductAuthorityReader["read"]>>) {
  return {
    license: {
      status: authority.license.status.status,
      revision: authority.license.status.revision,
      expiresAt: authority.license.status.expiresAt,
    },
    product: {
      status: authority.mapping.status,
      generation: authority.mapping.generation,
      userStatus: authority.user.status,
    },
    service: {
      state: authority.service.state,
      revision: authority.service.revision,
      reasonCode: authority.service.reasonCode,
    },
    policy: authority.controls.policy,
    usage: {
      consumed: authority.usage.consumed,
      remaining: authority.usage.remaining,
      resetAt: authority.usage.resetAt,
      updatedAt: authority.usage.updatedAt,
    },
  };
}

export function readProductionProductServiceConfig(
  environment: NodeJS.ProcessEnv,
): ProductionProductServiceConfig {
  const values = [
    environment.UCLAW_LICENSE_SERVICE_URL,
    environment.UCLAW_LICENSE_MANAGEMENT_CREDENTIAL,
    environment.UCLAW_NEW_API_MANAGEMENT_URL,
    environment.UCLAW_NEW_API_MANAGEMENT_CREDENTIAL,
  ];
  if (values.some((value) => value === undefined)) {
    throw new Error("Product service configuration is incomplete.");
  }
  try {
    const config = ProductionProductServiceConfigSchema.parse({
      licenseEndpoint: values[0],
      licenseCredential: values[1],
      newApiEndpoint: values[2],
      newApiCredential: values[3],
    });
    for (const endpoint of [config.licenseEndpoint, config.newApiEndpoint]) {
      const url = new URL(endpoint);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    }
    return config;
  } catch {
    throw new Error("Product service configuration is invalid.");
  }
}

export function createProductionProductServices({
  dataDir,
  environment = process.env,
  artifactWriter,
  fetch,
}: CreateProductionProductServicesOptions): ProductionProductServices {
  const configuredValues = [
    environment.UCLAW_LICENSE_SERVICE_URL,
    environment.UCLAW_LICENSE_MANAGEMENT_CREDENTIAL,
    environment.UCLAW_NEW_API_MANAGEMENT_URL,
    environment.UCLAW_NEW_API_MANAGEMENT_CREDENTIAL,
  ];
  if (configuredValues.every((value) => value === undefined)) {
    const unavailable = async (): Promise<never> => {
      throw Object.assign(new Error("Product services are not configured."), {
        code: "PRODUCT_SERVICES_NOT_CONFIGURED",
        retryable: false,
      });
    };
    return {
      licenseClient: createUnavailableLicenseLifecycleClient("License service is not configured."),
      newApiClient: createUnavailableNewApiManagementClient("New API management service is not configured."),
      provisioning: { provision: unavailable, applyLifecycle: unavailable },
      authority: { read: unavailable, readUsage: unavailable },
    };
  }
  const config = readProductionProductServiceConfig(environment);
  const licenseClient = createLicenseLifecycleClient({
    endpoint: config.licenseEndpoint,
    managementCredential: config.licenseCredential,
    fetch,
  });
  const newApiClient = createNewApiManagementClient({
    endpoint: config.newApiEndpoint,
    managementCredential: config.newApiCredential,
    fetch,
  });
  const writer = artifactWriter ?? createProvisioningArtifactWriter({
    dataDir,
    credentialStore: createBuiltinCredentialStore({ dataDir }),
  });
  return {
    licenseClient,
    newApiClient,
    provisioning: createProvisioningCoordinator({ licenseClient, newApiClient, artifactWriter: writer }),
    authority: createProductAuthorityReader({ artifactWriter: writer, licenseClient, newApiClient }),
  };
}

export function createProductionProductDomainModule(
  options: CreateProductionProductDomainModuleOptions,
): DesktopDomainModule {
  return {
    name: "product-services",
    register: () => {
      const services = options.services ?? createProductionProductServices(options);
      return {
        services,
        installIpc({ ipcMain, authorizedWebContents }) {
          ipcMain.handle(PRODUCT_SERVICES_IPC_CHANNEL, async (event, payload) => {
            const candidate = event as { sender?: unknown; senderFrame?: unknown };
            if (candidate.sender !== authorizedWebContents || candidate.senderFrame !== authorizedWebContents.mainFrame) {
              throw new Error("Product service IPC sender is not authorized.");
            }
            const request = ProductAuthorityIpcRequestSchema.parse(payload);
            try {
              const result = rendererAuthoritySummary(await services.authority.read());
              return { method: request.method, requestId: request.requestId, ok: true, result };
            } catch (error) {
              return { method: request.method, requestId: request.requestId, ok: false, error: toRendererSafeError(error) };
            }
          });
          return () => ipcMain.removeHandler(PRODUCT_SERVICES_IPC_CHANNEL);
        },
        dispose: () => undefined,
      };
    },
  };
}
