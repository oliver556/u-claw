import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FORBIDDEN_ELEMENTS = [
  "linearGradient",
  "radialGradient",
  "filter",
  "mask",
  "pattern",
  "clipPath",
  "image",
  "text",
];
const FORBIDDEN_ATTRIBUTES = ["opacity", "style", "class", "transform"];

function getAttribute(attributes, name) {
  const match = attributes.match(
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, "i"),
  );
  return match?.[2];
}

function hasAttribute(markup, names) {
  const attribute = new RegExp(`\\s(?:${names.join("|")})\\s*=`, "i");
  return [...markup.matchAll(/<[^!?/][^>]*>/g)].some(([tag]) =>
    attribute.test(tag),
  );
}

export function validateSvg(svg, source = "SVG") {
  const errors = [];
  const root = svg.match(/<svg\b([^>]*)>/i);
  const rootAttributes = root?.[1] ?? "";
  const paths = [...svg.matchAll(/<path\b([^>]*)>/gi)].map(
    (match) => match[1],
  );

  if (!root) {
    errors.push(`${source}: root svg is required`);
  } else if (getAttribute(rootAttributes, "viewBox") !== "0 0 512 512") {
    errors.push(`${source}: root viewBox must be 0 0 512 512`);
  }

  if (
    getAttribute(rootAttributes, "width") !== undefined ||
    getAttribute(rootAttributes, "height") !== undefined
  ) {
    errors.push(`${source}: root svg must not define width or height`);
  }

  const hasIcon = [...svg.matchAll(/<g\b([^>]*)>/gi)].some(
    (match) => getAttribute(match[1], "id") === "icon",
  );
  if (!hasIcon) {
    errors.push(`${source}: concept must contain g#icon`);
  }

  if (paths.length !== 1) {
    errors.push(`${source}: concept must contain exactly one path`);
  }

  if (hasAttribute(svg, ["stroke"])) {
    errors.push(`${source}: strokes are forbidden`);
  }

  if (paths.some((attributes) => getAttribute(attributes, "fill") !== "#111111")) {
    errors.push(`${source}: concept fill must be #111111`);
  }

  const pathData = paths.map((attributes) => getAttribute(attributes, "d") ?? "");
  if (pathData.some((data) => !/[Zz]\s*$/.test(data))) {
    errors.push(`${source}: silhouette path must end with Z`);
  }

  const forbiddenTag = new RegExp(
    `<\\s*(?:${FORBIDDEN_ELEMENTS.join("|")})\\b`,
    "i",
  );
  if (forbiddenTag.test(svg)) {
    errors.push(
      `${source}: gradients, filters, masks, patterns, clips, images, and text are forbidden`,
    );
  }

  if (hasAttribute(svg, FORBIDDEN_ATTRIBUTES)) {
    errors.push(
      `${source}: opacity, style, class, and transform attributes are forbidden`,
    );
  }

  if (pathData.some((data) => (data.match(/[Mm]/g) ?? []).length !== 1)) {
    errors.push(`${source}: silhouette must contain one continuous contour`);
  }

  return errors;
}

export function validateFile(file) {
  const result = spawnSync("/usr/bin/xmllint", ["--noout", file], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "unknown error").trim();
    return [`${file}: malformed XML: ${detail}`];
  }

  return validateSvg(readFileSync(file, "utf8"), file);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const files = process.argv.slice(2);

  if (files.length === 0) {
    console.error("Usage: node logos/validate.mjs <concept.svg> [...]");
    process.exitCode = 2;
  } else {
    const errors = files.flatMap(validateFile);

    if (errors.length > 0) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
    } else {
      console.log(`Validated ${files.length} SVG concept(s).`);
    }
  }
}
