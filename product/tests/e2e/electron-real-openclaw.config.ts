import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "electron-real-openclaw.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  use: { trace: "retain-on-failure" },
});
