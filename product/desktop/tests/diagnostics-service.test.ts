import { link, mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDiagnosticsService } from "../src/diagnostics/diagnostics-service.js";
import { LOG_OWNERSHIP_MANIFEST } from "../src/portable-paths.js";

const logEntry = (id: string, timestamp = "2026-08-09T01:00:00.000Z", level: "debug" | "info" | "warning" | "error" = "info") => ({
  id, timestamp, level, source: "desktop" as const,
  message: "Authorization: Bearer upstream-secret private conversation",
});

function diagnostics(pages: Array<{ items: ReturnType<typeof logEntry>[]; nextCursor: string | null; hasMore: boolean }> = [{ items: [logEntry("upstream-1")], nextCursor: null, hasMore: false }]) {
  let index = 0;
  return { list: async () => [], listLogs: async () => pages[Math.min(index++, pages.length - 1)]! };
}

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "uclaw-diagnostics-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const logsDir = join(dataDir, "diagnostics", "desktop-logs");
  const configPath = join(dataDir, ".openclaw", "openclaw.json");
  await mkdir(logsDir, { recursive: true });
  await mkdir(join(dataDir, ".openclaw"), { recursive: true });
  await writeFile(join(logsDir, ".uclaw-log-ownership.json"), JSON.stringify(LOG_OWNERSHIP_MANIFEST));
  return { root, dataDir, logsDir, configPath };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("diagnostics service", () => {
  it("lists only the existing diagnostics adapter page and projects messages before renderer", async () => {
    const paths = await fixture();
    const upstream = diagnostics([{ items: [logEntry("private-id")], nextCursor: "cursor-2", hasMore: true }]);
    const service = createDiagnosticsService({
      ...paths,
      diagnostics: upstream,
      runtime: { productVersion: "0.1.0", openClawVersion: "2026.7.1-2", gatewayPort: 18789 },
    });
    const response = await service.dispatch({ method: "logs.list", requestId: "list-1", params: { limit: 50 } });
    expect(response.ok).toBe(true);
    if (!response.ok || response.method !== "logs.list") return;
    expect(response.result.items).toHaveLength(1);
    expect(response.result.items[0]).toMatchObject({ timestamp: "2026-08-09T01:00:00.000Z", level: "info", source: "desktop", message: "Desktop info event." });
    expect(response.result.nextCursor).toBe("cursor-2");
    const serialized = JSON.stringify(response);
    expect(serialized).not.toMatch(/upstream-secret|private conversation|private-id/);
  });

  it("deep-redacts nested config and hides unknown fields before renderer and export", async () => {
    const paths = await fixture();
    await writeFile(paths.configPath, JSON.stringify({
      gateway: { port: 18789, status: "ready", auth: { token: "top-secret" } },
      providers: [{ id: "openai", apiKey: "sk-secret-value", headers: { Authorization: "Bearer nested" } }],
      prompt: "private conversation",
      mystery: { harmlessLooking: "must hide by default" },
      cause: { message: "cookie=session-secret", stack: "/Users/alice/private/config.ts:1" },
    }));
    const service = createDiagnosticsService({ ...paths, diagnostics: diagnostics(), runtime: { productVersion: "0.1.0" } });
    const response = await service.dispatch({ method: "config.get", requestId: "config-1", params: { query: "gateway" } });
    expect(response.ok).toBe(true);
    const serialized = JSON.stringify(response);
    expect(serialized).toContain("gateway.port");
    expect(serialized).not.toMatch(/top-secret|sk-secret|Bearer nested|private conversation|must hide|alice|config\.ts/);
    expect(serialized).toContain("[REDACTED]");
    await writeFile(paths.configPath, JSON.stringify({ status: "/Applications/U-Claw/alice/secret", state: "opaque-secret", model: "sk-secret", "sk-proj-key-name-secret": true }));
    const attack = await service.dispatch({ method: "config.get", requestId: "config-attack", params: {} });
    expect(JSON.stringify(attack)).not.toMatch(/Applications|alice|opaque-secret|sk-secret|sk-proj-key-name-secret/);
  });

  it("scans bounded upstream pages for filtered matches and rejects cyclic cursors", async () => {
    const paths = await fixture();
    const upstream = diagnostics([
      { items: [logEntry("one")], nextCursor: "page-2", hasMore: true },
      { items: [logEntry("two", "2026-08-09T01:00:00.000Z", "error")], nextCursor: null, hasMore: false },
    ]);
    const service = createDiagnosticsService({ ...paths, diagnostics: upstream, runtime: { productVersion: "0.1.0" } });
    const filtered = await service.dispatch({ method: "logs.list", requestId: "filtered", params: { limit: 100, levels: ["error"] } });
    expect(filtered).toMatchObject({ ok: true, result: { items: [{ level: "error" }], hasMore: false } });

    const cyclic = createDiagnosticsService({
      ...paths, runtime: { productVersion: "0.1.0" },
      diagnostics: { list: async () => [], listLogs: async () => ({ items: [logEntry("loop")], nextCursor: "same", hasMore: true }) },
    });
    const failed = await cyclic.dispatch({ method: "logs.list", requestId: "cyclic", params: { cursor: "same", limit: 100 } });
    expect(failed).toMatchObject({ ok: false, error: { code: "CONTRACT_INCOMPATIBLE" } });

    const paged = createDiagnosticsService({
      ...paths, runtime: { productVersion: "0.1.0" },
      diagnostics: { list: async () => [], listLogs: async (page) => ({ items: [logEntry("same-upstream-id")], nextCursor: page?.cursor ? null : "page-2", hasMore: !page?.cursor }) },
    });
    const first = await paged.dispatch({ method: "logs.list", requestId: "page-one", params: { limit: 100 } });
    const second = await paged.dispatch({ method: "logs.list", requestId: "page-two", params: { cursor: "page-2", limit: 100 } });
    expect(first.ok && first.method === "logs.list" && second.ok && second.method === "logs.list" && first.result.items[0]?.id).not.toBe(second.ok && second.method === "logs.list" ? second.result.items[0]?.id : undefined);
  });

  it("passes cancellation to the diagnostics adapter and releases the operation", async () => {
    const paths = await fixture();
    let adapterSignal: AbortSignal | undefined;
    const service = createDiagnosticsService({
      ...paths, runtime: { productVersion: "0.1.0" },
      diagnostics: {
        list: async () => [],
        listLogs: async (_page, signal) => {
          adapterSignal = signal;
          return new Promise(() => undefined);
        },
      },
    });
    const pending = service.dispatch({ method: "logs.list", requestId: "cancel-target", params: { limit: 100 } });
    await vi.waitFor(() => expect(adapterSignal).toBeDefined());
    await service.dispatch({ method: "operations.cancel", requestId: "cancel", params: { operationRequestId: "cancel-target" } });
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(adapterSignal?.aborted).toBe(true);
  });

  it("exports without overwrite and leaves source logs unchanged", async () => {
    const paths = await fixture();
    const upstream = diagnostics([
      { items: [logEntry("one")], nextCursor: "page-2", hasMore: true },
      { items: [logEntry("two")], nextCursor: null, hasMore: false },
    ]);
    const service = createDiagnosticsService({ ...paths, diagnostics: upstream, runtime: { productVersion: "0.1.0" } });
    const request = { method: "logs.export" as const, requestId: "export-1", params: { fileName: "diagnostics.jsonl" } };
    const first = await service.dispatch(request);
    const second = await service.dispatch({ ...request, requestId: "export-2" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!first.ok || first.method !== "logs.export") return;
    const exported = await readFile(join(paths.dataDir, first.result.relativePath), "utf8");
    expect(exported).not.toMatch(/secret|conversation|"id":"one"|"id":"two"/);
    expect(exported.trim().split("\n")).toHaveLength(2);
  });

  it("previews then clears only aged owned regular files and rejects link attacks", async () => {
    const paths = await fixture();
    const old = join(paths.logsDir, "uclaw-desktop.log");
    const recent = join(paths.logsDir, "uclaw-gateway.log");
    const outside = join(paths.root, "outside.log");
    await writeFile(old, "old\n");
    await writeFile(recent, "recent\n");
    await writeFile(outside, "outside\n");
    await utimes(old, new Date("2026-07-01T00:00:00Z"), new Date("2026-07-01T00:00:00Z"));
    await symlink(outside, join(paths.logsDir, "uclaw-channel.log"));
    await link(outside, join(paths.logsDir, "uclaw-adapter.log"));
    const service = createDiagnosticsService({ ...paths, diagnostics: diagnostics(), now: () => Date.parse("2026-08-09T00:00:00Z"), runtime: { productVersion: "0.1.0" } });
    const preview = await service.dispatch({ method: "logs.cleanup-preview", requestId: "preview-1", params: { retentionDays: 7 } });
    expect(preview.ok).toBe(true);
    if (!preview.ok || preview.method !== "logs.cleanup-preview") return;
    expect(preview.result.files.map((file) => file.name)).toEqual(["uclaw-desktop.log"]);
    const cleared = await service.dispatch({ method: "logs.cleanup", requestId: "clean-1", params: { previewId: preview.result.previewId, confirm: true } });
    expect(cleared).toMatchObject({ ok: true });
    await expect(readFile(old)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(recent, "utf8")).toBe("recent\n");
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });

  it("returns copied system values without user paths, unique IDs, or proxy credentials", async () => {
    const paths = await fixture();
    const service = createDiagnosticsService({
      ...paths,
      diagnostics: diagnostics(),
      environment: { HTTPS_PROXY: "http://alice:password@proxy.example:8080" },
      runtime: { productVersion: "0.1.0 /Applications/alice", openClawVersion: "token-secret", gatewayPort: 18789, gatewayStatus: "ready" },
    });
    const response = await service.dispatch({ method: "system.get", requestId: "system-1", params: {} });
    expect(response.ok).toBe(true);
    const serialized = JSON.stringify(response);
    expect(serialized).toContain("已配置（值已隐藏）");
    expect(serialized).not.toMatch(/alice|password|Users|Volumes|deviceId|machineId/);
    expect(serialized).not.toContain("token-secret");
    expect(serialized).toContain("unknown");
  });

  it("projects structured OpenClaw doctor checks and binds repairs to a server preview", async () => {
    const paths = await fixture();
    const repair = vi.fn(async () => undefined);
    const audit = vi.fn();
    const service = createDiagnosticsService({
      ...paths, runtime: { productVersion: "0.1.0" },
      doctorRepairActions: { "gateway-restart": repair },
      auditDoctorRepair: audit,
      diagnostics: { ...diagnostics(), doctor: async () => ({ status: "issues" as const, checks: [{ id: "gateway", title: "Gateway", severity: "error" as const, status: "fail" as const, summary: "Gateway unavailable.", suggestion: "Restart managed Gateway.", repair: { actionId: "gateway-restart", label: "Restart Gateway" } }] }) },
    });
    const result = await service.dispatch({ method: "doctor.run", requestId: "doctor-1", params: {} });
    expect(result).toMatchObject({ ok: true, result: { state: "issues", adapter: "openclaw", checks: [{ id: "gateway", level: "error", repair: { actionId: "gateway-restart" } }] } });
    if (!result.ok || result.method !== "doctor.run") return;
    const previewToken = result.result.checks[0]!.repair!.previewToken;
    await expect(service.dispatch({ method: "doctor.repair", requestId: "repair-1", params: { actionId: "gateway-restart", previewToken, confirmed: true } })).resolves.toMatchObject({ ok: true });
    expect(repair).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(audit.mock.calls.map(([event]) => event.event)).toEqual(["previewed", "confirmed", "started", "succeeded", "previewed"]);
    await expect(service.dispatch({ method: "doctor.repair", requestId: "repair-stale", params: { actionId: "gateway-restart", previewToken, confirmed: true } })).resolves.toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });

  it("keeps Doctor repair unavailable without an authoritative production action allowlist", async () => {
    const paths = await fixture();
    const repair = vi.fn(async () => undefined);
    const service = createDiagnosticsService({
      ...paths, runtime: { productVersion: "0.1.0" },
      diagnostics: { ...diagnostics(), doctor: async () => ({ status: "issues" as const, checks: [{ id: "gateway", title: "Gateway", severity: "error" as const, status: "fail" as const, summary: "failed", repair: { actionId: "gateway-restart", label: "repair" } }] }) },
    });
    const result = await service.dispatch({ method: "doctor.run", requestId: "doctor-production", params: {} });
    expect(result).toMatchObject({ ok: true, result: { checks: [{ id: "gateway" }] } });
    if (!result.ok || result.method !== "doctor.run") return;
    expect(result.result.checks[0]).not.toHaveProperty("repair");
    await expect(service.dispatch({ method: "doctor.repair", requestId: "repair-production", params: { actionId: "gateway-restart", previewToken: "doctor-preview-untrusted", confirmed: true } }))
      .resolves.toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    expect(repair).not.toHaveBeenCalled();
  });

  it("redacts Doctor text and invalidates repair previews after a fresh run", async () => {
    const paths = await fixture();
    let run = 0;
    const repair = vi.fn(async () => undefined);
    const service = createDiagnosticsService({
      ...paths, runtime: { productVersion: "0.1.0" },
      doctorRepairActions: { "gateway-restart": repair },
      diagnostics: {
        ...diagnostics(),
        doctor: async () => ++run === 1 ? ({ status: "issues" as const, checks: [{
          id: "gateway", title: "C:\\Users\\alice\\secret", severity: "error" as const, status: "fail" as const,
          summary: "Authorization: Bearer token-secret", suggestion: "rm -rf /",
          repair: { actionId: "gateway-restart", label: "api_key=sk-secret-value" },
        }] }) : ({ status: "ok" as const, checks: [] }),
      },
    });
    const first = await service.dispatch({ method: "doctor.run", requestId: "doctor-redacted", params: {} });
    expect(JSON.stringify(first)).not.toMatch(/alice|token-secret|rm -rf|sk-secret-value/);
    if (!first.ok || first.method !== "doctor.run") return;
    const preview = first.result.checks[0]!.repair!;
    await service.dispatch({ method: "doctor.run", requestId: "doctor-fresh", params: {} });
    await expect(service.dispatch({ method: "doctor.repair", requestId: "doctor-old-repair", params: { actionId: preview.actionId, previewToken: preview.previewToken, confirmed: true } }))
      .resolves.toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(repair).not.toHaveBeenCalled();
  });

  it("reports doctor UNAVAILABLE when production adapter lacks structured doctor support", async () => {
    const paths = await fixture();
    const service = createDiagnosticsService({ ...paths, diagnostics: diagnostics(), runtime: { productVersion: "0.1.0" } });
    await expect(service.dispatch({ method: "doctor.run", requestId: "doctor-1", params: {} })).resolves.toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
  });

  it("runs bounded concurrent network probes and classifies intranet-only state", async () => {
    const paths = await fixture();
    let active = 0; let maxActive = 0;
    const service = createDiagnosticsService({
      ...paths, diagnostics: diagnostics(), runtime: { productVersion: "0.1.0", gatewayPort: 18789, gatewayStatus: "ready" },
      environment: { HTTPS_PROXY: "http://secret:credential@proxy.example", NO_PROXY: "127.0.0.1,localhost" },
      networkProbe: async (target, signal) => {
        active += 1; maxActive = Math.max(maxActive, active);
        await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 5); signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
        active -= 1;
        return target === "provider" ? "unreachable" : "reachable";
      },
    });
    const result = await service.dispatch({ method: "network.run", requestId: "network-1", params: { timeoutMs: 1000 } });
    expect(result).toMatchObject({ ok: true, result: { mode: "intranet-only", proxy: { configured: true, noProxyConfigured: true } } });
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(JSON.stringify(result)).not.toMatch(/secret|credential|proxy\.example|18789/);
  });

  it("enforces probe deadlines even when a dependency ignores AbortSignal", async () => {
    const paths = await fixture();
    const service = createDiagnosticsService({
      ...paths, diagnostics: diagnostics(), runtime: { productVersion: "0.1.0" },
      networkProbe: async () => new Promise((resolve) => setTimeout(() => resolve("unreachable"), 500)),
    });
    const startedAt = Date.now();
    await expect(service.dispatch({ method: "network.run", requestId: "network-timeout", params: { timeoutMs: 250 } })).resolves.toMatchObject({ ok: true, result: { mode: "offline" } });
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("releases bounded probe workers when every dependency never settles", async () => {
    const paths = await fixture();
    const service = createDiagnosticsService({
      ...paths, diagnostics: diagnostics(), runtime: { productVersion: "0.1.0" },
      networkProbe: async () => new Promise(() => undefined),
    });
    const startedAt = Date.now();
    await expect(service.dispatch({ method: "network.run", requestId: "network-never", params: { timeoutMs: 250 } })).resolves.toMatchObject({ ok: true, result: { mode: "offline" } });
    expect(Date.now() - startedAt).toBeLessThan(1200);
  });

  it("keeps only the newest concurrent Doctor generation", async () => {
    const paths = await fixture();
    let firstResolve!: (value: any) => void;
    let secondResolve!: (value: any) => void;
    let call = 0;
    const service = createDiagnosticsService({
      ...paths, runtime: { productVersion: "0.1.0" },
      doctorRepairActions: { "gateway-restart": async () => undefined },
      diagnostics: {
        ...diagnostics(),
        doctor: async () => new Promise((resolve) => { if (++call === 1) firstResolve = resolve; else secondResolve = resolve; }),
      },
    });
    const first = service.dispatch({ method: "doctor.run", requestId: "doctor-generation-1", params: { timeoutMs: 1000 } });
    await vi.waitFor(() => expect(call).toBe(1));
    const second = service.dispatch({ method: "doctor.run", requestId: "doctor-generation-2", params: { timeoutMs: 1000 } });
    await vi.waitFor(() => expect(call).toBe(2));
    secondResolve({ status: "issues", checks: [{ id: "gateway", title: "Gateway", severity: "error", status: "fail", summary: "failed", repair: { actionId: "gateway-restart", label: "repair" } }] });
    await expect(second).resolves.toMatchObject({ ok: true });
    firstResolve({ status: "issues", checks: [{ id: "runtime", title: "Runtime", severity: "error", status: "fail", summary: "failed", repair: { actionId: "gateway-restart", label: "repair" } }] });
    await expect(first).resolves.toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });

  it("marks unsupported channel and capability probes unavailable instead of failed", async () => {
    const paths = await fixture();
    const list = vi.fn(async () => { throw { uclawError: { code: "UNSUPPORTED" } }; });
    const service = createDiagnosticsService({
      ...paths,
      diagnostics: { ...diagnostics(), list },
      runtime: { productVersion: "0.1.0", openClawVersion: "2026.7.1-2", gatewayStatus: "ready" },
    });
    const result = await service.dispatch({ method: "network.run", requestId: "network-unsupported", params: { timeoutMs: 250 } });
    expect(result).toMatchObject({ ok: true, result: { checks: [
      {}, {}, {}, {}, {}, {},
      { id: "channels", status: "unavailable", level: "info" },
      { id: "capabilities", status: "skipped", level: "info" },
    ] } });
    expect(list).not.toHaveBeenCalled();
  });

  it("times out and cancels Doctor adapter calls that never settle", async () => {
    const paths = await fixture();
    let adapterSignal: AbortSignal | undefined;
    const service = createDiagnosticsService({
      ...paths, runtime: { productVersion: "0.1.0" },
      diagnostics: { ...diagnostics(), doctor: async (signal) => { adapterSignal = signal; return new Promise(() => undefined); } },
    });
    const startedAt = Date.now();
    await expect(service.dispatch({ method: "doctor.run", requestId: "doctor-timeout", params: { timeoutMs: 250 } }))
      .resolves.toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(adapterSignal?.aborted).toBe(true);

    const pending = service.dispatch({ method: "doctor.run", requestId: "doctor-cancel-target", params: { timeoutMs: 10_000 } });
    await vi.waitFor(() => expect(adapterSignal?.aborted).toBe(false));
    await service.dispatch({ method: "operations.cancel", requestId: "doctor-cancel", params: { operationRequestId: "doctor-cancel-target" } });
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(adapterSignal?.aborted).toBe(true);
  });

  it("allows only one repair from a Doctor snapshot to execute", async () => {
    const paths = await fixture();
    let repairCalls = 0;
    const service = createDiagnosticsService({
      ...paths, runtime: { productVersion: "0.1.0" },
      doctorRepairActions: { "gateway-restart": async () => { repairCalls += 1; return new Promise(() => undefined); } },
      diagnostics: {
        ...diagnostics(),
        doctor: async () => ({ status: "issues", checks: [
          { id: "gateway", title: "Gateway", severity: "error", status: "fail", summary: "failed", repair: { actionId: "gateway-restart", label: "repair" } },
          { id: "runtime", title: "Runtime", severity: "error", status: "fail", summary: "failed", repair: { actionId: "gateway-restart", label: "repair" } },
        ] }),
      },
    });
    const doctor = await service.dispatch({ method: "doctor.run", requestId: "doctor-two-repairs", params: { timeoutMs: 1000 } });
    if (!doctor.ok || doctor.method !== "doctor.run") return;
    const [firstRepair, secondRepair] = doctor.result.checks.map((check) => check.repair!);
    const first = service.dispatch({ method: "doctor.repair", requestId: "repair-first", params: { actionId: firstRepair.actionId, previewToken: firstRepair.previewToken, confirmed: true, timeoutMs: 10_000 } });
    await vi.waitFor(() => expect(repairCalls).toBe(1));
    await expect(service.dispatch({ method: "doctor.repair", requestId: "repair-second", params: { actionId: secondRepair.actionId, previewToken: secondRepair.previewToken, confirmed: true, timeoutMs: 10_000 } }))
      .resolves.toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(repairCalls).toBe(1);
    await service.dispatch({ method: "operations.cancel", requestId: "repair-cancel", params: { operationRequestId: "repair-first" } });
    await expect(first).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
  });

  it("times out a controlled Doctor repair and records the bounded outcome", async () => {
    const paths = await fixture();
    const audit = vi.fn();
    const service = createDiagnosticsService({
      ...paths,
      runtime: { productVersion: "0.1.0" },
      auditDoctorRepair: audit,
      doctorRepairActions: { "gateway-restart": async () => new Promise(() => undefined) },
      diagnostics: { ...diagnostics(), doctor: async () => ({ status: "issues", checks: [{ id: "gateway", title: "Gateway", severity: "error", status: "fail", summary: "failed", repair: { actionId: "gateway-restart", label: "repair" } }] }) },
    });
    const doctor = await service.dispatch({ method: "doctor.run", requestId: "doctor-timeout-preview", params: {} });
    if (!doctor.ok || doctor.method !== "doctor.run") throw new Error("doctor preview failed");
    const repair = doctor.result.checks[0]!.repair!;

    await expect(service.dispatch({ method: "doctor.repair", requestId: "repair-timeout", params: { actionId: "gateway-restart", previewToken: repair.previewToken, confirmed: true, timeoutMs: 250 } }))
      .resolves.toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
    expect(audit.mock.calls.map(([event]) => event.event)).toContain("timed-out");
  });

  it("keeps Doctor repair busy after timeout until the executor actually settles", async () => {
    const paths = await fixture();
    let finishFirst!: () => void;
    let calls = 0;
    const service = createDiagnosticsService({
      ...paths,
      runtime: { productVersion: "0.1.0" },
      doctorRepairActions: {
        "gateway-restart": async () => {
          calls += 1;
          if (calls === 1) await new Promise<void>((resolve) => { finishFirst = resolve; });
        },
      },
      diagnostics: { ...diagnostics(), doctor: async () => ({ status: "issues", checks: [{ id: "gateway", title: "Gateway", severity: "error", status: "fail", summary: "failed", repair: { actionId: "gateway-restart", label: "repair" } }] }) },
    });
    const preview = async (requestId: string) => {
      const doctor = await service.dispatch({ method: "doctor.run", requestId, params: {} });
      if (!doctor.ok || doctor.method !== "doctor.run") throw new Error("doctor preview failed");
      return doctor.result.checks[0]!.repair!;
    };
    const first = await preview("doctor-timeout-busy-1");
    await expect(service.dispatch({ method: "doctor.repair", requestId: "repair-timeout-busy-1", params: { actionId: first.actionId, previewToken: first.previewToken, confirmed: true, timeoutMs: 250 } }))
      .resolves.toMatchObject({ ok: false, error: { code: "TIMEOUT" } });

    const second = await preview("doctor-timeout-busy-2");
    await expect(service.dispatch({ method: "doctor.repair", requestId: "repair-timeout-busy-2", params: { actionId: second.actionId, previewToken: second.previewToken, confirmed: true } }))
      .resolves.toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(calls).toBe(1);

    finishFirst();
    await vi.waitFor(() => expect(calls).toBe(1));
    const third = await preview("doctor-timeout-busy-3");
    await expect(service.dispatch({ method: "doctor.repair", requestId: "repair-timeout-busy-3", params: { actionId: third.actionId, previewToken: third.previewToken, confirmed: true } }))
      .resolves.toMatchObject({ ok: true });
    expect(calls).toBe(2);
  });
});
