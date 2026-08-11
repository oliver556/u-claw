import { describe, expect, it } from "vitest";

import { createOpenClawUsageService, packageName } from "../src/index.js";

describe("adapter workspace", () => {
  it("exports its package name", () => {
    expect(packageName).toBe("@uclaw/adapter");
    expect(createOpenClawUsageService).toBeTypeOf("function");
  });
});
