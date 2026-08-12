import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createTaskArtifactFileService } from "../src/task-artifacts/task-artifact-files.js";

describe("Task Artifact authoritative files", () => {
  const artifactDirectory = (dataRoot: string, id: string) => join(dataRoot, "artifacts", createHash("sha256").update(id).digest("hex"));
  it("downloads into controlled storage and verifies bytes from disk before returning", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "uclaw-artifacts-"));
    const service = createTaskArtifactFileService({ dataRoot, shell: { openPath: vi.fn(async () => "") } });
    const result = await service.persist({ artifactId: "artifact-1", name: "report.md", mediaType: "text/markdown", size: 6, dataBase64: "cmVwb3J0" });
    expect(result).toMatchObject({ artifactId: "artifact-1", name: "report.md", size: 6 });
    expect(await readFile(join(artifactDirectory(dataRoot, "artifact-1"), "report.md"), "utf8")).toBe("report");
    expect((await stat(join(artifactDirectory(dataRoot, "artifact-1"), "report.md"))).size).toBe(6);
  });

  it("opens and exports after Electron restart only from authoritative readback", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "uclaw-artifacts-"));
    const shell = { openPath: vi.fn(async () => "") };
    const exportTarget = join(dataRoot, "exported-report.md");
    const selectExportTarget = vi.fn(async () => exportTarget);
    const service = createTaskArtifactFileService({ dataRoot, shell, selectExportTarget });
    await expect(service.open("missing")).rejects.toThrow("not downloaded");
    await service.persist({ artifactId: "artifact-1", name: "report.md", mediaType: "text/markdown", size: 6, dataBase64: "cmVwb3J0" });
    const afterRestart = createTaskArtifactFileService({ dataRoot, shell, selectExportTarget });
    await afterRestart.open("artifact-1");
    await afterRestart.export("artifact-1");
    expect(shell.openPath).toHaveBeenCalledOnce();
    expect(selectExportTarget).toHaveBeenCalledWith("report.md");
    expect(await readFile(exportTarget, "utf8")).toBe("report");
    await writeFile(join(artifactDirectory(dataRoot, "artifact-1"), "report.md"), "tamper");
    await expect(afterRestart.open("artifact-1")).rejects.toThrow("authoritative readback");
  });

  it("reports unavailable when production Save Dialog is not registered", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "uclaw-artifacts-"));
    const service = createTaskArtifactFileService({ dataRoot, shell: { openPath: vi.fn(async () => "") } });
    await service.persist({ artifactId: "artifact-1", name: "report.md", mediaType: "text/markdown", size: 6, dataBase64: "cmVwb3J0" });
    await expect(service.export("artifact-1")).rejects.toThrow("export is unavailable");
  });

  it("rejects a symlinked Artifact directory", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "uclaw-artifacts-"));
    const outside = await mkdtemp(join(tmpdir(), "uclaw-outside-"));
    await symlink(outside, join(dataRoot, "artifacts"));
    const service = createTaskArtifactFileService({ dataRoot, shell: { openPath: vi.fn(async () => "") } });
    await expect(service.persist({ artifactId: "artifact-1", name: "report.md", mediaType: "text/markdown", size: 6, dataBase64: "cmVwb3J0" })).rejects.toThrow("symlink");
  });

  it("rejects a downloaded file replaced by a symlink", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "uclaw-artifacts-"));
    const outside = await mkdtemp(join(tmpdir(), "uclaw-outside-"));
    const service = createTaskArtifactFileService({ dataRoot, shell: { openPath: vi.fn(async () => "") } });
    await service.persist({ artifactId: "artifact-1", name: "report.md", mediaType: "text/markdown", size: 6, dataBase64: "cmVwb3J0" });
    const target = join(artifactDirectory(dataRoot, "artifact-1"), "report.md");
    await writeFile(join(outside, "report.md"), "report");
    await import("node:fs/promises").then(({ unlink }) => unlink(target));
    await symlink(join(outside, "report.md"), target);
    await expect(service.open("artifact-1")).rejects.toThrow("authoritative readback");
  });
});
import { createHash } from "node:crypto";
