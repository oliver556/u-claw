export type StartupMode = "normal" | "activation-only";

const STARTUP_MODE_ARGUMENT = "--uclaw-startup-mode=";
const STARTUP_MODES = new Set<StartupMode>(["normal", "activation-only"]);

export function parseStartupMode(argv: readonly string[]): StartupMode {
  const argumentsForMode = argv.filter((argument) => argument.startsWith("--uclaw-startup-mode"));
  if (argumentsForMode.length === 0) {
    throw new Error("Launcher startup mode is missing.");
  }
  if (argumentsForMode.length !== 1) {
    throw new Error("Launcher startup mode must be provided exactly once.");
  }

  const argument = argumentsForMode[0]!;
  if (!argument.startsWith(STARTUP_MODE_ARGUMENT)) {
    throw new Error("Launcher startup mode argument is invalid.");
  }
  const mode = argument.slice(STARTUP_MODE_ARGUMENT.length);
  if (!STARTUP_MODES.has(mode as StartupMode)) {
    throw new Error("Launcher startup mode is invalid.");
  }
  return mode as StartupMode;
}
