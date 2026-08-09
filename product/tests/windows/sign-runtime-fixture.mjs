import { generateKeyPairSync } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { signRuntimeManifest } from "../../scripts/runtime-manifest.mjs";

const { values } = parseArgs({ options: {
  input: { type: "string" },
  output: { type: "string" },
  "public-key": { type: "string" },
  "trusted-keys": { type: "string" },
} });
if (!values.input || !values.output || !values["public-key"] || !values["trusted-keys"]) throw new Error("fixture signing paths are required");

const keyId = "windows-fixture-runtime";
const keys = generateKeyPairSync("ed25519");
const manifest = JSON.parse(await readFile(values.input, "utf8"));
const signed = signRuntimeManifest(manifest, {
  keyId,
  privateKey: keys.privateKey,
  signedAt: "2026-08-09T00:00:00.000Z",
  expiresAt: "2036-08-09T00:00:00.000Z",
  sequence: 1,
});
const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const publicRaw = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
await writeFile(values.output, `${JSON.stringify(signed, null, 2)}\n`, { flag: "wx" });
await writeFile(values["public-key"], publicPem, { flag: "wx", mode: 0o600 });
await writeFile(values["trusted-keys"], JSON.stringify({ [keyId]: publicRaw }), { flag: "wx", mode: 0o600 });
