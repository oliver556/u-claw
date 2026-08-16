import { describe, expect, it } from "vitest";

import { parseStartupMode } from "../src/startup/mode.js";

describe("parseStartupMode", () => {
  it.each([
    ["normal", ["electron", "app", "--uclaw-startup-mode=normal"]],
    ["activation-only", ["electron", "app", "--uclaw-startup-mode=activation-only"]],
  ] as const)("accepts Launcher startup mode %s", (expected, argv) => {
    expect(parseStartupMode(argv)).toBe(expected);
  });

  it.each([
    [["electron", "app"], "missing"],
    [["electron", "app", "--uclaw-startup-mode=debug"], "invalid"],
    [["electron", "app", "--uclaw-startup-mode", "normal"], "invalid"],
    [["electron", "app", "--uclaw-startup-mode=normal", "--uclaw-startup-mode=activation-only"], "exactly once"],
  ])("fails closed for argv %j", (argv, message) => {
    expect(() => parseStartupMode(argv)).toThrow(message);
  });
});
