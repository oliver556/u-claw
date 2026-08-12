import fs from "node:fs";
import path from "node:path";
import AjvModule from "ajv";
import { describe, expect, it } from "vitest";
import * as shared from "../src/index.js";

const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures/admin-api-contract.json"), "utf8"));
const openapi = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../activation-server/api/openapi.yaml"), "utf8"));
const Ajv: any = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ strict: false, allowUnionTypes: true, validateFormats: false }); ajv.addSchema(openapi, "openapi");
const zod: Record<string, { parse(value: unknown): unknown }> = {
  AdminGenerateRequest: shared.AdminInventoryGenerateSchema, AdminImportRequest: shared.AdminInventoryImportSchema,
  AdminMutation: shared.AdminLicenseMutationSchema, AdminBalanceStatusRequest: shared.AdminMarkConfiguredSchema,
  AdminInventorySecret: shared.AdminInventorySecretSchema, AdminInventorySummary: shared.AdminInventorySummarySchema,
  AdminMutationResult: shared.AdminMutationResultSchema, AdminReissueResponse: shared.AdminReissueResponseSchema,
  AdminAuditEvent: shared.AdminAuditEventSchema,
};
const deref = (value: any): any => value?.$ref ? deref(value.$ref.split("/").slice(1).reduce((node: any, key: string) => node[key], openapi)) : value;
const schemaName = (schema: any): string => { const ref = schema?.$ref ?? schema?.items?.$ref; if (!ref) throw new Error("admin operation schema must use component ref"); return ref.split("/").at(-1)!; };
const operationSchemas = (route: any) => {
  const operation = deref(openapi.paths[route.path]?.[route.method]); if (!operation) throw new Error(`missing ${route.method} ${route.path}`);
  const request = operation.requestBody ? deref(operation.requestBody).content["application/json"].schema : null;
  const success = deref(operation.responses[route.method === "post" && route.path.startsWith("/internal/v1/inventory") ? "201" : "200"]);
  return { request, response: success.content["application/json"].schema };
};

describe("admin OpenAPI shared contract", () => {
  it("derives schemas from all nine operations and validates identical payloads with AJV and Zod", () => {
    expect(fixture.routes).toHaveLength(9);
    for (const route of fixture.routes) for (const [kind, schema, value] of [["request", operationSchemas(route).request, route.request], ["response", operationSchemas(route).response, route.response]] as const) {
      if (schema === null) { expect(value).toBeNull(); continue; }
      const name = schemaName(schema); expect(zod[name], `missing Zod schema ${name}`).toBeTruthy(); expect(zod[name].parse(value)).toEqual(value);
      const itemValidate = ajv.compile({ $ref: `openapi#/components/schemas/${name}` }); const validate = schema.type === "array" ? ajv.compile({ type:"array", items:{ $ref:`openapi#/components/schemas/${name}` } }) : itemValidate;
      expect(validate(schema.type === "array" ? [value] : value), `${route.path} ${kind}: ${ajv.errorsText(validate.errors)}`).toBe(true);
      expect(itemValidate({ ...value, unexpected: true })).toBe(false);
      const required = deref(schema.type === "array" ? schema.items : schema).required[0]; const missing = { ...value }; delete missing[required]; expect(itemValidate(missing)).toBe(false);
    }
  });
  it("rejects swapped schemas and array-object shape drift", () => {
    const mutation = operationSchemas(fixture.routes[3]).request; const summary = operationSchemas(fixture.routes[2]).response; const audit = operationSchemas(fixture.routes[8]).response;
    const mutationValidate=ajv.compile({$ref:`openapi#/components/schemas/${schemaName(mutation)}`}); const summaryValidate=ajv.compile({$ref:`openapi#/components/schemas/${schemaName(summary)}`}); const auditArray=ajv.compile({type:"array",items:{$ref:`openapi#/components/schemas/${schemaName(audit)}`}});
    expect(mutationValidate(fixture.routes[2].response)).toBe(false); expect(summaryValidate(fixture.routes[3].request)).toBe(false); expect(auditArray(fixture.routes[8].response)).toBe(false); expect(auditArray([fixture.routes[8].response])).toBe(true);
  });
  it("keeps pattern, enum, and minimum constraints aligned between AJV and Zod", () => {
    for (const [routeIndex, kind, patch] of [
      [0, "response", { activationCode: "invalid-code" }], [1, "request", { records: [{ ...fixture.routes[1].request.records[0], username: "x" }] }],
      [2, "response", { status: "disabled" }], [3, "response", { revision: 0 }], [6, "response", { status: "active" }],
    ] as const) {
      const route=fixture.routes[routeIndex]; const schema=operationSchemas(route)[kind]; const name=schemaName(schema); const original=route[kind]; const invalid={...original,...patch};
      const validate=ajv.compile({$ref:`openapi#/components/schemas/${name}`}); expect(validate(invalid), `${name} AJV accepted invalid`).toBe(false); expect(()=>zod[name].parse(invalid), `${name} Zod accepted invalid`).toThrow();
    }
  });
});
