import type { ProviderConfigEntry, UClawErrorCode } from "@uclaw/shared";

import {
  createBuiltinCredentialStore,
  type BuiltinCredentialStore,
  type BuiltinModelCredential,
} from "./builtin-credential-store.js";
import type { ProviderStore } from "./provider-store.js";

export type ModelSource = "builtin" | "domestic" | "custom";
export type ModelSourceFailureCategory = "authentication" | "quota" | "rate-limit" | "network" | "configuration" | "upstream";

const FAILURE_DETAILS: Record<ModelSourceFailureCategory, { code: UClawErrorCode; message: string; retryable: boolean }> = {
  authentication: { code: "PROVIDER_AUTH_FAILED", message: "Model provider authentication failed.", retryable: false },
  quota: { code: "MODEL_UNAVAILABLE", message: "Model provider quota is exhausted.", retryable: false },
  "rate-limit": { code: "NETWORK_UNREACHABLE", message: "Model provider rate limit was reached.", retryable: true },
  network: { code: "NETWORK_UNREACHABLE", message: "Model provider network request failed.", retryable: true },
  configuration: { code: "UNAVAILABLE", message: "Builtin model service is unavailable.", retryable: false },
  upstream: { code: "OPERATION_FAILED", message: "Model provider request failed.", retryable: false },
};

export class ModelSourceFailure extends Error {
  readonly code: UClawErrorCode;
  readonly retryable: boolean;
  readonly recoveryActions: ["retry"] | [];
  readonly causeDetails = {};

  constructor(readonly source: ModelSource, readonly category: ModelSourceFailureCategory) {
    const detail = FAILURE_DETAILS[category];
    super(detail.message);
    this.name = "ModelSourceFailure";
    this.code = detail.code;
    this.retryable = detail.retryable;
    this.recoveryActions = detail.retryable ? ["retry"] : [];
  }
}

export interface ModelSourceExecutors<Request, Result> {
  builtin(request: Request, credential: BuiltinModelCredential, signal?: AbortSignal): Promise<Result>;
  domestic(request: Request, provider: ProviderConfigEntry, signal?: AbortSignal): Promise<Result>;
  custom(request: Request, provider: ProviderConfigEntry, signal?: AbortSignal): Promise<Result>;
}

export interface CreateModelSourceRouterOptions<Request, Result> {
  providers: ProviderStore;
  credentials: BuiltinCredentialStore;
  executors: ModelSourceExecutors<Request, Result>;
}

export interface CreateMainProcessModelRoutingOptions<Request, Result> {
  dataDir: string;
  providers: ProviderStore;
  executors: ModelSourceExecutors<Request, Result>;
  allowLoopbackHttp?: boolean;
}

function externalSource(provider: ProviderConfigEntry): "domestic" | "custom" {
  return provider.templateId === undefined ? "custom" : "domestic";
}

export function createModelSourceRouter<Request, Result>({
  providers,
  credentials,
  executors,
}: CreateModelSourceRouterOptions<Request, Result>) {
  return {
    async execute(request: Request, signal?: AbortSignal): Promise<Result> {
      const provider = await providers.getSelectedForRuntime();
      if (provider !== null) {
        const source = externalSource(provider);
        try {
          return await executors[source](request, provider, signal);
        } catch (error) {
          if (error instanceof ModelSourceFailure && error.source === source) throw error;
          throw new ModelSourceFailure(source, "upstream");
        }
      }

      let credential: BuiltinModelCredential;
      try {
        credential = await credentials.loadActive();
      } catch {
        throw new ModelSourceFailure("builtin", "configuration");
      }
      try {
        return await executors.builtin(request, credential, signal);
      } catch (error) {
        if (error instanceof ModelSourceFailure && error.source === "builtin") throw error;
        throw new ModelSourceFailure("builtin", "upstream");
      }
    },
  };
}

export function createMainProcessModelRouting<Request, Result>({
  dataDir,
  providers,
  executors,
  allowLoopbackHttp = false,
}: CreateMainProcessModelRoutingOptions<Request, Result>) {
  const credentials = createBuiltinCredentialStore({ dataDir, allowLoopbackHttp });
  const router = createModelSourceRouter({ providers, credentials, executors });
  return { credentials, routeChatSend: router.execute };
}
