import { describe, expect, it } from "vitest";

import * as activationContract from "../src/activation.js";

import {
  ActivationCommitSchema,
  ActivationErrorSchema,
  ActivationRequestSchema,
  ActivationResponseSchema,
  BuiltinCredentialArtifactSchema,
  AdminInventoryGenerateSchema,
  AdminInventoryLocatorSchema,
  AdminMutationResultSchema,
  ClientPolicySchema,
  LicenseStatusSummarySchema,
  normalizeActivationCodeInput,
} from "../src/index.js";

const request = {
  activationCode: "TESTTESTTESTTESTTESTTEST12",
  usbFingerprint: {
    version: "uclaw-usb-v1",
    sha256: "a".repeat(64),
  },
  clientVersion: "1.0.0",
  idempotencyKey: "activation-fixture-001",
};

describe("activation API contract", () => {
	it("does not export the removed short-lived device token protocol", () => {
		expect(activationContract).not.toHaveProperty("DeviceTokenRequestSchema");
		expect(activationContract).not.toHaveProperty("DeviceTokenResponseSchema");
	});

	it("accepts activation code without username and rejects extra identity fields", () => {
		expect(ActivationRequestSchema.parse(request)).toEqual(request);
		expect(() => ActivationRequestSchema.parse({ ...request, username: "UCLAW-00000001" })).toThrow();
	});

	it("accepts controlled cross-system aliases without requiring equal fingerprints", () => {
		const aliased = {
			...request,
			deviceAliases: [
				{
					target: "win-x64",
					fingerprint: { version: "uclaw-usb-v1", sha256: "a".repeat(64) },
					evidence: {
						target: "win-x64",
						platform: "win32",
						arch: "x64",
						source: "windows-storage-descriptor",
						busType: "USB",
						vendor: "ACME",
						product: "FLASH DRIVE",
						serial: "SN123",
						capacityBytes: 64_000_000_000,
					},
				},
				{
					target: "macos-arm64",
					fingerprint: { version: "uclaw-usb-v2", sha256: "c".repeat(64) },
					evidence: {
						target: "macos-arm64",
						platform: "darwin",
						arch: "arm64",
						source: "macos-diskutil",
						busProtocol: "USB",
						deviceLocation: "external",
						vendor: "ACME",
						product: "FLASH DRIVE",
						serial: "SN123",
						capacityBytes: 64_000_000_000,
						volumeUuid: "4f2b2fc0-3e70-49a0-9dfc-0e012aef0001",
					},
				},
			],
		};
		const parsed = ActivationRequestSchema.parse(aliased);
		expect(parsed.deviceAliases?.[0]?.fingerprint.sha256).not.toBe(parsed.deviceAliases?.[1]?.fingerprint.sha256);
		expect(() => ActivationRequestSchema.parse({
			...aliased,
			deviceAliases: [aliased.deviceAliases[0], { ...aliased.deviceAliases[1], target: "win-x64" }],
		})).toThrow();
		expect(() => ActivationRequestSchema.parse({
			...aliased,
			deviceAliases: [{ ...aliased.deviceAliases[1], evidence: { ...aliased.deviceAliases[1].evidence, mountPath: "/Volumes/U-Claw" } }],
		})).toThrow();
	});

	it("locks the commercial device credential fields without server API keys", () => {
		const credential = {
			schemaVersion: 2,
			deviceId: "dev_fixture_001",
			licenseId: "lic_fixture_001",
			endpoint: "https://license.example.test/model-api/",
			deviceTokenId: "dt_fixture_001",
			model: "gpt-5.5",
			deviceToken: `uclaw_dt_${"A".repeat(43)}`,
		};

		expect(BuiltinCredentialArtifactSchema.parse(credential)).toEqual(credential);
		for (const endpoint of [
			"https://host.test/v1",
			"HTTPS://host.test/v1",
			"Https://host.test/v1",
			"https://192.0.2.1/v1",
			"https://[2001:db8::1]/v1",
			"https://[2001:db8::1]:8443/model-api/v1",
			"https://127.0.0.1:8443/model-api/",
			"https://host.test/model-api/%3F/%23",
		]) {
			expect(BuiltinCredentialArtifactSchema.parse({ ...credential, endpoint })).toBeTruthy();
		}
		expect(() => BuiltinCredentialArtifactSchema.parse({ ...credential, accessToken: ["legacy", "token", "material"].join("-") })).toThrow();
		expect(() => BuiltinCredentialArtifactSchema.parse({ ...credential, expiresAt: "2027-08-13T00:00:00Z" })).toThrow();
		expect(() => BuiltinCredentialArtifactSchema.parse({ ...credential, deviceToken: `uclaw_dt_${"A".repeat(42)}` })).toThrow();
		expect(() => BuiltinCredentialArtifactSchema.parse({ ...credential, deviceToken: `uclaw_dt_${"A".repeat(42)}!` })).toThrow();
		for (const endpoint of [
			"http://license.example.test/model-api/",
			"ftp://license.example.test/model-api/",
			"file:///model-api/",
			"javascript:alert(1)",
			"https://user:password@license.example.test/model-api/",
			"https://license.example.test/model-api/?region=test",
			"https://license.example.test/model-api/#models",
			"https://host.test/v1?",
			"https://host.test/v1#",
			"https:///a",
			" https://host.test/a",
			"https:\t//host.test/a",
			"https://host.test/a ",
			"https://host.test/a\n",
			String.raw`https:\host.test/a`,
			String.raw`https:\\host.test/a`,
			"https://",
			"https://user@@host.test/a",
			"https://user%40name@host.test/a",
		]) {
			expect(
				() => BuiltinCredentialArtifactSchema.parse({ ...credential, endpoint }),
				`accepted insecure endpoint: ${endpoint}`,
			).toThrow();
		}
	});

	it("keeps admin mutations explicit and redacted", () => {
		const operation = { operatorId: "operator_fixture", requestId: "request_fixture_001", idempotencyKey: "admin-fixture-001", reason: "support request" };
		expect(AdminInventoryGenerateSchema.parse({ count: 1, ...operation }).count).toBe(1);
		expect(() => AdminInventoryGenerateSchema.parse({ count: 1, ...operation, reason: "" })).toThrow();
		expect(() => AdminInventoryLocatorSchema.parse({ inventoryId: "inv_fixture_001", deviceId: "dev_fixture_001" })).toThrow();
		expect(() => AdminMutationResultSchema.parse({ licenseId: "lic_fixture_001", status: "reissued", revision: 2, replacementInventoryId: "inv_replacement_001", activationCode: "secret" })).toThrow();
	});
  it("separates UI normalization from the strict wire activation code", () => {
    expect(normalizeActivationCodeInput("01234-56789-abcde-fghjk-mnpqrs")).toBe("0123456789ABCDEFGHJKMNPQRS");
    const strictCode = ["0123456789", "ABCDEFGHJK", "MNPQRS"].join("");
    expect(ActivationRequestSchema.parse({ ...request, activationCode: strictCode }).activationCode).toBe(strictCode);
    expect(() => ActivationRequestSchema.parse({ ...request, activationCode: "01234-56789-ABCDE-FGHJK-MNPQRS" })).toThrow();
    expect(() => ActivationRequestSchema.parse({ ...request, activationCode: "0123456789ABCDEFGHJKMNPQRS0" })).toThrow();
    expect(() => ActivationRequestSchema.parse({ ...request, activationCode: "01234-56789-ABCDE-FGHIJ-KLMNOP" })).toThrow();
    expect(() => ActivationRequestSchema.parse({ ...request, status: "active" })).toThrow();
  });

  it("accepts strict activation response and commit payloads", () => {
    const response = {
      activationId: "act_fixture_001",
      deviceId: "dev_fixture_001",
      licenseId: "lic_fixture_001",
      license: {
        schemaVersion: 1,
        usernameId: "usr_fixture_001",
        deviceId: "dev_fixture_001",
        licenseId: "lic_fixture_001",
        usbFingerprint: { scheme: "uclaw-usb-v1", sha256: "a".repeat(64) },
        startupSecretProof: {
          algorithm: "sha256-salt-v1",
          startupSecretSalt: "b".repeat(32),
          startupSecretHash: "c".repeat(64),
        },
        notBefore: "2026-08-13T00:00:00Z",
        expiresAt: "2027-08-13T00:00:00Z",
        revision: 1,
        signature: { algorithm: "ed25519", keyId: "fixture-key", value: "d".repeat(88) },
      },
      startupCredential: {
        schemaVersion: 1,
        deviceId: "dev_fixture_001",
        licenseId: "lic_fixture_001",
        startupSecret: "fixture-generated-secret-material-001",
      },
      builtinCredential: {
        schemaVersion: 2,
        deviceId: "dev_fixture_001",
        licenseId: "lic_fixture_001",
        endpoint: "https://api.u-claw.org/v1",
        deviceTokenId: "dt_fixture_001",
        model: "gpt-5.5",
        deviceToken: `uclaw_dt_${"A".repeat(43)}`,
      },
      status: "active",
    };

    expect(ActivationResponseSchema.parse(response)).toEqual(response);
    expect(() => ActivationResponseSchema.parse({
      ...response,
      startupCredential: { ...response.startupCredential, deviceId: "dev_other_001" },
    })).toThrow();
    expect(() => ActivationResponseSchema.parse({
      ...response,
      builtinCredential: { ...response.builtinCredential, internalUrl: "https://internal.invalid" },
    })).toThrow();
    expect(ActivationCommitSchema.parse({
      idempotencyKey: "commit-fixture-001",
      artifactGeneration: 1,
    })).toBeTruthy();
    expect(() => ActivationCommitSchema.parse({
      idempotencyKey: "commit-fixture-001",
      artifactGeneration: 1,
      releaseBinding: true,
    })).toThrow();
  });

  it("accepts only the redacted public error envelope", () => {
    const error = {
      requestId: "req_fixture_001",
      activationId: "act_fixture_001",
      code: "ACTIVATION_SERVICE_UNAVAILABLE",
      stage: "server_bound",
      retryable: true,
      supportCode: "ACT-NET-004",
    };

    expect(ActivationErrorSchema.parse(error)).toEqual(error);
    for (const leakedField of ["message", "sql", "stack", "usbFingerprint", "activationCode", "authorization"]) {
      expect(() => ActivationErrorSchema.parse({ ...error, [leakedField]: "leak" })).toThrow();
    }
  });

  it("freezes client policy and license status fields", () => {
    expect(ClientPolicySchema.parse({
      minimumClientVersion: "1.0.0",
      upgradeRequired: false,
      feedUrl: "https://updates.u-claw.org/releases/",
    })).toBeTruthy();
    expect(() => ClientPolicySchema.parse({
      minimumClientVersion: "1.0.0",
      upgradeRequired: false,
      feedUrl: "https://updates.u-claw.org/releases/",
      releaseKey: "forbidden",
    })).toThrow();
    expect(LicenseStatusSummarySchema.parse({
      licenseId: "lic_fixture_001",
      deviceId: "dev_fixture_001",
      status: "active",
      revision: 1,
      notBefore: "2026-08-13T00:00:00.000Z",
      expiresAt: "2027-08-13T00:00:00.000Z",
      replacementLicenseId: null,
      updatedAt: "2026-08-13T00:00:00.000Z",
    })).toBeTruthy();
  });
});
