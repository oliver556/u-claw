import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import AjvModule from "ajv";
import { describe, expect, it } from "vitest";

const Ajv: any = (AjvModule as any).default ?? AjvModule;

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
  it("validates secure builtin credential endpoints with AJV", () => {
    const ajv = new Ajv({ strict: false, validateFormats: true });
    ajv.addFormat("uri", (value: string) => {
      try {
        return Boolean(new URL(value));
      } catch {
        return false;
      }
    });
    ajv.addSchema(document, "openapi");
    const validate = ajv.compile({ $ref: "openapi#/components/schemas/BuiltinCredential" });
    const credential = {
      schemaVersion: 1,
      deviceId: "dev_fixture_001",
      licenseId: "lic_fixture_001",
      endpoint: "https://license.example.test/model-api/",
      model: "uclaw-default",
      deviceToken: `uclaw_dt_${"A".repeat(43)}`,
    };

    expect(validate(credential), JSON.stringify(validate.errors)).toBe(true);
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
      expect(validate({ ...credential, endpoint }), `AJV rejected secure endpoint: ${endpoint}`).toBe(true);
    }
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
      expect(validate({ ...credential, endpoint }), `AJV accepted insecure endpoint: ${endpoint}`).toBe(false);
    }
  });

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
    ]));
    expect(document.paths["/v1/device-tokens"]).toBeUndefined();
  });

  it("locks component names and required field sets", () => {
    expect(required("ActivationRequest")).toEqual([
      "activationCode", "usbFingerprint", "clientVersion", "idempotencyKey",
    ]);
    expect(required("ActivationResponse")).toEqual([
      "activationId", "deviceId", "licenseId", "license", "startupCredential", "builtinCredential", "status",
    ]);
    expect(required("ActivationCommit")).toEqual(["idempotencyKey", "artifactGeneration"]);
    expect(required("ActivationError")).toEqual([
      "requestId", "activationId", "code", "stage", "retryable", "supportCode",
    ]);
    expect(required("ClientPolicy")).toEqual([
      "minimumClientVersion", "upgradeRequired", "feedUrl",
    ]);
    expect(required("LicenseStatusSummary")).toEqual([
      "licenseId", "deviceId", "status", "revision", "notBefore", "expiresAt", "replacementLicenseId", "updatedAt",
    ]);
    expect(required("StartupLicense")).toEqual([
      "schemaVersion", "usernameId", "deviceId", "licenseId", "usbFingerprint", "startupSecretProof", "notBefore", "expiresAt", "revision", "signature",
    ]);
    expect(required("StartupCredential")).toEqual(["schemaVersion", "deviceId", "licenseId", "startupSecret"]);
    expect(required("BuiltinCredential")).toEqual(["schemaVersion", "deviceId", "licenseId", "endpoint", "model", "deviceToken"]);
    expect(Object.keys(document.components.schemas.BuiltinCredential.properties ?? {})).toEqual(
      ["schemaVersion", "deviceId", "licenseId", "endpoint", "model", "deviceToken"],
    );
    expect(required("LicenseStatusReceipt")).toEqual(["value"]);
    expect(document.components.schemas.DeviceTokenRequest).toBeUndefined();
    expect(document.components.schemas.DeviceTokenResponse).toBeUndefined();
    expect(required("HealthResponse")).toEqual(["status"]);
    for (const name of [
      "ActivationRequest", "ActivationResponse", "ActivationCommit", "ActivationError", "ClientPolicy",
      "StartupLicense", "StartupCredential", "BuiltinCredential", "LicenseStatusSummary", "LicenseStatusReceipt",
      "LicenseStatusResponse", "HealthResponse",
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
      $ref: "#/components/schemas/ActivationCode",
    });
    expect(document.components.schemas.ActivationCode).toMatchObject({
      pattern: "^[0-9A-HJKMNP-TV-Z]{26}$",
    });
  });

  it("requires bearer auth for recovery and status", () => {
    expect(document.components.securitySchemes.BearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    for (const [path, method] of [
      ["/v1/activations/{activationId}", "get"],
      ["/v1/licenses/{licenseId}/status", "get"],
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
    expect(document.components.schemas.ClientPolicy.properties).toEqual({
      minimumClientVersion: expect.any(Object),
      upgradeRequired: { type: "boolean" },
      feedUrl: { type: "string", const: "https://updates.u-claw.org/releases/" },
    });
    expect(document.paths["/health/live"].get.responses["200"].content["application/json"].schema)
      .toEqual({ $ref: "#/components/schemas/HealthResponse" });
    expect(document.components.schemas.ActivationRequest.properties).not.toHaveProperty("username");
    expect(Object.keys(document.components.schemas.ActivationRequest.properties ?? {})).toEqual(
      ["activationCode", "usbFingerprint", "clientVersion", "idempotencyKey"],
    );
    expect(document.components.schemas.BuiltinCredential.properties).toEqual({
      schemaVersion: { const: 1 },
      deviceId: { $ref: "#/components/schemas/Identifier" },
      licenseId: { $ref: "#/components/schemas/Identifier" },
      endpoint: {
        type: "string",
        format: "uri",
        pattern: "^[Hh][Tt][Tt][Pp][Ss]://(?:\\[[0-9A-Fa-f:.]+\\]|[^/?#@\\[\\]\\\\\\u0000-\\u0020\\u007F:]+)(?::[0-9]+)?(?:/[^?#@\\\\\\u0000-\\u0020\\u007F]*)?$",
      },
      model: expect.any(Object),
      deviceToken: { type: "string", pattern: "^uclaw_dt_[A-Za-z0-9_-]{43}$" },
    });
    for (const status of ["401", "403", "429", "503"]) {
      expect(document.components.responses[status]).toMatchObject({
        content: { "application/json": { schema: { $ref: "#/components/schemas/ActivationError" } } },
      });
    }
  });
});
