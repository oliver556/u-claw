import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  buildWindowsWechatCandidates,
  classifyWechatResidue,
  cleanupWechatResidue,
  redactWechatAudit,
} from "../../portable/lib/wechat-host-residue.mjs";

const policyUrl = new URL("../tests/windows/wechat-host-residue-policy.json", import.meta.url);
const powershellUrl = new URL("../tests/windows/wechat-host-residue.ps1", import.meta.url);
const launcherUrl = new URL("../../portable/Windows-Start.bat", import.meta.url);
const installerUrl = new URL("../../portable/Windows-Install.bat", import.meta.url);
const configServerUrl = new URL("../../portable/config-server/server.js", import.meta.url);
const auditScriptUrl = new URL("../../portable/lib/wechat-host-residue.mjs", import.meta.url);
const execFileAsync = promisify(execFile);

const marker = {
  schemaVersion: 1,
  owner: "U-Claw",
  component: "personal-wechat",
  dataClass: "rebuildable-cache",
};

test("DATA-005 policy separates USB business data from host candidates", async () => {
  const policy = JSON.parse(await readFile(policyUrl, "utf8"));
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.component, "personal-wechat");
  assert.deepEqual(policy.usbBusinessData, [
    "data/.openclaw/openclaw-weixin/accounts.json",
    "data/.openclaw/openclaw-weixin/accounts/",
  ]);
  assert.equal(policy.usbBusinessDataOwnership, "openclaw-weixin");
  assert.equal(policy.usbBusinessDataCleanup, "never");
  assert.equal(policy.portableGuaranteeScope, "portable-usb");
  assert.equal(policy.hostInstalledMode.personalWechat, "not-shipped");
  assert.ok(policy.hostCandidateKinds.includes("appdata"));
  assert.ok(policy.hostCandidateKinds.includes("localappdata"));
  assert.ok(policy.hostCandidateKinds.includes("temp"));
  assert.ok(policy.hostCandidateKinds.includes("fixed-drive"));
  assert.ok(policy.hostCandidateKinds.includes("legacy-userprofile"));
  assert.equal(policy.markerFile, ".uclaw-residue-owner.json");
});

test("candidate inventory covers AppData, TEMP, fixed drives, and legacy USERPROFILE", () => {
  const candidates = buildWindowsWechatCandidates({
    env: {
      USERPROFILE: "C:\\Users\\Alice",
      APPDATA: "C:\\Users\\Alice\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local",
      TEMP: "C:\\Users\\Alice\\AppData\\Local\\Temp",
    },
    fixedDriveRoots: ["C:\\", "D:\\"],
  });
  assert.deepEqual(new Set(candidates.map(({ kind }) => kind)), new Set([
    "legacy-userprofile",
    "appdata",
    "localappdata",
    "temp",
    "fixed-drive",
  ]));
  assert.ok(candidates.some(({ absolutePath }) => absolutePath === "C:\\Users\\Alice\\.openclaw\\extensions\\openclaw-weixin"));
  assert.ok(candidates.some(({ absolutePath }) => absolutePath === "D:\\U-Claw\\openclaw-weixin"));
});

test("cleanup allows only marked rebuildable U-Claw residue", () => {
  assert.deepEqual(
    classifyWechatResidue({ kind: "temp", marker, relativeFiles: ["compiled.bin"] }),
    { decision: "clean", reason: "UCLAW_REBUILDABLE_RESIDUE" },
  );
  for (const input of [
    { kind: "temp", marker: null, relativeFiles: ["compiled.bin"], reason: "OWNERSHIP_MARKER_MISSING" },
    { kind: "legacy-userprofile", marker, relativeFiles: ["dist/index.js"], reason: "LEGACY_PLUGIN_OWNERSHIP_UNKNOWN" },
    { kind: "temp", marker: { ...marker, owner: "WeChat" }, relativeFiles: [], reason: "OWNERSHIP_MARKER_INVALID" },
    { kind: "temp", marker: { ...marker, note: "unexpected" }, relativeFiles: [], reason: "OWNERSHIP_MARKER_INVALID" },
    { kind: "temp", marker, relativeFiles: ["accounts/user.json"], reason: "BUSINESS_DATA_PRESENT" },
    { kind: "temp", marker, relativeFiles: ["bot-token.json"], reason: "BUSINESS_DATA_PRESENT" },
    { kind: "temp", marker, relativeFiles: ["openclaw.json"], reason: "BUSINESS_DATA_PRESENT" },
    { kind: "wechat-client", marker, relativeFiles: [], reason: "PATH_KIND_NOT_ALLOWED" },
  ]) {
    assert.deepEqual(classifyWechatResidue(input), { decision: "refuse", reason: input.reason });
  }
});

