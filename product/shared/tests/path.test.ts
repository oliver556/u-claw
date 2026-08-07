import { describe, expect, it } from "vitest";

import { BasenameSchema, FileRefSchema } from "../src/index.js";

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

  it("allows normal localized basenames", () => {
    expect(BasenameSchema.parse("会议 记录.md")).toBe("会议 记录.md");
  });

  it.each(["/etc/passwd", "folder/file.txt", "folder\\file.txt", ".", "..", "bad\0name"])(
    "rejects unsafe basename: %s",
    (name) => expect(() => FileRefSchema.parse({ ...file, name })).toThrow(),
  );

  it.each([
    "C:secret.txt",
    "file.txt:stream",
    "bad<name.txt",
    "bad>name.txt",
    "bad\"name.txt",
    "bad|name.txt",
    "bad?name.txt",
    "bad*name.txt",
    "trailing.",
    "trailing ",
    "CON",
    "con.txt",
    "PRN.log",
    "AUX",
    "NUL.txt",
    "COM1",
    "com9.md",
    "LPT1",
    "lpt9.txt",
  ])("rejects Windows-invalid basename: %s", (name) => {
    expect(() => BasenameSchema.parse(name)).toThrow();
  });
});
