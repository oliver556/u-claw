import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";

import type { DiagnosticsService } from "@uclaw/shared";
import { z } from "zod";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const DoctorOutputSchema = z.object({
  ok: z.boolean(), checksRun: z.number().int().nonnegative(), checksSkipped: z.number().int().nonnegative(),
  findings: z.array(z.object({
    checkId: z.string().regex(/^[a-z0-9][a-z0-9/._:-]{0,127}$/),
    severity: z.enum(["info", "warning", "error"]), message: z.string(),
  }).passthrough()).max(500),
}).passthrough();

const LABELS: Record<string, string> = {
  "core/doctor/gateway-health": "Gateway 健康",
  "core/doctor/security": "OpenClaw 安全",
  "core/doctor/skills-readiness": "Skills 就绪状态",
};

export function createOpenClawDoctorRuntime(input: {
  executable: string;
  entrypoint: string;
  stateDir: string;
  baseEnvironment?: NodeJS.ProcessEnv;
}): NonNullable<DiagnosticsService["doctor"]> {
  if (![input.executable, input.entrypoint, input.stateDir].every(isAbsolute)) throw new Error("OpenClaw Doctor paths must be absolute.");
  return async (signal) => {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(input.executable, [input.entrypoint, "doctor", "--lint", "--json"], {
        env: {
          ...(input.baseEnvironment ?? process.env), ELECTRON_RUN_AS_NODE: "1",
          OPENCLAW_STATE_DIR: input.stateDir, OPENCLAW_CONFIG_PATH: join(input.stateDir, "openclaw.json"),
        },
        shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(Buffer.concat(chunks).toString("utf8"));
      };
      const abort = () => { child.kill(); finish(new DOMException("Cancelled", "AbortError")); };
      const timer = setTimeout(() => { child.kill(); finish(new DOMException("Timed out", "TimeoutError")); }, TIMEOUT_MS);
      timer.unref?.();
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_OUTPUT_BYTES) { child.kill(); finish(new Error("OpenClaw Doctor output is invalid.")); return; }
        chunks.push(chunk);
      });
      child.once("error", () => finish(new Error("OpenClaw Doctor failed to start.")));
      child.once("close", (code) => code === 0 || code === 1 ? finish() : finish(new Error("OpenClaw Doctor command failed.")));
    });
    let parsed: z.infer<typeof DoctorOutputSchema>;
    try { parsed = DoctorOutputSchema.parse(JSON.parse(output)); } catch { throw new Error("OpenClaw Doctor output is invalid."); }
    return {
      status: parsed.ok && parsed.findings.length === 0 ? "ok" : "issues",
      checks: parsed.findings.map((finding) => ({
        id: finding.checkId,
        title: LABELS[finding.checkId] ?? "OpenClaw 检查项",
        severity: finding.severity,
        status: finding.severity === "error" ? "fail" as const : finding.severity === "warning" ? "warn" as const : "pass" as const,
        summary: finding.severity === "error" ? "OpenClaw Doctor 检查未通过。" : finding.severity === "warning" ? "OpenClaw Doctor 检查需要注意。" : "OpenClaw Doctor 检查通过。",
        ...(finding.checkId === "core/doctor/gateway-health" ? { repair: { actionId: "gateway-restart" as const, label: "重启 Managed Gateway" } } : {}),
      })),
    };
  };
}
