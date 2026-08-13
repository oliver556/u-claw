import { z } from "zod";

import { UClawErrorSchema } from "./errors.js";

function isCanonicalPercentEncoding(value: string, requireUppercase = false): boolean {
  try {
    const canonical = encodeURIComponent(decodeURIComponent(value));
    if (requireUppercase) return canonical === value;
    const normalize = (input: string) => input.replace(/%[0-9a-f]{2}/giu, (escape) => escape.toUpperCase());
    return normalize(canonical) === normalize(value);
  } catch {
    return false;
  }
}

export const ControlledImageSourceUrlSchema = z.string().superRefine((sourceUrl, context) => {
  const managed = /^http:\/\/127\.0\.0\.1:\d+\/api\/chat\/media\/outgoing\/([A-Za-z0-9%._~-]+)\/[0-9a-f-]+\/(?:full|preview)$/iu.exec(sourceUrl);
  if (managed && isCanonicalPercentEncoding(managed[1]!)) return;
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port === "" || url.username !== "" || url.password !== "" || url.hash !== "" || url.pathname !== "/__openclaw__/assistant-media") throw new Error("invalid endpoint");
    const rawSource = /^\?source=([^&]+)$/u.exec(url.search)?.[1];
    if (rawSource === undefined || !isCanonicalPercentEncoding(rawSource, true)) throw new Error("invalid query");
    const source = decodeURIComponent(rawSource);
    if (!/^\//u.test(source) && !/^[A-Z]:\\/iu.test(source)) throw new Error("invalid source");
    return;
  } catch {
    context.addIssue({ code: "custom", message: "Invalid controlled image source URL" });
  }
});

const RequestIdSchema = z.string().min(1);
const SuggestedNameSchema = z.string().min(1).max(255).refine((value) => value !== "." && value !== ".." && !/[\\/\0]/u.test(value));
const ParamsSchema = z.object({ sourceUrl: ControlledImageSourceUrlSchema, suggestedName: SuggestedNameSchema }).strict();
const MethodSchema = z.enum(["image.copy", "image.save"]);

export const ImageOperationIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("image.copy"), requestId: RequestIdSchema, params: ParamsSchema }).strict(),
  z.object({ method: z.literal("image.save"), requestId: RequestIdSchema, params: ParamsSchema }).strict(),
]);
export type ImageOperationIpcRequest = z.infer<typeof ImageOperationIpcRequestSchema>;

const ResultSchema = z.object({ status: z.enum(["completed", "cancelled"]) }).strict();
export const ImageOperationIpcResponseSchema = z.union([
  z.object({ method: MethodSchema, requestId: RequestIdSchema, ok: z.literal(true), result: ResultSchema }).strict(),
  z.object({ method: MethodSchema, requestId: RequestIdSchema, ok: z.literal(false), error: UClawErrorSchema }).strict(),
]);
export type ImageOperationIpcResponse = z.infer<typeof ImageOperationIpcResponseSchema>;
