import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { createLauncherReleaseFSHelper } from "../src/release/release-fs-helper.js";
import type { RuntimeManifest } from "../src/release/release-service.js";

function fakeChild(exitCode = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
  child.stdin.on("finish", () => queueMicrotask(() => child.emit("close", exitCode, null)));
  return child;
}

const runtimeManifest = (): RuntimeManifest => ({
  schemaVersion: 1, releaseId: "release-42", releaseSequence: 42, productVersion: "0.2.0", nodeVersion: "24.15.0", electronVersion: "40.10.6", runtimeVersion: "2026.7.1-2",
  runtimeId: "openclaw-2026.7.1-2-win-x64", targetPlatform: "win32", targetArch: "x64", runtimeArchive: "runtime.pkg",
  runtimeSha256: "a".repeat(64), runtimeTreeSha256: "b".repeat(64), runtimeBytes: 7, unpackedBytes: 7, fileCount: 1,
  entrypoint: "electron/electron.exe", entryArgs: [], criticalFiles: [{ path: "electron/electron.exe", size: 7, sha256: "c".repeat(64) }], signature: { algorithm: "ed25519", keyId: "release-2026", signedAt: "2026-08-09T00:00:00.000Z", expiresAt: "2027-08-09T00:00:00.000Z", sequence: 42, value: "signature" },
});

describe("launcher release filesystem helper", () => {
  it("streams a framed signed manifest and exact package with shell disabled", async () => {
    const child = fakeChild(); const chunks: Buffer[] = [];
    child.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const spawn = vi.fn(() => child as never);
    const helper = createLauncherReleaseFSHelper({ launcherPath: "C:\\portable\\U-Claw.exe", packageRoot: "C:\\portable\\.uclaw", cacheRoot: "C:\\cache\\U-Claw", spawn });

    await helper.secureInstall(runtimeManifest(), Readable.from([Buffer.from("run"), Buffer.from("time")]), new AbortController().signal);

    expect(spawn).toHaveBeenCalledWith("C:\\portable\\U-Claw.exe", ["--release-fs-helper", "secure-install", "--root", "C:\\portable\\.uclaw"], expect.objectContaining({ shell: false, windowsHide: true }));
    const wire = Buffer.concat(chunks); const headerLength = wire.readUInt32BE(0); const header = JSON.parse(wire.subarray(4, 4 + headerLength).toString("utf8"));
    expect(header).toMatchObject({ schemaVersion: 1, manifest: { runtimeId: "openclaw-2026.7.1-2-win-x64" } });
    expect(wire.subarray(4 + headerLength).toString("utf8")).toBe("runtime");
  });

  it("invokes only allowlisted cleanup children and rejects helper failure", async () => {
    const child = fakeChild(2); const spawn = vi.fn(() => child as never);
    const helper = createLauncherReleaseFSHelper({ launcherPath: "launcher.exe", packageRoot: "package", cacheRoot: "cache", spawn });
    await expect(helper.secureCleanup("runtime")).rejects.toThrow(/helper/i);
    expect(spawn).toHaveBeenCalledWith("launcher.exe", ["--release-fs-helper", "cleanup-cache", "--root", "cache", "--child", "runtime"], expect.objectContaining({ shell: false }));
  });
});
