import { createHash } from "node:crypto";

import type { ActivationRequest, ActivationResponse } from "@uclaw/shared";

import { ActivationClientError } from "./errors.js";

export type ActivationCoordinatorState = "checking" | "input" | "submitting" | "server-bound" | "writing" | "verifying" | "committing" | "complete" | "recovery-required" | "error";
export interface ActivationStatus { state: ActivationCoordinatorState; code?: string; }
export interface ActivationSubmitInput { activationCode: string; }

interface JournalBase {
  schemaVersion: 2; activationId: string | null; deviceId: string | null; licenseId: string | null;
  idempotencyKey: string; generation: number; stage: "requested" | "server_bound" | "committed";
}
interface RequestedJournal extends JournalBase {
  stage: "requested"; activationId: null; deviceId: null; licenseId: null;
  requestHash: string; usbFingerprint: ActivationRequest["usbFingerprint"]; clientVersion: string;
}
type BoundJournal = JournalBase & {
  stage: "server_bound" | "committed"; activationId: string; deviceId: string; licenseId: string;
  requestHash: string; usbFingerprint: ActivationRequest["usbFingerprint"]; clientVersion: string;
};
interface LegacyJournal extends Omit<JournalBase, "schemaVersion"> {
  schemaVersion: 1; username: string; requestHash: string;
  usbFingerprint: ActivationRequest["usbFingerprint"]; clientVersion: string;
}
type ActivationJournal = RequestedJournal | BoundJournal | LegacyJournal;

interface CoordinatorWriter {
  readJournal(): Promise<ActivationJournal | null>;
  writeJournal(journal: ActivationJournal): Promise<void>;
  writeServerBoundJournal(journal: BoundJournal): Promise<void>;
  recoverPendingArtifacts(): Promise<void>;
  discardRequestedJournal(idempotencyKey: string): Promise<void>;
  retireLegacyCredential(): Promise<void>;
  readLegacyServerBoundRecovery(journal: LegacyJournal): Promise<ActivationResponse>;
  commitLegacyServerBoundRecovery(journal: LegacyJournal, response: ActivationResponse): Promise<void>;
  writeArtifacts(input: { generation: number; response: ActivationResponse }): Promise<void>;
  verifyArtifacts(response: ActivationResponse, generation: number): Promise<void>;
  commitArtifacts(activationId: string, generation: number): Promise<void>;
}
export interface ActivationCoordinator {
  status(): ActivationStatus; preflight(): Promise<ActivationStatus>;
  submit(input: ActivationSubmitInput): Promise<ActivationStatus>; commit(): Promise<ActivationStatus>;
  cancel(): ActivationStatus; close(): ActivationStatus;
}
export interface ActivationCoordinatorDependencies {
  preflight(): Promise<{ usbPresent: boolean }>;
  client: { activate(input: ActivationRequest, signal?: AbortSignal): Promise<ActivationResponse> };
  writer: CoordinatorWriter;
  usbFingerprint: ActivationRequest["usbFingerprint"];
  clientVersion: string;
  randomUUID(): string;
  verifyLicense(response: ActivationResponse): Promise<boolean>;
  commitRemote(activationId: string, idempotencyKey: string, generation: number, signal?: AbortSignal): Promise<void>;
  exit(code: number): void;
}

function requestHash(request: Omit<ActivationRequest, "idempotencyKey">): string {
  return createHash("sha256").update(JSON.stringify([
    "uclaw-activation-request-v2", request.activationCode,
    request.usbFingerprint.version, request.usbFingerprint.sha256, request.clientVersion,
  ])).digest("hex");
}

function legacyRequestHash(journal: LegacyJournal, activationCode: string): string {
  return createHash("sha256").update(JSON.stringify([
    "uclaw-activation-request-v1", journal.username, activationCode,
    journal.usbFingerprint.version, journal.usbFingerprint.sha256, journal.clientVersion,
  ])).digest("hex");
}

