import { describe, expect, it } from "vitest";

import { ContentBlockSchema } from "../src/chat.js";

const imageBlock = (sourceUrl: string) => ({
  id: "image-1",
  type: "image",
  file: { id: "image-1", name: "image.png", mediaType: "image/png", size: 0, kind: "artifact" },
  sourceUrl,
});

describe("assistant image source URL contract", () => {
  it("accepts only the controlled loopback assistant-media endpoint", () => {
    expect(ContentBlockSchema.safeParse(imageBlock(
      "http://127.0.0.1:18789/__openclaw__/assistant-media?source=U%3A%5C.uclaw%5Cdata%5Cworkspace%5C.media%5Cimages%5Cimage.png",
    )).success).toBe(true);
    expect(ContentBlockSchema.safeParse(imageBlock(
      "http://127.0.0.1:18789/__openclaw__/assistant-media?source=%2FUsers%2Ftest%2F.uclaw%2Fdata%2Fworkspace%2F.media%2Fimages%2Fimage_003.png",
    )).success).toBe(true);

    for (const sourceUrl of [
      "file:///Users/test/.uclaw/data/workspace/image.png",
      "https://example.com/__openclaw__/assistant-media?source=%2Ftmp%2Fimage.png",
      "http://127.0.0.1:18789/__openclaw__/assistant-media?source=relative.png",
      "http://127.0.0.1:18789/__openclaw__/assistant-media?source=%2Ftmp%2Fimage.png&extra=1",
    ]) {
      expect(ContentBlockSchema.safeParse(imageBlock(sourceUrl)).success, sourceUrl).toBe(false);
    }
  });

  it("rejects malformed percent encoding in managed outgoing media paths", () => {
    expect(() => ContentBlockSchema.parse({
      id: "image-1",
      type: "image",
      file: { id: "file-1", name: "image.png", mediaType: "image/png", size: 0, kind: "artifact" },
      sourceUrl: "http://127.0.0.1:18789/api/chat/media/outgoing/bad%/fc0adee3-cf57-47e3-ba7e-e4095976033f/full",
    })).toThrow();
  });
});
