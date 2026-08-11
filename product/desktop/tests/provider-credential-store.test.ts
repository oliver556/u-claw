import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createProviderCredentialStore } from "../src/providers/provider-credential-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("provider credential store", () => {
  it("stores keys in a pinned main-only mode-0600 target", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-provider-credentials-"));
    roots.push(dataDir);
    const store = createProviderCredentialStore({ dataDir });
    await store.set("openai", "sk-main-only");

    await expect(store.get("openai")).resolves.toBe("sk-main-only");
    await expect(store.has("openai")).resolves.toBe(true);
    const path = join(dataDir, ".uclaw", "provider-credentials.v1.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toContain("sk-main-only");
  });

  it("rejects an unsafe hardlinked credential target", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-provider-credentials-unsafe-"));
    roots.push(dataDir);
    await mkdir(join(dataDir, ".uclaw"), { recursive: true });
    const source = join(dataDir, "outside.json");
    await writeFile(source, "preserve", { mode: 0o600 });
    await link(source, join(dataDir, ".uclaw", "provider-credentials.v1.json"));

    const store = createProviderCredentialStore({ dataDir });
    await expect(store.set("openai", "sk-rejected")).rejects.toMatchObject({ code: "OPERATION_FAILED" });
    expect(await readFile(source, "utf8")).toBe("preserve");
  });
});
