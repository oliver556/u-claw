import { describe, expect, it } from "vitest";

import {
  DUAL_SYSTEM_USB_LAYOUT_CONTRACT_VERSION,
  DUAL_SYSTEM_USB_TARGETS,
  DualSystemUsbManifestSchema,
  DualSystemUsbRuntimeManifestSchema,
} from "../src/dual-system-usb.js";

describe("dual-system USB contract schemas", () => {
  it("freezes target ids and manifest roots", () => {
    expect(DUAL_SYSTEM_USB_LAYOUT_CONTRACT_VERSION).toBe(1);
    expect(DUAL_SYSTEM_USB_TARGETS).toEqual(["win-x64", "macos-arm64"]);
    expect(DualSystemUsbManifestSchema.parse({
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
      signature: { algorithm: "ed25519", keyId: "fixture", value: "fixture-signature-value" },
    })).toBeTruthy();
  });

  it("requires target-aware runtime identity", () => {
    expect(DualSystemUsbRuntimeManifestSchema.safeParse({
      schemaVersion: 1,
      releaseId: "release-1",
      releaseSequence: 1,
      productVersion: "0.1.0",
      nodeVersion: "24.15.0",
      electronVersion: "40.10.6",
      runtimeVersion: "2026.7.1-2",
      runtimeId: "openclaw-2026.7.1-2-macos-arm64",
      target: "macos-arm64",
      targetPlatform: "darwin",
      targetArch: "arm64",
      runtimeArchive: "runtime.pkg",
      runtimeSha256: "a".repeat(64),
      runtimeTreeSha256: "b".repeat(64),
      runtimeBytes: 1,
      unpackedBytes: 1,
      fileCount: 1,
      entrypoint: "Electron.app/Contents/MacOS/Electron",
      entryArgs: [],
      criticalFiles: [{ path: "Electron.app/Contents/MacOS/Electron", size: 1, sha256: "c".repeat(64) }],
    }).success).toBe(true);
  });
});
