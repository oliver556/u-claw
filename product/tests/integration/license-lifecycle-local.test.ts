import { generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLicenseLifecycleClient,
  createUnavailableLicenseLifecycleClient,
  type LocalLicenseLifecycleServer,
  startLocalLicenseLifecycleServer,
} from "../../desktop/src/license-lifecycle/index.js";

const servers: LocalLicenseLifecycleServer[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

async function setup(now = "2026-08-10T00:00:00.000Z") {
  const keys = generateKeyPairSync("ed25519");
  const server = await startLocalLicenseLifecycleServer({
    hostname: "127.0.0.1",
    managementCredential: "fixture-license-management-credential",
    signingKeyId: "fixture-license-key",
    signingPrivateKey: keys.privateKey,
    now: () => new Date(now),
  });
  servers.push(server);
  return {
    server,
    publicKey: keys.publicKey,
    client: createLicenseLifecycleClient({
      endpoint: server.url,
      managementCredential: "fixture-license-management-credential",
      allowLoopbackHttp: true,
    }),
  };
}

const issueInput = {
  idempotencyKey: "issue-fixture-001",
  deviceId: "dev_fixture_001",
  usbFingerprint: "a".repeat(64),
  notBefore: "2026-08-09T00:00:00.000Z",
  expiresAt: "2027-08-10T00:00:00.000Z",
};
const reissueInput = {
  idempotencyKey: "reissue-fixture-001",
  usbFingerprint: "b".repeat(64),
  notBefore: "2026-08-10T00:00:00.000Z",
  expiresAt: "2028-08-10T00:00:00.000Z",
};

describe("localhost license lifecycle backend", () => {
  it("issues, queries, revokes, and distinguishes online failure from revoked", async () => {
    const { client, server } = await setup();
    const issued = await client.issueLicense(issueInput);
    expect(issued.status).toMatchObject({ status: "active", revision: 1, replacementLicenseId: null });
    expect(issued.startupCredential.licenseId).toBe(issued.license.licenseId);
    expect(issued.startupCredential.startupSecret).not.toContain("new-api");
    await expect(client.getLicenseStatus(issued.status.licenseId)).resolves.toMatchObject({
      status: { status: "active", licenseId: issued.status.licenseId },
      receipt: { value: expect.stringMatching(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u) },
    });
    const clientStatus = await fetch(new URL(issued.status.licenseId, server.clientStatusUrl), {
      headers: { authorization: `Bearer ${issued.startupCredential.startupSecret}` },
    });
    expect(clientStatus.status).toBe(200);
    await expect(clientStatus.json()).resolves.toMatchObject({ status: { status: "active" } });
    const unauthorized = await fetch(new URL(issued.status.licenseId, server.clientStatusUrl), {
      headers: { authorization: "Bearer fixture-wrong-startup-secret-material" },
    });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.text()).not.toMatch(/fixture-wrong-startup-secret-material|authorization/iu);

    const revoked = await client.revokeLicense(issued.status.licenseId, { idempotencyKey: "revoke-fixture-001" });
    expect(revoked).toMatchObject({ status: { status: "revoked", revision: 2 } });
    await expect(client.revokeLicense(issued.status.licenseId, { idempotencyKey: "revoke-fixture-001" })).resolves.toEqual(revoked);
    await expect(client.revokeLicense(issued.status.licenseId, { idempotencyKey: "revoke-fixture-002" }))
      .resolves.toMatchObject({ status: { status: "revoked", revision: 2 } });
    await expect(client.getLicenseStatus(issued.status.licenseId)).resolves.toMatchObject({ status: { status: "revoked" } });

    const unavailable = createUnavailableLicenseLifecycleClient("License endpoint is not configured.");
    await expect(unavailable.getLicenseStatus(issued.status.licenseId)).rejects.toMatchObject({
      category: "unavailable", code: "ENDPOINT_NOT_CONFIGURED", retryable: false,
    });
    expect(JSON.stringify(server.listAuditEvents())).not.toMatch(/fixture-license-management-credential|startupSecret|usbFingerprint|signature|authorization/iu);
  });

  it("reissues atomically with rotated identity, secret, and signed artifact", async () => {
    const { client } = await setup();
    const issued = await client.issueLicense(issueInput);
    const replacement = await client.reissueLicense(issued.status.licenseId, reissueInput);
    await expect(client.reissueLicense(issued.status.licenseId, reissueInput)).resolves.toEqual(replacement);
    expect(replacement.status).toMatchObject({ status: "active", revision: 1 });
    expect(replacement.status.licenseId).not.toBe(issued.status.licenseId);
    expect(replacement.startupCredential.startupSecret).not.toBe(issued.startupCredential.startupSecret);
    expect(replacement.license.usbFingerprint.sha256).toBe(reissueInput.usbFingerprint);
    expect(replacement.license.expiresAt).toBe(reissueInput.expiresAt);
    expect(replacement.license.signature.value).not.toBe(issued.license.signature.value);
    await expect(client.getLicenseStatus(issued.status.licenseId)).resolves.toMatchObject({
      status: { status: "reissued", replacementLicenseId: replacement.status.licenseId, revision: 2 },
    });
    await expect(client.revokeLicense(issued.status.licenseId, { idempotencyKey: "revoke-old-001" })).rejects.toMatchObject({
      category: "status", code: "LICENSE_REISSUED", retryable: false,
    });
  });

  it("replays identical idempotent mutations and rejects key/input and concurrent conflicts", async () => {
    const { client } = await setup();
    const first = await client.issueLicense(issueInput);
    await expect(client.issueLicense(issueInput)).resolves.toEqual(first);
    await expect(client.issueLicense({ ...issueInput, deviceId: "dev_changed_001" })).rejects.toMatchObject({
      category: "conflict", code: "IDEMPOTENCY_CONFLICT", retryable: false,
    });
    await expect(client.issueLicense({ ...issueInput, idempotencyKey: "issue-fixture-other" })).rejects.toMatchObject({
      category: "conflict", code: "LICENSE_CONFLICT", retryable: false,
    });

    const [one, two] = await Promise.allSettled([
      client.reissueLicense(first.status.licenseId, { ...reissueInput, idempotencyKey: "reissue-concurrent-a" }),
      client.reissueLicense(first.status.licenseId, { ...reissueInput, idempotencyKey: "reissue-concurrent-b" }),
    ]);
    expect([one.status, two.status].sort()).toEqual(["fulfilled", "rejected"]);
    const rejection = [one, two].find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({ category: "status", code: "LICENSE_REISSUED" });

    const concurrent = await setup();
    const [issueOne, issueTwo] = await Promise.allSettled([
      concurrent.client.issueLicense({ ...issueInput, idempotencyKey: "issue-concurrent-a" }),
      concurrent.client.issueLicense({ ...issueInput, idempotencyKey: "issue-concurrent-b" }),
    ]);
    expect([issueOne.status, issueTwo.status].sort()).toEqual(["fulfilled", "rejected"]);
    const issueRejection = [issueOne, issueTwo].find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(issueRejection.reason).toMatchObject({ category: "conflict", code: "LICENSE_CONFLICT" });
  });

  it("derives expired state and enforces HTTPS except exact test loopback", async () => {
    const { client } = await setup("2028-08-10T00:00:00.000Z");
    const issued = await client.issueLicense({
      ...issueInput,
      notBefore: "2026-08-09T00:00:00.000Z",
      expiresAt: "2027-08-10T00:00:00.000Z",
    });
    await expect(client.getLicenseStatus(issued.status.licenseId)).resolves.toMatchObject({ status: { status: "expired" } });
    const replacement = await client.reissueLicense(issued.status.licenseId, {
      ...reissueInput,
      notBefore: "2028-08-10T00:00:00.000Z",
      expiresAt: "2029-08-10T00:00:00.000Z",
    });
    expect(replacement.status.status).toBe("active");
    for (const endpoint of ["http://example.test/v1/", "http://127.0.0.2/v1/", "http://192.168.1.10/v1/"]) {
      expect(() => createLicenseLifecycleClient({ endpoint, managementCredential: "fixture-license-management-credential" })).toThrow(/HTTPS|loopback/iu);
    }
    expect(() => createLicenseLifecycleClient({
      endpoint: "http://127.0.0.1/v1/", managementCredential: "fixture-license-management-credential",
    })).toThrow(/HTTPS|loopback/iu);
  });

  it("never exposes remote lifecycle error messages", async () => {
    const credential = "fixture-license-management-credential";
    const fingerprint = "f".repeat(64);
    const remoteMessage = [
      "fixture-startup-secret-material-001",
      fingerprint,
      "receipt.signature.value",
      "Authorization: Bearer",
      credential,
    ].join(" ");
    const client = createLicenseLifecycleClient({
      endpoint: "http://127.0.0.1/uclaw-license/v1/",
      managementCredential: credential,
      allowLoopbackHttp: true,
      fetch: async () => new Response(JSON.stringify({
        error: {
          category: "status",
          code: "LICENSE_REVOKED",
          message: remoteMessage,
          retryable: false,
        },
      }), { status: 409, headers: { "content-type": "application/json" } }),
    });

    const error = await client.getLicenseStatus("lic_fixture_001").catch((caught: unknown) => caught) as Error & Record<string, unknown>;
    expect(error).toMatchObject({ category: "status", code: "LICENSE_REVOKED", retryable: false, status: 409 });
    for (const exposed of [error.message, error.toString(), JSON.stringify(error)]) {
      expect(exposed).not.toContain("fixture-startup-secret-material-001");
      expect(exposed).not.toContain(fingerprint);
      expect(exposed).not.toMatch(/receipt|signature|authorization/iu);
      expect(exposed).not.toContain(credential);
    }
  });
});
