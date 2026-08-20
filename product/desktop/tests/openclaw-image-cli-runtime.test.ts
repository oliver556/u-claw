import { describe, expect, it } from "vitest";

import { buildOpenClawImageInferArgs } from "../src/providers/openclaw-image-cli-runtime.js";

describe("OpenClaw image CLI runtime", () => {
  it("uses image generate with explicit output and no reference", () => {
    expect(buildOpenClawImageInferArgs({ prompt: "blue dot", model: "uclaw-commercial/gpt-image-2" }, "/workspace/out.png")).toEqual([
      "infer", "image", "generate",
      "--model", "uclaw-commercial/gpt-image-2",
      "--prompt", "blue dot",
      "--count", "1",
      "--output", "/workspace/out.png",
      "--json",
    ]);
  });

  it("uses image edit with the historical image as --file", () => {
    expect(buildOpenClawImageInferArgs({
      prompt: "make it red",
      model: "uclaw-commercial/gpt-image-2",
      image: "/workspace/previous.png",
    }, "/workspace/edited.png")).toContainEqual("edit");
    expect(buildOpenClawImageInferArgs({
      prompt: "make it red",
      model: "uclaw-commercial/gpt-image-2",
      image: "/workspace/previous.png",
    }, "/workspace/edited.png")).toEqual(expect.arrayContaining(["--file", "/workspace/previous.png"]));
  });
});