test("cleanup is idempotent and refuses an unmarked directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-wechat-residue-test-"));
  const owned = path.join(root, "owned");
  const unknown = path.join(root, "unknown");
  await mkdir(owned);
  await mkdir(unknown);
  await writeFile(path.join(owned, ".uclaw-residue-owner.json"), JSON.stringify(marker));
  await writeFile(path.join(owned, "compiled.bin"), "cache");
  await writeFile(path.join(unknown, "compiled.bin"), "unknown");

  assert.deepEqual(await cleanupWechatResidue({ absolutePath: owned, kind: "temp" }), {
    decision: "cleaned",
    reason: "UCLAW_REBUILDABLE_RESIDUE",
  });
  assert.deepEqual(await cleanupWechatResidue({ absolutePath: owned, kind: "temp" }), {
    decision: "absent",
    reason: "PATH_ABSENT",
  });
  assert.deepEqual(await cleanupWechatResidue({ absolutePath: unknown, kind: "temp" }), {
    decision: "refuse",
    reason: "OWNERSHIP_MARKER_MISSING",
  });
  await rm(root, { recursive: true });
});

test("audit evidence never leaks usernames or absolute paths", () => {
  const username = "Alice-Private";
  const audit = redactWechatAudit([
    {
      absolutePath: `C:\\Users\\${username}\\AppData\\Local\\Temp\\U-Claw\\openclaw-weixin`,
      kind: "temp",
      decision: "refuse",
      reason: "OWNERSHIP_MARKER_MISSING",
    },
  ]);
  const serialized = JSON.stringify(audit);
  assert.doesNotMatch(serialized, new RegExp(username, "i"));
  assert.doesNotMatch(serialized, /C:\\\\Users|AppData|openclaw-weixin/i);
  assert.match(audit.entries[0].pathSha256, /^[a-f0-9]{64}$/);
});

test("CLI atomically creates redacted evidence in a new directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-wechat-cli-test-"));
  const evidencePath = path.join(root, "nested", "evidence.json");
  const username = "CLI-Private-User";
  await execFileAsync(process.execPath, [
    fileURLToPath(auditScriptUrl),
    "--evidence",
    evidencePath,
    "--mode",
    "audit",
    "--fixed-drive-root",
    "Q:\\",
  ], {
    env: {
      ...process.env,
      USERPROFILE: `C:\\Users\\${username}`,
      APPDATA: `C:\\Users\\${username}\\AppData\\Roaming`,
      LOCALAPPDATA: `C:\\Users\\${username}\\AppData\\Local`,
      TEMP: `C:\\Users\\${username}\\AppData\\Local\\Temp`,
    },
  });
  const serialized = await readFile(evidencePath, "utf8");
  assert.doesNotMatch(serialized, new RegExp(username, "i"));
  assert.doesNotMatch(serialized, /C:\\\\Users|Q:\\\\/i);
  assert.equal(JSON.parse(serialized).status, "passed");
  await rm(root, { recursive: true });
});

test("PowerShell gate records real Windows and physical USB blockers", async () => {
  const source = await readFile(powershellUrl, "utf8");
  assert.match(source, /Set-StrictMode -Version Latest/);
  assert.match(source, /Win32_DiskDrive/);
  assert.match(source, /PHYSICAL_USB_REQUIRED/);
  assert.match(source, /WECHAT_PLUGIN_ARTIFACT_REQUIRED/);
  assert.match(source, /Get-PSDrive[\s\S]*Root/);
  assert.match(source, /wechat-host-residue\.mjs/);
  assert.doesNotMatch(source, /Remove-Item[\s\S]*WeChat Files|Tencent\\WeChat/i);
});

test("Windows launcher keeps plugin and account state on USB", async () => {
  const [launcher, installer, configServer] = await Promise.all([
    readFile(launcherUrl, "utf8"),
    readFile(installerUrl, "utf8"),
    readFile(configServerUrl, "utf8"),
  ]);
  assert.match(launcher, /WECHAT_PLUGIN_DST=%STATE_DIR%\\extensions\\openclaw-weixin/i);
  assert.doesNotMatch(launcher, /WECHAT_PLUGIN_DST=%USERPROFILE%/i);
  assert.doesNotMatch(launcher, /mkdir "%USERPROFILE%\\\.openclaw\\extensions"/i);
  assert.doesNotMatch(installer, /openclaw-weixin/i);
  assert.doesNotMatch(installer, /%USERPROFILE%\\\.openclaw\\extensions/i);
  assert.match(configServer, /process\.env\.OPENCLAW_STATE_DIR\s*\|\|\s*\n\s*path\.join\(__dirname,\s*['"]\.\.\/data\/\.openclaw['"]\)/);
  assert.doesNotMatch(configServer, /USERPROFILE[\s\S]{0,120}\.openclaw/);
});
