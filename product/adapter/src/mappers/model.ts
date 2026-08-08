import { type ModelSummary } from "@uclaw/shared";
import { z } from "zod";

export const RawOpenClawModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  alias: z.string().min(1).optional(),
  available: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.string()).optional(),
}).passthrough();

export const RawOpenClawModelsListResponseSchema = z.object({
  models: z.array(RawOpenClawModelSchema),
}).strict();

export type RawOpenClawModel = z.infer<typeof RawOpenClawModelSchema>;

export function mapOpenClawModel(model: RawOpenClawModel): ModelSummary {
  const capabilities: ModelSummary["capabilities"] = [];
  if (model.input?.includes("text")) capabilities.push("text");
  if (model.input?.includes("image")) capabilities.push("vision");
  if (capabilities.length === 0) capabilities.push("unknown");

  const available = model.available === true;
  return {
    id: `${model.provider}/${model.id}`,
    label: model.name,
    providerId: model.provider,
    available,
    locality: "unknown",
    capabilities,
    ...(available ? {} : {
      unavailableReason: {
        code: "MODEL_UNAVAILABLE",
        message: "Model is unavailable in the current OpenClaw runtime.",
        retryable: false,
      },
    }),
  };
}
