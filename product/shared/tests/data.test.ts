import { describe, expect, it } from "vitest";

import {
  DATA_ROOT_CONTRACT,
  DataIpcRequestSchema,
  DataRootContractSchema,
  RelativeDomainIdSchema,
} from "../src/data.js";
import { IpcRequestSchema, IpcResponseSchema } from "../src/ipc.js";

describe("data management contract", () => {
  it("accepts normalized relative domain IDs", () => {
    expect(RelativeDomainIdSchema.parse("reports/2026/summary.md")).toBe("reports/2026/summary.md");
    expect(RelativeDomainIdSchema.parse("MEMORY.md")).toBe("MEMORY.md");
  });

  it.each([
    "", ".", "..", "../escape", "folder/../escape", "/etc/passwd", "\\\\server\\share",
    "C:\\secret.txt", "file.txt:stream", "CON", "con.txt", "folder/NUL.md", "folder\\file.md",
  ])("rejects unsafe domain ID %s", (value) => {
    expect(RelativeDomainIdSchema.safeParse(value).success).toBe(false);
  });

  it("requires explicit confirmation and a version for destructive writes", () => {
    expect(DataIpcRequestSchema.safeParse({
      method: "workspace.delete", requestId: "delete-1",
      params: { entryId: "notes/a.md", version: "v1", confirmed: false },
    }).success).toBe(false);
    expect(DataIpcRequestSchema.safeParse({
      method: "memory.delete", requestId: "delete-2",
      params: { memoryId: "memory/2026-08-09.md", version: "v1", confirmed: true },
    }).success).toBe(true);
  });

  it("participates in the unified IPC request and response contracts", () => {
    expect(IpcRequestSchema.safeParse({
      method: "workspace.list",
      requestId: "workspace-list",
      params: { limit: 20 },
    }).success).toBe(true);
    expect(IpcResponseSchema.safeParse({
      method: "workspace.open",
      requestId: "workspace-open",
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "Controlled system opener is unavailable.",
        retryable: false,
        recoveryActions: [],
        causeDetails: {},
      },
    }).success).toBe(true);
  });

  it("freezes distinct durable, backup and cleanup classes for P2-T11", () => {
    const contract = DataRootContractSchema.parse(DATA_ROOT_CONTRACT);
    expect(contract.backupSets).toContain("openclaw-memory");
    expect(contract.backupPolicies["openclaw-memory"].includes).toEqual([
      "workspace/MEMORY.md", "workspace/memory/**/*.md",
    ]);
    expect(contract.backupPolicies["workspace-user-files"].excludes).toContain("workspace/AGENTS.md");
    expect(contract.cleanupPolicies["user-managed"].excludes).toContain("workspace/AGENTS.md");
    expect(contract.backupPolicies["uclaw-configuration"].includes).toEqual(expect.arrayContaining([
      ".openclaw/**", "desktop/**", "workspace/AGENTS.md",
    ]));
    expect(contract.backupPolicies["uclaw-configuration"].excludes).toEqual([".openclaw/agents/**"]);
    expect(contract.cleanupPolicies["protected-durable"].includes).toContain("desktop/**");
    expect(contract.cleanupPolicies["rebuildable-cache"]).toEqual({ root: "cache", includes: ["**"] });
  });
});
