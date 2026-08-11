import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "workspace-memory-real.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  use: { trace: "retain-on-failure" },
});
