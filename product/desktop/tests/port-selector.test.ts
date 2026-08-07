import { describe, expect, it, vi } from "vitest";

import { selectGatewayPort } from "../src/gateway/port-selector.js";

describe("selectGatewayPort", () => {
  it("falls back within 18789-18799 when the first port is occupied", async () => {
    const probe = vi.fn(async (port: number) => port !== 18789);
    await expect(selectGatewayPort({ probe })).resolves.toBe(18790);
    expect(probe.mock.calls.map(([port]) => port)).toEqual([18789, 18790]);
  });

  it("fails after probing the whole fixed range", async () => {
    const probe = vi.fn(async () => false);
    await expect(selectGatewayPort({ probe })).rejects.toThrow("18789-18799");
    expect(probe).toHaveBeenCalledTimes(11);
  });
});
