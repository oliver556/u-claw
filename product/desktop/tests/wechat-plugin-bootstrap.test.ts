import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { bootstrapWechatPlugin } from "../src/channels/wechat-plugin-bootstrap.js";

describe("WeChat plugin startup bootstrap", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "uclaw-wechat-bootstrap-"));
    cleanup.push(root);
    const sourceDir = join(root, "runtime", "extensions", "openclaw-weixin");
    const targetDir = join(root, "data", ".openclaw", "extensions", "openclaw-weixin");
    await mkdir(join(sourceDir, "dist"), { recursive: true });
    await writeFile(join(sourceDir, "openclaw.plugin.json"), JSON.stringify({ id: "openclaw-weixin" }));
    await writeFile(join(sourceDir, "package.json"), JSON.stringify({ name: "@tencent-weixin/openclaw-weixin", version: "2.4.6" }));
    await writeFile(join(sourceDir, "dist/index.js"), "export default true;");
    const files = await Promise.all(["openclaw.plugin.json", "package.json", "dist/index.js"].map(async (path) => {
      const content = await readFile(join(sourceDir, path));
      return { path, bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex") };
    }));
    await writeFile(join(sourceDir, ".uclaw-plugin-manifest.json"), JSON.stringify({
      schemaVersion: 1,
      plugins: [{
        id: "openclaw-weixin", package: "@tencent-weixin/openclaw-weixin", version: "2.4.6",
        npmIntegrity: "sha512-qw9k3PLTiMWGNjjsknHgcTManH1w4j+Ji1ArWIaYLKCq3aFRsVwcqnPi127bvOoVMJGW4dbyJ8NECEMgoO+iRw==",
        openclawVersionRange: ">=2026.7.1-2 <2026.8.0", files,
      }],
    }));
    return { root, sourceDir, targetDir };
  }

  it("repairs a missing target from the trusted bundled runtime", async () => {
    const { sourceDir, targetDir } = await fixture();

    await expect(bootstrapWechatPlugin({ sourceDir, targetDir })).resolves.toEqual({
      available: true, initialStatus: "missing", status: "repaired",
    });
    expect(JSON.parse(await readFile(join(targetDir, "package.json"), "utf8"))).toMatchObject({ version: "2.4.6" });
  });

  it("repairs a tampered target atomically", async () => {
    const { sourceDir, targetDir } = await fixture();
    await bootstrapWechatPlugin({ sourceDir, targetDir });
    await writeFile(join(targetDir, "dist/index.js"), "tampered");

    await expect(bootstrapWechatPlugin({ sourceDir, targetDir })).resolves.toEqual({
      available: true, initialStatus: "tampered", status: "repaired",
    });
    expect(await readFile(join(targetDir, "dist/index.js"), "utf8")).toBe("export default true;");
  });

  it("reports healthy without rewriting during repeated startup", async () => {
    const { sourceDir, targetDir } = await fixture();
    await bootstrapWechatPlugin({ sourceDir, targetDir });
    const before = await readFile(join(targetDir, ".uclaw-plugin-manifest.json"), "utf8");

    await expect(bootstrapWechatPlugin({ sourceDir, targetDir })).resolves.toEqual({
      available: true, initialStatus: "healthy", status: "healthy",
    });
    expect(await readFile(join(targetDir, ".uclaw-plugin-manifest.json"), "utf8")).toBe(before);
  });

  it("classifies an incompatible installed version before repair", async () => {
    const { sourceDir, targetDir } = await fixture();
    await bootstrapWechatPlugin({ sourceDir, targetDir });
    await writeFile(join(targetDir, "package.json"), JSON.stringify({ name: "@tencent-weixin/openclaw-weixin", version: "9.9.9" }));

    await expect(bootstrapWechatPlugin({ sourceDir, targetDir })).resolves.toEqual({
      available: true, initialStatus: "incompatible", status: "repaired",
    });
  });

  it("fails closed when the trusted source is damaged", async () => {
    const { sourceDir, targetDir } = await fixture();
    await writeFile(join(sourceDir, "dist/index.js"), "damaged source");

    await expect(bootstrapWechatPlugin({ sourceDir, targetDir })).resolves.toMatchObject({
      available: false, initialStatus: "missing", status: "repair-failed", code: "SOURCE_INVALID",
    });
    await expect(readFile(join(targetDir, "package.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symbolic-link target without following it", async () => {
    const { root, sourceDir, targetDir } = await fixture();
    const outside = join(root, "outside");
    await mkdir(join(targetDir, ".."), { recursive: true });
    await mkdir(outside);
    await symlink(outside, targetDir);

    await expect(bootstrapWechatPlugin({ sourceDir, targetDir })).resolves.toMatchObject({
      available: false, initialStatus: "tampered", status: "repair-failed", code: "TARGET_UNSAFE",
    });
    await expect(readFile(join(outside, "package.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symbolic-link target parent without writing outside controlled state", async () => {
    const { root, sourceDir, targetDir } = await fixture();
    const outside = join(root, "outside-parent");
    await mkdir(join(targetDir, "..", ".."), { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(targetDir, ".."));

    await expect(bootstrapWechatPlugin({ sourceDir, targetDir })).resolves.toMatchObject({
      available: false, initialStatus: "missing", status: "repair-failed", code: "TARGET_UNSAFE",
    });
    await expect(readFile(join(outside, "openclaw-weixin", "package.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
