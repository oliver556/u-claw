import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import { createActivationCoordinator } from "../src/activation/coordinator.js";

const input = {
  username: "UCLAW-TEST",
  activationCode: "0123456789ABCDEFGHJKMNPQRS",
};
const fingerprint = { version: "uclaw-usb-v1" as const, sha256: "a".repeat(64) };
const response = {
  activationId: "activation-001",
  deviceId: "device-001",
  licenseId: "license-001",
  license: {
    schemaVersion: 1,
    deviceId: "device-001",
    licenseId: "license-001",
    usbFingerprint: { scheme: "uclaw-usb-v1", sha256: "a".repeat(64) },
    startupSecretProof: {
      algorithm: "sha256-salt-v1",
      startupSecretSalt: "b".repeat(32),
      startupSecretHash: "c".repeat(64),
    },
    notBefore: "2026-08-13T00:00:00.000Z",
    expiresAt: "2027-08-13T00:00:00.000Z",
    signature: { algorithm: "ed25519", keyId: "activation-key", value: "s".repeat(80) },
  },
  startupCredential: {
    schemaVersion: 1,
    deviceId: "device-001",
    licenseId: "license-001",
    startupSecret: "x".repeat(32),
  },
  builtinCredential: {
    schemaVersion: 1,
    deviceId: "device-001",
    licenseId: "license-001",
    accessToken: "t".repeat(16),
    expiresAt: "2026-08-14T00:00:00.000Z",
  },
  status: "active" as const,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function requestedJournal() {
  const hash = createHash("sha256").update(JSON.stringify([
    "uclaw-activation-request-v1", input.username, input.activationCode,
    fingerprint.version, fingerprint.sha256, "1.2.3",
  ])).digest("hex");
  return {
    schemaVersion: 1 as const,
    activationId: null,
    deviceId: null,
    licenseId: null,
    idempotencyKey: "activation:fixed-uuid",
    generation: 1,
    stage: "requested" as const,
    username: input.username,
    requestHash: hash,
    usbFingerprint: fingerprint,
    clientVersion: "1.2.3",
  };
}

function serverBoundJournal() {
  const binding = requestedJournal();
  return {
    schemaVersion: 1 as const,
    idempotencyKey: "activation:fixed-uuid",
    generation: 1,
    activationId: response.activationId,
    deviceId: response.deviceId,
    licenseId: response.licenseId,
    stage: "server_bound" as const,
    username: binding.username,
    requestHash: binding.requestHash,
    usbFingerprint: binding.usbFingerprint,
    clientVersion: binding.clientVersion,
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  const writer = {
    readJournal: vi.fn<() => Promise<any>>(async () => null),
    writeJournal: vi.fn(async (): Promise<void> => undefined),
    writeServerBoundJournal: vi.fn(async () => undefined),
    recoverPendingArtifacts: vi.fn(async () => undefined),
    writeArtifacts: vi.fn(async (): Promise<void> => undefined),
    verifyArtifacts: vi.fn(async () => undefined),
    commitArtifacts: vi.fn(async () => undefined),
  };
  const deps = {
    preflight: vi.fn(async () => ({ usbPresent: true })),
    client: { activate: vi.fn(async () => response) },
    writer,
    usbFingerprint: fingerprint,
    clientVersion: "1.2.3",
    randomUUID: vi.fn(() => "fixed-uuid"),
    verifyLicense: vi.fn(async () => true),
    commitRemote: vi.fn(async () => undefined),
    exit: vi.fn(),
    ...overrides,
  };
  return { deps, writer, coordinator: createActivationCoordinator(deps as never) };
}

describe("activation coordinator", () => {
  it("moves checking to input after preflight", async () => {
    const { coordinator } = setup();
    expect(await coordinator.preflight()).toEqual({ state: "input" });
  });

  it("constructs the trusted request and persists requested before calling server", async () => {
    const { coordinator, deps, writer } = setup();
    await coordinator.preflight();

    expect(await coordinator.submit(input)).toEqual({ state: "complete" });
    const request = {
      ...input,
      usbFingerprint: fingerprint,
      clientVersion: "1.2.3",
      idempotencyKey: "activation:fixed-uuid",
    };
    expect(writer.writeJournal).toHaveBeenCalledWith({
      schemaVersion: 1,
      activationId: null,
      deviceId: null,
      licenseId: null,
      idempotencyKey: request.idempotencyKey,
      generation: 1,
      stage: "requested",
      username: input.username,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      usbFingerprint: fingerprint,
      clientVersion: "1.2.3",
    });
    expect(deps.client.activate).toHaveBeenCalledWith(request, expect.any(AbortSignal));
    expect(writer.writeJournal.mock.invocationCallOrder[0]).toBeLessThan(deps.client.activate.mock.invocationCallOrder[0]);
    expect(deps.commitRemote).toHaveBeenCalledWith(
      response.activationId,
      request.idempotencyKey,
      1,
      expect.any(AbortSignal),
    );
    expect(deps.exit).toHaveBeenCalledWith(20);
  });

  it("rejects concurrent submit without disturbing the active operation", async () => {
    const activation = deferred<typeof response>();
    const client = { activate: vi.fn(() => activation.promise) };
    const { coordinator } = setup({ client });
    await coordinator.preflight();

    const first = coordinator.submit(input);
    await vi.waitFor(() => expect(client.activate).toHaveBeenCalledOnce());
    expect(await coordinator.submit(input)).toEqual({ state: "error", code: "OPERATION_IN_PROGRESS" });
    expect(coordinator.status()).toEqual({ state: "submitting" });

    activation.resolve(response);
    expect(await first).toEqual({ state: "complete" });
    expect(client.activate).toHaveBeenCalledOnce();
  });

  it("returns the current redacted status when commit polls an active operation", async () => {
    const artifactWrite = deferred<void>();
    const { coordinator, writer } = setup();
    writer.writeArtifacts.mockImplementation(() => artifactWrite.promise);
    await coordinator.preflight();

    const pending = coordinator.submit(input);
    await vi.waitFor(() => expect(coordinator.status()).toEqual({ state: "writing" }));
    expect(await coordinator.commit()).toEqual({ state: "writing" });

    artifactWrite.resolve();
    expect(await pending).toEqual({ state: "complete" });
  });

  it("locks submission while the requested journal is being written", async () => {
    const journalWrite = deferred<void>();
    const { coordinator, writer, deps } = setup();
    writer.writeJournal.mockImplementation(async () => { await journalWrite.promise; });
    await coordinator.preflight();

    const first = coordinator.submit(input);
    expect(await coordinator.submit(input)).toEqual({ state: "error", code: "OPERATION_IN_PROGRESS" });
    expect(deps.client.activate).not.toHaveBeenCalled();

    journalWrite.resolve();
    expect(await first).toEqual({ state: "complete" });
  });

  it("does not call the server when cancelled while writing the requested journal", async () => {
    const journalWrite = deferred<void>();
    const { coordinator, writer, deps } = setup();
    writer.writeJournal.mockImplementation(async () => { await journalWrite.promise; });
    await coordinator.preflight();

    const pending = coordinator.submit(input);
    expect(coordinator.cancel()).toEqual({ state: "recovery-required", code: "ACTIVATION_RESULT_UNKNOWN" });
    journalWrite.resolve();

    expect(await pending).toEqual({ state: "recovery-required", code: "ACTIVATION_RESULT_UNKNOWN" });
    expect(deps.client.activate).not.toHaveBeenCalled();
  });

  it("aborts an in-flight request and prevents late success from writing artifacts", async () => {
    const activation = deferred<typeof response>();
    let signal: AbortSignal | undefined;
    const client = { activate: vi.fn((_request, nextSignal: AbortSignal) => {
      signal = nextSignal;
      return activation.promise;
    }) };
    const { coordinator, writer, deps } = setup({ client });
    await coordinator.preflight();

    const pending = coordinator.submit(input);
    await vi.waitFor(() => expect(client.activate).toHaveBeenCalledOnce());
    expect(coordinator.cancel()).toEqual({ state: "recovery-required", code: "ACTIVATION_RESULT_UNKNOWN" });
    expect(signal?.aborted).toBe(true);
    activation.resolve(response);
    expect(await pending).toEqual({ state: "recovery-required", code: "ACTIVATION_RESULT_UNKNOWN" });
    expect(writer.writeServerBoundJournal).not.toHaveBeenCalled();
    expect(writer.writeArtifacts).not.toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();
  });

  it("does not abort after server binding and leaves recovery required", async () => {
    const artifactWrite = deferred<void>();
    const { coordinator, writer } = setup();
    writer.writeArtifacts.mockImplementation(() => artifactWrite.promise);
    await coordinator.preflight();

    const pending = coordinator.submit(input);
    await vi.waitFor(() => expect(coordinator.status().state).toBe("writing"));
    expect(coordinator.close()).toEqual({ state: "recovery-required" });
    artifactWrite.resolve();
    expect(await pending).toEqual({ state: "recovery-required" });
    expect(writer.verifyArtifacts).not.toHaveBeenCalled();
  });

  it("keeps the requested journal after an unknown network result", async () => {
    const { coordinator, writer } = setup({
      client: { activate: vi.fn(async () => { throw Object.assign(new Error("redacted"), { code: "TIMEOUT" }); }) },
    });
    await coordinator.preflight();

    expect(await coordinator.submit(input)).toEqual({ state: "recovery-required", code: "ACTIVATION_RESULT_UNKNOWN" });
    expect(writer.writeJournal).toHaveBeenCalledWith(requestedJournal());
    expect(writer.writeServerBoundJournal).not.toHaveBeenCalled();
  });

  it("requires input for a restarted requested journal, then replays with the same idempotency key", async () => {
    const pending = requestedJournal();
    const { coordinator, writer, deps } = setup();
    writer.readJournal.mockResolvedValue(pending);
    expect(await coordinator.preflight()).toEqual({ state: "recovery-required", code: "RECOVERY_INPUT_REQUIRED" });

    expect(await coordinator.commit()).toEqual({ state: "recovery-required", code: "RECOVERY_INPUT_REQUIRED" });
    expect(await coordinator.submit(input)).toEqual({ state: "complete" });
    expect(deps.randomUUID).not.toHaveBeenCalled();
    expect(deps.client.activate).toHaveBeenCalledWith(
      { ...input, usbFingerprint: fingerprint, clientVersion: "1.2.3", idempotencyKey: pending.idempotencyKey },
      expect.any(AbortSignal),
    );
  });

  it("replays activate for server-bound recovery and rejects mismatched response IDs", async () => {
    const pending = serverBoundJournal();
    const mismatched = { ...response, licenseId: "license-other" };
    const { coordinator, writer } = setup({ client: { activate: vi.fn(async () => mismatched) } });
    writer.readJournal.mockResolvedValue(pending);
    await coordinator.preflight();

    expect(await coordinator.submit(input)).toEqual({ state: "recovery-required", code: "RECOVERY_REQUIRED" });
    expect(writer.writeArtifacts).not.toHaveBeenCalled();
  });

  it("requires matching input before replaying a restarted server-bound journal", async () => {
    const pending = serverBoundJournal();
    const { coordinator, writer, deps } = setup();
    writer.readJournal.mockResolvedValue(pending);
    await coordinator.preflight();

    expect(await coordinator.commit()).toEqual({ state: "recovery-required", code: "RECOVERY_INPUT_REQUIRED" });
    expect(await coordinator.submit({ ...input, activationCode: "ZZZZZZZZZZZZZZZZZZZZZZZZZZ" }))
      .toEqual({ state: "recovery-required", code: "RECOVERY_INPUT_MISMATCH" });
    expect(deps.client.activate).not.toHaveBeenCalled();
    expect(await coordinator.submit(input)).toEqual({ state: "complete" });
    expect(deps.client.activate).toHaveBeenCalledWith(
      { ...input, usbFingerprint: fingerprint, clientVersion: "1.2.3", idempotencyKey: pending.idempotencyKey },
      expect.any(AbortSignal),
    );
  });

  it("rejects a server-bound journal whose trusted request metadata no longer matches", async () => {
    const pending = {
      ...serverBoundJournal(),
      usbFingerprint: { ...fingerprint, sha256: "b".repeat(64) },
    };
    const { coordinator, writer, deps } = setup();
    writer.readJournal.mockResolvedValue(pending);
    await coordinator.preflight();

    expect(await coordinator.submit(input))
      .toEqual({ state: "recovery-required", code: "RECOVERY_INPUT_MISMATCH" });
    expect(deps.client.activate).not.toHaveBeenCalled();
  });

  it("continues a matching server-bound recovery through local verification and commit", async () => {
    const pending = serverBoundJournal();
    const { coordinator, writer, deps } = setup();
    writer.readJournal.mockResolvedValue(pending);
    await coordinator.preflight();

    expect(await coordinator.submit(input)).toEqual({ state: "complete" });
    expect(writer.writeArtifacts).toHaveBeenCalledWith({ generation: 1, response });
    expect(deps.verifyLicense).toHaveBeenCalledWith(response);
    expect(writer.verifyArtifacts).toHaveBeenCalledWith(response, 1);
    expect(deps.commitRemote).toHaveBeenCalledWith(
      response.activationId,
      pending.idempotencyKey,
      1,
      expect.any(AbortSignal),
    );
    expect(writer.commitArtifacts).toHaveBeenCalledWith(response.activationId, 1);
  });

  it("runs preflight then cleans up a restarted committed journal without secret input", async () => {
    const { coordinator, writer, deps } = setup();
    writer.readJournal.mockResolvedValue({ ...serverBoundJournal(), stage: "committed" });
    expect(await coordinator.preflight()).toEqual({ state: "complete" });

    expect(deps.preflight).toHaveBeenCalledOnce();
    expect(writer.recoverPendingArtifacts).toHaveBeenCalledOnce();
    expect(deps.client.activate).not.toHaveBeenCalled();
    expect(deps.commitRemote).not.toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledWith(20);
  });

  it.each([
    ["artifact write", "writeArtifacts"],
    ["artifact readback", "verifyArtifacts"],
  ] as const)("retains recovery after %s failure", async (_name, method) => {
    const { coordinator, writer } = setup();
    writer[method].mockRejectedValue(new Error("ENODEV"));
    await coordinator.preflight();
    expect(await coordinator.submit(input)).toEqual({ state: "recovery-required", code: "RECOVERY_REQUIRED" });
  });

  it("retains recovery after local license verification failure", async () => {
    const { coordinator, deps } = setup();
    deps.verifyLicense.mockResolvedValue(false);
    await coordinator.preflight();
    expect(await coordinator.submit(input)).toEqual({ state: "recovery-required", code: "RECOVERY_REQUIRED" });
  });

  it("retains recovery after remote commit result is lost", async () => {
    const { coordinator, deps } = setup();
    deps.commitRemote.mockRejectedValue(new Error("lost"));
    await coordinator.preflight();
    expect(await coordinator.submit(input)).toEqual({ state: "recovery-required", code: "RECOVERY_REQUIRED" });
  });

  it("returns fixed preflight errors", async () => {
    const missing = setup({ preflight: vi.fn(async () => ({ usbPresent: false })) });
    expect(await missing.coordinator.preflight()).toEqual({ state: "error", code: "USB_MISSING" });
    const failed = setup({ preflight: vi.fn(async () => { throw new Error("/private/path"); }) });
    expect(await failed.coordinator.preflight()).toEqual({ state: "error", code: "PREFLIGHT_FAILED" });
  });
});
