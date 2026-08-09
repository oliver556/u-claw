import { describe, expect, it } from "vitest";

import * as desktop from "../src/index.js";

describe("MCP stdio policy", () => {
  const assess = (server: unknown) => (desktop as any).assessMcpStdioPolicy(server);

  it("accepts only controlled executable IDs and resolves paths in main process", () => {
    expect(assess({ id: "safe", name: "Safe", enabled: true, transport: "stdio", executableId: "node", args: ["server.js"], env: {} }))
      .toMatchObject({ allowed: true, confirmationRequired: false, executableId: "node" });
    expect(() => assess({ id: "bad", name: "Bad", enabled: true, transport: "stdio", executableId: "/tmp/node", args: [], env: {} })).toThrow();
  });

  it.each([
    ["eval", ["--eval", "process.exit()"], {}],
    ["shell", ["server.js", ";", "whoami"], {}],
    ["traversal", ["../server.js"], {}],
    ["node-options", ["server.js"], { NODE_OPTIONS: "--require=/tmp/hook.js" }],
    ["secret-env", ["server.js"], { AWS_SECRET_ACCESS_KEY: "secret" }],
  ])("rejects dangerous %s stdio input", (_name, args, env) => {
    expect(assess({ id: "bad", name: "Bad", enabled: true, transport: "stdio", executableId: "node", args, env }))
      .toMatchObject({ allowed: false });
  });

  it("requires confirmation for package execution and MCP environment injection", () => {
    const result = assess({
      id: "package", name: "Package", enabled: true, transport: "stdio", executableId: "npx",
      args: ["@modelcontextprotocol/server-filesystem"], env: { MCP_ROOT_MODE: "read-only" },
    });
    expect(result).toMatchObject({ allowed: true, confirmationRequired: true });
    expect(result.fingerprint).toMatch(/^sha256:/u);
    expect(JSON.stringify(result)).not.toContain("read-only");
  });
});
