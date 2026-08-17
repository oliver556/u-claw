import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { scanText } from "./secret-scan.mjs";

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function createRuntimePluginManifest(pluginDir, lock) {
  const entries = [];
  const secretFindings = [];
  async function visit(relativeDir = "") {
    const children = await readdir(path.join(pluginDir, relativeDir), { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const child of children) {
      const relative = relativeDir ? `${relativeDir}/${child.name}` : child.name;
      if (relative === ".uclaw-plugin-manifest.json") continue;
      const absolute = path.join(pluginDir, relative);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`plugin symlink is forbidden: ${relative}`);
      if (info.isDirectory()) await visit(relative);
      else if (info.isFile()) {
        entries.push({ path: relative, bytes: info.size, sha256: await sha256(absolute) });
        if (info.size <= 5 * 1024 * 1024) {
          const contents = await readFile(absolute);
          if (!contents.includes(0)) {
            const source = contents.toString("utf8");
            const lines = source.split(/\r?\n/u);
            secretFindings.push(...scanText(relative, source).filter((finding) => !/^\s*(?:\/\/|\*|\/\*)/u.test(lines[finding.line - 1] ?? "")));
          }
        }
      }
      else throw new Error(`unsupported plugin entry: ${relative}`);
    }
  }
  await visit();
  for (const required of ["package.json", "openclaw.plugin.json", "dist/index.js"]) {
    if (!entries.some((entry) => entry.path === required)) throw new Error(`required plugin file is missing: ${required}`);
  }
  if (secretFindings.length > 0) throw new Error(`plugin secret scan failed: ${secretFindings[0].path}:${secretFindings[0].line}`);
  const { schemaVersion, ...pluginLock } = lock;
  return { schemaVersion, plugins: [{ ...pluginLock, files: entries }] };
}

async function runCLI() {
  const { values } = parseArgs({ options: { plugin: { type: "string" }, lock: { type: "string" }, output: { type: "string" } } });
  const locks = JSON.parse(await readFile(values.lock, "utf8"));
  const locked = locks.plugins?.find((plugin) => plugin.id === "openclaw-weixin");
  if (!locked) throw new Error("locked WeChat plugin is missing");
  const manifest = await createRuntimePluginManifest(path.resolve(values.plugin), { schemaVersion: locks.schemaVersion, ...locked });
  await writeFile(values.output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCLI().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
