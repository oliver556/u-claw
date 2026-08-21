import type { BuiltinCredentialArtifact } from "@uclaw/shared";

import type { ProductionRuntimeConsistencyCoordinator } from "../data/production-consistency-coordinator.js";
import type { BuiltinModelCredential } from "./builtin-credential-store.js";
import type {
  CommercialProviderModel,
  OpenClawProviderConfigBackend,
} from "./openclaw-provider-config.js";

interface CommercialCredentialStore {
  readonly credentialPath: string;
  provision(input: BuiltinCredentialArtifact): Promise<void>;
  loadActive(): Promise<Pick<BuiltinModelCredential, "endpoint" | "deviceToken" | "model">>;
}

interface CommercialModelReadback {
  id: string;
  available?: boolean;
}

export interface RotateCommercialOpenClawCredentialOptions {
  next: BuiltinCredentialArtifact;
  store: CommercialCredentialStore;
  config: Pick<OpenClawProviderConfigBackend, "synchronizeCommercial" | "readCommercial">;
  gateway: Pick<ProductionRuntimeConsistencyCoordinator, "restartManagedGateway">;
  reconnect(): Promise<void>;
  fetchModels(credential: Pick<BuiltinModelCredential, "endpoint" | "deviceToken">): Promise<readonly CommercialProviderModel[]>;
  listModels(): Promise<readonly CommercialModelReadback[]>;
}

type ExistingCommercialOpenClawCredentialOptions = Omit<RotateCommercialOpenClawCredentialOptions, "next">;

export interface CommercialOpenClawReadinessGate {
  run(operation: () => Promise<void>): Promise<void>;
  wait(signal?: AbortSignal): Promise<void>;
}

export function createCommercialOpenClawReadinessGate(): CommercialOpenClawReadinessGate {
  let pending: Promise<void> | undefined;

  return {
    run: (operation) => {
      if (pending !== undefined) return pending;
      const current = Promise.resolve().then(operation);
      pending = current;
      void current.then(
        () => { if (pending === current) pending = undefined; },
        () => { if (pending === current) pending = undefined; },
      );
      return current;
    },
    wait: async (signal) => {
      const current = pending;
      if (current === undefined) return;
      signal?.throwIfAborted();
      if (signal === undefined) {
        await current;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        void current.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
      });
    },
  };
}

function assertReadback(
  models: readonly CommercialProviderModel[],
  configuration: { configured: boolean },
  modelReadback: readonly CommercialModelReadback[],
): void {
  if (!configuration.configured) throw new Error("Commercial Provider config readback failed.");
  const available = new Set(modelReadback.filter((model) => model.available !== false).map(({ id }) => id));
  if (models.some(({ id }) => !available.has(`uclaw-commercial/${id}`))) {
    throw new Error("Commercial Provider models/auth readback failed.");
  }
}

export async function rotateCommercialOpenClawCredential({
  next,
  store,
  config,
  gateway,
  reconnect,
  fetchModels,
  listModels,
}: RotateCommercialOpenClawCredentialOptions): Promise<void> {
  await store.provision(next);
  const credential = await store.loadActive();
  if (credential.endpoint.href !== new URL(next.endpoint).href || credential.deviceToken !== next.deviceToken) {
    throw new Error("Commercial credential secure write readback failed.");
  }
  const models = await fetchModels(credential);
  if (models.length === 0) throw new Error("Commercial model catalog readback failed.");
  await config.synchronizeCommercial({
    endpoint: credential.endpoint.href,
    credentialPath: store.credentialPath,
    defaultModel: credential.model,
    models,
  });
  await gateway.restartManagedGateway();
  await reconnect();
  const [configuration, modelReadback] = await Promise.all([config.readCommercial(), listModels()]);
  assertReadback(models, configuration, modelReadback);
}

export async function synchronizeExistingCommercialOpenClawCredential({
  store,
  config,
  gateway,
  reconnect,
  fetchModels,
  listModels,
}: ExistingCommercialOpenClawCredentialOptions): Promise<void> {
  const credential = await store.loadActive();
  const models = await fetchModels(credential);
  if (models.length === 0) throw new Error("Commercial model catalog readback failed.");
  const changed = await config.synchronizeCommercial({
    endpoint: credential.endpoint.href,
    credentialPath: store.credentialPath,
    defaultModel: credential.model,
    models,
  });
  if (changed) {
    await gateway.restartManagedGateway();
    await reconnect();
  }
  const [configuration, modelReadback] = await Promise.all([config.readCommercial(), listModels()]);
  assertReadback(models, configuration, modelReadback);
}

export async function fetchCommercialModels(
  credential: Pick<BuiltinModelCredential, "endpoint" | "deviceToken">,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<CommercialProviderModel[]> {
  const baseUrl = new URL(credential.endpoint);
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/u, "");
  if (!baseUrl.pathname.endsWith("/v1")) baseUrl.pathname = `${baseUrl.pathname}/v1`;
  const endpoint = new URL(`${baseUrl.href}/models`);
  const response = await fetchImpl(endpoint, {
    method: "GET",
    headers: { authorization: `Bearer ${credential.deviceToken}`, accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) throw new Error("Commercial model catalog request failed.");
  const body = await response.json() as unknown;
  if (body === null || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) {
    throw new Error("Commercial model catalog response is invalid.");
  }
  const models = (body as { data: unknown[] }).data.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || id.trim() === "") return [];
    const name = (entry as { name?: unknown }).name;
    return [{ id, name: typeof name === "string" && name.trim() !== "" ? name : id }];
  });
  if (models.length === 0) throw new Error("Commercial model catalog response is invalid.");
  return models;
}