export function createActivationCoordinator(deps: ActivationCoordinatorDependencies): ActivationCoordinator {
  let current: ActivationStatus = { state: "checking" };
  let pendingJournal: ActivationJournal | null = null;
  let pendingRequest: ActivationRequest | null = null;
  let operation: { token: number; controller: AbortController; serverBound: boolean } | null = null;
  let nextToken = 0;
  const set = (state: ActivationCoordinatorState, code?: string): ActivationStatus => current = code ? { state, code } : { state };
  const operationError = (): ActivationStatus => ({ state: "error", code: "OPERATION_IN_PROGRESS" });
  const isCurrent = (token: number): boolean => operation?.token === token;
  const recovery = (code?: string): ActivationStatus => set("recovery-required", code);

  const finish = async (journal: BoundJournal, response: ActivationResponse, token: number): Promise<ActivationStatus> => {
    if (journal.stage === "server_bound") await deps.writer.recoverPendingArtifacts();
    if (!isCurrent(token)) return current;
    set("writing"); await deps.writer.writeArtifacts({ generation: journal.generation, response });
    if (!isCurrent(token)) return current;
    set("verifying");
    if (!await deps.verifyLicense(response)) throw new Error("license verification failed");
    if (!isCurrent(token)) return current;
    await deps.writer.verifyArtifacts(response, journal.generation);
    if (!isCurrent(token)) return current;
    set("committing");
    await deps.commitRemote(response.activationId, journal.idempotencyKey, journal.generation, operation?.controller.signal);
    if (!isCurrent(token)) return current;
    await deps.writer.commitArtifacts(response.activationId, journal.generation);
    if (!isCurrent(token)) return current;
    pendingJournal = null; pendingRequest = null; set("complete"); deps.exit(20); return current;
  };

  const run = async (journal: RequestedJournal | BoundJournal, request: ActivationRequest): Promise<ActivationStatus> => {
    if (operation) return operationError();
    const active = { token: ++nextToken, controller: new AbortController(), serverBound: journal.stage !== "requested" };
    operation = active;
    try {
      set("submitting");
      let response: ActivationResponse;
      try { response = await deps.client.activate(request, active.controller.signal); }
      catch (error) {
        if (error instanceof ActivationClientError && error.stage === "failed_before_bind") {
          try {
            await deps.writer.discardRequestedJournal(journal.idempotencyKey);
            pendingJournal = null;
            pendingRequest = null;
          } catch { return recovery("RECOVERY_REQUIRED"); }
          return set("error", error.code);
        }
        return recovery("ACTIVATION_RESULT_UNKNOWN");
      }
      if (!isCurrent(active.token)) return current;
      if (journal.stage !== "requested" && (response.activationId !== journal.activationId || response.deviceId !== journal.deviceId || response.licenseId !== journal.licenseId)) return recovery("RECOVERY_REQUIRED");
      const bound: BoundJournal = {
        schemaVersion: 2, activationId: response.activationId, deviceId: response.deviceId,
        licenseId: response.licenseId, idempotencyKey: journal.idempotencyKey,
        generation: journal.generation, stage: "server_bound",
        requestHash: journal.requestHash, usbFingerprint: journal.usbFingerprint,
        clientVersion: journal.clientVersion,
      };
      active.serverBound = true; set("server-bound");
      if (journal.stage === "requested") await deps.writer.writeServerBoundJournal(bound);
      if (!isCurrent(active.token)) return current;
      pendingJournal = bound;
      return await finish(bound, response, active.token);
    } catch { return recovery("RECOVERY_REQUIRED"); }
    finally { if (operation?.token === active.token) operation = null; }
  };

  const interrupt = (): ActivationStatus => {
    if (!operation) return pendingJournal ? recovery() : set("input");
    const active = operation; operation = null;
    if (!active.serverBound) active.controller.abort();
    return active.serverBound ? recovery() : recovery("ACTIVATION_RESULT_UNKNOWN");
  };

  return {
    status: () => current,
    async preflight() {
      if (operation) return operationError();
      set("checking");
      try {
        pendingJournal = await deps.writer.readJournal(); pendingRequest = null;
        if (pendingJournal?.schemaVersion === 1) await deps.writer.retireLegacyCredential();
        const result = await deps.preflight();
        if (!result.usbPresent) return set("error", "USB_MISSING");
        if (pendingJournal?.stage === "committed") {
          await deps.writer.recoverPendingArtifacts();
          pendingJournal = null;
          set("complete");
          deps.exit(20);
          return current;
        }
        if (pendingJournal) return recovery("RECOVERY_INPUT_REQUIRED");
        return set("input");
      } catch { return set("error", "PREFLIGHT_FAILED"); }
    },
    async submit(input) {
      if (operation) return operationError();
      if (current.state !== "input" && current.state !== "recovery-required") return set("error", "INVALID_STATE");
      const base = { activationCode: input.activationCode, usbFingerprint: deps.usbFingerprint, clientVersion: deps.clientVersion };
      if (pendingJournal?.schemaVersion === 1) {
        const legacy = pendingJournal;
        if (legacy.requestHash !== legacyRequestHash(legacy, input.activationCode)
            || legacy.usbFingerprint.version !== deps.usbFingerprint.version
            || legacy.usbFingerprint.sha256 !== deps.usbFingerprint.sha256
            || legacy.clientVersion !== deps.clientVersion) return recovery("RECOVERY_INPUT_REQUIRED");
        if (legacy.stage === "requested") {
          try { await deps.writer.recoverPendingArtifacts(); }
          catch { return recovery("RECOVERY_REQUIRED"); }
          pendingJournal = null;
        } else if (legacy.stage === "server_bound") {
          let response: ActivationResponse;
          try { response = await deps.writer.readLegacyServerBoundRecovery(legacy); }
          catch { return recovery("LEGACY_RECOVERY_REISSUE_REQUIRED"); }
          set("verifying");
          try {
            if (!await deps.verifyLicense(response)) return recovery("RECOVERY_REQUIRED");
            set("committing");
            await deps.commitRemote(
              response.activationId, legacy.idempotencyKey, legacy.generation, new AbortController().signal,
            );
            await deps.writer.commitLegacyServerBoundRecovery(legacy, response);
          } catch { return recovery("RECOVERY_REQUIRED"); }
          pendingJournal = null;
          set("complete");
          deps.exit(20);
          return current;
        }
      }
      if (pendingJournal?.schemaVersion === 2) {
        if (pendingJournal.requestHash !== requestHash(base)
            || pendingJournal.usbFingerprint.version !== deps.usbFingerprint.version
            || pendingJournal.usbFingerprint.sha256 !== deps.usbFingerprint.sha256
            || pendingJournal.clientVersion !== deps.clientVersion) return recovery("RECOVERY_INPUT_MISMATCH");
        if (pendingJournal.stage === "committed") {
          try { await deps.writer.recoverPendingArtifacts(); pendingJournal = null; set("complete"); deps.exit(20); return current; }
          catch { return recovery("RECOVERY_REQUIRED"); }
        }
        pendingRequest = { ...base, idempotencyKey: pendingJournal.idempotencyKey };
        return run(pendingJournal, pendingRequest);
      }
      const request = { ...base, idempotencyKey: `activation:${deps.randomUUID()}` };
      const journal: RequestedJournal = { schemaVersion: 2, stage: "requested", activationId: null, deviceId: null, licenseId: null, generation: 1, idempotencyKey: request.idempotencyKey, requestHash: requestHash(base), usbFingerprint: deps.usbFingerprint, clientVersion: deps.clientVersion };
      const active = { token: ++nextToken, controller: new AbortController(), serverBound: false };
      operation = active; set("submitting");
      try { await deps.writer.writeJournal(journal); }
      catch { if (operation?.token === active.token) operation = null; return set("error", "REQUEST_JOURNAL_FAILED"); }
      if (!isCurrent(active.token)) return current;
      operation = null; pendingJournal = journal; pendingRequest = request;
      return run(journal, request);
    },
    async commit() {
      if (operation) return current;
      if (!pendingJournal || current.state !== "recovery-required") return set("error", "INVALID_STATE");
      return pendingRequest && pendingJournal.schemaVersion === 2 ? run(pendingJournal, pendingRequest) : recovery("RECOVERY_INPUT_REQUIRED");
    },
    cancel: interrupt, close: interrupt,
  };
}
