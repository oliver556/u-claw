import { describe, expect, it } from "vitest";

import { DEFAULT_PRODUCT_MODEL, toProductModels } from "../src/features/chat/product-model-catalog";

describe("product model catalog", () => {
  it("only exposes GPT-5.6 Sol in the first release catalog", () => {
    expect(toProductModels([
      { id: "uclaw-development-gpt/gpt-5.6-sol", label: "Raw Sol", available: true },
      { id: "uclaw-development-gpt/gpt-5.6-luna", label: "Luna", available: true },
      { id: "anthropic/claude-opus", label: "Claude", available: true },
    ])).toEqual([
      { id: "uclaw-development-gpt/gpt-5.6-sol", label: "GPT-5.6 Sol", available: true },
    ]);
    expect(DEFAULT_PRODUCT_MODEL.modelId).toBe("gpt-5.6-sol");
  });
});
