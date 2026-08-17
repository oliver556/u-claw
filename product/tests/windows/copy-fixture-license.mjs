import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const fixtureLicenseEntries = [
  ".startup-credential.json",
  ".status-response.json",
  "license.json",
];

export async function copyFixtureLicense(source, target) {
  const entries = (await readdir(source)).sort();
  if (JSON.stringify(entries) !== JSON.stringify(fixtureLicenseEntries)) {
    throw new Error("fixture license contains unexpected entries");
  }
  for (const entry of entries) {
    const info = await lstat(path.join(source, entry));
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("fixture license contains an unsafe entry");
    }
  }
  const existing = await lstat(target).catch(error => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (existing !== undefined) throw new Error("fixture license target already exists");

  await mkdir(target, { mode: 0o700 });
  try {
    for (const entry of entries) {
      await copyFile(path.join(source, entry), path.join(target, entry), constants.COPYFILE_EXCL);
    }
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}
