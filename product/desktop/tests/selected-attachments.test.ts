import { describe, expect, it, vi } from "vitest";

import { readSelectedAttachments } from "../src/main.js";

describe("readSelectedAttachments", () => {
  const fileStat = (size: number) => ({ isFile: () => true, size });

  it("rechecks actual bytes after read when a selected file grows", async () => {
    const error = await readSelectedAttachments(["C:\\selected\\growing.txt"], {
      maxFileBytes: 8,
      maxTotalBytes: 16,
      stat: vi.fn(async () => fileStat(4)),
      readFile: vi.fn(async () => Buffer.from("123456789")),
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("rejects actual cumulative growth and bounds read concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const readFile = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      return Buffer.from("1234");
    });
    const error = await readSelectedAttachments(["a.txt", "b.txt", "c.txt", "d.txt"], {
      maxFileBytes: 8,
      maxTotalBytes: 14,
      concurrency: 2,
      stat: vi.fn(async () => fileStat(2)),
      readFile,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("rejects too many selections before reading", async () => {
    const readFile = vi.fn();
    const error = await readSelectedAttachments(Array.from({ length: 9 }, (_, index) => `${index}.txt`), {
      maxFiles: 8,
      stat: vi.fn(),
      readFile,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(readFile).not.toHaveBeenCalled();
  });
});
