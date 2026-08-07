import { describe, expect, it } from "vitest";

import { FileRefSchema } from "../src/index.js";

const file = {
  id: "file-1",
  name: "notes.md",
  mediaType: "text/markdown",
  size: 10,
  kind: "workspace",
};

describe("controlled relative paths", () => {
  it("parses a normalized controlled relative path", () => {
    expect(FileRefSchema.parse({ ...file, relativePath: "notes/2026/today.md" })).toBeTruthy();
  });

  it.each([
    "/etc/passwd",
    "C:\\Users\\private.txt",
    "\\\\server\\share\\file.txt",
    "notes//today.md",
    "notes/./today.md",
    "notes/../private.md",
    "notes/\0private.md",
  ])("rejects unsafe relative path: %s", (relativePath) => {
    expect(() => FileRefSchema.parse({ ...file, relativePath })).toThrow();
  });
});
