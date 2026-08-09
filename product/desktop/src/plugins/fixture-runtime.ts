import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PluginRuntimeAdapter, RuntimePluginRecord } from "./runtime-adapter.js";

type Config = Record<string, unknown> & {
  plugins?: Record<string, unknown> & {
    entries?: Record<string, { enabled?: boolean }>;
    allow?: string[];
    deny?: string[];
  };
};

async function readConfig(path: string): Promise<Config> {
  try { return JSON.parse(await readFile(path, "utf8")) as Config; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}

async function writeConfig(path: string, config: Config): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function withEnabled(config: Config, slug: string, enabled: boolean): Config {
  const plugins = { ...(config.plugins ?? {}) };
  const entries = { ...(plugins.entries ?? {}), [slug]: { ...(plugins.entries?.[slug] ?? {}), enabled } };
  let allow = plugins.allow;
  let deny = plugins.deny;
  if (enabled) {
    if (allow?.length && !allow.includes(slug)) allow = [...allow, slug];
    if (deny?.includes(slug)) deny = deny.filter((id) => id !== slug);
  }
  return { ...config, plugins: { ...plugins, entries, ...(allow?.length ? { allow } : {}), ...(deny?.length ? { deny } : {}) } };
}

function withoutPlugin(config: Config, slug: string): Config {
  const plugins = { ...(config.plugins ?? {}) };
  const entries = { ...(plugins.entries ?? {}) };
  delete entries[slug];
  delete plugins.entries;
  delete plugins.allow;
  delete plugins.deny;
  if (Object.keys(entries).length) plugins.entries = entries;
  const allow = config.plugins?.allow?.filter((id) => id !== slug);
  const deny = config.plugins?.deny?.filter((id) => id !== slug);
  if (allow?.length) plugins.allow = allow;
  if (deny?.length) plugins.deny = deny;
  const next = { ...config };
  if (Object.keys(plugins).length) next.plugins = plugins;
  else delete next.plugins;
  return next;
}

export function createFixturePluginRuntime(dataDir: string): PluginRuntimeAdapter {
  const extensionsDir = join(dataDir, ".openclaw", "extensions");
  const configPath = join(dataDir, ".openclaw", "openclaw.json");
  const installed = async (): Promise<RuntimePluginRecord[]> => {
    const config = await readConfig(configPath);
    const names = await readdir(extensionsDir).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    const records: RuntimePluginRecord[] = [];
    for (const slug of names.filter((name) => !name.startsWith("."))) {
      try {
        const manifest = JSON.parse(await readFile(join(extensionsDir, slug, "openclaw.plugin.json"), "utf8")) as { id?: string; name?: string; description?: string };
        const packageJson = JSON.parse(await readFile(join(extensionsDir, slug, "package.json"), "utf8")) as { version?: string };
        const enabledByEntry = config.plugins?.entries?.[slug]?.enabled !== false;
        const globallyEnabled = config.plugins?.enabled !== false;
        const allowed = !config.plugins?.allow?.length || config.plugins.allow.includes(slug);
        const denied = config.plugins?.deny?.includes(slug) ?? false;
        records.push({
          slug: manifest.id ?? slug,
          name: manifest.name ?? slug,
          description: manifest.description ?? "",
          version: packageJson.version ?? "unknown",
          enabled: globallyEnabled && enabledByEntry && allowed && !denied,
          origin: "global",
          source: join(extensionsDir, slug),
        });
      } catch { /* Ignore invalid external directories, matching runtime discovery diagnostics. */ }
    }
    return records;
  };
  return {
    installed,
    async installFromPath({ sourceDir, slug }) {
      await mkdir(extensionsDir, { recursive: true });
      const target = join(extensionsDir, slug);
      const backup = join(extensionsDir, `.${slug}.fixture-backup`);
      await rm(backup, { recursive: true, force: true });
      await rename(target, backup).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      try {
        await cp(sourceDir, target, { recursive: true, errorOnExist: true, force: false });
        await writeConfig(configPath, withEnabled(await readConfig(configPath), slug, true));
        await rm(backup, { recursive: true, force: true });
      } catch (error) {
        await rm(target, { recursive: true, force: true });
        await rename(backup, target).catch(() => undefined);
        throw error;
      }
    },
    async uninstall(slug) {
      await rm(join(extensionsDir, slug), { recursive: true, force: true });
      await writeConfig(configPath, withoutPlugin(await readConfig(configPath), slug));
    },
    async setEnabled(slug, enabled) {
      await writeConfig(configPath, withEnabled(await readConfig(configPath), slug, enabled));
    },
  };
}
