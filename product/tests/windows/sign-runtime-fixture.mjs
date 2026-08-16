import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { signRuntimeManifest } from "../../scripts/runtime-manifest.mjs";

const { values } = parseArgs({ options: {
  input: { type: "string" },
  output: { type: "string" },
  "public-key": { type: "string" },
  "trusted-keys": { type: "string" },
  "private-key": { type: "string" },
  sequence: { type: "string", default: "1" },
} });
if (!values.input || !values.output || !values["public-key"] || !values["trusted-keys"]) throw new Error("fixture signing paths are required");

const keyId = "windows-fixture-runtime";
let privateKey;
if (values["private-key"]) {
  try {
    privateKey = await readFile(values["private-key"], "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const generated = generateKeyPairSync("ed25519");
    privateKey = generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await writeFile(values["private-key"], privateKey, { flag: "wx", mode: 0o600 });
  }
} else {
  privateKey = generateKeyPairSync("ed25519").privateKey;
}
const publicKey = createPublicKey(privateKey);
const sequence = Number(values.sequence);
const manifest = JSON.parse(await readFile(values.input, "utf8"));
const signed = signRuntimeManifest(manifest, {
  keyId,
  privateKey,
  signedAt: "2026-08-09T00:00:00.000Z",
  expiresAt: "2036-08-09T00:00:00.000Z",
  sequence,
});
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const publicRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
await writeFile(values.output, `${JSON.stringify(signed, null, 2)}\n`, { flag: "wx" });
await writeFile(values["public-key"], publicPem, { flag: "wx", mode: 0o600 });
await writeFile(values["trusted-keys"], JSON.stringify({ [keyId]: publicRaw }), { flag: "wx", mode: 0o600 });
