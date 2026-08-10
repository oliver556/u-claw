# U Claw Logo Concepts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce four distinct, production-constrained U Claw lobster silhouette concepts, a comparison preview, and automated SVG contract checks so the user can select one direction for refinement.

**Architecture:** Keep all concept work isolated under `logos/`. A dependency-free Node validator enforces the machine-checkable SVG contract, while `/usr/bin/xmllint` verifies XML structure. Four independent concept files share one approved brief but explore different outer-contour proportions; a self-contained HTML page presents identical application tests for fair visual comparison.

**Tech Stack:** SVG, HTML/CSS, Node.js 24 built-in test runner, `/usr/bin/xmllint`, `logo-designer` skill.

---

## File Map

- Create: `logos/validate.mjs` — validates one-path, one-color, self-contained concept SVGs and exposes a CLI.
- Create: `logos/validate.test.mjs` — unit tests valid and invalid SVG contracts.
- Create: `logos/concepts/concept-1-compact.svg` — compact, near-circular lobster silhouette.
- Create: `logos/concepts/concept-2-wide-claw.svg` — horizontally assertive lobster silhouette.
- Create: `logos/concepts/concept-3-long-body.svg` — vertically clear full-lobster silhouette.
- Create: `logos/concepts/concept-4-shield.svg` — condensed, shield-like lobster silhouette.
- Create: `logos/preview.html` — side-by-side concept, metal, inverse, and small-size comparisons.
- Create: `logos/preview.test.mjs` — checks that the preview contains every concept and required application state.

Do not modify the current app icon, product code, packaging files, or any unrelated dirty-worktree files during this plan.

### Task 1: SVG Contract Validator

**Files:**
- Create: `logos/validate.test.mjs`
- Create: `logos/validate.mjs`

- [ ] **Step 1: Create the validator test first**

Create `logos/validate.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { validateSvg } from "./validate.mjs";

const validSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <g id="icon">
    <path fill="#111111" d="M64 256C64 128 160 64 256 64C352 64 448 128 448 256C448 384 352 448 256 448C160 448 64 384 64 256Z"/>
  </g>
</svg>`;

test("accepts one closed monochrome silhouette", () => {
  assert.deepEqual(validateSvg(validSvg, "valid.svg"), []);
});

test("rejects fixed dimensions, multiple paths, strokes, and open paths", () => {
  const invalidSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
    <g id="icon">
      <path fill="#111111" stroke="#000000" d="M20 20L40 40"/>
      <path fill="#E33B2E" d="M50 50L70 70Z"/>
    </g>
  </svg>`;

  assert.deepEqual(validateSvg(invalidSvg, "invalid.svg"), [
    "invalid.svg: root svg must not define width or height",
    "invalid.svg: concept must contain exactly one path",
    "invalid.svg: strokes are forbidden",
    "invalid.svg: concept fill must be #111111",
    "invalid.svg: silhouette path must end with Z",
  ]);
});

test("rejects multiple contours and forbidden presentation features", () => {
  const invalidSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <defs><linearGradient id="g"/></defs>
    <g id="icon" opacity="0.8">
      <path fill="#111111" d="M20 20L40 20ZM60 60L80 60Z"/>
    </g>
  </svg>`;

  assert.deepEqual(validateSvg(invalidSvg, "invalid-effects.svg"), [
    "invalid-effects.svg: gradients, filters, masks, patterns, clips, images, and text are forbidden",
    "invalid-effects.svg: opacity, style, class, and transform attributes are forbidden",
    "invalid-effects.svg: silhouette must contain one continuous contour",
  ]);
});
```

- [ ] **Step 2: Run the test and confirm the expected failure**

Run:

```bash
node --test logos/validate.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `logos/validate.mjs`.

- [ ] **Step 3: Implement the minimal validator**

Create `logos/validate.mjs`:

