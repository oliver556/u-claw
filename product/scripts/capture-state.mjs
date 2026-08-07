import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";

export const CAPTURE_STATE_MARKER = ".uclaw-openclaw-v4-capture-state";
export const CAPTURE_STATE_MARKER_CONTENT = "uclaw-openclaw-v4-capture-state:v1\n";

function unsafeTargetError(target) {
  return new Error(`Refusing to prepare unsafe OpenClaw capture state directory: ${target}`);
}

export async function prepareCaptureStateDir(stateDir, options = {}) {
  const target = resolve(stateDir);
  const configuredHome = resolve(options.homeDir ?? homedir());
  if (target === parse(target).root || target === configuredHome) throw unsafeTargetError(target);

  let entry;
  try {
    entry = await lstat(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (entry === undefined) {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, CAPTURE_STATE_MARKER), CAPTURE_STATE_MARKER_CONTENT, { flag: "wx" });
    return;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw unsafeTargetError(target);

  const [canonicalTarget, canonicalHome] = await Promise.all([realpath(target), realpath(configuredHome).catch(() => configuredHome)]);
  if (canonicalTarget === parse(canonicalTarget).root || canonicalTarget === canonicalHome) throw unsafeTargetError(target);

  let marker;
  try {
    marker = await readFile(join(target, CAPTURE_STATE_MARKER), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Refusing to clear existing capture state without marker: ${target}`);
    throw error;
  }
  if (marker !== CAPTURE_STATE_MARKER_CONTENT) throw new Error(`Refusing to clear capture state with invalid marker: ${target}`);

  await rm(target, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(join(target, CAPTURE_STATE_MARKER), CAPTURE_STATE_MARKER_CONTENT, { flag: "wx" });
}
