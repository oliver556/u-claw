import { describe, expect, it } from "vitest";

import {
  ControlledImageSourceUrlSchema,
  ImageOperationIpcRequestSchema,
  ImageOperationIpcResponseSchema,
} from "../src/image-operations.js";

const managed = "http://127.0.0.1:18789/api/chat/media/outgoing/agent%3Amain%3Adashboard%3Atest/fc0adee3-cf57-47e3-ba7e-e4095976033f/full";
const assistant = "http://127.0.0.1:18789/__openclaw__/assistant-media?source=%2Fdata%2Fworkspace%2Fimage.png";

describe("image operation IPC contract", () => {
  it("accepts only controlled Gateway image URLs", () => {
    expect(ControlledImageSourceUrlSchema.parse(managed)).toBe(managed);
    expect(ControlledImageSourceUrlSchema.parse(assistant)).toBe(assistant);
    for (const value of [
      "https://example.com/image.png",
      "file:///tmp/image.png",
      "/tmp/image.png",
      "http://127.0.0.1:18789/api/chat/media/outgoing/bad%/fc0adee3-cf57-47e3-ba7e-e4095976033f/full",
      `${assistant}&extra=1`,
      "http://127.0.0.1:18789/__openclaw__/assistant-media?source=/data/workspace/image.png",
      "http://127.0.0.1:18789/__openclaw__/assistant-media?source=%ZZ",
      "http://127.0.0.1:18789/__openclaw__/assistant-media?source=%252Fdata%252Fworkspace%252Fimage.png",
      "http://127.0.0.1:18789/__openclaw__/assistant-media?source=%2fdata%2fworkspace%2fimage.png",
      "http://user:password@127.0.0.1:18789/__openclaw__/assistant-media?source=%2Fdata%2Fworkspace%2Fimage.png",
      `${assistant}#fragment`,
    ]) expect(ControlledImageSourceUrlSchema.safeParse(value).success, value).toBe(false);
  });

  it("parses copy and save requests with a safe suggested filename", () => {
    expect(ImageOperationIpcRequestSchema.parse({ method: "image.copy", requestId: "request-1", params: { sourceUrl: managed, suggestedName: "image.png" } }).method).toBe("image.copy");
    expect(ImageOperationIpcRequestSchema.parse({ method: "image.save", requestId: "request-2", params: { sourceUrl: assistant, suggestedName: "image.png" } }).method).toBe("image.save");
    for (const suggestedName of ["../image.png", "folder/image.png", "folder\\image.png", "", `${"x".repeat(256)}.png`]) {
      expect(ImageOperationIpcRequestSchema.safeParse({ method: "image.save", requestId: "request-3", params: { sourceUrl: managed, suggestedName } }).success).toBe(false);
    }
  });

  it("parses success, cancelled, and stable error responses", () => {
    expect(ImageOperationIpcResponseSchema.parse({ method: "image.copy", requestId: "request-1", ok: true, result: { status: "completed" } }).ok).toBe(true);
    expect(ImageOperationIpcResponseSchema.parse({ method: "image.save", requestId: "request-2", ok: true, result: { status: "cancelled" } }).ok).toBe(true);
    expect(ImageOperationIpcResponseSchema.parse({ method: "image.copy", requestId: "request-3", ok: false, error: {
      code: "OPERATION_FAILED", message: "无法复制此图片。", retryable: true, recoveryActions: ["retry"], causeDetails: {},
    } }).ok).toBe(false);
  });
});
