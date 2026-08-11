import { describe, expect, it } from "vitest";

import {
  createOpenClawProviderExecutor,
  createUsageDispatcher,
  createUsageDomainRegistration,
  packageName,
} from "../src/index.js";

describe("desktop workspace", () => {
  it("exports its package name", () => {
    expect(packageName).toBe("@uclaw/desktop");
    expect(createOpenClawProviderExecutor).toBeTypeOf("function");
    expect(createUsageDispatcher).toBeTypeOf("function");
    expect(createUsageDomainRegistration).toBeTypeOf("function");
  });
});
