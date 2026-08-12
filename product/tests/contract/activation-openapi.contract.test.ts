import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const document = JSON.parse(readFileSync(resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../activation-server/api/openapi.yaml",
), "utf8")) as {
  openapi: string;
  paths: Record<string, Record<string, any>>;
  components: {
    securitySchemes: Record<string, unknown>;
    responses: Record<string, unknown>;
    schemas: Record<string, { required?: string[]; properties?: Record<string, any>; additionalProperties?: boolean }>;
  };
};

const required = (schemaName: string) => document.components.schemas[schemaName]?.required ?? [];

describe("activation OpenAPI contract", () => {
  it("declares all public activation and lifecycle routes", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining([
      "/health/live",
      "/health/ready",
      "/v1/client-policy",
      "/v1/activations",
      "/v1/activations/{activationId}",
      "/v1/activations/{activationId}/commit",
      "/v1/licenses/{licenseId}/status",
      "/v1/device-tokens",
    ]));
  });

  it("locks component names and required field sets", () => {
    expect(required("ActivationRequest")).toEqual([
      "username", "activationCode", "usbFingerprint", "clientVersion", "idempotencyKey",
    ]);
    expect(required("ActivationResponse")).toEqual([
      "activationId", "deviceId", "licenseId", "license", "startupCredential", "builtinCredential", "status",
    ]);
    expect(required("ActivationCommit")).toEqual(["idempotencyKey", "artifactGeneration"]);
    expect(required("ActivationError")).toEqual([
      "requestId", "activationId", "code", "stage", "retryable", "supportCode",
    ]);
    expect(required("ClientPolicy")).toEqual([
      "minimumClientVersion", "latestClientVersion", "upgradeRequired", "statusRefreshSeconds", "maximumOfflineGraceSeconds",
    ]);
    expect(required("LicenseStatusSummary")).toEqual([
      "licenseId", "deviceId", "status", "revision", "notBefore", "expiresAt", "replacementLicenseId", "updatedAt",
    ]);
    expect(required("StartupLicense")).toEqual([
      "schemaVersion", "usernameId", "deviceId", "licenseId", "usbFingerprint", "startupSecretProof", "notBefore", "expiresAt", "revision", "signature",
    ]);
    expect(required("StartupCredential")).toEqual(["schemaVersion", "deviceId", "licenseId", "startupSecret"]);
    expect(required("BuiltinCredential")).toEqual(["schemaVersion", "deviceId", "licenseId", "accessToken", "expiresAt"]);
    expect(required("LicenseStatusReceipt")).toEqual(["value"]);
    expect(required("DeviceTokenRequest")).toEqual(["deviceId", "licenseId", "idempotencyKey"]);
    expect(required("DeviceTokenResponse")).toEqual(["accessToken", "tokenType", "expiresAt"]);
    expect(required("HealthResponse")).toEqual(["status"]);
    for (const name of [
      "ActivationRequest", "ActivationResponse", "ActivationCommit", "ActivationError", "ClientPolicy",
      "StartupLicense", "StartupCredential", "BuiltinCredential", "LicenseStatusSummary", "LicenseStatusReceipt",
      "LicenseStatusResponse", "DeviceTokenRequest", "DeviceTokenResponse", "HealthResponse",
    ]) expect(document.components.schemas[name].additionalProperties).toBe(false);
    expect(document.components.schemas.ActivationResponse.properties).toMatchObject({
      license: { $ref: "#/components/schemas/StartupLicense" },
      startupCredential: { $ref: "#/components/schemas/StartupCredential" },
      builtinCredential: { $ref: "#/components/schemas/BuiltinCredential" },
    });
    expect(document.components.schemas.LicenseStatusResponse.properties).toMatchObject({
      receipt: { $ref: "#/components/schemas/LicenseStatusReceipt" },
    });
  });

  it("uses the same normalized Crockford code pattern as shared", () => {
    expect(document.components.schemas.ActivationRequest.properties?.activationCode).toMatchObject({
      pattern: "^[0-9A-HJKMNP-TV-Z]{26}$",
    });
  });

  it("requires bearer auth for recovery, status, and token issuance", () => {
    expect(document.components.securitySchemes.BearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    for (const [path, method] of [
      ["/v1/activations/{activationId}", "get"],
      ["/v1/licenses/{licenseId}/status", "get"],
      ["/v1/device-tokens", "post"],
    ] as const) expect(document.paths[path][method].security).toEqual([{ BearerAuth: [] }]);
  });

  it("defines bounded payloads, health bodies, and unified public errors", () => {
    expect(document.components.schemas.ActivationCommit.properties?.artifactGeneration).toMatchObject({
      maximum: Number.MAX_SAFE_INTEGER,
    });
    expect(document.components.schemas.LicenseStatusSummary.properties?.revision).toMatchObject({
      maximum: Number.MAX_SAFE_INTEGER,
    });
    for (const field of ["notBefore", "expiresAt"]) {
      expect(document.components.schemas.StartupLicense.properties?.[field]).toMatchObject({
        pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$",
      });
    }
    expect(document.components.schemas.ClientPolicy.properties?.minimumClientVersion).toMatchObject({
      pattern: "^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)$",
    });
    expect(document.paths["/health/live"].get.responses["200"].content["application/json"].schema)
      .toEqual({ $ref: "#/components/schemas/HealthResponse" });
    expect(document.paths["/v1/device-tokens"].post.requestBody.content["application/json"].schema)
      .toEqual({ $ref: "#/components/schemas/DeviceTokenRequest" });
    expect(document.paths["/v1/device-tokens"].post.responses["200"].content["application/json"].schema)
      .toEqual({ $ref: "#/components/schemas/DeviceTokenResponse" });
    for (const status of ["401", "403", "429", "503"]) {
      expect(document.components.responses[status]).toMatchObject({
        content: { "application/json": { schema: { $ref: "#/components/schemas/ActivationError" } } },
      });
    }
  });
});
