import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DUAL_SYSTEM_USB_TARGETS,
  DualSystemUsbAcceptanceMatrixSchema,
  DualSystemUsbLayoutFixtureSchema,
  type DualSystemUsbTarget,
} from "../../shared/src/index.js";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const layout = DualSystemUsbLayoutFixtureSchema.parse(JSON.parse(readFileSync(resolve(
  fixtureRoot,
  "dual-system-usb-layout-v1.json",
), "utf8")));
const matrix = DualSystemUsbAcceptanceMatrixSchema.parse(JSON.parse(readFileSync(resolve(
  fixtureRoot,
  "dual-system-usb-acceptance-matrix-v1.json",
), "utf8")));

function targetPaths(target: DualSystemUsbTarget): string[] {
  const paths = layout.usbManifest.targets[target];
  return [paths.package, paths.manifest, paths.current, paths.installState];
}

describe("dual-system USB layout v1 fixture", () => {
  it("locks the target layout without using legacy packaging inputs", () => {
    expect(layout.usbManifest.targets["win-x64"]).toEqual({
      entry: "U-Claw.exe",
      package: "app/packages/win-x64/runtime.pkg",
      manifest: "app/manifests/win-x64.version.json",
      current: "app/current/win-x64.json",
      installState: "app/install-state/win-x64.json",
    });
    expect(layout.usbManifest.targets["macos-arm64"]).toEqual({
      entry: "U-Claw.app",
      package: "app/packages/macos-arm64/runtime.pkg",
      manifest: "app/manifests/macos-arm64.version.json",
      current: "app/current/macos-arm64.json",
      installState: "app/install-state/macos-arm64.json",
    });
    expect(JSON.stringify(layout)).not.toContain("final-windows-runtime");
    expect(JSON.stringify(layout)).not.toContain("product.yml");
    expect(JSON.stringify(layout)).not.toContain("product/packaging/runtime-app");
  });

  it("keeps runtime manifests explicit per target", () => {
    expect(layout.runtimeManifests["win-x64"]).toMatchObject({
      target: "win-x64",
      targetPlatform: "win32",
      targetArch: "x64",
      runtimeArchive: "runtime.pkg",
      entrypoint: "electron/electron.exe",
    });
    expect(layout.runtimeManifests["macos-arm64"]).toMatchObject({
      target: "macos-arm64",
      targetPlatform: "darwin",
      targetArch: "arm64",
      runtimeArchive: "runtime.pkg",
      entrypoint: "Electron.app/Contents/MacOS/Electron",
    });
  });

  it("keeps current and install-state target-local", () => {
    for (const target of DUAL_SYSTEM_USB_TARGETS) {
      const paths = layout.usbManifest.targets[target];
      expect(layout.current[target]).toMatchObject({
        target,
        manifest: paths.manifest,
        package: paths.package,
      });
      expect(layout.installState[target]).toMatchObject({
        target,
        manifest: paths.manifest,
        package: paths.package,
      });
    }
    expect(new Set(targetPaths("win-x64")).intersection(new Set(targetPaths("macos-arm64"))).size).toBe(0);
  });

  it("locks shared data and license identity roots", () => {
    expect(layout.sharedData).toMatchObject({
      root: "data",
      requiredSubdirs: ["data/.openclaw", "data/outputs", "data/logs"],
      legacyReadonlyProbe: ".uclaw/data",
      firstWriteRoot: "data",
    });
    expect(layout.sharedData.environment).toEqual({
      UCLAW_USB_ROOT: "<usb-root>",
      UCLAW_DATA_DIR: "<usb-root>/data",
      UCLAW_OPENCLAW_HOME: "<usb-root>/data/.openclaw",
      OPENCLAW_HOME: "<usb-root>/data",
      OPENCLAW_STATE_DIR: "<usb-root>/data/.openclaw",
    });
    expect(layout.licenseIdentity).toMatchObject({
      root: ".uclaw/license",
      bindingScope: "physical-usb",
      sharedFiles: ["license.json", ".startup-credential.json", ".lifecycle-cache.json"],
      forbiddenUniqueFields: ["volumeName", "mountPath", "driveLetter"],
      serverMapping: { fingerprintVersion: 2, deviceAliasesRequired: true },
    });
  });

  it("adds static macOS and cross-os acceptance samples", () => {
    const ids = matrix.cases.map(({ id }) => id);
    for (const required of [
      "win-runtime-target-files",
      "macos-runtime-target-files",
      "shared-data-root-authority",
      "shared-license-identity",
      "windows-activation-macos-first-launch",
      "macos-activation-windows-first-launch",
      "win-update-does-not-touch-macos",
      "macos-update-does-not-touch-win",
      "drive-letter-mountpoint-change",
      "different-usb-rejected",
    ]) {
      expect(ids).toContain(required);
    }
    expect(matrix.requiredHostMatrix.some((entry) => entry.osFamily === "macos" && entry.arch === "arm64")).toBe(true);
    expect(matrix.requiredHostMatrix.some((entry) => entry.role === "cross-os")).toBe(true);
  });

  it("keeps public fixtures free of secret material", () => {
    expect(JSON.stringify({ layout, matrix })).not.toMatch(
      /api[_-]?key|authorization\s*[:=]|newApiToken|providerKey|secretValue|\bsk-[A-Za-z0-9]/iu,
    );
  });
});
