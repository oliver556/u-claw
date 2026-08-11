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

const forbiddenElementTest = FORBIDDEN_ELEMENTS.map(
  (name) => `name()='${name}'`,
).join(" or ");
const forbiddenAttributeTest = FORBIDDEN_ATTRIBUTES.map(
  (name) => `name()='${name}'`,
).join(" or ");
const allowedElementTest = ["svg", "g", "path"]
  .map((name) => `name()='${name}'`)
  .join(" or ");
const normalizedAttributeName = "translate(name(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')";
const activeAttributeTest = `starts-with(${normalizedAttributeName}, 'on') or ${normalizedAttributeName}='href' or ${normalizedAttributeName}='xlink:href' or ${normalizedAttributeName}='xml:base'`;

const SUMMARY_XPATH = `concat(
  name(/*), '|',
  namespace-uri(/*), '|',
  /*/@viewBox = '0 0 512 512', '|',
  count(/*/@width | /*/@height), '|',
  count(//*[name()='g' and @id='icon']), '|',
  count(//*[name()='path']), '|',
  count(//@*[name()='stroke']), '|',
  count(//*[name()='path' and not(@fill='#111111')]), '|',
  count(//*[${forbiddenElementTest}]), '|',
  count(//@*[${forbiddenAttributeTest}]), '|',
  count(//@*[${activeAttributeTest}]), '|',
  count(//processing-instruction()), '|',
  count(//*[not(${allowedElementTest} or ${forbiddenElementTest})]), '|',
  count(//*) = 3 and
    count(/*/*) = 1 and
    name(/*/*[1]) = 'g' and
    /*/*[1]/@id = 'icon' and
    count(/*/*[1]/*) = 1 and
    name(/*/*[1]/*[1]) = 'path'
)`;

function runXPath(svg, expression) {
  const result = spawnSync("/usr/bin/xmllint", ["--nonet", "--xpath", expression, "-"], {
    encoding: "utf8",
    input: svg,
  });

  return result.status === 0 ? result.stdout.trimEnd() : null;
}

export function validateSvg(svg, source = "SVG") {
  const errors = [];
  const hasDoctype = /<!DOCTYPE\b/u.test(svg);
  const summary = runXPath(svg, SUMMARY_XPATH);
  if (summary === null) {
    return [`${source}: root svg is required`];
  }

  const [
    rootName,
    rootNamespace,
    viewBoxIsValid,
    rootSizeCount,
    iconCount,
    pathCountValue,
    strokeCount,
    invalidFillCount,
    forbiddenElementCount,
    forbiddenAttributeCount,
    activeAttributeCount,
    processingInstructionCount,
    unsupportedElementCount,
    structureIsValid,
  ] = summary.split("|");
  const pathCount = Number(pathCountValue);
  const pathData = Array.from(
    { length: pathCount },
    (_, index) =>
      runXPath(svg, `string((//*[name()='path'])[${index + 1}]/@d)`) ?? "",
  );

  if (rootName !== "svg") {
    errors.push(`${source}: root svg is required`);
  } else {
    if (rootNamespace !== "http://www.w3.org/2000/svg") {
      errors.push(`${source}: root svg namespace must be http://www.w3.org/2000/svg`);
    }
    if (viewBoxIsValid !== "true") {
      errors.push(`${source}: root viewBox must be 0 0 512 512`);
    }
  }

  if (rootName === "svg" && rootSizeCount !== "0") {
    errors.push(`${source}: root svg must not define width or height`);
  }

  if (iconCount !== "1") {
    errors.push(`${source}: concept must contain g#icon`);
  }

  if (pathCount !== 1) {
    errors.push(`${source}: concept must contain exactly one path`);
  }

  if (
    rootName === "svg" &&
    iconCount === "1" &&
    pathCount === 1 &&
    forbiddenElementCount === "0" &&
    unsupportedElementCount === "0" &&
    structureIsValid !== "true"
  ) {
    errors.push(`${source}: concept structure must be svg > g#icon > path`);
  }

  if (strokeCount !== "0") {
    errors.push(`${source}: strokes are forbidden`);
  }

  if (invalidFillCount !== "0") {
    errors.push(`${source}: concept fill must be #111111`);
  }

  if (pathData.some((data) => !/[Zz]\s*$/.test(data))) {
    errors.push(`${source}: silhouette path must end with Z`);
  }

  if (forbiddenElementCount !== "0") {
    errors.push(
      `${source}: gradients, filters, masks, patterns, clips, images, and text are forbidden`,
    );
  }

  if (forbiddenAttributeCount !== "0") {
    errors.push(
      `${source}: opacity, style, class, and transform attributes are forbidden`,
    );
  }

  if (activeAttributeCount !== "0") {
    errors.push(`${source}: event, href, and xml:base attributes are forbidden`);
  }

  if (processingInstructionCount !== "0" || hasDoctype) {
    errors.push(`${source}: processing instructions and DOCTYPE are forbidden`);
  }

  if (rootName === "svg" && unsupportedElementCount !== "0") {
    errors.push(`${source}: only svg, g, and path elements are allowed`);
  }

  if (pathData.some((data) => (data.match(/[Mm]/g) ?? []).length !== 1)) {
    errors.push(`${source}: silhouette must contain one continuous contour`);
  }

  return errors;
}

export function validateFile(file) {
  const result = spawnSync("/usr/bin/xmllint", ["--nonet", "--noout", file], {
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
