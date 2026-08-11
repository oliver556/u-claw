// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CapabilitiesView } from "../src/features/capabilities/CapabilitiesView.js";

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "uclaw", { value: undefined, configurable: true });
});

describe("CapabilitiesView usage", () => {
  it("opens authoritative usage as a first-class capability tab", async () => {
    Object.defineProperty(window, "uclaw", { configurable: true, value: {
      usage: { invoke: vi.fn(async () => ({
        ok: true,
        result: {
          fetchedAt: "2026-08-12T08:00:00.000Z",
          openClaw: {
            providerStatus: { updatedAt: 1_754_982_400_000, providers: [] },
            cost: { totals: { totalTokens: 3, totalCost: 0.03 } },
            sessions: { sessions: [] },
          },
          newApi: null,
        },
      })) },
    } });

    render(<CapabilitiesView />);
    fireEvent.click(screen.getByRole("tab", { name: "用量" }));

    expect(await screen.findByRole("region", { name: "用量与成本" })).toBeInTheDocument();
  });
});
