import { describe, expect, it } from "vitest";

import { ReconnectPolicy, SequenceGapDetector } from "../src/reconnect.js";

describe("ReconnectPolicy", () => {
  it("uses injectable random and bounded exponential backoff", () => {
    const policy = new ReconnectPolicy({ random: () => 0.5 });
    expect(policy.delay(0)).toBe(800);
    expect(policy.delay(1)).toBe(1360);
    expect(policy.delay(99)).toBe(15000);
  });

  it("clamps startup retryAfterMs", () => {
    const policy = new ReconnectPolicy({ random: () => 0.5 });
    expect(policy.startupDelay(1)).toBe(100);
    expect(policy.startupDelay(900)).toBe(900);
    expect(policy.startupDelay(5000)).toBe(2000);
  });
});

describe("SequenceGapDetector", () => {
  it("returns accepted, duplicate, and gap explicitly", () => {
    const resync: Array<{ expected: number; received: number }> = [];
    const detector = new SequenceGapDetector((gap) => resync.push(gap));
    expect(detector.observe(7)).toBe("accepted");
    expect(detector.observe(7)).toBe("duplicate");
    expect(detector.observe(8)).toBe("accepted");
    expect(detector.observe(10)).toBe("gap");
    expect(resync).toEqual([{ expected: 9, received: 10 }]);
  });
});
