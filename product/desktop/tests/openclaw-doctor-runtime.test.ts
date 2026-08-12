import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createOpenClawDoctorRuntime } from "../src/diagnostics/openclaw-doctor-runtime.js";

async function fixture(body: string) {
  const root = await mkdtemp(join(tmpdir(), "uclaw-doctor-runtime-"));
  const stateDir = join(root, "data", ".openclaw");
  await mkdir(stateDir, { recursive: true });
  const entrypoint = join(root, "openclaw.mjs");
  await writeFile(entrypoint, body);
  return { root, stateDir, entrypoint };
}

describe("OpenClaw Doctor CLI runtime", () => {
  it("projects exit-one lint JSON without exposing messages or paths", async () => {
    const setup = await fixture(`console.log(JSON.stringify({ ok: false, checksRun: 2, checksSkipped: 0, findings: [
      { checkId: "core/doctor/gateway-health", severity: "error", message: "token=secret /Users/alice" },
      { checkId: "core/doctor/security", severity: "warning", message: "Bearer private" }
    ] })); process.exit(1);`);
    const doctor = createOpenClawDoctorRuntime({ executable: process.execPath, entrypoint: setup.entrypoint, stateDir: setup.stateDir });
    const result = await doctor();
    expect(result).toEqual({ status: "issues", checks: [
      { id: "core/doctor/gateway-health", title: "Gateway 健康", severity: "error", status: "fail", summary: "OpenClaw Doctor 检查未通过。", repair: { actionId: "gateway-restart", label: "重启 Managed Gateway" } },
      { id: "core/doctor/security", title: "OpenClaw 安全", severity: "warning", status: "warn", summary: "OpenClaw Doctor 检查需要注意。" },
    ] });
    expect(JSON.stringify(result)).not.toMatch(/secret|Users|Bearer|alice/);
  });

  it("fails closed for invalid output", async () => {
    const setup = await fixture(`console.log("not-json");`);
    const doctor = createOpenClawDoctorRuntime({ executable: process.execPath, entrypoint: setup.entrypoint, stateDir: setup.stateDir });
    await expect(doctor()).rejects.toThrow("OpenClaw Doctor output is invalid.");
  });
});
