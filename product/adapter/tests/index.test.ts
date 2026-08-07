import { describe, expect, it } from "vitest";

import { packageName } from "../src/index.js";

describe("adapter workspace", () => {
  it("exports its package name", () => {
    expect(packageName).toBe("@uclaw/adapter");
  });
});
