import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateFile, validateSvg } from "./validate.mjs";

const CLI = fileURLToPath(new URL("./validate.mjs", import.meta.url));
const VALID_SVG = `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <g id="icon">
      <path fill="#111111" d="M100 100 L412 100 L256 412 Z" />
    </g>
  </svg>
`;

function createTempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), "u-claw-svg-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("accepts a production-safe SVG concept", () => {
  assert.deepEqual(validateSvg(VALID_SVG, "valid.svg"), []);
});

for (const [name, namespace] of [
  ["missing", ""],
  ["wrong", "https://example.com/not-svg"],
]) {
  test(`rejects a ${name} SVG namespace`, () => {
    const declaration = namespace === "" ? "" : ` xmlns="${namespace}"`;
    const svg = VALID_SVG.replace(' xmlns="http://www.w3.org/2000/svg"', declaration);

    assert.deepEqual(validateSvg(svg, `${name}-namespace.svg`), [
      `${name}-namespace.svg: root svg namespace must be http://www.w3.org/2000/svg`,
    ]);
  });
}

for (const attribute of [
  'onload="alert(1)"',
  'onclick="alert(1)"',
  'href="https://example.com/logo.svg"',
  'xml:base="https://example.com/"',
]) {
  test(`rejects active SVG attribute ${attribute.split("=")[0]}`, () => {
    const svg = VALID_SVG.replace("<svg ", `<svg ${attribute} `);

    assert.deepEqual(validateSvg(svg, "active-attribute.svg"), [
      "active-attribute.svg: event, href, and xml:base attributes are forbidden",
    ]);
  });
}

test("rejects xlink:href attributes", () => {
  const svg = VALID_SVG.replace(
    "<svg ",
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://example.com/logo.svg" ',
  );

  assert.deepEqual(validateSvg(svg, "xlink.svg"), [
    "xlink.svg: event, href, and xml:base attributes are forbidden",
  ]);
});

test("rejects xml-stylesheet processing instructions", () => {
  const svg = `<?xml-stylesheet type="text/css" href="https://example.invalid/logo.css"?>${VALID_SVG}`;

  assert.deepEqual(validateSvg(svg, "stylesheet.svg"), [
    "stylesheet.svg: processing instructions and DOCTYPE are forbidden",
  ]);
});

for (const [name, declaration] of [
  ["external", '<!DOCTYPE svg SYSTEM "https://example.invalid/logo.dtd">'],
  ["internal", '<!DOCTYPE svg [<!ENTITY mark "U Claw">]>'],
]) {
  test(`rejects ${name} DOCTYPE declarations`, () => {
    assert.deepEqual(validateSvg(`${declaration}${VALID_SVG}`, `${name}-doctype.svg`), [
      `${name}-doctype.svg: processing instructions and DOCTYPE are forbidden`,
    ]);
  });
}

test("requires svg to be the document root", () => {
  const svg = `
    <root>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
        <g id="icon">
          <path fill="#111111" d="M100 100 L412 100 L256 412 Z" />
        </g>
      </svg>
    </root>
  `;

  assert.deepEqual(validateSvg(svg, "wrapped.svg"), [
    "wrapped.svg: root svg is required",
  ]);
});

test("does not report root svg dimensions on a wrapping element", () => {
  const svg = `
    <root width="512">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
        <g id="icon">
          <path fill="#111111" d="M100 100 L412 100 L256 412 Z" />
        </g>
      </svg>
    </root>
  `;

  assert.deepEqual(validateSvg(svg, "wrapped-width.svg"), [
    "wrapped-width.svg: root svg is required",
  ]);
});

test("accepts path data split across lines", () => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
      <g id="icon">
        <path fill="#111111" d="M100 100 L412 100 L256 412
          Z" />
      </g>
    </svg>
  `;

  assert.deepEqual(validateSvg(svg, "multiline.svg"), []);
});

test("requires the path to be a direct child of g#icon", () => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
      <g id="icon" />
      <path fill="#111111" d="M100 100 L412 100 L256 412 Z" />
    </svg>
  `;

  assert.deepEqual(validateSvg(svg, "outside.svg"), [
    "outside.svg: concept structure must be svg > g#icon > path",
  ]);
});

for (const element of ["rect", "style"]) {
  test(`rejects an extra ${element} element`, () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
        <g id="icon">
          <path fill="#111111" d="M100 100 L412 100 L256 412 Z" />
          <${element} />
        </g>
      </svg>
    `;

    assert.deepEqual(validateSvg(svg, `extra-${element}.svg`), [
      `extra-${element}.svg: only svg, g, and path elements are allowed`,
    ]);
  });
}

test("detects forbidden attributes after a quoted greater-than sign", () => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" data-note=">" opacity="0.5">
      <g id="icon">
        <path fill="#111111" d="M100 100 L412 100 L256 412 Z" />
      </g>
    </svg>
  `;

  assert.deepEqual(validateSvg(svg, "quoted.svg"), [
    "quoted.svg: opacity, style, class, and transform attributes are forbidden",
  ]);
});

