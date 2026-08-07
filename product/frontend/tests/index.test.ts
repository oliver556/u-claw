import { describe, expect, it } from "vitest";

import { packageName } from "../src/index";

describe("frontend workspace", () => {
  it("exports its package name", () => {
    expect(packageName).toBe("@uclaw/frontend");
  });
});
