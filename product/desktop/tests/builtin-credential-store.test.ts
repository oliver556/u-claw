import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { getFsSafePythonConfig } from "@openclaw/fs-safe/config";

import { createBuiltinCredentialStore } from "../src/providers/builtin-credential-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function setup(allowLoopbackHttp = true) {
  const dataDir = await mkdtemp(join(tmpdir(), "uclaw-builtin-credential-"));
  roots.push(dataDir);
  return { dataDir, store: createBuiltinCredentialStore({ dataDir, allowLoopbackHttp, platformForTest: "linux" }) };
}

function provisionInput(endpoint = "http://127.0.0.1:18090/v1") {
  const suffix = randomUUID().replaceAll("-", "");
  return {
    schemaVersion: 2 as const,
    deviceId: `dev_${suffix}`,
    licenseId: `lic_${suffix}`,
    endpoint,
    deviceToken: `uclaw_dt_${"A".repeat(43)}`,
  };
}

describe("builtin credential store", () => {
  it("exposes only the normal credential API", async () => {
    const { store } = await setup(true);
    expect(store).not.toHaveProperty("provisionActivation");
    expect(store).not.toHaveProperty("loadActivation");
  });
  it("does not initialize the credential root until the first I/O operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-builtin-invalid-root-"));
    roots.push(root);
    const dataDir = join(root, "plain-file");
    await writeFile(dataDir, "not a directory");

    createBuiltinCredentialStore({ dataDir, platformForTest: "linux" });
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("reports an unsafe credential root on the first load", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-builtin-invalid-root-"));
    roots.push(root);
    const dataDir = join(root, "plain-file");
    await writeFile(dataDir, "not a directory");

    const store = createBuiltinCredentialStore({ dataDir, platformForTest: "linux" });
    await expect(store.loadActive()).rejects.toMatchObject({ code: "BUILTIN_CREDENTIAL_UNSAFE" });
  });

  it("requires pinned filesystem access and rejects Windows before P3-T08", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-builtin-windows-"));
    roots.push(dataDir);
    expect(() => createBuiltinCredentialStore({ dataDir, platformForTest: "win32" }))
      .toThrow(/P3-T08 native helper/u);
    const testOnly = createBuiltinCredentialStore({
      dataDir, platformForTest: "win32", allowUnpinnedFilesystemForTest: true,
    });
    expect(testOnly.pinnedFilesystem).toBe(false);
    const native = createBuiltinCredentialStore({ dataDir, platformForTest: "linux" });
    expect(native.pinnedFilesystem).toBe(true);
    expect(getFsSafePythonConfig().mode).toBe("require");
  });

  it("fails closed when credential is missing", async () => {
    const { store } = await setup();
    await expect(store.loadActive()).rejects.toMatchObject({ code: "BUILTIN_CREDENTIAL_MISSING" });
  });

  it("persists the strict activated credential in the mode-0600 normal store", async () => {
    const { dataDir, store } = await setup();
    const input = provisionInput();
    await store.provision(input);

    await expect(store.loadActive()).resolves.toMatchObject({
      endpoint: new URL(input.endpoint),
      deviceId: input.deviceId,
      licenseId: input.licenseId,
      deviceToken: input.deviceToken,
    });
    const path = join(dataDir, ".uclaw", "builtin-model-credential.v1.json");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...input, endpoint: `${input.endpoint}/` });
  });

  it("loads a server-reissued credential carrying deviceTokenId", async () => {
    const { dataDir, store } = await setup();
    const input = provisionInput();
    const credentialDir = join(dataDir, ".uclaw");
    await mkdir(credentialDir, { recursive: true });
    await writeFile(join(credentialDir, "builtin-model-credential.v1.json"), `${JSON.stringify({
      ...input,
      deviceTokenId: `dt_${randomUUID().replaceAll("-", "")}`,
    })}\n`, { mode: 0o600 });

    await expect(store.loadActive()).resolves.toMatchObject({
      deviceId: input.deviceId,
      licenseId: input.licenseId,
      deviceToken: input.deviceToken,
    });
  });

  it("loads a legacy single-model credential without making its model authoritative", async () => {
    const { dataDir, store } = await setup();
    const current = provisionInput();
    const credentialDir = join(dataDir, ".uclaw");
    await mkdir(credentialDir, { recursive: true });
    await writeFile(join(credentialDir, "builtin-model-credential.v1.json"), `${JSON.stringify({
      ...current,
      schemaVersion: 1,
      model: "legacy-model",
    })}\n`, { mode: 0o600 });

    await expect(store.loadActive()).resolves.toMatchObject({
      endpoint: new URL(`${current.endpoint}/`),
      deviceToken: current.deviceToken,
      model: "legacy-model",
    });
  });

  it("rejects extra fields and malformed token fields", async () => {
    const { store } = await setup();
    const input = provisionInput();
    await expect(store.provision({
      ...input,
      mapping: {},
    } as never)).rejects.toMatchObject({ code: "BUILTIN_CREDENTIAL_INVALID" });
    await expect(store.provision({
      ...input,
      deviceToken: `uclaw_dt_${"A".repeat(42)}`,
    })).rejects.toMatchObject({ code: "BUILTIN_CREDENTIAL_INVALID" });
    await expect(store.provision({
      ...input,
      deviceTokenId: "invalid token id",
    } as never)).rejects.toMatchObject({ code: "BUILTIN_CREDENTIAL_INVALID" });
  });

  it("rejects a hardlinked credential target", async () => {
    const { dataDir, store } = await setup();
    const uclawDir = join(dataDir, ".uclaw");
    await mkdir(uclawDir, { recursive: true });
    const source = join(dataDir, "linked-secret.json");
    await writeFile(source, "preserve-me", { mode: 0o600 });
    await link(source, join(uclawDir, "builtin-model-credential.v1.json"));
    await expect(store.provision(provisionInput())).rejects.toMatchObject({ code: "BUILTIN_CREDENTIAL_UNSAFE" });
    expect(await readFile(source, "utf8")).toBe("preserve-me");
  });

  it.skipIf(process.platform === "win32")("rejects symlinked and broadly readable credential targets", async () => {
    const linked = await setup();
    const linkedDir = join(linked.dataDir, ".uclaw");
    await mkdir(linkedDir, { recursive: true });
    const source = join(linked.dataDir, "linked-secret.json");
    await writeFile(source, `${JSON.stringify(provisionInput())}\n`, { mode: 0o600 });
    await symlink(source, join(linkedDir, "builtin-model-credential.v1.json"));
    await expect(linked.store.loadActive()).rejects.toMatchObject({ code: "BUILTIN_CREDENTIAL_UNSAFE" });

    const broad = await setup();
    await broad.store.provision(provisionInput());
    await chmod(join(broad.dataDir, ".uclaw", "builtin-model-credential.v1.json"), 0o644);
    await expect(broad.store.loadActive()).rejects.toMatchObject({ code: "BUILTIN_CREDENTIAL_UNSAFE" });
  });

  it("uses the same strict credential for connectivity checks", async () => {
    const { store } = await setup();
    const input = provisionInput();
    await expect(store.provision(input)).resolves.toBeUndefined();
    await expect(store.loadForConnectivityCheck()).resolves.toMatchObject({ deviceToken: input.deviceToken });
    await expect(store.loadActive()).resolves.toMatchObject({ deviceToken: input.deviceToken });
  });

  it("allows loopback HTTP only under explicit development-test policy", async () => {
    const development = await setup(true);
    await expect(development.store.provision(provisionInput("http://localhost:18090/v1"))).resolves.toBeUndefined();

    const production = await setup(false);
    await expect(production.store.provision(provisionInput("http://127.0.0.1:18090/v1"))).rejects.toMatchObject({ code: "BUILTIN_ENDPOINT_INSECURE" });
    await expect(production.store.provision(provisionInput("https://builtin.example.test/v1"))).resolves.toBeUndefined();
    for (const endpoint of [
      "http://example.test/v1",
      "http://127.0.0.2/v1",
      "https://user:password@example.test/v1",
      "https://example.test/v1?token=value",
      "https://example.test/v1#fragment",
    ]) {
      await expect(production.store.provision(provisionInput(endpoint))).rejects.toMatchObject({ code: "BUILTIN_ENDPOINT_INSECURE" });
    }
  });

  it("clears the credential and returns to fail-closed state", async () => {
    const { store } = await setup();
    await store.provision(provisionInput());
    await store.clear();
    await expect(store.loadActive()).rejects.toMatchObject({ code: "BUILTIN_CREDENTIAL_MISSING" });
  });
});
