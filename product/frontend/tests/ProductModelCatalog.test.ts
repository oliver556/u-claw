import { describe, expect, it } from "vitest";

import { toProductModels } from "../src/features/chat/product-model-catalog";

describe("product model catalog", () => {
  it("exposes every server model without a client model-ID allowlist", () => {
    expect(toProductModels([
      { id: "uclaw-development-gpt/gpt-5.6-sol", label: "Raw Sol", available: true },
      { id: "uclaw-development-gpt/gpt-5.6-luna", label: "Luna", available: true },
      { id: "anthropic/claude-opus", label: "Claude", available: true },
    ])).toEqual([
      { id: "uclaw-development-gpt/gpt-5.6-sol", label: "Raw Sol", available: true },
      { id: "uclaw-development-gpt/gpt-5.6-luna", label: "Luna", available: true },
      { id: "anthropic/claude-opus", label: "Claude", available: true },
    ]);
  });
});
