import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function source(path: string): string {
  return readFileSync(join(productRoot, path), "utf8");
}

function sourceTree(path: string): string {
  const root = join(productRoot, path);
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}

function sourceFiles(path: string): Array<{ path: string; body: string }> {
  const root = join(productRoot, path);
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ts$/u.test(entry.name))
    .map((entry) => ({
      path: join(entry.parentPath, entry.name).slice(productRoot.length + 1).replaceAll("\\", "/"),
      body: readFileSync(join(entry.parentPath, entry.name), "utf8"),
    }));
}

describe("OpenClaw-only production chat contract", () => {
  it("keeps Electron production wiring disconnected from legacy model inference clients", () => {
    const productionChat = [
      source("desktop/src/main.ts"),
      source("desktop/src/index.ts"),
      source("desktop/src/wiring/create-desktop-main-options.ts"),
    ].join("\n");

    for (const forbidden of [
      "createMainProcessModelRouting",
      "createLegacyBuiltinServiceClientForTest",
      "modelSourceExecutors",
      "/chat/completions",
      "/images/generations",
      "/images/edits",
    ]) expect(productionChat).not.toContain(forbidden);
  });

  it("keeps Renderer chat free of model HTTP inference endpoints", () => {
    const rendererChat = sourceTree("frontend/src/features/chat");

    for (const forbidden of [
      "/chat/completions",
      "/images/generations",
      "/images/edits",
      "createBuiltinServiceClient",
    ]) expect(rendererChat).not.toContain(forbidden);
  });

  it("allows Electron model HTTP only for explicit BYOK credential verification", () => {
    const directChatEndpoints = sourceFiles("desktop/src")
      .filter(({ body }) => body.includes("/chat/completions"))
      .map(({ path }) => path);

    expect(directChatEndpoints).toEqual(["desktop/src/providers/provider-network.ts"]);
    expect(source("desktop/src/providers/provider-network.ts")).toContain("const verify = async");
  });
});
