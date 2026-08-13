import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import { createSkillImportService } from "../src/skills/skill-import-service.js";
const roots: string[] = [];
const makeRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "uclaw-skill-import-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeZip(path: string, entries: Record<string, string>): Promise<void> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
}

const markdown = "---\nslug: useful-skill\nname: Useful Skill\ndescription: Helps with useful work\nversion: 1.2.3\n---\n";

describe("SkillImportService", () => {
  it("copies one selected ZIP into controlled staging without exposing its path", async () => {
    const dataDir = await makeRoot();
    const source = join(dataDir, "download.zip");
    await writeZip(source, { "SKILL.md": markdown });
    const service = createSkillImportService({ dataDir, selectZip: async () => source });

    const selected = await service.select();

    expect(selected).toMatchObject({ fileName: "download.zip" });
    expect(selected?.token).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(JSON.stringify(selected)).not.toContain(source);
    expect((await stat(join(dataDir, "capabilities", ".skill-imports", `${selected!.token}.zip`))).isFile()).toBe(true);
  });

  it("returns null when selection is cancelled", async () => {
    const dataDir = await makeRoot();
    const service = createSkillImportService({ dataDir, selectZip: async () => null });
    await expect(service.select()).resolves.toBeNull();
  });

  it.each([
    ["a non-ZIP file", "skill.txt", 1],
    ["a ZIP over 20 MB", "skill.zip", 20 * 1024 * 1024 + 1],
  ])("rejects %s", async (_label, name, bytes) => {
    const dataDir = await makeRoot();
    const source = join(dataDir, name);
    await writeFile(source, Buffer.alloc(bytes));
    const service = createSkillImportService({ dataDir, selectZip: async () => source });
    await expect(service.select()).rejects.toThrow();
  });

  it("prepares a canonical Skill and consumes its token once", async () => {
    const dataDir = await makeRoot();
    const source = join(dataDir, "skill.zip");
    await writeZip(source, { "SKILL.md": markdown, "references/guide.md": "guide" });
    const service = createSkillImportService({ dataDir, selectZip: async () => source });
    const selected = await service.select();

    const prepared = await service.prepare(selected!.token);

    expect(prepared.detail).toMatchObject({ slug: "useful-skill", name: "Useful Skill", version: "1.2.3", risk: "high" });
    expect(prepared.validated.files.map((file) => file.path)).toEqual(["SKILL.md", "references/guide.md"]);
    expect(JSON.stringify(prepared)).not.toContain("api.skillhub.cn");
    await expect(service.prepare(selected!.token)).rejects.toThrow(/expired|used/i);
  });

  it("rejects unsafe archive paths and removes staged data", async () => {
    const dataDir = await makeRoot();
    const source = join(dataDir, "unsafe.zip");
    const zip = new JSZip();
    zip.file("SKILL.md", markdown);
    zip.file("CON/readme.md", "unsafe");
    await writeFile(source, await zip.generateAsync({ type: "nodebuffer" }));
    const service = createSkillImportService({ dataDir, selectZip: async () => source });
    const selected = await service.select();

    await expect(service.prepare(selected!.token)).rejects.toThrow();
    await expect(access(join(dataDir, "capabilities", ".skill-imports", `${selected!.token}.zip`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects expired tokens and allows explicit disposal", async () => {
    const dataDir = await makeRoot();
    const source = join(dataDir, "skill.zip");
    await writeZip(source, { "SKILL.md": markdown });
    let now = 10;
    const service = createSkillImportService({ dataDir, selectZip: async () => source, now: () => now, tokenTtlMs: 100 });
    const expired = await service.select();
    now = 111;
    await expect(service.prepare(expired!.token)).rejects.toThrow(/expired|used/i);

    now = 200;
    const disposed = await service.select();
    await service.dispose(disposed!.token);
    await expect(readFile(join(dataDir, "capabilities", ".skill-imports", `${disposed!.token}.zip`))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
