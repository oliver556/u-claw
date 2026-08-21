import { describe, expect, it } from "vitest";

import { TargetInstallStateSchema, TargetRuntimeCurrentSchema, UsbManifestSchema } from "../src/usb-layout.js";

const usbManifest = {
  schemaVersion: 1,
  product: "U-Claw",
  usbLayoutVersion: 1,
  minimumBootstrapVersion: "0.1.0",
  dataRoot: "data",
  licenseRoot: ".uclaw/license",
  targets: {
    "win-x64": {
      entry: "U-Claw.exe",
      package: "app/packages/win-x64/runtime.pkg",
      manifest: "app/manifests/win-x64.version.json",
      current: "app/current/win-x64.json",
      installState: "app/install-state/win-x64.json",
    },
    "macos-arm64": {
      entry: "U-Claw.app",
      package: "app/packages/macos-arm64/runtime.pkg",
      manifest: "app/manifests/macos-arm64.version.json",
      current: "app/current/macos-arm64.json",
      installState: "app/install-state/macos-arm64.json",
    },
  },
  signature: { algorithm: "ed25519", keyId: "usb-layout-2026", value: "A".repeat(86) },
};

describe("dual-system USB layout contracts", () => {
  it("parses target-isolated runtime paths with shared data and license roots", () => {
    expect(UsbManifestSchema.parse(usbManifest)).toMatchObject({
      dataRoot: "data",
      licenseRoot: ".uclaw/license",
      targets: {
        "win-x64": { package: "app/packages/win-x64/runtime.pkg" },
        "macos-arm64": { package: "app/packages/macos-arm64/runtime.pkg" },
      },
    });
  });

  it("rejects absolute or parent-relative target paths", () => {
    expect(UsbManifestSchema.safeParse({
      ...usbManifest,
      targets: {
        ...usbManifest.targets,
        "win-x64": { ...usbManifest.targets["win-x64"], package: "../runtime.pkg" },
      },
    }).success).toBe(false);
    expect(UsbManifestSchema.safeParse({
      ...usbManifest,
      targets: {
        ...usbManifest.targets,
        "macos-arm64": { ...usbManifest.targets["macos-arm64"], entry: "/Applications/U-Claw.app" },
      },
    }).success).toBe(false);
  });

  it("parses future current and install-state records per target", () => {
    expect(TargetRuntimeCurrentSchema.parse({
      schemaVersion: 1,
      target: "macos-arm64",
      releaseId: "release-42",
      releaseSequence: 42,
      runtimeId: "openclaw-2026.7.1-2-macos-arm64",
      runtimeSha256: "a".repeat(64),
      installedAt: "2026-08-21T00:00:00.000Z",
    })).toMatchObject({ target: "macos-arm64" });
    expect(TargetInstallStateSchema.parse({
      schemaVersion: 1,
      target: "win-x64",
      state: "switching",
      releaseId: "release-42",
      releaseSequence: 42,
      runtimeId: "openclaw-2026.7.1-2-win-x64",
      startedAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:01:00.000Z",
    })).toMatchObject({ target: "win-x64", state: "switching" });
  });
});
