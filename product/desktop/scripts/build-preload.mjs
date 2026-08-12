import { build } from "esbuild";
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
    "@uclaw/shared/dist/automation.js": fileURLToPath(new URL("../../shared/dist/automation.js", import.meta.url)),
  },
});
