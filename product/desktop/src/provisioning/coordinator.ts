import { createHash } from "node:crypto";

import {
  NewApiDeviceMappingSchema,
  NewApiPolicySchema,
  ProvisioningIdentityInputSchema,
  ProvisioningIdentityResultSchema,
  ProvisioningJournalSchema,
  ProvisioningLifecycleActionSchema,
  type IssuedLicense,
  type LicenseLifecycleClient,
  type NewApiDeviceMapping,
  type NewApiIssuedToken,
  type NewApiManagementClient,
  type NewApiPolicy,
  type NewApiUser,
  type ProvisioningBinding,
  type ProvisioningIdentityInput,
  type ProvisioningIdentityResult,
  type ProvisioningJournal,
  type ProvisioningLifecycleAction,
} from "@uclaw/shared";

import type { ProvisioningArtifactWriter } from "./artifact-writer.js";

export type ProvisioningCoordinatorErrorCode =
  | "BINDING_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "LICENSE_FAILED"
  | "NEW_API_FAILED"
  | "ARTIFACT_WRITE_FAILED"
  | "ACTIVATION_FAILED"
  | "COMPENSATION_PENDING"
  | "LIFECYCLE_FAILED";

export class ProvisioningCoordinatorError extends Error {
  constructor(
    readonly code: ProvisioningCoordinatorErrorCode,
    readonly stage: string,
    readonly retryable: boolean,
  ) {
    super(`Provisioning failed during ${stage}.`);
    this.name = "ProvisioningCoordinatorError";
  }
}

export interface CreateProvisioningCoordinatorOptions {
  licenseClient: LicenseLifecycleClient;
  newApiClient: NewApiManagementClient;
  artifactWriter: ProvisioningArtifactWriter;
  now?: () => Date;
}

export interface ProvisioningCoordinator {
  provision(input: ProvisioningIdentityInput): Promise<ProvisioningIdentityResult>;
  applyLifecycle(action: ProvisioningLifecycleAction): Promise<ProvisioningIdentityResult>;
}

type Step = "license" | "user" | "policy" | "token" | "mapping" | "active" | "failed" | "compensation-complete" | "revoke-token" | "revoke-license" | "lifecycle";

export function deriveProvisioningStepKey(idempotencyKey: string, step: Step, generation: number): string {
  return `p_${createHash("sha256")
    .update("uclaw-provisioning-step-v1\0")
    .update(step)
    .update("\0")
    .update(String(generation))
    .update("\0")
    .update(idempotencyKey)
    .digest("hex")}`;
}

function digest(value: unknown, domain: string): string {
  return createHash("sha256").update(domain).update("\0").update(JSON.stringify(value)).digest("hex");
}

function provisioningPolicy(model: string, disabled = false): NewApiPolicy {
  return NewApiPolicySchema.parse({
    quota: { unit: "tokens", limit: 100_000, period: "monthly" },
    rateLimit: { requestsPerMinute: 60, concurrentRequests: 2 },
    allowedModels: [model],
    disabled,
  });
}

function policyDigest(policy: NewApiPolicy): string {
  return digest(policy, "uclaw-new-api-policy-v1");
}

function resultFrom(journal: ProvisioningJournal, status: "active" | "disabled" | "revoked"): ProvisioningIdentityResult {
  return ProvisioningIdentityResultSchema.parse({
    transactionId: journal.transactionId,
    ...journal.binding,
    endpoint: journal.endpoint,
    model: journal.model,
    status,
  });
}

function sameBinding(left: ProvisioningBinding, right: ProvisioningBinding): boolean {
  return Object.keys(left).every((key) => left[key as keyof ProvisioningBinding] === right[key as keyof ProvisioningBinding]);
}

