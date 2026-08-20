import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installBundledCommercialImageExtension } from "../src/providers/commercial-image-extension-bootstrap.js";

const cleanup: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "uclaw-image-extension-"));
  cleanup.push(root);
  const sourceDir = join(root, "source");
  const targetDir = join(root, "state", "extensions", "uclaw-commercial-image");
  await mkdir(join(sourceDir, "dist"), { recursive: true });
  await writeFile(join(sourceDir, "package.json"), JSON.stringify({ name: "@uclaw/openclaw-commercial-image", openclaw: { extensions: ["./dist/index.js"] } }));
  await writeFile(join(sourceDir, "openclaw.plugin.json"), JSON.stringify({ id: "uclaw-commercial-image", contracts: { imageGenerationProviders: ["uclaw-commercial"] } }));
  await writeFile(join(sourceDir, "dist", "index.js"), "export default {};\n");
  return { root, sourceDir, targetDir };
}

afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("commercial image extension bootstrap", () => {
  it("installs the bundled OpenClaw extension into portable state", async () => {
    const { sourceDir, targetDir } = await fixture();

    await installBundledCommercialImageExtension({ sourceDir, targetDir });

    await expect(readFile(join(targetDir, "dist", "index.js"), "utf8")).resolves.toBe("export default {};\n");
  });

  it("rejects a symlink target instead of writing outside controlled state", async () => {
    const { root, sourceDir, targetDir } = await fixture();
    await mkdir(join(targetDir, ".."), { recursive: true });
    await symlink(root, targetDir);

    await expect(installBundledCommercialImageExtension({ sourceDir, targetDir })).rejects.toThrow("unsafe");
  });
});
