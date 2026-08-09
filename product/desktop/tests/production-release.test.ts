import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { writeBoundedResponseBody } from "../src/release/production-release.js";

const body = (...chunks: string[]) => new ReadableStream<Uint8Array>({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
    controller.close();
  },
});

describe("production release download", () => {
  it("writes exactly the signed byte count", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-download-"));
    const target = join(root, "runtime.pkg");
    await writeBoundedResponseBody(body("run", "time"), target, 7, new AbortController().signal);
    expect(await readFile(target, "utf8")).toBe("runtime");
  });

  it.each([["oversized", ["runtime", "overflow"], 7], ["truncated", ["run"], 7]])("rejects %s bodies and removes partial files", async (_name, chunks, expected) => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-download-"));
    const target = join(root, "runtime.pkg");
    await expect(writeBoundedResponseBody(body(...chunks), target, expected, new AbortController().signal)).rejects.toThrow(/size/i);
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