export function createProvisioningCoordinator({
  licenseClient,
  newApiClient,
  artifactWriter,
  now = () => new Date(),
}: CreateProvisioningCoordinatorOptions): ProvisioningCoordinator {
  const deviceQueues = new Map<string, Promise<void>>();

  const serialized = async <T>(deviceId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = deviceQueues.get(deviceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => current);
    deviceQueues.set(deviceId, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (deviceQueues.get(deviceId) === queued) deviceQueues.delete(deviceId);
    }
  };

  const save = async (journal: ProvisioningJournal, update: Partial<ProvisioningJournal>): Promise<ProvisioningJournal> => {
    const next = ProvisioningJournalSchema.parse({ ...journal, ...update, updatedAt: now().toISOString() });
    await artifactWriter.writeJournal(next);
    return next;
  };

  const compensate = async (journal: ProvisioningJournal, failureCode: string): Promise<ProvisioningJournal> => {
    let next = await save(journal, { stage: "compensating", failureCode });
    const tokenId = next.binding.newApiTokenId;
    const licenseId = next.binding.licenseId;
    const hasMapping = next.compensation.mapping !== "not-needed"
      && next.binding.newApiUserId !== undefined && tokenId !== undefined && licenseId !== undefined;

    if (hasMapping && next.compensation.mapping !== "succeeded") {
      try {
        await newApiClient.updateDeviceStatus(next.binding.deviceId, {
          idempotencyKey: deriveProvisioningStepKey(next.transactionId, "failed", next.generation),
          status: "failed",
          failure: {
            code: failureCode,
            compensation: { tokenId, status: "pending", attemptedAt: null },
          },
        });
        next = await save(next, { compensation: { ...next.compensation, mapping: "succeeded" } });
      } catch {
        next = await save(next, { compensation: { ...next.compensation, mapping: "pending" } });
      }
    }

    if (tokenId !== undefined && next.compensation.token !== "succeeded") {
      try {
        await newApiClient.revokeToken(tokenId, {
          idempotencyKey: deriveProvisioningStepKey(next.transactionId, "revoke-token", next.generation),
        });
        next = await save(next, { compensation: { ...next.compensation, token: "succeeded" } });
      } catch {
        next = await save(next, { compensation: { ...next.compensation, token: "pending" } });
      }
    }

    if (licenseId !== undefined && next.compensation.license !== "succeeded") {
      try {
        await licenseClient.revokeLicense(licenseId, {
          idempotencyKey: deriveProvisioningStepKey(next.transactionId, "revoke-license", next.generation),
        });
        next = await save(next, { compensation: { ...next.compensation, license: "succeeded" } });
      } catch {
        next = await save(next, { compensation: { ...next.compensation, license: "pending" } });
      }
    }
    if (next.compensation.artifacts !== "succeeded" && next.compensation.artifacts !== "not-needed") {
      try {
        await artifactWriter.cleanupArtifacts();
        next = await save(next, { compensation: { ...next.compensation, artifacts: "succeeded" } });
      } catch {
        next = await save(next, { compensation: { ...next.compensation, artifacts: "pending" } });
      }
    }
    if (hasMapping && next.compensation.token === "succeeded"
        && next.compensation.license === "succeeded"
        && next.compensation.artifacts !== "pending") {
      try {
        await newApiClient.updateDeviceStatus(next.binding.deviceId, {
          idempotencyKey: deriveProvisioningStepKey(next.transactionId, "compensation-complete", next.generation),
          status: "failed",
          failure: {
            code: failureCode,
            compensation: { tokenId: tokenId!, status: "succeeded", attemptedAt: now().toISOString() },
          },
        });
        next = await save(next, { compensation: { ...next.compensation, mapping: "succeeded" } });
      } catch {
        next = await save(next, { compensation: { ...next.compensation, mapping: "pending" } });
      }
    }
    const pending = Object.values(next.compensation).includes("pending");
    return save(next, { stage: pending ? "compensation-pending" : "failed" });
  };

  const execute = async (
    input: ProvisioningIdentityInput,
    seed?: ProvisioningJournal,
    preissued?: IssuedLicense,
  ): Promise<ProvisioningIdentityResult> => {
    const requestHash = digest(input, "uclaw-provisioning-request-v1");
    const timestamp = now().toISOString();
    const generation = seed?.generation ?? 1;
    const transactionId = seed?.transactionId ?? `txn_${requestHash.slice(0, 24)}`;
    const previousTokenId = seed?.mappedTokenId ?? null;
    let journal = seed ?? ProvisioningJournalSchema.parse({
      schemaVersion: 1,
      generation,
      transactionId,
      requestHash,
      mappedTokenId: null,
      binding: { deviceId: input.deviceId, usbFingerprint: input.usbFingerprint, channelId: input.channelId },
      endpoint: input.endpoint,
      model: input.model,
      stage: "started",
      failureCode: null,
      compensation: { mapping: "not-needed", token: "not-needed", license: "not-needed", artifacts: "not-needed" },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    if (!seed) await artifactWriter.writeJournal(journal);
    let issued: IssuedLicense | undefined = preissued;
    let user: NewApiUser | undefined;
    let issuedToken: NewApiIssuedToken | undefined;
    let mapping: NewApiDeviceMapping | undefined;
    let failureCode: ProvisioningCoordinatorErrorCode = "LICENSE_FAILED";

    try {
      if (!issued) {
        issued = generation === 1
          ? await licenseClient.issueLicense({
            idempotencyKey: deriveProvisioningStepKey(input.idempotencyKey, "license", generation),
            deviceId: input.deviceId,
            usbFingerprint: input.usbFingerprint,
            notBefore: input.notBefore,
            expiresAt: input.expiresAt,
          })
          : await licenseClient.reissueLicense(journal.binding.licenseId!, {
            idempotencyKey: deriveProvisioningStepKey(input.idempotencyKey, "license", generation),
            usbFingerprint: input.usbFingerprint,
            notBefore: input.notBefore,
            expiresAt: input.expiresAt,
          });
      }
      journal = await save(journal, {
        stage: "license-issued",
        binding: { ...journal.binding, licenseId: issued.status.licenseId },
        compensation: { ...journal.compensation, license: "pending" },
      });
      if (issued.status.deviceId !== input.deviceId || issued.status.licenseId !== issued.license.licenseId
          || issued.startupCredential.deviceId !== input.deviceId || issued.startupCredential.licenseId !== issued.status.licenseId
          || issued.license.deviceId !== input.deviceId || issued.license.usbFingerprint.sha256 !== input.usbFingerprint) {
        throw new ProvisioningCoordinatorError("BINDING_MISMATCH", "license-issued", false);
      }

      failureCode = "NEW_API_FAILED";
      if (journal.binding.newApiUserId !== undefined) {
        user = {
          id: journal.binding.newApiUserId,
          deviceId: input.deviceId,
          username: journal.binding.newApiUsername!,
          status: "active",
          policy: provisioningPolicy(input.model),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
      } else {
        user = await newApiClient.createUser({
          idempotencyKey: deriveProvisioningStepKey(input.idempotencyKey, "user", generation),
          deviceId: input.deviceId,
          username: input.username,
        });
      }
      if (user.deviceId !== input.deviceId || user.username !== input.username) {
        throw new ProvisioningCoordinatorError("BINDING_MISMATCH", "user-created", false);
      }
      journal = await save(journal, {
        stage: "user-created",
        binding: { ...journal.binding, newApiUserId: user.id, newApiUsername: user.username },
      });

      const policy = provisioningPolicy(input.model);
      await newApiClient.updatePolicy(user.id, policy);
      const boundPolicyDigest = policyDigest(policy);
      issuedToken = await newApiClient.createToken({
        idempotencyKey: deriveProvisioningStepKey(input.idempotencyKey, "token", generation),
        userId: user.id,
        name: "device",
        channelId: input.channelId,
        policyDigest: boundPolicyDigest,
        generation,
      });
      if (issuedToken.token.userId !== user.id || issuedToken.token.channelId !== input.channelId
          || issuedToken.token.policyDigest !== boundPolicyDigest || issuedToken.token.generation !== generation
          || issuedToken.token.status !== "active") {
        throw new ProvisioningCoordinatorError("BINDING_MISMATCH", "token-created", false);
      }
      journal = await save(journal, {
        stage: "token-created",
        binding: { ...journal.binding, newApiTokenId: issuedToken.token.id },
        compensation: { ...journal.compensation, token: "pending" },
      });

      mapping = await newApiClient.createDeviceMapping({
        idempotencyKey: deriveProvisioningStepKey(input.idempotencyKey, "mapping", generation),
        deviceId: input.deviceId,
        licenseId: issued.status.licenseId,
        startupSecretHash: issued.license.startupSecretProof.startupSecretHash,
        startupSecretSalt: issued.license.startupSecretProof.startupSecretSalt,
        usbFingerprint: input.usbFingerprint,
        newApiUserId: user.id,
        newApiUsername: user.username,
        newApiTokenId: issuedToken.token.id,
        channelId: input.channelId,
        policyDigest: boundPolicyDigest,
        generation,
        previousTokenId,
        status: "provisioning",
      });
      const expectedBinding: ProvisioningBinding = {
        deviceId: input.deviceId,
        usbFingerprint: input.usbFingerprint,
        licenseId: issued.status.licenseId,
        newApiUserId: user.id,
        newApiUsername: user.username,
        newApiTokenId: issuedToken.token.id,
        channelId: input.channelId,
      };
      if (!sameBinding(expectedBinding, mapping)
          || mapping.policyDigest !== boundPolicyDigest || mapping.generation !== generation
          || mapping.previousTokenId !== previousTokenId || mapping.status !== "provisioning") {
        throw new ProvisioningCoordinatorError("BINDING_MISMATCH", "mapping-created", false);
      }
      journal = await save(journal, {
        stage: "mapping-created",
        mappedTokenId: issuedToken.token.id,
        binding: expectedBinding,
        compensation: { ...journal.compensation, mapping: "pending", artifacts: "pending" },
      });

      failureCode = "ARTIFACT_WRITE_FAILED";
      await artifactWriter.writeArtifacts({
        startupCredential: issued.startupCredential,
        license: issued.license,
        endpoint: input.endpoint,
        model: input.model,
        mapping,
        issuedToken,
      });
      await artifactWriter.verifyArtifacts(expectedBinding);
      journal = await save(journal, { stage: "artifacts-written" });

      failureCode = "ACTIVATION_FAILED";
      const activeMapping = await newApiClient.updateDeviceStatus(input.deviceId, {
        idempotencyKey: deriveProvisioningStepKey(input.idempotencyKey, "active", generation),
        status: "active",
      });
      if (!sameBinding(expectedBinding, activeMapping) || activeMapping.status !== "active") {
        throw new ProvisioningCoordinatorError("BINDING_MISMATCH", "active", false);
      }
      failureCode = "ARTIFACT_WRITE_FAILED";
      await artifactWriter.finalizeCredential({
        endpoint: input.endpoint, model: input.model, mapping: activeMapping, issuedToken,
      });
      await artifactWriter.verifyArtifacts(expectedBinding, true);
      journal = await save(journal, {
        stage: "active",
        failureCode: null,
        compensation: { mapping: "not-needed", token: "not-needed", license: "not-needed", artifacts: "not-needed" },
      });
      return resultFrom(journal, "active");
    } catch (error) {
      const code = error instanceof ProvisioningCoordinatorError ? error.code : failureCode;
      const stage = error instanceof ProvisioningCoordinatorError ? error.stage : journal.stage;
      const compensated = await compensate(journal, code);
      if (compensated.stage === "compensation-pending") {
        throw new ProvisioningCoordinatorError("COMPENSATION_PENDING", "compensating", true);
      }
      throw new ProvisioningCoordinatorError(code, stage, false);
    }
  };

  const provisionLocked = async (rawInput: ProvisioningIdentityInput): Promise<ProvisioningIdentityResult> => {
    const input = ProvisioningIdentityInputSchema.parse(rawInput);
    const requestHash = digest(input, "uclaw-provisioning-request-v1");
    const existing = await artifactWriter.readJournal();
    if (existing) {
      if (existing.binding.deviceId !== input.deviceId) {
        throw new ProvisioningCoordinatorError("IDEMPOTENCY_CONFLICT", "started", false);
      }
      if (existing.stage === "active") {
        if (existing.requestHash !== requestHash) throw new ProvisioningCoordinatorError("IDEMPOTENCY_CONFLICT", "active", false);
        await artifactWriter.verifyArtifacts(existing.binding as ProvisioningBinding, true);
        return resultFrom(existing, "active");
      }
      if (existing.stage === "compensation-pending") {
        const compensated = await compensate(existing, existing.failureCode ?? "NEW_API_FAILED");
        if (compensated.stage === "compensation-pending") {
          throw new ProvisioningCoordinatorError("COMPENSATION_PENDING", "compensating", true);
        }
        const retry = ProvisioningJournalSchema.parse({
          ...compensated,
          generation: compensated.generation + 1,
          requestHash,
          stage: "started",
          failureCode: null,
          compensation: { mapping: "not-needed", token: "not-needed", license: "not-needed", artifacts: "not-needed" },
          updatedAt: now().toISOString(),
        });
        await artifactWriter.writeJournal(retry);
        return execute(input, retry);
      }
      if (existing.stage === "failed") {
        const retry = ProvisioningJournalSchema.parse({
          ...existing,
          generation: existing.generation + 1,
          requestHash,
          stage: "started",
          failureCode: null,
          compensation: { mapping: "not-needed", token: "not-needed", license: "not-needed", artifacts: "not-needed" },
          updatedAt: now().toISOString(),
        });
        await artifactWriter.writeJournal(retry);
        return execute(input, retry);
      }
      if (existing.requestHash !== requestHash) throw new ProvisioningCoordinatorError("IDEMPOTENCY_CONFLICT", existing.stage, false);
      return execute(input, existing);
    }
    return execute(input);
  };

  const applyLifecycleLocked = async (raw: ProvisioningLifecycleAction): Promise<ProvisioningIdentityResult> => {
    const action = ProvisioningLifecycleActionSchema.parse(raw);
    let journal = await artifactWriter.readJournal();
    if (journal && action.action === "reissue" && journal.stage === "active"
        && journal.requestHash === digest(action, "uclaw-provisioning-reissue-v1")) {
      await artifactWriter.verifyArtifacts(journal.binding as ProvisioningBinding, true);
      return resultFrom(journal, "active");
    }
    if (!journal || !sameBinding(action.binding, journal.binding as ProvisioningBinding)) {
      throw new ProvisioningCoordinatorError("BINDING_MISMATCH", "lifecycle", false);
    }
    if (action.action === "disable") {
      journal = await save(journal, { stage: "disabling" });
      await newApiClient.updatePolicy(action.binding.newApiUserId, provisioningPolicy(journal.model, true));
      await newApiClient.updateDeviceStatus(action.binding.deviceId, {
        idempotencyKey: deriveProvisioningStepKey(action.idempotencyKey, "lifecycle", journal.generation), status: "disabled",
      });
      await artifactWriter.cleanupArtifacts();
      journal = await save(journal, { stage: "disabled" });
      return resultFrom(journal, "disabled");
    }
    if (action.action === "revoke") {
      if (journal.stage !== "revoked") journal = await save(journal, { stage: "revoking" });
      await newApiClient.updateDeviceStatus(action.binding.deviceId, {
        idempotencyKey: deriveProvisioningStepKey(action.idempotencyKey, "lifecycle", journal.generation), status: "revoked",
      });
      await newApiClient.revokeToken(action.binding.newApiTokenId, {
        idempotencyKey: deriveProvisioningStepKey(action.idempotencyKey, "revoke-token", journal.generation),
      });
      await licenseClient.revokeLicense(action.binding.licenseId, {
        idempotencyKey: deriveProvisioningStepKey(action.idempotencyKey, "revoke-license", journal.generation),
      });
      await artifactWriter.cleanupArtifacts();
      journal = await save(journal, { stage: "revoked" });
      return resultFrom(journal, "revoked");
    }

    journal = await save(journal, { stage: "reissuing" });
    await newApiClient.updateDeviceStatus(action.binding.deviceId, {
      idempotencyKey: deriveProvisioningStepKey(action.idempotencyKey, "lifecycle", journal.generation), status: "revoked",
    });
    await newApiClient.revokeToken(action.binding.newApiTokenId, {
      idempotencyKey: deriveProvisioningStepKey(action.idempotencyKey, "revoke-token", journal.generation),
    });
    await artifactWriter.cleanupArtifacts();
    const issued = await licenseClient.reissueLicense(action.binding.licenseId, {
      idempotencyKey: deriveProvisioningStepKey(action.idempotencyKey, "license", journal.generation + 1),
      usbFingerprint: action.usbFingerprint,
      notBefore: action.notBefore,
      expiresAt: action.expiresAt,
    });
    const retry = ProvisioningJournalSchema.parse({
      ...journal,
      generation: journal.generation + 1,
      requestHash: digest(action, "uclaw-provisioning-reissue-v1"),
      binding: { ...journal.binding, usbFingerprint: action.usbFingerprint },
      stage: "started",
      failureCode: null,
      compensation: { mapping: "not-needed", token: "not-needed", license: "not-needed", artifacts: "not-needed" },
      updatedAt: now().toISOString(),
    });
    await artifactWriter.writeJournal(retry);
    return execute({
      idempotencyKey: action.idempotencyKey,
      deviceId: action.binding.deviceId,
      usbFingerprint: action.usbFingerprint,
      username: action.binding.newApiUsername,
      channelId: action.binding.channelId,
      endpoint: journal.endpoint,
      model: journal.model,
      notBefore: action.notBefore,
      expiresAt: action.expiresAt,
    }, retry, issued);
  };

  return {
    provision: (input) => serialized(input.deviceId, () => provisionLocked(input)),
    applyLifecycle: (action) => serialized(action.binding.deviceId, async () => {
      try {
        return await applyLifecycleLocked(action);
      } catch (error) {
        if (error instanceof ProvisioningCoordinatorError) throw error;
        throw new ProvisioningCoordinatorError("LIFECYCLE_FAILED", "lifecycle", true);
      }
    }),
  };
}
