import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const launcher = new URL("../启动-U-Claw.command", import.meta.url);

describe("local Electron launcher", () => {
  it("uses repository-relative Electron and portable runtime paths", async () => {
    await access(launcher, constants.X_OK);
    const source = await readFile(launcher, "utf8");
    assert.match(source, /PRODUCT_DIR=/u);
    assert.match(source, /UCLAW_RUNTIME_DIR/u);
    assert.match(source, /desktop\/dist\/entry\.js/u);
    assert.doesNotMatch(source, /\.codex\/worktrees/u);
  });
});
