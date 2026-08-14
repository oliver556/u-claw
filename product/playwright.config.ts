import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  projects: [
    {
      name: "default",
      testIgnore: ["electron-real-openclaw.spec.ts", "session-organizer-local.spec.ts", "workspace-memory-real.spec.ts"],
    },
    {
      name: "real-electron",
      testMatch: ["electron-real-openclaw.spec.ts", "session-organizer-local.spec.ts", "workspace-memory-real.spec.ts"],
      fullyParallel: false,
      workers: 1,
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -w @uclaw/frontend -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
  },
});
