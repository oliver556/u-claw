import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const preview = readFileSync(new URL("./preview.html", import.meta.url), "utf8");

test("includes every logo concept, comparison state, and physical size", () => {
  for (const path of [
    "concepts/concept-1-compact.svg",
    "concepts/concept-2-wide-claw.svg",
    "concepts/concept-3-long-body.svg",
    "concepts/concept-4-shield.svg",
  ]) {
    assert.match(preview, new RegExp(path.replaceAll(".", "\\.")));
  }

  for (const label of [
    "White",
    "Black",
    "Silver metal",
    "Black metal",
    "64 px",
    "32 px",
    "16 px",
    "18 mm",
    "15 mm",
    "12 mm",
  ]) {
    assert.match(preview, new RegExp(label));
  }
});
