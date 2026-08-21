const requiredTargets = Object.freeze({
  "win-x64": Object.freeze({ targetPlatform: "win32", targetArch: "x64" }),
  "macos-arm64": Object.freeze({ targetPlatform: "darwin", targetArch: "arm64" }),
});

function validateTarget(targetId, value) {
  const expected = requiredTargets[targetId];
  if (!expected || !value || typeof value !== "object") throw new Error(`runtime target ${targetId} is invalid`);
  if (
    value.targetPlatform !== expected.targetPlatform ||
    value.targetArch !== expected.targetArch ||
    typeof value.runtimeId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.runtimeId) ||
    typeof value.entrypoint !== "string" ||
    value.entrypoint.length === 0
  ) {
    throw new Error(`runtime target ${targetId} is invalid`);
  }
  return {
    targetPlatform: value.targetPlatform,
    targetArch: value.targetArch,
    runtimeId: value.runtimeId,
    entrypoint: value.entrypoint,
  };
}

export function runtimeTargetsFromVersions(versions) {
  if (versions?.targets === undefined) {
    return {
      "win-x64": validateTarget("win-x64", {
        targetPlatform: versions?.targetPlatform,
        targetArch: versions?.targetArch,
        runtimeId: versions?.runtimeId,
        entrypoint: "electron/electron.exe",
      }),
    };
  }

  const targets = Object.fromEntries(
    Object.keys(requiredTargets).map((targetId) => [targetId, validateTarget(targetId, versions.targets[targetId])]),
  );
  const legacy = targets["win-x64"];
  if (
    versions.runtimeId !== legacy.runtimeId ||
    versions.targetPlatform !== legacy.targetPlatform ||
    versions.targetArch !== legacy.targetArch
  ) {
    throw new Error("runtime-versions legacy win-x64 fields must match targets.win-x64");
  }
  return targets;
}

export function selectRuntimeTarget(versions, targetId = "win-x64") {
  const targets = runtimeTargetsFromVersions(versions);
  const target = targets[targetId];
  if (!target) throw new Error(`runtime target ${targetId} is not configured`);
  return target;
}
