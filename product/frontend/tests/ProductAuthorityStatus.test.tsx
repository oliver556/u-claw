// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductAuthorityStatus } from "../src/features/system/ProductAuthorityStatus.js";

afterEach(cleanup);

describe("ProductAuthorityStatus", () => {
  it("renders only renderer-safe authority status", async () => {
    const readAuthority = vi.fn(async ({ requestId }: { method: "product.authority.read"; requestId: string }) => ({
      method: "product.authority.read" as const, requestId, ok: true as const, result: {
        license: { status: "active" as const, revision: 3, expiresAt: "2027-08-01T00:00:00.000Z" },
        product: { status: "active" as const, generation: 3, userStatus: "active" as const },
        service: { state: "enabled" as const, revision: 2, reasonCode: "OPERATOR_ENABLED" },
        policy: { quota: { unit: "tokens" as const, limit: 100, period: "monthly" as const }, rateLimit: { requestsPerMinute: 60, concurrentRequests: 2 }, allowedModels: ["builtin/model"], disabled: false },
        usage: { consumed: 25, remaining: 75, resetAt: null, updatedAt: "2026-08-12T00:00:00.000Z" },
      },
    }));
    render(<ProductAuthorityStatus bridge={{ readAuthority }} />);
    expect(await screen.findByText("授权有效")).toBeVisible();
    expect(screen.getByText("25 / 100 tokens")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/deviceId|licenseId|userId|tokenId|credential/u);
  });

  it("shows exact fail-closed status when production services are absent", async () => {
    const readAuthority = vi.fn(async ({ method, requestId }: { method: string; requestId: string }) => ({ method, requestId, ok: false as const, error: { code: "PRODUCT_SERVICES_NOT_CONFIGURED" as const, message: "Product services are not configured.", retryable: false, recoveryActions: ["open-diagnostics" as const], causeDetails: {} } }));
    render(<ProductAuthorityStatus bridge={{ readAuthority: readAuthority as never }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("PRODUCT_SERVICES_NOT_CONFIGURED");
    expect(screen.queryByRole("button", { name: /制盘|开户|撤销|重制/u })).not.toBeInTheDocument();
  });
});
