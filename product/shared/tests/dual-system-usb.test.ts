import { describe, expect, it } from "vitest";

import {
  DUAL_SYSTEM_USB_LAYOUT_CONTRACT_VERSION,
  DUAL_SYSTEM_USB_TARGETS,
  DualSystemUsbLicenseDeviceMappingInputSchema,
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

  it("models cross-system license/device mapping without assuming equal fingerprints", () => {
    const mapping = {
      schemaVersion: 1,
      fingerprintVersion: 2,
      deviceId: "dev_fixture_001",
      licenseId: "lic_fixture_001",
      deviceAliases: [
        {
          target: "win-x64",
          fingerprint: { version: "uclaw-usb-v1", sha256: "a".repeat(64) },
          evidence: {
            target: "win-x64",
            platform: "win32",
            arch: "x64",
            source: "windows-storage-descriptor",
            busType: "USB",
            vendor: "ACME",
            product: "FLASH DRIVE",
            revision: "1.00",
            serial: "SN123",
            capacityBytes: 64_000_000_000,
            uniqueDescriptorSha256: "b".repeat(64),
          },
        },
        {
          target: "macos-arm64",
          fingerprint: { version: "uclaw-usb-v2", sha256: "c".repeat(64) },
          evidence: {
            target: "macos-arm64",
            platform: "darwin",
            arch: "arm64",
            source: "macos-diskutil",
            busProtocol: "USB",
            deviceLocation: "external",
            vendor: "ACME",
            product: "FLASH DRIVE",
            revision: "1.00",
            serial: "SN123",
            capacityBytes: 64_000_000_000,
            volumeUuid: "4f2b2fc0-3e70-49a0-9dfc-0e012aef0001",
            mediaUuid: "7A9877AE-2941-4F87-83EF-C9B7DF8DA111",
          },
        },
      ],
    };
    const parsed = DualSystemUsbLicenseDeviceMappingInputSchema.parse(mapping);
    expect(parsed.deviceAliases[0]!.fingerprint.sha256).not.toBe(parsed.deviceAliases[1]!.fingerprint.sha256);
  });

  it("rejects mutable macOS and Windows location fields as mapping evidence", () => {
    const macosAlias = {
      target: "macos-arm64",
      fingerprint: { version: "uclaw-usb-v2", sha256: "c".repeat(64) },
      evidence: {
        target: "macos-arm64",
        platform: "darwin",
        arch: "arm64",
        source: "macos-diskutil",
        busProtocol: "USB",
        deviceLocation: "external",
        vendor: "ACME",
        product: "FLASH DRIVE",
        serial: "SN123",
        capacityBytes: 64_000_000_000,
        volumeUuid: "4f2b2fc0-3e70-49a0-9dfc-0e012aef0001",
      },
    };
    for (const forbidden of ["volumeName", "mountPath", "driveLetter"]) {
      expect(() => DualSystemUsbLicenseDeviceMappingInputSchema.parse({
        schemaVersion: 1,
        fingerprintVersion: 2,
        deviceAliases: [{ ...macosAlias, evidence: { ...macosAlias.evidence, [forbidden]: "mutable" } }],
      })).toThrow();
    }
    expect(() => DualSystemUsbLicenseDeviceMappingInputSchema.parse({
      schemaVersion: 1,
      fingerprintVersion: 2,
      deviceAliases: [{ ...macosAlias, target: "win-x64" }],
    })).toThrow();
  });
});
