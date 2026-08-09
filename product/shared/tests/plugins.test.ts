import { describe, expect, it } from "vitest";

import {
  PluginCatalogItemSchema,
  PluginDetailSchema,
  PluginIpcRequestSchema,
} from "../src/plugins.js";

const plugin = {
  packageKind: "plugin",
  slug: "openclaw-calendar",
  name: "Calendar",
  description: "Calendar integration",
  version: "1.2.0",
  installedVersion: null,
  enabled: false,
  updateAvailable: false,
  source: { provider: "fixture", url: "https://plugins.openclaw.ai/openclaw-calendar", packaged: true },
  integritySha256: "0".repeat(64),
  integrityVerified: true,
  managedByUClaw: false,
  availability: "installable",
  compatibility: { state: "compatible", openClawVersion: "2026.7.1-2" },
  permissions: [],
  permissionFingerprint: "sha256",
  risk: "low",
  nativeCode: false,
  commandExecution: false,
  mode: "fixture",
};

describe("Plugin contracts", () => {
  it("keeps Plugin as an independent package kind", () => {
    expect(PluginCatalogItemSchema.parse(plugin).packageKind).toBe("plugin");
    expect(() => PluginCatalogItemSchema.parse({ ...plugin, packageKind: "skill" })).toThrow();
  });

  it("requires the OpenClaw plugin manifest shape", () => {
    expect(PluginDetailSchema.parse({
      ...plugin,
      manifest: {
        id: plugin.slug,
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        packageName: "@uclaw/openclaw-calendar",
        entry: "./dist/index.js",
        minHostVersion: ">=2026.7.1-2",
        pluginApi: ">=2026.7.1-2",
      },
    }).manifest?.id).toBe(plugin.slug);
  });

  it("rejects renderer paths and commands", () => {
    expect(PluginIpcRequestSchema.safeParse({
      method: "plugins.install",
      requestId: "bad",
      params: { slug: plugin.slug, confirmation: null, path: "/tmp/plugin", command: "openclaw plugins install" },
    }).success).toBe(false);
  });
});
