import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOpenClawCliPluginRuntime } from "../src/plugins/openclaw-cli-runtime.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixtureRuntime() {
  const root = await mkdtemp(join(tmpdir(), "uclaw-cli-runtime-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const dataDir = join(root, "data");
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(join(runtimeRoot, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.7.1-2" }));
  await writeFile(join(runtimeRoot, "openclaw.mjs"), `
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
const statePath = join(process.env.OPENCLAW_STATE_DIR, "fixture-runtime.json");
await mkdir(process.env.OPENCLAW_STATE_DIR, { recursive: true });
let state = { plugins: [] };
try { state = JSON.parse(await readFile(statePath, "utf8")); } catch {}
if (args[0] !== "plugins") process.exit(2);
if (args[1] === "list") console.log(JSON.stringify(state));
else if (args[1] === "install") {
  const source = args[2];
  const manifest = JSON.parse(await readFile(join(source, "openclaw.plugin.json"), "utf8"));
  const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  state.plugins = state.plugins.filter((plugin) => plugin.id !== manifest.id);
  state.plugins.push({ id: manifest.id, name: manifest.id, version: pkg.version, enabled: true, origin: "global", source });
  await writeFile(statePath, JSON.stringify(state));
} else if (args[1] === "uninstall") {
  state.plugins = state.plugins.filter((plugin) => plugin.id !== args[2]);
  await writeFile(statePath, JSON.stringify(state));
} else if (args[1] === "enable" || args[1] === "disable") {
  state.plugins = state.plugins.map((plugin) => plugin.id === args[2] ? { ...plugin, enabled: args[1] === "enable" } : plugin);
  await writeFile(statePath, JSON.stringify(state));
} else process.exit(3);
`);
  return { root, runtimeRoot, dataDir };
}

describe("OpenClaw CLI Plugin runtime adapter", () => {
  it("rejects an entrypoint from a different OpenClaw version", async () => {
    const fixture = await fixtureRuntime();
    await writeFile(join(fixture.runtimeRoot, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.7.1-1" }));
    await expect(createOpenClawCliPluginRuntime({
      runtimeRoot: fixture.runtimeRoot,
      executable: process.execPath,
      dataDir: fixture.dataDir,
    })).rejects.toThrow("Locked OpenClaw runtime entrypoint not found.");
  });

  it("delegates install, enablement, listing, and uninstall to the runtime CLI", async () => {
    const fixture = await fixtureRuntime();
    const sourceDir = join(fixture.root, "source");
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, "openclaw.plugin.json"), JSON.stringify({ id: "calendar", configSchema: { type: "object" } }));
    await writeFile(join(sourceDir, "package.json"), JSON.stringify({ name: "calendar", version: "1.2.0", openclaw: { extensions: ["./index.js"] } }));
    const runtime = await createOpenClawCliPluginRuntime({
      runtimeRoot: fixture.runtimeRoot,
      executable: process.execPath,
      dataDir: fixture.dataDir,
      baseEnvironment: {},
    });
    await runtime.installFromPath({ sourceDir, slug: "calendar" });
    expect(await runtime.installed()).toEqual([expect.objectContaining({ slug: "calendar", version: "1.2.0", enabled: true })]);
    await runtime.setEnabled("calendar", false);
    expect((await runtime.installed())[0].enabled).toBe(false);
    await runtime.uninstall("calendar");
    expect(await runtime.installed()).toEqual([]);
  });

  it("does not expose runtime stderr through lifecycle errors", async () => {
    const fixture = await fixtureRuntime();
    await writeFile(join(fixture.runtimeRoot, "openclaw.mjs"), "process.stderr.write('secret-token'); process.exit(1);");
    const runtime = await createOpenClawCliPluginRuntime({ runtimeRoot: fixture.runtimeRoot, executable: process.execPath, dataDir: fixture.dataDir });
    await expect(runtime.installed()).rejects.not.toThrow(/secret-token/);
    await expect(readFile(join(fixture.runtimeRoot, "openclaw.mjs"), "utf8")).resolves.toContain("secret-token");
  });
});
