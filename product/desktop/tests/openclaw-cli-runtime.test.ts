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

async function flakyListRuntime() {
  const fixture = await fixtureRuntime();
  const entrypoint = join(fixture.runtimeRoot, "openclaw.mjs");
  await writeFile(entrypoint, `
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const marker = join(process.env.OPENCLAW_STATE_DIR, "list-attempt.txt");
await mkdir(process.env.OPENCLAW_STATE_DIR, { recursive: true });
let attempt = 0;
try { attempt = Number(await readFile(marker, "utf8")); } catch {}
await writeFile(marker, String(attempt + 1));
if (attempt === 0) process.exit(0);
console.log(JSON.stringify({ plugins: [] }));
`);
  return fixture;
}

describe("OpenClaw CLI Plugin runtime adapter", () => {
  it("uses the production-validated explicit entrypoint without scanning the runtime inventory", async () => {
    const fixture = await fixtureRuntime();
    const nestedRoot = join(fixture.runtimeRoot, "core", "node_modules", "openclaw");
    await mkdir(nestedRoot, { recursive: true });
    const entrypoint = join(nestedRoot, "openclaw.mjs");
    await writeFile(join(nestedRoot, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.7.1-2" }));
    await writeFile(entrypoint, "console.log(JSON.stringify({ plugins: [] }));");
    await rm(join(fixture.runtimeRoot, "openclaw.mjs"));
    await rm(join(fixture.runtimeRoot, "package.json"));

    const runtime = await createOpenClawCliPluginRuntime({
      runtimeRoot: fixture.runtimeRoot,
      executable: process.execPath,
      entrypoint,
      dataDir: fixture.dataDir,
      baseEnvironment: {},
    });

    await expect(runtime.installed()).resolves.toEqual([]);
  });

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

  it("uses the production Gateway state and config paths inside the portable data root", async () => {
    const fixture = await fixtureRuntime();
    const stateDir = join(fixture.dataDir, "openclaw-state");
    const configPath = join(fixture.dataDir, "config", "openclaw.json");
    const runtime = await createOpenClawCliPluginRuntime({
      runtimeRoot: fixture.runtimeRoot,
      executable: process.execPath,
      dataDir: fixture.dataDir,
      baseEnvironment: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
    });

    const sourceDir = join(fixture.root, "portable-path-plugin");
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, "openclaw.plugin.json"), JSON.stringify({ id: "portable-path", configSchema: { type: "object" } }));
    await writeFile(join(sourceDir, "package.json"), JSON.stringify({ name: "portable-path", version: "1.0.0", openclaw: { extensions: ["./index.js"] } }));
    await runtime.installFromPath({ sourceDir, slug: "portable-path" });
    await expect(readFile(join(stateDir, "fixture-runtime.json"), "utf8")).resolves.toContain('"plugins"');
    await expect(readFile(join(fixture.dataDir, ".openclaw", "fixture-runtime.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries an empty authoritative Plugin list response before parsing", async () => {
    const fixture = await flakyListRuntime();
    const runtime = await createOpenClawCliPluginRuntime({
      runtimeRoot: fixture.runtimeRoot, executable: process.execPath, dataDir: fixture.dataDir,
    });
    await expect(runtime.installed()).resolves.toEqual([]);
    await expect(readFile(join(fixture.dataDir, ".openclaw", "list-attempt.txt"), "utf8")).resolves.toBe("2");
  });

  it("does not expose runtime stderr through lifecycle errors", async () => {
    const fixture = await fixtureRuntime();
    await writeFile(join(fixture.runtimeRoot, "openclaw.mjs"), "process.stderr.write('secret-token'); process.exit(1);");
    const runtime = await createOpenClawCliPluginRuntime({ runtimeRoot: fixture.runtimeRoot, executable: process.execPath, dataDir: fixture.dataDir });
    await expect(runtime.installed()).rejects.not.toThrow(/secret-token/);
    await expect(readFile(join(fixture.runtimeRoot, "openclaw.mjs"), "utf8")).resolves.toContain("secret-token");
  });
});
