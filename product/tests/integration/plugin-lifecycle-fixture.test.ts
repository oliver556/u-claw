import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFixturePluginRegistryClient } from "../../desktop/src/plugins/fixture-client.js";
import { createFixturePluginRuntime } from "../../desktop/src/plugins/fixture-runtime.js";
import { createPluginService } from "../../desktop/src/plugins/plugin-service.js";

describe("Plugin fixture lifecycle integration", () => {
  it("searches, installs, updates, disables, and uninstalls independently", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-plugin-integration-"));
    try {
      const service = await createPluginService({ dataDir, client: createFixturePluginRegistryClient(), runtime: createFixturePluginRuntime(dataDir) });
      const detail = await service.detail("openclaw-calendar");
      const confirmation = { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk };
      await service.waitForOperation((await service.startInstall({ slug: detail.slug, confirmation })).id);
      const updatedService = await createPluginService({
        dataDir,
        client: createFixturePluginRegistryClient({ versionOverride: { "openclaw-calendar": "1.3.0" } }),
        runtime: createFixturePluginRuntime(dataDir),
      });
      const updated = await updatedService.detail(detail.slug);
      await updatedService.waitForOperation((await updatedService.startUpdate({
        slug: updated.slug,
        confirmation: { permissionFingerprint: updated.permissionFingerprint, acceptedRisk: updated.risk },
      })).id);
      expect((await updatedService.installed())[0].installedVersion).toBe("1.3.0");
      await updatedService.setEnabled({ slug: detail.slug, enabled: false, confirmation: null });
      expect((await updatedService.installed())[0].enabled).toBe(false);
      await updatedService.waitForOperation((await updatedService.startUninstall(detail.slug)).id);
      expect(await updatedService.installed()).toEqual([]);
      const config = JSON.parse(await readFile(join(dataDir, ".openclaw", "openclaw.json"), "utf8"));
      expect(config.plugins?.entries?.[detail.slug]).toBeUndefined();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
