import { describe, expect, it, vi } from "vitest";

import { installNavigationPolicy } from "../src/security/navigation-policy.js";

describe("installNavigationPolicy", () => {
  it("blocks renderer navigation and opens only allowlisted external URLs", async () => {
    let navigate: ((event: { preventDefault: () => void }, url: string) => void) | undefined;
    let openWindow: ((details: { url: string }) => { action: "deny" }) | undefined;
    const openExternal = vi.fn(async () => undefined);
    const preventDefault = vi.fn();

    installNavigationPolicy({
      webContents: {
        on: (_event, listener) => { navigate = listener; },
        setWindowOpenHandler: (handler) => { openWindow = handler; },
      },
      openExternal,
    });

    navigate?.({ preventDefault }, "https://example.com/help");
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith("https://example.com/help");

    expect(openWindow?.({ url: "javascript:alert(1)" })).toEqual({ action: "deny" });
    expect(openWindow?.({ url: "https://example.com/docs" })).toEqual({ action: "deny" });
    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs");
    expect(openExternal).not.toHaveBeenCalledWith("javascript:alert(1)");
  });

  it("rejects file URLs and credential-bearing HTTPS URLs", () => {
    let navigate: ((event: { preventDefault: () => void }, url: string) => void) | undefined;
    const openExternal = vi.fn(async () => undefined);
    installNavigationPolicy({
      webContents: {
        on: (_event, listener) => { navigate = listener; },
        setWindowOpenHandler: vi.fn(),
      },
      openExternal,
    });

    navigate?.({ preventDefault: vi.fn() }, "file:///etc/passwd");
    navigate?.({ preventDefault: vi.fn() }, "https://user:pass@example.com/");
    expect(openExternal).not.toHaveBeenCalled();
  });
});
