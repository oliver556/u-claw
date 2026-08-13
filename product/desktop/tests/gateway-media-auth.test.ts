import { describe, expect, it, vi } from "vitest";

import { installGatewayMediaRequestAuth } from "../src/gateway/media-request-auth.js";

describe("installGatewayMediaRequestAuth", () => {
  it("adds Gateway auth only to managed outgoing image requests", () => {
    let listener: ((details: { url: string; requestHeaders: Record<string, string> }, callback: (result: { requestHeaders: Record<string, string> }) => void) => void) | null = null;
    const onBeforeSendHeaders = vi.fn((_filter, next) => { listener = next; });
    const dispose = installGatewayMediaRequestAuth({ onBeforeSendHeaders }, 18789, "gateway-secret");

    const callback = vi.fn();
    listener!({
      url: "http://127.0.0.1:18789/api/chat/media/outgoing/agent%3Amain%3Adashboard%3Atest/fc0adee3-cf57-47e3-ba7e-e4095976033f/full",
      requestHeaders: { Accept: "image/*" },
    }, callback);
    expect(callback).toHaveBeenCalledWith({ requestHeaders: {
      Accept: "image/*",
      Authorization: "Bearer gateway-secret",
      "x-openclaw-requester-session-key": "agent:main:dashboard:test",
    } });
    expect(onBeforeSendHeaders.mock.calls[0]?.[0]).toEqual({ urls: [
      "http://127.0.0.1:18789/api/chat/media/outgoing/*",
      "http://127.0.0.1:18789/__openclaw__/assistant-media*",
    ] });

    dispose();
    expect(onBeforeSendHeaders).toHaveBeenLastCalledWith({ urls: [
      "http://127.0.0.1:18789/api/chat/media/outgoing/*",
      "http://127.0.0.1:18789/__openclaw__/assistant-media*",
    ] }, null);
  });

  it("adds Gateway Bearer auth to controlled assistant-media requests", () => {
    let listener: ((details: { url: string; requestHeaders: Record<string, string> }, callback: (result: { requestHeaders: Record<string, string> }) => void) => void) | null = null;
    const onBeforeSendHeaders = vi.fn((_filter, next) => { listener = next; });
    installGatewayMediaRequestAuth({ onBeforeSendHeaders }, 18789, "gateway-secret");

    const callback = vi.fn();
    listener!({
      url: "http://127.0.0.1:18789/__openclaw__/assistant-media?source=%2FUsers%2Ftest%2F.uclaw%2Fdata%2Fworkspace%2F.media%2Fimages%2Fimage.png",
      requestHeaders: { Accept: "image/*" },
    }, callback);

    expect(callback).toHaveBeenCalledWith({ requestHeaders: {
      Accept: "image/*",
      Authorization: "Bearer gateway-secret",
    } });
    expect(onBeforeSendHeaders.mock.calls[0]?.[0]).toEqual({ urls: [
      "http://127.0.0.1:18789/api/chat/media/outgoing/*",
      "http://127.0.0.1:18789/__openclaw__/assistant-media*",
    ] });
  });

  it("leaves malformed managed-media paths unauthenticated without throwing", () => {
    let listener: ((details: { url: string; requestHeaders: Record<string, string> }, callback: (result: { requestHeaders: Record<string, string> }) => void) => void) | null = null;
    const onBeforeSendHeaders = vi.fn((_filter, next) => { listener = next; });
    installGatewayMediaRequestAuth({ onBeforeSendHeaders }, 18789, "gateway-secret");

    const callback = vi.fn();
    expect(() => listener!({
      url: "http://127.0.0.1:18789/api/chat/media/outgoing/bad%/fc0adee3-cf57-47e3-ba7e-e4095976033f/full",
      requestHeaders: { Accept: "image/*" },
    }, callback)).not.toThrow();

    expect(callback).toHaveBeenCalledWith({ requestHeaders: { Accept: "image/*" } });
  });
});