```js
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const forbiddenTags = /<(?:linearGradient|radialGradient|filter|mask|pattern|clipPath|image|text)\b/i;
const forbiddenAttributes = /\s(?:opacity|style|class|transform)\s*=/i;

export function validateSvg(svg, source = "SVG") {
  const errors = [];
  const rootMatch = svg.match(/<svg\b([^>]*)>/i);
  const rootAttributes = rootMatch?.[1] ?? "";
  const paths = [...svg.matchAll(/<path\b([^>]*)\/?\s*>/gi)];
  const pathAttributes = paths[0]?.[1] ?? "";
  const fills = paths.map((path) => path[1].match(/\sfill=["']([^"']+)["']/i)?.[1]);
  const d = pathAttributes.match(/\sd=["']([^"']+)["']/i)?.[1] ?? "";

  if (!rootMatch) errors.push(`${source}: missing root svg element`);
  if (!/\sviewBox=["']0 0 512 512["']/i.test(rootAttributes)) {
    errors.push(`${source}: viewBox must be 0 0 512 512`);
  }
  if (/\s(?:width|height)\s*=/i.test(rootAttributes)) {
    errors.push(`${source}: root svg must not define width or height`);
  }
  if (!/<g\b[^>]*\sid=["']icon["'][^>]*>/i.test(svg)) {
    errors.push(`${source}: missing g#icon`);
  }
  if (paths.length !== 1) {
    errors.push(`${source}: concept must contain exactly one path`);
  }
  if (/\sstroke\s*=/i.test(svg)) {
    errors.push(`${source}: strokes are forbidden`);
  }
  if (paths.length > 0 && fills.some((fill) => fill !== "#111111")) {
    errors.push(`${source}: concept fill must be #111111`);
  }
  if (paths.length > 0 && !/[zZ]\s*$/.test(d)) {
    errors.push(`${source}: silhouette path must end with Z`);
  }
  if (forbiddenTags.test(svg)) {
    errors.push(`${source}: gradients, filters, masks, patterns, clips, images, and text are forbidden`);
  }
  if (forbiddenAttributes.test(svg)) {
    errors.push(`${source}: opacity, style, class, and transform attributes are forbidden`);
  }
  if ((d.match(/[Mm]/g) ?? []).length > 1) {
    errors.push(`${source}: silhouette must contain one continuous contour`);
  }

  return errors;
}

export function validateFile(file) {
  const xml = spawnSync("/usr/bin/xmllint", ["--noout", file], { encoding: "utf8" });
  if (xml.status !== 0) {
    return [`${file}: malformed XML: ${xml.stderr.trim()}`];
  }
  return validateSvg(readFileSync(file, "utf8"), file);
}

