import { build } from "esbuild";
import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: ["src/preload.ts"],
  outfile: "dist/preload.cjs",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  external: ["electron"],
  alias: {
    "@uclaw/shared": fileURLToPath(new URL("../../shared/dist/ipc.js", import.meta.url)),
    "@uclaw/shared/dist/image-operations.js": fileURLToPath(new URL("../../shared/dist/image-operations.js", import.meta.url)),
    "@uclaw/shared/dist/automation.js": fileURLToPath(new URL("../../shared/dist/automation.js", import.meta.url)),
    "@uclaw/shared/dist/task-artifacts.js": fileURLToPath(new URL("../../shared/dist/task-artifacts.js", import.meta.url)),
    "@uclaw/shared/dist/system-node.js": fileURLToPath(new URL("../../shared/dist/system-node.js", import.meta.url)),
    "@uclaw/shared/dist/system-voice.js": fileURLToPath(new URL("../../shared/dist/system-voice.js", import.meta.url)),
    "@uclaw/shared/dist/product-services.js": fileURLToPath(new URL("../../shared/dist/product-services.js", import.meta.url)),
  },
});

const extensionOutput = new URL("../dist/openclaw-extensions/uclaw-commercial-image/", import.meta.url);
await rm(extensionOutput, { recursive: true, force: true });
await cp(new URL("../../openclaw-extensions/uclaw-commercial-image/", import.meta.url), extensionOutput, { recursive: true });