test("ignores fake path and g#icon markup in comments", () => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
      <!-- <g id="icon"><path fill="#111111" d="M0 0 Z" /></g> -->
    </svg>
  `;

  assert.deepEqual(validateSvg(svg, "comment.svg"), [
    "comment.svg: concept must contain g#icon",
    "comment.svg: concept must contain exactly one path",
  ]);
});

test("rejects uppercase SVG root element", () => {
  const svg = VALID_SVG.replace("<svg", "<SVG").replace("</svg>", "</SVG>");

  assert.deepEqual(validateSvg(svg, "uppercase-root.svg"), [
    "uppercase-root.svg: root svg is required",
  ]);
});

test("rejects uppercase VIEWBOX attribute", () => {
  const svg = VALID_SVG.replace("viewBox", "VIEWBOX");

  assert.deepEqual(validateSvg(svg, "uppercase-viewbox.svg"), [
    "uppercase-viewbox.svg: root viewBox must be 0 0 512 512",
  ]);
});

test("rejects uppercase G and ID names", () => {
  const svg = VALID_SVG.replace("<g id=", "<G ID=").replace("</g>", "</G>");

  assert.deepEqual(validateSvg(svg, "uppercase-group.svg"), [
    "uppercase-group.svg: concept must contain g#icon",
    "uppercase-group.svg: only svg, g, and path elements are allowed",
  ]);
});

test("reports structural and silhouette violations in contract order", () => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" stroke="none">
      <g id="icon">
        <path fill="#ffffff" d="M0 0 L10 10" />
        <path fill="#111111" d="M20 20 Z" />
      </g>
    </svg>
  `;

  assert.deepEqual(validateSvg(svg, "invalid.svg"), [
    "invalid.svg: root svg must not define width or height",
    "invalid.svg: concept must contain exactly one path",
    "invalid.svg: strokes are forbidden",
    "invalid.svg: concept fill must be #111111",
    "invalid.svg: silhouette path must end with Z",
  ]);
});

test("reports an open path after the first path", () => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
      <g id="icon">
        <path fill="#111111" d="M0 0 Z" />
        <path fill="#111111" d="M10 10 L20 20" />
      </g>
    </svg>
  `;

  assert.deepEqual(validateSvg(svg, "later-open.svg"), [
    "later-open.svg: concept must contain exactly one path",
    "later-open.svg: silhouette path must end with Z",
  ]);
});

test("reports multiple contours in a path after the first path", () => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
      <g id="icon">
        <path fill="#111111" d="M0 0 Z" />
        <path fill="#111111" d="M10 10 Z M20 20 Z" />
      </g>
    </svg>
  `;

  assert.deepEqual(validateSvg(svg, "later-contour.svg"), [
    "later-contour.svg: concept must contain exactly one path",
    "later-contour.svg: silhouette must contain one continuous contour",
  ]);
});

test("reports forbidden effects and multiple contours in contract order", () => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
      <linearGradient id="shade" />
      <g id="icon" opacity="0.8">
        <path fill="#111111" d="M0 0 L10 10 Z M20 20 L30 30 Z" />
      </g>
    </svg>
  `;

  assert.deepEqual(validateSvg(svg, "invalid-effects.svg"), [
    "invalid-effects.svg: gradients, filters, masks, patterns, clips, images, and text are forbidden",
    "invalid-effects.svg: opacity, style, class, and transform attributes are forbidden",
    "invalid-effects.svg: silhouette must contain one continuous contour",
  ]);
});

test("validateFile accepts a valid SVG", (t) => {
  const file = join(createTempDir(t), "valid.svg");
  writeFileSync(file, VALID_SVG);

  assert.deepEqual(validateFile(file), []);
});

test("validateFile returns only malformed XML errors", (t) => {
  const file = join(createTempDir(t), "malformed.svg");
  writeFileSync(
    file,
    `<svg viewBox="wrong" width="512"><rect opacity="0.5"></svg>`,
  );

  const errors = validateFile(file);
  assert.equal(errors.length, 1);
  assert.match(errors[0], new RegExp(`^${file}: malformed XML: `));
  assert.doesNotMatch(errors[0], /viewBox must|width or height|forbidden/);
});

test("CLI validates a valid file", (t) => {
  const file = join(createTempDir(t), "valid.svg");
  writeFileSync(file, VALID_SVG);

  const result = spawnSync(process.execPath, [CLI, file], { encoding: "utf8" });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "Validated 1 SVG concept(s).\n");
  assert.equal(result.stderr, "");
});

test("CLI reports usage when no files are provided", () => {
  const result = spawnSync(process.execPath, [CLI], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Usage: node logos/validate.mjs <concept.svg> [...]\n",
  );
});

test("CLI reports semantic validation errors", (t) => {
  const file = join(createTempDir(t), "invalid.svg");
  writeFileSync(file, VALID_SVG.replace("<svg ", '<svg width="512" '));

  const result = spawnSync(process.execPath, [CLI, file], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    `${file}: root svg must not define width or height\n`,
  );
});

test("CLI reports only malformed XML errors", (t) => {
  const file = join(createTempDir(t), "malformed.svg");
  writeFileSync(
    file,
    `<svg viewBox="wrong" width="512"><rect opacity="0.5"></svg>`,
  );

  const result = spawnSync(process.execPath, [CLI, file], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.startsWith(`${file}: malformed XML: `));
  assert.doesNotMatch(
    result.stderr,
    /root viewBox must|width or height|attributes are forbidden/,
  );
});

test("CLI aggregates errors from multiple files", (t) => {
  const directory = createTempDir(t);
  const first = join(directory, "first.svg");
  const second = join(directory, "second.svg");
  writeFileSync(first, VALID_SVG.replace("<svg ", '<svg width="512" '));
  writeFileSync(second, VALID_SVG.replace("<g id=", '<g opacity="0.5" id='));

  const result = spawnSync(process.execPath, [CLI, first, second], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    `${first}: root svg must not define width or height\n${second}: opacity, style, class, and transform attributes are forbidden\n`,
  );
});
