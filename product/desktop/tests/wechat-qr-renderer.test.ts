import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOpenClawQrRenderer } from "../src/channels/wechat-qr-renderer.js";

describe("OpenClaw QR renderer", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("keeps a maximum-size QR image inside the renderer IPC contract", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "uclaw-qr-runtime-"));
    cleanup.push(runtimeRoot);
    const moduleRoot = join(runtimeRoot, "node_modules", "qrcode-terminal", "vendor", "QRCode");
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(join(moduleRoot, "index.js"), `module.exports = class QRCode {
      addData() {}
      make() {}
      getModuleCount() { return 177; }
      isDark(row, column) { return ((row * 131 + column * 197 + row * column) % 11) < 5; }
    };\n`);
    await writeFile(join(moduleRoot, "QRErrorCorrectLevel.js"), "module.exports = { L: 1 };\n");
    const render = createOpenClawQrRenderer(runtimeRoot, join(runtimeRoot, "plugin"));

    const result = await render("A".repeat(4_096));

    expect(result).toMatch(/^data:image\/png;base64,iVBORw0KGgo/u);
    expect(result.length).toBeLessThanOrEqual(16_384);
  });
});
