import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as desktop from "../src/index.js";

describe("MCP portable store", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  async function setup(options: Record<string, unknown> = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-mcp-store-"));
    roots.push(dataDir);
    const create = (desktop as any).createMcpStore;
    expect(create).toBeTypeOf("function");
    return { dataDir, store: create({ dataDir, runtimeAvailable: () => false, ...options }) as any };
  }

  const httpServer = (id = "docs") => ({
    id, name: "Docs", enabled: true, transport: "streamable-http",
    url: "https://mcp.example.com/rpc", authentication: { type: "bearer", secret: "top-secret-value" },
  });

  it("persists servers on the portable data root while returning only secret hints", async () => {
    const { dataDir, store } = await setup();
    const snapshot = await store.create(httpServer());
    expect(snapshot.runtime).toEqual({ state: "unavailable", reason: "locked-runtime-no-mcp-rpc" });
    expect(snapshot.servers[0]).toMatchObject({
      id: "docs", endpointHint: "mcp.example.com", status: "unavailable",
      authentication: { type: "bearer", configured: true, hint: "...alue" },
    });
    expect(JSON.stringify(snapshot)).not.toContain("top-secret-value");
    expect(await store.getForRuntime("docs")).toMatchObject({ authentication: { secret: "top-secret-value" } });
    expect(await readFile(join(dataDir, "mcp", "mcp-config.v1.json"), "utf8")).toContain("top-secret-value");
  });

  it("serializes mutations and keeps old disk and memory state when atomic write fails", async () => {
    const writeAtomically = vi.fn(async (path: string, body: string) => {
      if (body.includes("will-fail")) throw new Error("secret path /Users/name/private");
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, body, "utf8");
    });
    const { dataDir, store } = await setup({ writeAtomically });
    await Promise.all([store.create(httpServer("first")), store.create(httpServer("second"))]);
    const before = await readFile(join(dataDir, "mcp", "mcp-config.v1.json"), "utf8");
    const error = await store.create(httpServer("will-fail")).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "DATA_WRITE_FAILED" });
    expect(JSON.stringify(error)).not.toMatch(/secret path|Users\/name/u);
    expect(await readFile(join(dataDir, "mcp", "mcp-config.v1.json"), "utf8")).toBe(before);
    expect((await store.list()).servers.map((server: any) => server.id)).toEqual(["first", "second"]);
  });

  it("rejects changing a server ID through the store boundary", async () => {
    const { store } = await setup();
    await store.create(httpServer("original"));
    await expect(store.update("original", httpServer("renamed"))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect((await store.list()).servers.map((server: any) => server.id)).toEqual(["original"]);
  });

  it("preserves stdio confirmation when metadata changes without changing the risk fingerprint", async () => {
    const { store } = await setup();
    const server = {
      id: "package", name: "Package", enabled: false, transport: "stdio",
      executableId: "npx", args: ["@modelcontextprotocol/server-filesystem"], env: {},
    };
    const created = await store.create(server);
    const fingerprint = created.servers[0].riskFingerprint;
    await store.confirmRisk("package", fingerprint);
    await store.update("package", { ...server, name: "Renamed" });
    await expect(store.getForRuntime("package")).resolves.toMatchObject({ confirmedRiskFingerprint: fingerprint });
  });

  it("degrades corrupted configuration to an empty renderer-safe snapshot", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-mcp-corrupt-"));
    roots.push(dataDir);
    await mkdir(join(dataDir, "mcp"), { recursive: true });
    await writeFile(join(dataDir, "mcp", "mcp-config.v1.json"), "{ bearer: top-secret-fragment", "utf8");
    const store = (desktop as any).createMcpStore({ dataDir, runtimeAvailable: () => false });
    const snapshot = await store.list();
    expect(snapshot.servers).toEqual([]);
    expect(snapshot.storage).toMatchObject({ state: "degraded" });
    expect(JSON.stringify(snapshot)).not.toContain("top-secret-fragment");
  });

  it("rejects every mutation after corrupt configuration is degraded and preserves the original", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-mcp-corrupt-mutation-"));
    roots.push(dataDir);
    const configPath = join(dataDir, "mcp", "mcp-config.v1.json");
    const corruptBody = "{ bearer: top-secret-fragment";
    await mkdir(join(dataDir, "mcp"), { recursive: true });
    await writeFile(configPath, corruptBody, "utf8");
    const store = (desktop as any).createMcpStore({ dataDir, runtimeAvailable: () => false });
    await store.list();

    const mutations = [
      () => store.create(httpServer()),
      () => store.update("missing", httpServer("missing")),
      () => store.remove("missing"),
      () => store.setEnabled("missing", true),
      () => store.confirmRisk("missing", "fingerprint"),
      () => store.record("missing", { status: "disconnected" }),
    ];
    for (const mutate of mutations) {
      await expect(mutate()).rejects.toMatchObject({ code: "DATA_WRITE_FAILED" });
      expect(await readFile(configPath, "utf8")).toBe(corruptBody);
    }
    expect((await store.list()).storage).toMatchObject({ state: "degraded" });
  });

  it("rejects symlinked data and MCP directories before writing outside the portable data root", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-mcp-link-root-"));
    const outsideData = await mkdtemp(join(tmpdir(), "uclaw-mcp-link-data-outside-"));
    const outsideMcp = await mkdtemp(join(tmpdir(), "uclaw-mcp-link-dir-outside-"));
    roots.push(root, outsideData, outsideMcp);

    const linkedDataDir = join(root, "data");
    await symlink(outsideData, linkedDataDir, "dir");
    const linkedDataStore = (desktop as any).createMcpStore({ dataDir: linkedDataDir, runtimeAvailable: () => false });
    await expect(linkedDataStore.create(httpServer("linked-data"))).rejects.toMatchObject({ code: "DATA_WRITE_FAILED" });
    await expect(lstat(join(outsideData, "mcp", "mcp-config.v1.json"))).rejects.toThrow();

    const dataDir = join(root, "real-data");
    await mkdir(dataDir, { recursive: true });
    await symlink(outsideMcp, join(dataDir, "mcp"), "dir");
    const linkedMcpStore = (desktop as any).createMcpStore({ dataDir, runtimeAvailable: () => false });
    await expect(linkedMcpStore.create(httpServer("linked-mcp"))).rejects.toMatchObject({ code: "DATA_WRITE_FAILED" });
    await expect(lstat(join(outsideMcp, "mcp-config.v1.json"))).rejects.toThrow();
  });

  it("rejects a symlinked ancestor of the portable data directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-mcp-ancestor-root-"));
    const outside = await mkdtemp(join(tmpdir(), "uclaw-mcp-ancestor-outside-"));
    roots.push(root, outside);
    await mkdir(join(outside, "portable-data"), { recursive: true });
    const linkedAncestor = join(root, "portable-link");
    await symlink(outside, linkedAncestor, "dir");
    const dataDir = join(linkedAncestor, "portable-data");
    const store = (desktop as any).createMcpStore({ dataDir, runtimeAvailable: () => false });

    await expect(store.create(httpServer("ancestor-link"))).rejects.toMatchObject({ code: "DATA_WRITE_FAILED" });
    await expect(lstat(join(outside, "portable-data", "mcp", "mcp-config.v1.json"))).rejects.toThrow();
  });
});
