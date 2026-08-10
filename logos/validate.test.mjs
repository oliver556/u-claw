import assert from "node:assert/strict";
import test from "node:test";

import { validateSvg } from "./validate.mjs";

test("accepts a production-safe SVG concept", () => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
      <g id="icon">
        <path fill="#111111" d="M100 100 L412 100 L256 412 Z" />
      </g>
    </svg>
  `;

  assert.deepEqual(validateSvg(svg, "valid.svg"), []);
});

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
