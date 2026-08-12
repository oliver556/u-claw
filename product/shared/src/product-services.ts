import { z } from "zod";

import { BuiltinServiceStateSchema } from "./builtin-service-operations.js";
import { UClawErrorSchema } from "./errors.js";
import { LicenseLifecycleStatusSchema } from "./license-lifecycle.js";
import { NewApiPolicySchema, NewApiProvisioningStatusSchema } from "./new-api-management.js";

const Id = z.string().trim().min(1).max(512);
const Timestamp = z.string().datetime({ offset: true });

export const ProductAuthoritySummarySchema = z.object({
  license: z.object({
    status: LicenseLifecycleStatusSchema,
    revision: z.number().int().positive(),
    expiresAt: Timestamp,
  }).strict(),
  product: z.object({
    status: NewApiProvisioningStatusSchema,
    generation: z.number().int().positive(),
    userStatus: z.enum(["active", "disabled"]),
  }).strict(),
  service: z.object({
    state: BuiltinServiceStateSchema,
    revision: z.number().int().positive(),
    reasonCode: z.string().min(1).max(128),
  }).strict(),
  policy: NewApiPolicySchema,
  usage: z.object({
    consumed: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    resetAt: Timestamp.nullable(),
    updatedAt: Timestamp,
  }).strict(),
}).strict();
export type ProductAuthoritySummary = z.infer<typeof ProductAuthoritySummarySchema>;

export const ProductAuthorityIpcRequestSchema = z.object({
  method: z.literal("product.authority.read"),
  requestId: Id,
  params: z.object({}).strict(),
}).strict();
export type ProductAuthorityIpcRequest = z.infer<typeof ProductAuthorityIpcRequestSchema>;

export const ProductAuthorityIpcResponseSchema = z.union([
  z.object({ method: z.literal("product.authority.read"), requestId: Id, ok: z.literal(true), result: ProductAuthoritySummarySchema }).strict(),
  z.object({ method: z.literal("product.authority.read"), requestId: Id, ok: z.literal(false), error: UClawErrorSchema }).strict(),
]);
export type ProductAuthorityIpcResponse = z.infer<typeof ProductAuthorityIpcResponseSchema>;

export const PRODUCT_SERVICES_IPC_CHANNEL = "uclaw:product-services";
