import { z } from "zod";

export const RuntimeTargetSchema = z.enum(["win-x64", "macos-arm64"]);
export type RuntimeTarget = z.infer<typeof RuntimeTargetSchema>;

export const TargetPlatformSchema = z.enum(["win32", "darwin"]);
export type TargetPlatform = z.infer<typeof TargetPlatformSchema>;

export const TargetArchSchema = z.enum(["x64", "arm64"]);
export type TargetArch = z.infer<typeof TargetArchSchema>;

export const RuntimeTargetDetails = {
  "win-x64": { platform: "win32", arch: "x64" },
  "macos-arm64": { platform: "darwin", arch: "arm64" },
} as const satisfies Record<RuntimeTarget, { platform: TargetPlatform; arch: TargetArch }>;

export function runtimeTargetForPlatformArch(platform: TargetPlatform, arch: TargetArch): RuntimeTarget | undefined {
  return (Object.entries(RuntimeTargetDetails) as Array<[RuntimeTarget, { platform: TargetPlatform; arch: TargetArch }]>)
    .find(([, target]) => target.platform === platform && target.arch === arch)?.[0];
}

export function refineRuntimeTargetTriple(
  value: { target?: RuntimeTarget; platform: TargetPlatform; arch: TargetArch },
  context: z.RefinementCtx,
): void {
  const inferred = runtimeTargetForPlatformArch(value.platform, value.arch);
  if (!inferred) {
    context.addIssue({ code: "custom", path: ["target"], message: "unsupported runtime target" });
    return;
  }
  if (value.target !== undefined && value.target !== inferred) {
    context.addIssue({ code: "custom", path: ["target"], message: "target must match platform and arch" });
  }
}

export const RuntimeReleaseCompatibilitySchema = z.object({
  target: RuntimeTargetSchema.optional(),
  platform: TargetPlatformSchema,
  arch: TargetArchSchema,
  runtimeId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
}).strict().superRefine(refineRuntimeTargetTriple);
export type RuntimeReleaseCompatibility = z.infer<typeof RuntimeReleaseCompatibilitySchema>;
