import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";

const schemaUrl = new URL("../packaging/runtime-manifest.schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, "utf8"));
const validateSchema = new Ajv2020({ allErrors: true }).compile(schema);

const invalidWindowsCharacters = /[<>:"|?*\u0000-\u001f\u007f]/u;
const windowsDeviceName = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;

function schemaErrorFields(errors) {
  return [...new Set(errors.map((error) => {
    const path = error.instancePath.replaceAll("/", ".").replace(/^\./u, "");
    if (error.keyword === "required") return error.params.missingProperty;
    if (error.keyword === "additionalProperties") return error.params.additionalProperty;
    return path || "manifest";
  }))];
}

export function isSafeWindowsRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 32767) return false;
  if (value.startsWith("/") || value.startsWith("\\") || invalidWindowsCharacters.test(value)) return false;

  const segments = value.replaceAll("\\", "/").split("/");
  return segments.every((segment) => {
    if (segment.length === 0 || segment === "." || segment === "..") return false;
    if (segment.endsWith(".") || segment.endsWith(" ")) return false;
    const baseName = segment.split(".", 1)[0];
    return !windowsDeviceName.test(baseName);
  });
}

export function validateRuntimeManifest(value) {
  if (!validateSchema(value)) {
    const fields = schemaErrorFields(validateSchema.errors ?? []);
    const hasUnexpected = (validateSchema.errors ?? []).some(
      (error) => error.keyword === "additionalProperties",
    );
    throw new Error(
      hasUnexpected
        ? `${fields.join(", ")}: unexpected field`
        : `invalid runtime manifest: ${fields.join(", ")}`,
    );
  }
  for (const field of ["runtimeArchive", "entrypoint"]) {
    if (!isSafeWindowsRelativePath(value[field])) {
      throw new Error(`${field}: unsafe Windows relative path`);
    }
  }
  if (value.entryArgs.some((argument) => argument.includes("\0"))) {
    throw new Error("entryArgs: NUL is forbidden");
  }
  return value;
}
