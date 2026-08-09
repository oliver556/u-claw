export interface RuntimePluginRecord {
  slug: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  origin: "bundled" | "global" | "workspace" | "config" | "unknown";
  source: string;
}

export interface PluginRuntimeAdapter {
  installed(): Promise<RuntimePluginRecord[]>;
  installFromPath(input: { sourceDir: string; slug: string }): Promise<void>;
  uninstall(slug: string): Promise<void>;
  setEnabled(slug: string, enabled: boolean): Promise<void>;
}
