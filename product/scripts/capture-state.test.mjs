import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import test from "node:test";

import {
  CAPTURE_STATE_MARKER,
  CAPTURE_STATE_MARKER_CONTENT,
  prepareCaptureStateDir,
} from "./capture-state.mjs";

async function fixture() {
  return mkdtemp(join(tmpdir(), "uclaw-capture-state-test-"));
}

test("creates a missing capture state directory with its marker", async () => {
  const parent = await fixture();
  const target = join(parent, "state");
  try {
    await prepareCaptureStateDir(target);
    assert.equal(await readFile(join(target, CAPTURE_STATE_MARKER), "utf8"), CAPTURE_STATE_MARKER_CONTENT);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("clears only a capture state directory with the exact marker", async () => {
  const parent = await fixture();
  const target = join(parent, "state");
  try {
    await prepareCaptureStateDir(target);
    await writeFile(join(target, "stale.txt"), "stale");
    await prepareCaptureStateDir(target);
    await assert.rejects(access(join(target, "stale.txt")));
    assert.equal(await readFile(join(target, CAPTURE_STATE_MARKER), "utf8"), CAPTURE_STATE_MARKER_CONTENT);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("preserves and rejects an existing directory without the exact marker", async () => {
  const parent = await fixture();
  const target = join(parent, "state");
  try {
    await mkdir(target);
    await writeFile(join(target, "keep.txt"), "keep");
    await assert.rejects(prepareCaptureStateDir(target), /without marker/);
    assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "keep");
    await writeFile(join(target, CAPTURE_STATE_MARKER), "wrong marker\n");
    await assert.rejects(prepareCaptureStateDir(target), /invalid marker/);
    assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "keep");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("rejects filesystem root and home before reading or deleting them", async () => {
  const fakeHome = await fixture();
  try {
    await assert.rejects(prepareCaptureStateDir(parse(fakeHome).root, { homeDir: fakeHome }), /unsafe/);
    await assert.rejects(prepareCaptureStateDir(fakeHome, { homeDir: fakeHome }), /unsafe/);
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
  }
});
