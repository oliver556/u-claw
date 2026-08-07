import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = resolve(frontendDir, "dist/index.html");
const indexUrl = pathToFileURL(indexPath);
const html = await readFile(indexUrl, "utf8");
const assetReferences = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((reference) => !reference.startsWith("data:"));

assert.ok(assetReferences.length > 0, "dist/index.html must reference built assets");
for (const reference of assetReferences) {
  assert.ok(reference.startsWith("./"), `asset must be relative for file:// loading: ${reference}`);
  await readFile(new URL(reference, indexUrl));
}
