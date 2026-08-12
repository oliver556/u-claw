import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactDownloadSchema, PersistedArtifactSchema, type ArtifactDownload, type PersistedArtifact } from "@uclaw/shared/dist/task-artifacts.js";

interface ArtifactShell { openPath(path: string): Promise<string>; }
export interface TaskArtifactFileService {
  persist(download: ArtifactDownload): Promise<PersistedArtifact>;
  open(artifactId: string): Promise<void>;
  export(artifactId: string): Promise<void>;
}

export function createTaskArtifactFileService(options: { dataRoot: string; shell: ArtifactShell; selectExportTarget?: (suggestedName: string) => Promise<string | undefined>; now?: () => Date }): TaskArtifactFileService {
  const root = join(options.dataRoot, "artifacts");
  const directoryName = (artifactId: string) => createHash("sha256").update(artifactId).digest("hex");
  const artifactDirectory = (artifactId: string) => join(root, directoryName(artifactId));
  const metadataPath = (artifactId: string) => join(artifactDirectory(artifactId), "artifact.json");
  const verifyDirectory = async (path: string, label: string): Promise<void> => {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error(`${label} must not be a symlink.`);
    if (!entry.isDirectory()) throw new Error(`${label} must be a directory.`);
  };
  const prepareDirectory = async (artifactId: string): Promise<string> => {
    await verifyDirectory(options.dataRoot, "Portable data root");
    try { await verifyDirectory(root, "Artifact root"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(root, { mode: 0o700 });
      await verifyDirectory(root, "Artifact root");
    }
    const directory = artifactDirectory(artifactId);
    try { await verifyDirectory(directory, "Artifact directory"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(directory, { mode: 0o700 });
      await verifyDirectory(directory, "Artifact directory");
    }
    return directory;
  };
  const load = async (artifactId: string): Promise<{ metadata: PersistedArtifact; path: string }> => {
    await prepareDirectory(artifactId);
    let metadata: PersistedArtifact;
    try { metadata = PersistedArtifactSchema.parse(JSON.parse(await readFile(metadataPath(artifactId), "utf8"))); }
    catch { throw new Error("Artifact is not downloaded."); }
    if (metadata.artifactId !== artifactId) throw new Error("Downloaded Artifact failed authoritative readback.");
    const path = join(artifactDirectory(metadata.artifactId), metadata.name);
    const current = await lstat(path);
    if (current.isSymbolicLink() || !current.isFile() || current.size !== metadata.size) throw new Error("Downloaded Artifact failed authoritative readback.");
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    if (digest !== metadata.sha256) throw new Error("Downloaded Artifact failed authoritative readback.");
    return { metadata, path };
  };
  return {
    async persist(input) {
      const download = ArtifactDownloadSchema.parse(input);
      const bytes = Buffer.from(download.dataBase64, "base64");
      if (bytes.byteLength !== download.size) throw new Error("Artifact download size mismatch.");
      const directory = await prepareDirectory(download.artifactId);
      const target = join(directory, download.name);
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, target);
      const { dataBase64: _content, ...downloadMetadata } = download;
      const metadata = PersistedArtifactSchema.parse({ ...downloadMetadata, sha256: createHash("sha256").update(bytes).digest("hex"), downloadedAt: (options.now?.() ?? new Date()).toISOString() });
      const metadataTemporary = join(directory, `.${randomUUID()}.json.tmp`);
      const metadataHandle = await open(metadataTemporary, "wx", 0o600);
      try { await metadataHandle.writeFile(`${JSON.stringify(metadata)}\n`); await metadataHandle.sync(); } finally { await metadataHandle.close(); }
      await rename(metadataTemporary, metadataPath(download.artifactId));
      return (await load(download.artifactId)).metadata;
    },
    async open(artifactId) {
      const item = await load(artifactId);
      const error = await options.shell.openPath(item.path);
      if (error) throw new Error("Electron shell rejected the controlled Artifact target.");
    },
    async export(artifactId) {
      if (!options.selectExportTarget) throw new Error("Artifact export is unavailable.");
      const item = await load(artifactId);
      const target = await options.selectExportTarget(item.metadata.name);
      if (!target) return;
      await copyFile(item.path, target);
      const exported = await lstat(target);
      const digest = createHash("sha256").update(await readFile(target)).digest("hex");
      if (exported.isSymbolicLink() || !exported.isFile() || exported.size !== item.metadata.size || digest !== item.metadata.sha256) throw new Error("Exported Artifact failed authoritative readback.");
    },
  };
}