function main(files) {
  if (files.length === 0) {
    console.error("Usage: node logos/validate.mjs <concept.svg> [...]");
    process.exitCode = 2;
    return;
  }

  const errors = files.flatMap(validateFile);
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
    return;
  }

  console.log(`Validated ${files.length} SVG concept(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
```

- [ ] **Step 4: Run tests and confirm they pass**

Run:

```bash
node --test logos/validate.test.mjs
```

Expected: 3 tests, 3 passes, 0 failures.

- [ ] **Step 5: Commit only the validator files**

```bash
git add logos/validate.mjs logos/validate.test.mjs
git commit -m "test(brand): enforce logo SVG contract"
```

### Task 2: Four Independent Lobster Silhouettes

**Files:**
- Create: `logos/concepts/concept-1-compact.svg`
- Create: `logos/concepts/concept-2-wide-claw.svg`
- Create: `logos/concepts/concept-3-long-body.svg`
- Create: `logos/concepts/concept-4-shield.svg`

- [ ] **Step 1: Create the concept directory**

Run:

```bash
mkdir -p logos/concepts
```

Expected: `logos/concepts/` exists and is empty.

- [ ] **Step 2: Dispatch four independent concept tasks in parallel**

Use four fresh general-purpose subagents. Give every subagent this exact common contract:

```text
Create one original U Claw logo concept as a self-contained SVG at the assigned path.

Brand: U Claw, a portable AI workspace carried on a USB drive.
Audience: client gifts and product demonstrations.
Reference principle: Apple-like strength of silhouette, Figma-like geometric discipline, Instagram-like centered balance. Do not copy any existing logo.

Visual subject: a complete lobster viewed from above and nearly symmetrical. Preserve only two claws, main body, and fan tail. Do not include the letter U, eyes, antennae, thin legs, shell lines, mechanical parts, gradients, shadows, glow, strokes, text, or internal decoration.

SVG contract:
- Root: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"> with no width or height.
- One <g id="icon"> containing exactly one <path>.
- Path fill exactly #111111; no other color.
- One continuous closed outer contour: one M/m command and a final Z/z; no holes or interior subpaths.
- No defs, image, text, use, gradient, filter, mask, pattern, clipPath, opacity, style, class, transform, or stroke.
- Keep visible geometry inside x/y 48..464 for clear space.
- Make claws and fan tail distinguishable at 32 px; preserve a strong overall silhouette at 16 px.
- Write only the requested SVG file. Do not touch other files.
```

Assign these distinct directions and paths:

```text
Agent 1 — Compact:
Path: logos/concepts/concept-1-compact.svg
Direction: near-circular overall footprint. Claws remain close to the body; body is broad; tail fan is compact. Optimize for icon and engraving recognition. Avoid shield-like corners.

Agent 2 — Wide Claw:
Path: logos/concepts/concept-2-wide-claw.svg
Direction: visibly wider horizontal footprint. Claws open outward and carry the silhouette; body and tail stay compact. Optimize for a strong horizontal lockup without resembling a crab.

Agent 3 — Long Body:
Path: logos/concepts/concept-3-long-body.svg
Direction: clearly vertical lobster anatomy. Elongated body and readable tail fan balance moderate claws. Optimize for immediate full-lobster recognition without adding legs or antennae.

Agent 4 — Shield:
Path: logos/concepts/concept-4-shield.svg
Direction: condensed, premium, shield-like footprint formed only by lobster anatomy. Claws define upper shoulders; tail closes the lower point. It must still read as a lobster, not a generic shield or beetle.
```

Expected: four meaningfully different SVG outer contours, each at its assigned path.

- [ ] **Step 3: Run automated XML and contract validation**

Run:

```bash
node logos/validate.mjs \
  logos/concepts/concept-1-compact.svg \
  logos/concepts/concept-2-wide-claw.svg \
  logos/concepts/concept-3-long-body.svg \
  logos/concepts/concept-4-shield.svg
```

Expected: `Validated 4 SVG concept(s).`

- [ ] **Step 4: Review and fix contract failures without changing another concept**

For any failing concept, return only that file to its assigned agent with the exact validator errors. Rerun Step 3 after every fix. Do not relax `logos/validate.mjs` to accommodate a concept.

- [ ] **Step 5: Commit the four validated concepts**

```bash
git add \
  logos/concepts/concept-1-compact.svg \
  logos/concepts/concept-2-wide-claw.svg \
  logos/concepts/concept-3-long-body.svg \
  logos/concepts/concept-4-shield.svg
git commit -m "feat(brand): add U Claw logo concepts"
```

### Task 3: Comparison Preview

**Files:**
- Create: `logos/preview.test.mjs`
- Create: `logos/preview.html`

- [ ] **Step 1: Create the preview contract test**

Create `logos/preview.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const previewPath = new URL("./preview.html", import.meta.url);

test("preview includes every concept and application check", () => {
  const html = readFileSync(previewPath, "utf8");
  const concepts = [
    "concept-1-compact.svg",
    "concept-2-wide-claw.svg",
    "concept-3-long-body.svg",
    "concept-4-shield.svg",
  ];

  for (const concept of concepts) {
    assert.match(html, new RegExp(`concepts/${concept.replace(".", "\\.")}`, "g"));
  }

  for (const label of ["White", "Black", "Silver metal", "Black metal", "64 px", "32 px", "16 px", "18 mm", "15 mm", "12 mm"]) {
    assert.match(html, new RegExp(label));
  }
});
```

- [ ] **Step 2: Run the test and confirm the expected failure**

Run:

```bash
node --test logos/preview.test.mjs
```

Expected: FAIL with `ENOENT` for `logos/preview.html`.

- [ ] **Step 3: Create the self-contained comparison page**

Create `logos/preview.html` with this complete structure. Keep each concept's states identical so differences come only from the SVG silhouette.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>U Claw Logo Concepts</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #f4f5f7; color: #15171a; font-family: Arial, Helvetica, sans-serif; }
  header { padding: 28px 32px 22px; background: #fff; border-bottom: 1px solid #dfe2e6; }
  h1 { margin: 0; font-size: 26px; letter-spacing: 0; }
  header p { margin: 8px 0 0; color: #62676f; }
  main { padding: 28px 32px 40px; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
  .concept { background: #fff; border: 1px solid #d9dde2; border-radius: 6px; overflow: hidden; }
  .concept > h2 { margin: 0; padding: 16px 18px; font-size: 17px; border-bottom: 1px solid #e4e7eb; }
  .states { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .state { min-height: 230px; display: grid; place-items: center; position: relative; padding: 34px 20px 24px; }
  .state span { position: absolute; top: 12px; left: 14px; font-size: 12px; color: #727780; }
  .state img { width: 144px; height: 144px; object-fit: contain; }
  .white { background: #fff; }
  .black { background: #111; }
  .black span, .black-metal span { color: #aeb3ba; }
  .black img, .black-metal img { filter: invert(1); }
  .silver { background: linear-gradient(135deg, #f8f9fa, #b9bec4 48%, #eef0f2); }
  .black-metal { background: linear-gradient(135deg, #2c2f33, #08090a 55%, #35383c); }
  .lockup { display: flex; align-items: center; gap: 14px; }
  .lockup img { width: 76px; height: 76px; }
  .wordmark { font-size: 27px; font-weight: 600; letter-spacing: 0; white-space: nowrap; }
  .black-metal .wordmark { color: #fff; }
  .sizes { display: flex; align-items: end; justify-content: center; gap: 24px; padding: 18px; border-top: 1px solid #e4e7eb; }
  .size { display: grid; justify-items: center; gap: 7px; font-size: 12px; color: #727780; }
  .size img { display: block; object-fit: contain; }
  .laser { margin-top: 24px; background: #fff; border: 1px solid #d9dde2; border-radius: 6px; padding: 20px; }
  .laser h2 { margin: 0 0 6px; font-size: 18px; }
  .laser > p { margin: 0 0 20px; color: #62676f; }
  .laser-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
  .laser-row { display: flex; align-items: end; justify-content: space-between; gap: 18px; padding: 16px; background: linear-gradient(135deg, #f8f9fa, #b9bec4 48%, #eef0f2); }
  .laser-row strong { align-self: center; min-width: 88px; font-size: 13px; }
  .laser-size { display: grid; justify-items: center; gap: 6px; font-size: 11px; color: #5f656d; }
  .laser-size img { display: block; object-fit: contain; }
  @media (max-width: 850px) { main, header { padding-left: 16px; padding-right: 16px; } .grid { grid-template-columns: 1fr; } }
  @media (max-width: 520px) { .states, .laser-grid { grid-template-columns: 1fr; } .state { min-height: 210px; } }
</style>
</head>
<body>
<header>
  <h1>U Claw Logo Concepts</h1>
  <p>Compare silhouette only. Wordmark shown for proportion, not final typography.</p>
</header>
<main>
  <div class="grid">
    <article class="concept" data-concept="1">
      <h2>01 Compact</h2>
      <div class="states">
        <div class="state white"><span>White</span><img src="concepts/concept-1-compact.svg" alt="Compact logo on white"></div>
        <div class="state black"><span>Black</span><img src="concepts/concept-1-compact.svg" alt="Compact logo reversed on black"></div>
        <div class="state silver"><span>Silver metal</span><div class="lockup"><img src="concepts/concept-1-compact.svg" alt="Compact logo on silver metal"><b class="wordmark">U Claw</b></div></div>
        <div class="state black-metal"><span>Black metal</span><div class="lockup"><img src="concepts/concept-1-compact.svg" alt="Compact logo on black metal"><b class="wordmark">U Claw</b></div></div>
      </div>
      <div class="sizes"><div class="size"><img src="concepts/concept-1-compact.svg" width="64" height="64"><span>64 px</span></div><div class="size"><img src="concepts/concept-1-compact.svg" width="32" height="32"><span>32 px</span></div><div class="size"><img src="concepts/concept-1-compact.svg" width="16" height="16"><span>16 px</span></div></div>
    </article>
    <article class="concept" data-concept="2">
      <h2>02 Wide Claw</h2>
      <div class="states">
        <div class="state white"><span>White</span><img src="concepts/concept-2-wide-claw.svg" alt="Wide claw logo on white"></div>
        <div class="state black"><span>Black</span><img src="concepts/concept-2-wide-claw.svg" alt="Wide claw logo reversed on black"></div>
        <div class="state silver"><span>Silver metal</span><div class="lockup"><img src="concepts/concept-2-wide-claw.svg" alt="Wide claw logo on silver metal"><b class="wordmark">U Claw</b></div></div>
        <div class="state black-metal"><span>Black metal</span><div class="lockup"><img src="concepts/concept-2-wide-claw.svg" alt="Wide claw logo on black metal"><b class="wordmark">U Claw</b></div></div>
      </div>
      <div class="sizes"><div class="size"><img src="concepts/concept-2-wide-claw.svg" width="64" height="64"><span>64 px</span></div><div class="size"><img src="concepts/concept-2-wide-claw.svg" width="32" height="32"><span>32 px</span></div><div class="size"><img src="concepts/concept-2-wide-claw.svg" width="16" height="16"><span>16 px</span></div></div>
    </article>
    <article class="concept" data-concept="3">
      <h2>03 Long Body</h2>
      <div class="states">
        <div class="state white"><span>White</span><img src="concepts/concept-3-long-body.svg" alt="Long body logo on white"></div>
        <div class="state black"><span>Black</span><img src="concepts/concept-3-long-body.svg" alt="Long body logo reversed on black"></div>
        <div class="state silver"><span>Silver metal</span><div class="lockup"><img src="concepts/concept-3-long-body.svg" alt="Long body logo on silver metal"><b class="wordmark">U Claw</b></div></div>
        <div class="state black-metal"><span>Black metal</span><div class="lockup"><img src="concepts/concept-3-long-body.svg" alt="Long body logo on black metal"><b class="wordmark">U Claw</b></div></div>
      </div>
      <div class="sizes"><div class="size"><img src="concepts/concept-3-long-body.svg" width="64" height="64"><span>64 px</span></div><div class="size"><img src="concepts/concept-3-long-body.svg" width="32" height="32"><span>32 px</span></div><div class="size"><img src="concepts/concept-3-long-body.svg" width="16" height="16"><span>16 px</span></div></div>
    </article>
    <article class="concept" data-concept="4">
      <h2>04 Shield</h2>
      <div class="states">
        <div class="state white"><span>White</span><img src="concepts/concept-4-shield.svg" alt="Shield logo on white"></div>
        <div class="state black"><span>Black</span><img src="concepts/concept-4-shield.svg" alt="Shield logo reversed on black"></div>
        <div class="state silver"><span>Silver metal</span><div class="lockup"><img src="concepts/concept-4-shield.svg" alt="Shield logo on silver metal"><b class="wordmark">U Claw</b></div></div>
        <div class="state black-metal"><span>Black metal</span><div class="lockup"><img src="concepts/concept-4-shield.svg" alt="Shield logo on black metal"><b class="wordmark">U Claw</b></div></div>
      </div>
      <div class="sizes"><div class="size"><img src="concepts/concept-4-shield.svg" width="64" height="64"><span>64 px</span></div><div class="size"><img src="concepts/concept-4-shield.svg" width="32" height="32"><span>32 px</span></div><div class="size"><img src="concepts/concept-4-shield.svg" width="16" height="16"><span>16 px</span></div></div>
    </article>
  </div>
  <section class="laser">
    <h2>Laser size simulation</h2>
    <p>Physical CSS units are a comparison aid. Supplier material proof remains the production authority.</p>
    <div class="laser-grid">
      <div class="laser-row"><strong>01 Compact</strong><div class="laser-size"><img src="concepts/concept-1-compact.svg" style="width:18mm;height:18mm"><span>18 mm</span></div><div class="laser-size"><img src="concepts/concept-1-compact.svg" style="width:15mm;height:15mm"><span>15 mm</span></div><div class="laser-size"><img src="concepts/concept-1-compact.svg" style="width:12mm;height:12mm"><span>12 mm</span></div></div>
      <div class="laser-row"><strong>02 Wide Claw</strong><div class="laser-size"><img src="concepts/concept-2-wide-claw.svg" style="width:18mm;height:18mm"><span>18 mm</span></div><div class="laser-size"><img src="concepts/concept-2-wide-claw.svg" style="width:15mm;height:15mm"><span>15 mm</span></div><div class="laser-size"><img src="concepts/concept-2-wide-claw.svg" style="width:12mm;height:12mm"><span>12 mm</span></div></div>
      <div class="laser-row"><strong>03 Long Body</strong><div class="laser-size"><img src="concepts/concept-3-long-body.svg" style="width:18mm;height:18mm"><span>18 mm</span></div><div class="laser-size"><img src="concepts/concept-3-long-body.svg" style="width:15mm;height:15mm"><span>15 mm</span></div><div class="laser-size"><img src="concepts/concept-3-long-body.svg" style="width:12mm;height:12mm"><span>12 mm</span></div></div>
      <div class="laser-row"><strong>04 Shield</strong><div class="laser-size"><img src="concepts/concept-4-shield.svg" style="width:18mm;height:18mm"><span>18 mm</span></div><div class="laser-size"><img src="concepts/concept-4-shield.svg" style="width:15mm;height:15mm"><span>15 mm</span></div><div class="laser-size"><img src="concepts/concept-4-shield.svg" style="width:12mm;height:12mm"><span>12 mm</span></div></div>
    </div>
  </section>
</main>
</body>
</html>
```

- [ ] **Step 4: Run preview and validator tests**

Run:

```bash
node --test logos/validate.test.mjs logos/preview.test.mjs
```

Expected: 4 tests, 4 passes, 0 failures.

- [ ] **Step 5: Open the preview and inspect responsive layout**

Open `logos/preview.html` directly in the browser. Inspect desktop and mobile widths. Confirm:

- All four concepts render without missing-image icons.
- Every concept has identical white, black, silver-metal, and black-metal treatment.
- Labels and wordmarks do not overlap the marks.
- `64 / 32 / 16 px` samples retain fixed dimensions and do not shift the layout.
- `18 / 15 / 12 mm` metal simulations render for every concept; they are treated as comparison aids, not a substitute for supplier material proof.
- Mobile width stacks concept cards and application states without horizontal scrolling.

- [ ] **Step 6: Commit the preview files**

```bash
git add logos/preview.html logos/preview.test.mjs
git commit -m "feat(brand): add logo concept preview"
```

### Task 4: Final Concept-Round Verification and User Selection

**Files:**
- Verify: `logos/validate.mjs`
- Verify: `logos/validate.test.mjs`
- Verify: `logos/concepts/*.svg`
- Verify: `logos/preview.html`
- Verify: `logos/preview.test.mjs`

- [ ] **Step 1: Run the complete automated verification**

```bash
node --test logos/validate.test.mjs logos/preview.test.mjs
node logos/validate.mjs \
  logos/concepts/concept-1-compact.svg \
  logos/concepts/concept-2-wide-claw.svg \
  logos/concepts/concept-3-long-body.svg \
  logos/concepts/concept-4-shield.svg
```

Expected:

```text
4 tests, 4 passes, 0 failures
Validated 4 SVG concept(s).
```

- [ ] **Step 2: Perform visual acceptance checks against the approved spec**

For each concept, record pass/fail for these exact checks:

```text
[ ] Reads as lobster without the U Claw wordmark
[ ] Does not read primarily as crab, beetle, shield, or letter U
[ ] Two claws remain distinguishable at 32 px
[ ] Fan tail remains distinguishable at 32 px
[ ] Overall silhouette remains coherent at 16 px
[ ] Silhouette remains coherent in 18 / 15 / 12 mm metal simulations
[ ] White reverse preserves the same geometry
[ ] Silver and black metal simulations remain legible
[ ] Contains no eyes, antennae, thin legs, shell lines, mechanical parts, or internal decoration
```

Reject any concept failing the first, second, or final check before showing it to the user. Fix only that concept and rerun all verification.

- [ ] **Step 3: Present the comparison for selection**

Give the user the absolute link to `logos/preview.html` and summarize each concept in one sentence. Ask for one of these responses:

```text
1 — Compact
2 — Wide Claw
3 — Long Body
4 — Shield
Mix — name one base concept and one specific trait from another concept
Reject — state what all four get wrong
```

Stop after selection feedback. Refinement, wordmark path conversion, PNG export, app integration, laser supplier files, and packaging require the selected base concept and are outside this concept-round plan.
