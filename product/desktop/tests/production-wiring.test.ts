import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDesktopMainOptions } from "../src/wiring/create-desktop-main-options.js";
import * as desktopMain from "../src/main.js";
import { formalProposalInspect, formalProposalRecord } from "./skill-proposal-fixture.js";

class ScriptedWebSocket {
  static instances: ScriptedWebSocket[] = [];
  static outcome: "success" | "usage" | "automation" | "task-artifacts" | "system-node" | "system-voice" | "offline" | "authentication" | "protocol" | "missing-methods" = "success";
  static skillDisabled = false;
  static selectedModel: { sessionId: string; providerId: string; model: string } | undefined;
  static config: Record<string, unknown> = {};
  static configRevision = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly close = vi.fn();
  private readonly listeners = new Map<string, Set<(event: { data?: string }) => void>>();

  constructor(readonly url: string) {
    if (ScriptedWebSocket.outcome === "offline") throw new Error("offline with /private/runtime and token=secret");
    ScriptedWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.emit("open", {});
      this.emit("message", {
        data: JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "nonce-1", ts: 1 },
        }),
      });
    });
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    if (frame.method === "config.schema") {
      queueMicrotask(() => this.respond(frame, { schema: { type: "object" } }));
      return;
    }
    if (frame.method === "config.get") {
      queueMicrotask(() => this.respond(frame, {
        valid: true,
        hash: `config-${ScriptedWebSocket.configRevision}`,
        sourceConfig: structuredClone(ScriptedWebSocket.config),
      }));
      return;
    }
    if (frame.method === "config.apply") {
      const params = frame.params as { raw: string };
      ScriptedWebSocket.config = JSON.parse(params.raw) as Record<string, unknown>;
      ScriptedWebSocket.configRevision += 1;
      queueMicrotask(() => this.respond(frame, { ok: true }));
      return;
    }
    if (frame.method === "agents.list") {
      queueMicrotask(() => this.respond(frame, { agents: [{ id: "main", name: "Main" }] }));
      return;
    }
    if (frame.method === "tasks.list") {
      queueMicrotask(() => this.respond(frame, { tasks: [{ id: "task-1", title: "Report", status: "running", createdAt: "2026-08-12T08:00:00.000Z", updatedAt: "2026-08-12T08:01:00.000Z" }] }));
      return;
    }
    if (frame.method === "artifacts.list") {
      queueMicrotask(() => this.respond(frame, { artifacts: [] }));
      return;
    }
    if (frame.method === "environments.list") {
      queueMicrotask(() => this.respond(frame, { environments: [{ id: "gateway", type: "local", label: "Gateway", status: "available" }] }));
      return;
    }
    if (frame.method === "voicewake.get") {
      queueMicrotask(() => this.respond(frame, { triggers: ["uclaw"] }));
      return;
    }
    if (frame.method === "usage.status") {
      queueMicrotask(() => this.respond(frame, { updatedAt: 100, providers: [] }));
      return;
    }
    if (frame.method === "usage.cost") {
      queueMicrotask(() => this.respond(frame, { updatedAt: 101, days: 1, daily: [], totals: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0,
        inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, missingCostEntries: 0,
      } }));
      return;
    }
    if (frame.method === "sessions.usage") {
      queueMicrotask(() => this.respond(frame, { updatedAt: 102, startDate: "2026-08-12", endDate: "2026-08-12", sessions: [], totals: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0,
        inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, missingCostEntries: 0,
      } }));
      return;
    }
    if (frame.method === "sessions.patch") {
      const params = frame.params as { key: string; model: string };
      const separator = params.model.indexOf("/");
      ScriptedWebSocket.selectedModel = {
        sessionId: params.key,
        providerId: params.model.slice(0, separator),
        model: params.model.slice(separator + 1),
      };
      queueMicrotask(() => this.respond(frame, { ok: true, key: params.key }));
      return;
    }
    if (frame.method === "skills.status") {
      queueMicrotask(() => this.respond(frame, {
        workspaceDir: "/portable/workspace",
        managedSkillsDir: "/portable/.openclaw/skills",
        skills: [{
          name: "china-weather", description: "weather", source: "workspace", bundled: false,
          disabled: ScriptedWebSocket.skillDisabled, eligible: !ScriptedWebSocket.skillDisabled,
          blockedByAllowlist: false, blockedByAgentFilter: false, modelVisible: !ScriptedWebSocket.skillDisabled,
          userInvocable: true, commandVisible: !ScriptedWebSocket.skillDisabled,
          missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
        }],
      }));
      return;
    }
    if (frame.method === "skills.update") {
      ScriptedWebSocket.skillDisabled = (frame.params as { enabled?: boolean }).enabled === false;
      queueMicrotask(() => this.respond(frame, { ok: true }));
      return;
    }
    if (frame.method === "skills.curator.status") {
      queueMicrotask(() => this.respond(frame, {
        lastAttemptAtMs: null, lastSuccessAtMs: null, lastError: null,
        counts: { active: 0, stale: 0, archived: 0 }, skills: [], overlaps: [],
      }));
      return;
    }
    if (["skills.curator.pin", "skills.curator.unpin", "skills.curator.restore"].includes(String(frame.method))) {
      queueMicrotask(() => this.respond(frame, {
        skillFile: "china-weather/SKILL.md", skillKey: "china-weather", skillName: "china-weather",
        state: "active", pinned: frame.method === "skills.curator.pin",
        createdAtMs: 1, stateChangedAtMs: 2, lastUsedAtMs: null, useCount: 0, archivedReason: null,
      }));
      return;
    }
    if (frame.method === "skills.proposals.list") {
      queueMicrotask(() => this.respond(frame, {
        schema: "openclaw.skill-workshop.proposals-manifest.v1",
        updatedAt: "2026-08-12T00:00:00.000Z",
        proposals: [],
      }));
      return;
    }
    if (frame.method === "skills.proposals.inspect") {
      queueMicrotask(() => this.respond(frame, formalProposalInspect));
      return;
    }
    if (["skills.proposals.apply", "skills.proposals.reject", "skills.proposals.quarantine"].includes(String(frame.method))) {
      queueMicrotask(() => this.respond(frame, frame.method === "skills.proposals.apply"
        ? { record: formalProposalRecord, targetSkillFile: formalProposalRecord.target.skillFile }
        : formalProposalRecord));
      return;
    }
    if (["skills.proposals.create", "skills.proposals.update", "skills.proposals.revise"].includes(String(frame.method))) {
      queueMicrotask(() => this.respond(frame, formalProposalInspect));
      return;
    }
    if (frame.method === "skills.proposals.requestRevision") {
      queueMicrotask(() => this.respond(frame, { runId: "run-1", status: "started" }));
      return;
    }
    if (frame.method === "sessions.list") {
      if (ScriptedWebSocket.selectedModel !== undefined) {
        const selected = ScriptedWebSocket.selectedModel;
        queueMicrotask(() => this.respond(frame, {
          sessions: [{ key: selected.sessionId, modelProvider: selected.providerId, model: selected.model }],
          hasMore: false,
          nextCursor: null,
        }));
        return;
      }
      queueMicrotask(() => this.emit("message", {
        data: JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { sessions: [], hasMore: false, nextOffset: null },
        }),
      }));
      return;
    }
    if (frame.method === "chat.inject") {
      queueMicrotask(() => this.respond(frame, { ok: true, messageId: `injected-${this.sent.length}` }));
      return;
    }
    if (frame.method === "chat.send") {
      queueMicrotask(() => this.respond(frame, { runId: "run-attachment", status: "started" }));
      return;
    }
    if (frame.method !== "connect") return;
    if (ScriptedWebSocket.outcome === "authentication") {
      queueMicrotask(() => this.emit("message", {
        data: JSON.stringify({
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: "UNAUTHORIZED", message: "token=secret /private/runtime", retryable: false },
        }),
      }));
      return;
    }
    queueMicrotask(() => this.emit("message", {
      data: JSON.stringify({
        type: "res",
        id: frame.id,
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: ScriptedWebSocket.outcome === "protocol" ? 3 : 4,
          server: { version: ScriptedWebSocket.outcome === "task-artifacts" ? "2026.8.0-contract-fixture" : "2026.7.1-2" },
          features: {
            methods: ScriptedWebSocket.outcome === "missing-methods"
              ? ["sessions.list", "chat.history", "chat.send"]
              : ScriptedWebSocket.outcome === "usage"
                ? ["sessions.list", "sessions.describe", "sessions.patch", "chat.history", "chat.send", "usage.status", "usage.cost", "sessions.usage", "sessions.usage.timeseries", "sessions.usage.logs"]
                : ScriptedWebSocket.outcome === "automation"
                  ? ["sessions.list", "sessions.describe", "chat.history", "chat.send", "agents.list", "agent.identity.get", "agents.create", "agents.update", "agents.delete", "agents.files.list", "agents.files.get", "agents.files.set", "agents.workspace.list", "agents.workspace.get", "cron.list", "cron.status", "cron.get", "cron.add", "cron.update", "cron.remove", "cron.run", "cron.runs"]
                  : ScriptedWebSocket.outcome === "task-artifacts"
                    ? ["sessions.list", "sessions.describe", "chat.history", "chat.send", "tasks.list", "tasks.get", "tasks.cancel", "tasks.retry", "artifacts.list", "artifacts.get", "artifacts.download"]
                  : ScriptedWebSocket.outcome === "system-node"
                    ? ["sessions.list", "sessions.describe", "chat.history", "chat.send", "environments.list", "terminal.list"]
                  : ScriptedWebSocket.outcome === "system-voice"
                    ? ["sessions.list", "sessions.describe", "chat.history", "chat.send", "talk.session.create", "talk.session.close", "talk.client.create", "talk.client.toolCall", "talk.client.steer", "tts.status", "tts.providers", "tts.setProvider", "tts.personas", "tts.setPersona", "tts.speak", "voicewake.get", "voicewake.set", "voicewake.routing.get", "voicewake.routing.set", "agent.wait"]
                  : ["sessions.list", "sessions.describe", "sessions.patch", "chat.history", "chat.send"],
            events: ["chat"],
          },
          policy: { maxPayload: 1_000_000, maxBufferedBytes: 2_000_000 },
        },
      }),
    }));
  }

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { data?: string }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private respond(frame: Record<string, unknown>, payload: unknown): void {
    this.emit("message", { data: JSON.stringify({ type: "res", id: frame.id, ok: true, payload }) });
  }

  private emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("production desktop wiring", () => {
  const OriginalWebSocket = globalThis.WebSocket;
  let runtimeRoot: string;
  let openClawEntry: string;
  let dataRoot: string;
  let cacheRoot: string;
  let productionEnv: NodeJS.ProcessEnv;

  async function writeWechatPlugin(pluginDir: string, distContent = "") {
    await mkdir(join(pluginDir, "dist"), { recursive: true });
    await writeFile(join(pluginDir, "openclaw.plugin.json"), JSON.stringify({ id: "openclaw-weixin" }));
    await writeFile(join(pluginDir, "package.json"), JSON.stringify({ name: "@tencent-weixin/openclaw-weixin", version: "2.4.6" }));
    await writeFile(join(pluginDir, "dist/index.js"), distContent);
    const files = await Promise.all(["openclaw.plugin.json", "package.json", "dist/index.js"].map(async (file) => {
      const content = await readFile(join(pluginDir, file));
      return { path: file, bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex") };
    }));
    await writeFile(join(pluginDir, ".uclaw-plugin-manifest.json"), JSON.stringify({ schemaVersion: 1, plugins: [{ id: "openclaw-weixin", package: "@tencent-weixin/openclaw-weixin", version: "2.4.6", npmIntegrity: "sha512-qw9k3PLTiMWGNjjsknHgcTManH1w4j+Ji1ArWIaYLKCq3aFRsVwcqnPi127bvOoVMJGW4dbyJ8NECEMgoO+iRw==", openclawVersionRange: ">=2026.7.1-2 <2026.8.0", files }] }));
  }

  beforeEach(async () => {
    runtimeRoot = await mkdtemp(join(tmpdir(), "uclaw-production-wiring-"));
    openClawEntry = join(runtimeRoot, "openclaw", "openclaw.mjs");
    await mkdir(join(runtimeRoot, "openclaw"), { recursive: true });
    await writeFile(openClawEntry, "// fixture\n");
    await writeFile(join(runtimeRoot, "openclaw", "package.json"), JSON.stringify({ name: "openclaw", version: "2026.7.1-2" }));
    runtimeRoot = await realpath(runtimeRoot);
    openClawEntry = await realpath(openClawEntry);
    dataRoot = await mkdtemp(join(tmpdir(), "uclaw-production-data-"));
    cacheRoot = await mkdtemp(join(tmpdir(), "uclaw-production-cache-"));
    const stateRoot = join(dataRoot, ".openclaw");
    await mkdir(stateRoot, { recursive: true });
    const configPath = join(stateRoot, "openclaw.json");
    await writeFile(configPath, JSON.stringify({ gateway: { auth: { mode: "token", token: ["test", "gateway", "token"].join("-") } } }));
    productionEnv = {
      UCLAW_RUNTIME_DIR: runtimeRoot,
      UCLAW_OPENCLAW_ENTRY: openClawEntry,
      UCLAW_DATA_DIR: dataRoot,
      UCLAW_CACHE_DIR: cacheRoot,
      OPENCLAW_CONFIG_PATH: configPath,
      UCLAW_PORTABLE_SKILLS_DIR: await realpath(resolve(import.meta.dirname, "../../../portable/skills-cn")),
    };
  });

  afterEach(async () => {
    ScriptedWebSocket.instances = [];
    ScriptedWebSocket.outcome = "success";
    ScriptedWebSocket.skillDisabled = false;
    ScriptedWebSocket.selectedModel = undefined;
    ScriptedWebSocket.config = {};
    ScriptedWebSocket.configRevision = 1;
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: OriginalWebSocket });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await Promise.all([runtimeRoot, dataRoot, cacheRoot].map((path) => rm(path, { recursive: true, force: true })));
  });

  it("returns a diagnostic UClaw error when runtime configuration is missing", async () => {
    await expect(createDesktopMainOptions({})).rejects.toMatchObject({
      code: "UNCONFIGURED",
      retryable: false,
      causeDetails: { operation: "desktop.wiring" },
    });
  });

  it("accepts the existing portable short token without weakening character validation", async () => {
    const configPath = productionEnv.OPENCLAW_CONFIG_PATH!;
    productionEnv.UNRELATED_HOST_SECRET = "must-not-reach-gateway";
    await writeFile(configPath, JSON.stringify({ gateway: { auth: { mode: "token", token: "uclaw" } } }));

    const options = await createDesktopMainOptions(productionEnv);
    const launch = options.buildGatewayLaunchOptions(18790) as { env: NodeJS.ProcessEnv };
    expect(launch.env).not.toHaveProperty("OPENCLAW_GATEWAY_TOKEN");
    expect(launch.env.OPENCLAW_CONFIG_PATH).toBe(configPath);
    expect(launch.env).not.toHaveProperty("UNRELATED_HOST_SECRET");
    await options.dispose?.();
  });

  it("exposes only dynamic gateway image authority to Electron main wiring", async () => {
    const options = await createDesktopMainOptions(productionEnv);
    expect(options.gatewayMediaToken).toBe("test-gateway-token");
    expect(options.imageDataRoot).toBe(await realpath(dataRoot));
    expect(options.gatewayOrigin?.()).toBeUndefined();
    options.buildGatewayLaunchOptions(18790);
    expect(options.gatewayOrigin?.()).toBe("http://127.0.0.1:18790");
    await options.dispose?.();
  });

  it("writes local application turns through the official chat.inject RPC", async () => {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: ScriptedWebSocket });
    const options = await createDesktopMainOptions(productionEnv);
    options.buildGatewayLaunchOptions(18790);
    await options.probeCapabilities(18790, new AbortController().signal);

    await options.injectChatMessage!("agent:main:main", "帮我打开 WPS", "uclaw-local-user-v1");

    expect(ScriptedWebSocket.instances[0]!.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "chat.inject",
        params: { sessionKey: "agent:main:main", message: "帮我打开 WPS", label: "uclaw-local-user-v1" },
      }),
    ]));
    await options.dispose?.();
  });

  it("wires the locked OpenClaw Doctor CLI into production diagnostics", async () => {
    const options = await createDesktopMainOptions(productionEnv);

    expect(options.client?.diagnostics.doctor).toBeTypeOf("function");
    await expect(options.client!.diagnostics.doctor!()).rejects.not.toThrow("Capability is not supported");
    await options.dispose?.();
  });

  it("skips an OpenClaw filename decoy and resolves the locked package", async () => {
    const decoy = join(runtimeRoot, "aaa-decoy");
    await mkdir(decoy);
    await writeFile(join(decoy, "openclaw.mjs"), "// decoy\n");
    await writeFile(join(decoy, "package.json"), JSON.stringify({ name: "not-openclaw", version: "0.0.0" }));
    delete productionEnv.UCLAW_OPENCLAW_ENTRY;

    const options = await createDesktopMainOptions(productionEnv);
    const launch = options.buildGatewayLaunchOptions(18790) as { args: string[] };
    expect(launch.args[0]).toBe(openClawEntry);
    await options.dispose?.();
  });

  it("selects the fixed node_modules runtime before scanning the fallback inventory", async () => {
    const decoy = join(runtimeRoot, "aaa-decoy");
    await mkdir(decoy);
    await writeFile(join(decoy, "openclaw.mjs"), "// decoy\n");
    await writeFile(join(decoy, "package.json"), JSON.stringify({ name: "not-openclaw", version: "0.0.0" }));
    const fixedPackage = join(runtimeRoot, "node_modules", "openclaw");
    await mkdir(fixedPackage, { recursive: true });
    const fixedEntry = join(fixedPackage, "openclaw.mjs");
    await writeFile(fixedEntry, "// fixed runtime\n");
    await writeFile(join(fixedPackage, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.7.1-2" }));
    delete productionEnv.UCLAW_OPENCLAW_ENTRY;

    const options = await createDesktopMainOptions(productionEnv);
    const launch = options.buildGatewayLaunchOptions(18790) as { args: string[] };
    expect(launch.args[0]).toBe(await realpath(fixedEntry));
    await options.dispose?.();
  }, 15_000);

  it("rejects an explicit entry whose adjacent package is not the locked OpenClaw version", async () => {
    await writeFile(join(runtimeRoot, "openclaw", "package.json"), JSON.stringify({ name: "openclaw", version: "2025.1.0" }));

    await expect(createDesktopMainOptions(productionEnv)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("rejects an explicit non-entry file inside the locked OpenClaw package", async () => {
    const alternate = join(runtimeRoot, "openclaw", "alternate.mjs");
    await writeFile(alternate, "// not the package entrypoint\n");
    productionEnv.UCLAW_OPENCLAW_ENTRY = alternate;

    await expect(createDesktopMainOptions(productionEnv)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("assembles one authenticated v4 client graph for health, IPC, attachments, and cleanup", async () => {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: ScriptedWebSocket });
    const options = await createDesktopMainOptions(productionEnv);
    const launch = options.buildGatewayLaunchOptions(18791) as {
      executable: string;
      args: string[];
      env: NodeJS.ProcessEnv;
    };

    expect(launch.args).toEqual(expect.arrayContaining([
      openClawEntry, "gateway", "run", "--port", "18791", "--auth", "token",
    ]));
    expect(launch.args.join(" ")).not.toContain("test-gateway-token");
    expect(launch.env).not.toHaveProperty("OPENCLAW_GATEWAY_TOKEN");
    expect(options.client?.attachments).toBe(options.attachments);
    expect(options.attachments).toMatchObject({ beginImport: expect.any(Function), importChunk: expect.any(Function), finishImport: expect.any(Function) });
    expect(options.client?.sessionAdvanced).toBeDefined();
    expect(options.providerConfig).toBeDefined();
    expect(options.pluginRuntime).toBeDefined();
    expect((options.client!.channels as unknown as { wechat?: unknown }).wechat).toBeDefined();

    await expect(options.probeCapabilities(18791, new AbortController().signal)).resolves.toEqual({
      helloOk: true,
      methods: ["sessions.list", "sessions.describe", "sessions.patch", "chat.history", "chat.send"],
    });
    const socket = ScriptedWebSocket.instances[0]!;
    expect(socket.url).toBe("ws://127.0.0.1:18791");
    expect(socket.sent[0]).toMatchObject({
      method: "connect",
      params: {
        minProtocol: 4,
        maxProtocol: 4,
        auth: { token: ["test", "gateway", "token"].join("-") },
        scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
      },
    });

    await expect(options.dispatchClient({
      method: "sessions.list",
      requestId: "wiring-sessions",
      params: {},
    })).resolves.toMatchObject({ ok: true, result: { items: [], hasMore: false } });
    await options.dispose?.();
    expect(socket.close).toHaveBeenCalled();
  });

  it("bootstraps the fixed development provider only after Gateway negotiation", async () => {
    const apiKey = ["development", "provider", "secret"].join("-");
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: ScriptedWebSocket });
    const options = await createDesktopMainOptions({
      ...productionEnv,
      UCLAW_TEST_PROVIDER_BASE_URL: "https://provider.example/v1",
      UCLAW_TEST_PROVIDER_API_KEY: apiKey,
      UCLAW_TEST_PROVIDER_MODEL: "gpt-5.6-sol",
    });

    expect(await options.providers!.list()).not.toMatchObject({
      selectedProviderId: "uclaw-development-gpt",
    });

    options.buildGatewayLaunchOptions(18796);
    await options.probeCapabilities(18796, new AbortController().signal);
    const snapshot = await options.providers!.list();
    expect(snapshot.selectedProviderId).toBe("uclaw-development-gpt");
    expect(snapshot.providers).toContainEqual(expect.objectContaining({
      id: "uclaw-development-gpt",
      model: "gpt-5.6-sol",
      apiKeyConfigured: true,
    }));
    expect(JSON.stringify(snapshot)).not.toContain(apiKey);
    expect(JSON.stringify(ScriptedWebSocket.config)).toContain("uclaw-development-gpt/gpt-5.6-sol");

    const providerMetadata = await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(dataRoot, "providers", "provider-config.v1.json"), "utf8"));
    expect(providerMetadata).not.toContain(apiKey);
    const applyCount = ScriptedWebSocket.instances[0]!.sent.filter(({ method }) => method === "config.apply").length;
    await options.probeCapabilities(18796, new AbortController().signal);
    expect(ScriptedWebSocket.instances[0]!.sent.filter(({ method }) => method === "config.apply")).toHaveLength(applyCount);
    await options.dispose?.();
  });

  it("sends a cached video through the production chat.send wiring", async () => {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: ScriptedWebSocket });
    const options = await createDesktopMainOptions(productionEnv);
    options.buildGatewayLaunchOptions(18791);
    await options.probeCapabilities(18791, new AbortController().signal);
    const attachments = options.attachments!;
    const bytes = Buffer.from("000000186674797069736f6d00000000", "hex");
    const begun = await attachments.beginImport!({ name: "clip.mp4", mediaType: "video/mp4", size: bytes.length });
    await attachments.importChunk!({ importId: begun.importId, offset: 0, contentBase64: bytes.toString("base64") });
    const attachment = await attachments.finishImport!({ importId: begun.importId });

    const iterator = options.client!.chat.send({
      sessionId: "agent:main:main",
      clientRequestId: "stable-production-video-key",
      blocks: [{ type: "text", text: "分析视频", format: "plain" }, { type: "attachment", attachmentId: attachment.id }],
    })[Symbol.asyncIterator]();
    void iterator.next();
    await vi.waitFor(() => expect(ScriptedWebSocket.instances[0]!.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "chat.send",
        params: expect.objectContaining({
          message: "分析视频",
          idempotencyKey: "stable-production-video-key",
          attachments: [{ type: "file", fileName: "clip.mp4", mimeType: "video/mp4", content: bytes.toString("base64") }],
        }),
      }),
    ])));
    await vi.waitFor(async () => expect(await attachments.get(attachment.id)).toMatchObject({ state: "attached", progress: 1 }));
    await options.dispose?.();
  });

  it("injects the production process lifecycle and data-root projection into client status", async () => {
    const options = await createDesktopMainOptions(productionEnv);

    await expect(options.client!.gateway.getStatus()).resolves.toMatchObject({
      connectionState: "idle",
      processAlive: false,
      usb: { state: "available", dataWritable: true },
    });
    await options.dispose?.();
  });

  it("registers product services from the supplied env instead of global process state", async () => {
    const options = await createDesktopMainOptions({
      ...productionEnv,
      UCLAW_LICENSE_SERVICE_URL: "https://license.example.test/v1/",
      UCLAW_LICENSE_MANAGEMENT_CREDENTIAL: "license-management-secret",
      UCLAW_NEW_API_MANAGEMENT_URL: "https://management.example.test/v1/",
      UCLAW_NEW_API_MANAGEMENT_CREDENTIAL: "new-api-management-secret",
    });

    expect(options.domainRegistrations!.resolve("product-services")).toMatchObject({
      services: { authority: expect.any(Object), provisioning: expect.any(Object) },
    });
    await options.dispose?.();
  });

  it("injects the executable personal WeChat runtime instead of the adapter Unsupported surface", async () => {
    const pluginDir = join(dirname(productionEnv.OPENCLAW_CONFIG_PATH!), "extensions", "openclaw-weixin");
    await writeWechatPlugin(pluginDir);
    const options = await createDesktopMainOptions(productionEnv);

    await expect((options.client!.channels as unknown as {
      wechat: { capability(signal: AbortSignal): Promise<unknown> };
    }).wechat.capability(new AbortController().signal)).resolves.toEqual({
      available: true,
      pluginStatus: "installed",
    });
    await options.dispose?.();
  });

  it("repairs the controlled WeChat extension from bundled runtime before gateway launch options are used", async () => {
    const sourceDir = join(runtimeRoot, "extensions", "openclaw-weixin");
    const targetDir = join(dirname(productionEnv.OPENCLAW_CONFIG_PATH!), "extensions", "openclaw-weixin");
    await writeWechatPlugin(sourceDir, "trusted bundled runtime");

    const options = await createDesktopMainOptions(productionEnv);

    expect(await readFile(join(targetDir, "dist/index.js"), "utf8")).toBe("trusted bundled runtime");
    expect(options.buildGatewayLaunchOptions).toBeTypeOf("function");
    await expect((options.client!.channels as unknown as { wechat: { capability(signal: AbortSignal): Promise<unknown> } }).wechat.capability(new AbortController().signal)).resolves.toEqual({ available: true, pluginStatus: "installed" });
    await options.dispose?.();
  });

  it("fails the WeChat capability closed when bundled repair source is damaged", async () => {
    const sourceDir = join(runtimeRoot, "extensions", "openclaw-weixin");
    await writeWechatPlugin(sourceDir, "trusted bundled runtime");
    await writeFile(join(sourceDir, "dist/index.js"), "damaged after manifest");

    const options = await createDesktopMainOptions(productionEnv);

    await expect((options.client!.channels as unknown as { wechat: { capability(signal: AbortSignal): Promise<unknown> } }).wechat.capability(new AbortController().signal)).resolves.toMatchObject({
      available: false, pluginStatus: "missing", reason: "随包个人微信组件校验失败，请重新安装 U-Claw。",
    });
    await options.dispose?.();
  });

  it("registers the OpenClaw Skill runtime on the production transport with portable roots", async () => {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: ScriptedWebSocket });
    const options = await createDesktopMainOptions(productionEnv);
    options.buildGatewayLaunchOptions(18798);
    await options.probeCapabilities(18798, new AbortController().signal);

    const registration = options.domainRegistrations!.resolve("skills.runtime") as unknown as {
      runtime: {
        status(): Promise<{ skills: Array<{ id: string; disabled: boolean }> }>;
        setEnabled(skillKey: string, enabled: boolean): Promise<{ id: string; disabled: boolean }>;
        curatorStatus(): Promise<{ counts: { active: number } }>;
        curatorAction(skill: string, action: "pin" | "unpin" | "restore"): Promise<{ skillKey: string }>;
        listProposals(): Promise<{ proposals: unknown[] }>;
        inspectProposal(proposalId: string): Promise<{ record: { id: string } }>;
        proposalAction(proposalId: string, action: "apply" | "reject" | "quarantine", reason?: string): Promise<unknown>;
        createProposal(input: unknown): Promise<{ record: { id: string } }>;
        updateProposal(input: unknown): Promise<{ record: { id: string } }>;
        reviseProposal(input: unknown): Promise<{ record: { id: string } }>;
        requestProposalRevision(input: unknown): Promise<{ runId: string; status: string }>;
      };
      bundledRoots: string[];
    };
    expect(registration.bundledRoots).toEqual([productionEnv.UCLAW_PORTABLE_SKILLS_DIR]);
    await expect(readdir(registration.bundledRoots[0]!, { withFileTypes: true })).resolves.toSatisfy(
      (entries: Array<{ isDirectory(): boolean }>) => entries.filter((entry) => entry.isDirectory()).length === 17,
    );
    await expect(registration.runtime.status()).resolves.toMatchObject({
      skills: [{ id: "china-weather", disabled: false }],
    });
    await expect(registration.runtime.setEnabled("china-weather", false)).resolves.toMatchObject({
      id: "china-weather", disabled: true,
    });
    await expect(registration.runtime.curatorStatus()).resolves.toMatchObject({ counts: { active: 0 } });
    for (const action of ["pin", "unpin", "restore"] as const) {
      await expect(registration.runtime.curatorAction("china-weather", action)).resolves.toMatchObject({ skillKey: "china-weather" });
    }
    await expect(registration.runtime.listProposals()).resolves.toMatchObject({ proposals: [] });
    await expect(registration.runtime.inspectProposal("proposal-1")).resolves.toMatchObject({ record: { id: "proposal-1" } });
    for (const action of ["apply", "reject", "quarantine"] as const) {
      await expect(registration.runtime.proposalAction("proposal-1", action, "reviewed")).resolves.toMatchObject(action === "apply" ? { targetSkillFile: formalProposalRecord.target.skillFile } : { id: "proposal-1" });
    }
    await expect(registration.runtime.createProposal({ name: "weather", description: "Weather", content: "# Weather" })).resolves.toMatchObject({ record: { id: "proposal-1" } });
    await expect(registration.runtime.updateProposal({ skillName: "weather", content: "# Weather v2" })).resolves.toMatchObject({ record: { id: "proposal-1" } });
    await expect(registration.runtime.reviseProposal({ proposalId: "proposal-1", content: "# Revised" })).resolves.toMatchObject({ record: { id: "proposal-1" } });
    await expect(registration.runtime.requestProposalRevision({ proposalId: "proposal-1", instructions: "Add tests", sessionKey: "session-key" })).resolves.toMatchObject({ runId: "run-1", status: "started" });

    const skillFrames = ScriptedWebSocket.instances[0]!.sent.filter((frame) => String(frame.method).startsWith("skills."));
    expect(skillFrames.slice(0, 3)).toMatchObject([
      { method: "skills.status", params: {} },
      { method: "skills.update", params: { skillKey: "china-weather", enabled: false } },
      { method: "skills.status", params: {} },
    ]);
    const methods = skillFrames.map((frame) => frame.method);
    expect(methods).toEqual(expect.arrayContaining([
      "skills.status", "skills.update", "skills.curator.status", "skills.proposals.list",
      "skills.curator.pin", "skills.curator.unpin", "skills.curator.restore",
      "skills.proposals.inspect", "skills.proposals.apply", "skills.proposals.reject", "skills.proposals.quarantine",
      "skills.proposals.create", "skills.proposals.update", "skills.proposals.revise", "skills.proposals.requestRevision",
    ]));
    await options.dispose?.();
  });

  it("registers production Usage IPC without an Electron model inference fallback", async () => {
    ScriptedWebSocket.outcome = "usage";
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: ScriptedWebSocket });
    const fetchSpy = vi.fn(async () => { throw new Error("HTTP executor must not run"); });
    vi.stubGlobal("fetch", fetchSpy);
    const options = await createDesktopMainOptions(productionEnv);
    options.buildGatewayLaunchOptions(18801);
    await options.probeCapabilities(18801, new AbortController().signal);

    const usage = options.domainRegistrations!.resolve("usage") as {
      installIpc(context: {
        ipcMain: { handle(channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>): void; removeHandler(channel: string): void };
        authorizedWebContents: { mainFrame: unknown };
      }): () => void;
    } | undefined;
    expect(usage).toBeDefined();
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const frame = {};
    const webContents = { mainFrame: frame };
    const disposeUsage = usage!.installIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => { handlers.delete(channel); } },
      authorizedWebContents: webContents,
    });
    await expect(handlers.get("uclaw:usage")!({ sender: webContents, senderFrame: frame }, {
      method: "usage.snapshot",
      requestId: "usage-production-1",
      params: { startDate: "2026-08-12", endDate: "2026-08-12" },
    })).resolves.toMatchObject({ ok: true, result: { newApi: null } });

    expect(options).not.toHaveProperty("modelSourceExecutors");
    expect(fetchSpy).not.toHaveBeenCalled();

    disposeUsage();
    await options.dispose?.();
  });

  it("registers production Agent/Cron IPC and dispatches through OpenClaw", async () => {
    ScriptedWebSocket.outcome = "automation";
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: ScriptedWebSocket });
    const options = await createDesktopMainOptions(productionEnv);
    options.buildGatewayLaunchOptions(18801);
    await options.probeCapabilities(18801, new AbortController().signal);
    const automation = options.domainRegistrations!.resolve("automation") as {
      installIpc(context: { ipcMain: { handle(channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>): void; removeHandler(channel: string): void }; authorizedWebContents: { mainFrame: unknown } }): () => void;
    } | undefined;
    expect(automation).toBeDefined();
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const frame = {};
    const webContents = { mainFrame: frame };
    const disposeAutomation = automation!.installIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => { handlers.delete(channel); } }, authorizedWebContents: webContents });
    await expect(handlers.get("uclaw:automation")!({ sender: webContents, senderFrame: frame }, { method: "agents.list", requestId: "automation-production-1", params: {} })).resolves.toMatchObject({ ok: true, result: { agents: [{ id: "main", name: "Main" }] } });
    expect(ScriptedWebSocket.instances[0]!.sent).toEqual(expect.arrayContaining([expect.objectContaining({ method: "agents.list", params: {} })]));
    disposeAutomation();
    await options.dispose?.();
  });

  it("registers production Task/Artifact IPC and dispatches through OpenClaw", async () => {
    ScriptedWebSocket.outcome = "task-artifacts";
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: ScriptedWebSocket });
    const options = await createDesktopMainOptions(productionEnv);
    options.buildGatewayLaunchOptions(18802);
    await options.probeCapabilities(18802, new AbortController().signal);
    const registration = options.domainRegistrations!.resolve("task-artifacts") as {
      installIpc(context: { ipcMain: { handle(channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>): void; removeHandler(channel: string): void }; authorizedWebContents: { mainFrame: unknown; send(...args: unknown[]): void } }): () => void;
    } | undefined;
    expect(registration).toBeDefined();
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const frame = {};
    const webContents = { mainFrame: frame, send: vi.fn() };
    const dispose = registration!.installIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) }, authorizedWebContents: webContents });
    const taskResponse = await handlers.get("uclaw:task-artifacts")!({ sender: webContents, senderFrame: frame }, { method: "tasks.list", requestId: "tasks-production-1", params: {} });
    expect(taskResponse).toMatchObject({ ok: true, result: [{ id: "task-1", title: "Report" }] });
    expect(ScriptedWebSocket.instances[0]!.sent).toEqual(expect.arrayContaining([expect.objectContaining({ method: "tasks.list", params: {} })]));
    dispose();
    await options.dispose?.();
  });

  it("registers production System/Node IPC while keeping Terminal fail-closed", async () => {
    ScriptedWebSocket.outcome = "system-node";
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: ScriptedWebSocket });
    const options = await createDesktopMainOptions(productionEnv);
    options.buildGatewayLaunchOptions(18803);
    await options.probeCapabilities(18803, new AbortController().signal);
    const registration = options.domainRegistrations!.resolve("system-node") as {
      installIpc(context: { ipcMain: { handle(channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>): void; removeHandler(channel: string): void }; authorizedWebContents: { mainFrame: unknown; send(...args: unknown[]): void } }): () => void;
    } | undefined;
    expect(registration).toBeDefined();
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const frame = {};
    const webContents = { mainFrame: frame, send: vi.fn() };
    const dispose = registration!.installIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) }, authorizedWebContents: webContents });
    await expect(handlers.get("uclaw:system-node")!({ sender: webContents, senderFrame: frame }, { method: "environments.list", requestId: "system-node-production-1", params: {} })).resolves.toMatchObject({ ok: true, result: { environments: [{ id: "gateway" }] } });
    await expect(handlers.get("uclaw:system-node")!({ sender: webContents, senderFrame: frame }, { method: "terminal.list", requestId: "terminal-production-1", params: {} })).resolves.toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(ScriptedWebSocket.instances[0]!.sent).toEqual(expect.arrayContaining([expect.objectContaining({ method: "environments.list", params: {} })]));
    expect(ScriptedWebSocket.instances[0]!.sent).not.toEqual(expect.arrayContaining([expect.objectContaining({ method: "terminal.list" })]));
    dispose();
    await options.dispose?.();
  });

  it("registers production System Voice IPC and fails closed without renderer permission authority", async () => {
    ScriptedWebSocket.outcome = "system-voice";
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: ScriptedWebSocket });
    const options = await createDesktopMainOptions(productionEnv);
    options.buildGatewayLaunchOptions(18804);
    await options.probeCapabilities(18804, new AbortController().signal);
    const registration = options.domainRegistrations!.resolve("system-voice") as {
      installIpc(context: { ipcMain: { handle(channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>): void; removeHandler(channel: string): void }; authorizedWebContents: { mainFrame: unknown } }): () => void;
    } | undefined;
    expect(registration).toBeDefined();
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const frame = {};
    const webContents = { mainFrame: frame };
    const dispose = registration!.installIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) }, authorizedWebContents: webContents });
    await expect(handlers.get("uclaw:system-voice")!({ sender: webContents, senderFrame: frame }, { method: "voicewake.get", requestId: "system-voice-read", params: {} })).resolves.toEqual({ method: "voicewake.get", requestId: "system-voice-read", ok: true, result: { authority: { triggers: ["uclaw"] }, permissions: { microphone: "unknown", notifications: "restricted" } } });
    await expect(handlers.get("uclaw:system-voice")!({ sender: webContents, senderFrame: frame }, { method: "talk.session.create", requestId: "system-voice-denied", params: { mode: "realtime" } })).resolves.toMatchObject({ ok: false, error: { code: "AUTHORIZATION_REQUIRED" } });
    dispose();
    await options.dispose?.();
  });

  it("resolves the repository portable Skill root when the explicit override is absent", async () => {
    delete productionEnv.UCLAW_PORTABLE_SKILLS_DIR;
    const options = await createDesktopMainOptions(productionEnv);
    const registration = options.domainRegistrations!.resolve("skills.runtime") as unknown as { bundledRoots: string[] };

    expect(registration.bundledRoots).toHaveLength(1);
    await expect(readdir(registration.bundledRoots[0]!, { withFileTypes: true })).resolves.toSatisfy(
      (entries: Array<{ isDirectory(): boolean }>) => entries.filter((entry) => entry.isDirectory()).length === 17,
    );
    await options.dispose?.();
  });

  it("fails closed for a bad explicit portable Skill override instead of using a fallback", async () => {
    productionEnv.UCLAW_PORTABLE_SKILLS_DIR = join(dataRoot, "missing-skills-cn");

    await expect(createDesktopMainOptions(productionEnv)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Portable Skill source is unavailable.",
    });
  });

  it("requires a registered Skill runtime only when a production domain registry exists", () => {
    const resolveSkillRuntimeRegistration = (desktopMain as unknown as {
      resolveSkillRuntimeRegistration?: (registry: unknown) => unknown;
    }).resolveSkillRuntimeRegistration;
    expect(resolveSkillRuntimeRegistration).toBeTypeOf("function");
    expect(resolveSkillRuntimeRegistration!(undefined)).toBeUndefined();
    expect(() => resolveSkillRuntimeRegistration!({ resolve: () => undefined })).toThrow("Skill runtime is not registered");
    expect(resolveSkillRuntimeRegistration!({ resolve: () => ({ runtime: {}, bundledRoots: [] }) })).toMatchObject({
      runtime: {}, bundledRoots: [],
    });
  });

  it("spawns only the configured runtime and exposes no model-source executor", async () => {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: ScriptedWebSocket });
    const options = await createDesktopMainOptions(productionEnv);
    try {
      const launch = options.buildGatewayLaunchOptions(18792) as { executable: string; args: string[]; env: NodeJS.ProcessEnv };
      await options.probeCapabilities(18792, new AbortController().signal);

      expect(typeof options.spawn).toBe("function");
      expect(launch.executable).toBe(process.execPath);
      expect(options).not.toHaveProperty("modelSourceExecutors");
    } finally {
      await options.dispose?.();
    }
  });

  it("shares saved provider proxy settings with the managed Gateway launch", async () => {
    const options = await createDesktopMainOptions(productionEnv);
    expect(options.providers).toBeDefined();

    await options.providers!.setNetwork({
      httpProxy: "http://proxy.example.com:8080",
      httpsProxy: "https://proxy.example.com:8443",
      noProxy: ["localhost", "127.0.0.1", "::1", ".example.com"],
    });

    const launch = options.buildGatewayLaunchOptions(18796) as { env: NodeJS.ProcessEnv };
    expect(launch.env).toMatchObject({
      HTTP_PROXY: "http://proxy.example.com:8080",
      http_proxy: "http://proxy.example.com:8080",
      HTTPS_PROXY: "https://proxy.example.com:8443",
      https_proxy: "https://proxy.example.com:8443",
      NO_PROXY: "localhost,127.0.0.1,::1,.example.com",
      no_proxy: "localhost,127.0.0.1,::1,.example.com",
    });
    await options.dispose?.();
  });

  it("provides a closeable domain registration point for phases 03 through 16", async () => {
    const options = await createDesktopMainOptions(productionEnv);
    const dispose = vi.fn();
    const unregister = options.domainRegistrations!.register("work.sessions", { dispose });

    expect(options.domainRegistrations!.resolve("work.sessions")).toBeDefined();
    unregister();
    expect(options.domainRegistrations!.resolve("work.sessions")).toBeUndefined();
    options.domainRegistrations!.register("work.sessions", { dispose });
    await options.dispose?.();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("installs domain IPC hooks and cleans IPC and registrations in reverse order", async () => {
    const options = await createDesktopMainOptions(productionEnv);
    const calls: string[] = [];
    options.domainRegistrations!.register("work.first", {
      installIpc: () => {
        calls.push("install:first");
        return () => calls.push("uninstall:first");
      },
      dispose: () => { calls.push("dispose:first"); },
    });
    options.domainRegistrations!.register("work.second", {
      installIpc: () => {
        calls.push("install:second");
        return () => calls.push("uninstall:second");
      },
      dispose: () => { calls.push("dispose:second"); },
    });

    const uninstall = options.domainRegistrations!.installIpc({
      ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } as never,
      authorizedWebContents: { mainFrame: {}, send: vi.fn() },
      client: options.client!,
      services: { get: () => undefined },
    });
    expect(calls).toEqual(["install:first", "install:second"]);
    uninstall();
    await options.dispose?.();
    expect(calls).toEqual([
      "install:first", "install:second",
      "uninstall:second", "uninstall:first",
      "dispose:second", "dispose:first",
    ]);
  });

  it("continues uninstalling domain IPC hooks after one disposer fails", async () => {
    const options = await createDesktopMainOptions(productionEnv);
    const first = vi.fn();
    const second = vi.fn(() => { throw new Error("second failed"); });
    options.domainRegistrations!.register("work.first", { installIpc: () => first });
    options.domainRegistrations!.register("work.second", { installIpc: () => second });
    const uninstall = options.domainRegistrations!.installIpc({
      ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } as never,
      authorizedWebContents: { mainFrame: {}, send: vi.fn() },
      client: options.client!,
      services: { get: () => undefined },
    });

    expect(() => uninstall()).toThrow(AggregateError);
    expect(second).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();
    await options.dispose?.();
  });

  it("preserves module install failure while rolling back every installed IPC hook", async () => {
    const options = await createDesktopMainOptions(productionEnv);
    const rollback = vi.fn(() => { throw new Error("rollback failed"); });
    options.domainRegistrations!.register("work.first", { installIpc: () => rollback });
    options.domainRegistrations!.register("work.second", { installIpc: () => { throw new Error("install failed"); } });

    const error = (() => {
      try {
        options.domainRegistrations!.installIpc({
          ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } as never,
          authorizedWebContents: { mainFrame: {}, send: vi.fn() },
          client: options.client!,
          services: { get: () => undefined },
        });
      } catch (caught) {
        return caught;
      }
      throw new Error("install unexpectedly succeeded");
    })();

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toMatchObject([
      { message: "install failed" },
      { message: "rollback failed" },
    ]);
    expect(rollback).toHaveBeenCalledOnce();
    await options.dispose?.();
  });

  it.each([
    ["offline", "OFFLINE"],
    ["authentication", "AUTH_FAILED"],
    ["protocol", "PROTOCOL_ERROR"],
  ] as const)("maps %s startup failures without leaking credentials or paths", async (outcome, code) => {
    ScriptedWebSocket.outcome = outcome;
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: ScriptedWebSocket });
    const options = await createDesktopMainOptions(productionEnv);
    options.buildGatewayLaunchOptions(18793);

    const error = await options.probeCapabilities(18793, new AbortController().signal).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code });
    expect(JSON.stringify(error)).not.toContain("test-gateway-token");
    expect(JSON.stringify(error)).not.toContain(runtimeRoot);
    await options.dispose?.();
  });

  it("preserves unsupported capability as an explicit state", async () => {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: ScriptedWebSocket });
    const options = await createDesktopMainOptions(productionEnv);
    options.buildGatewayLaunchOptions(18794);
    await options.probeCapabilities(18794, new AbortController().signal);

    await expect(options.client!.files.list()).rejects.toMatchObject({
      uclawError: { code: "UNSUPPORTED" },
    });
    await options.dispose?.();
  });

  it("rejects hello immediately when a required gateway method is missing", async () => {
    ScriptedWebSocket.outcome = "missing-methods";
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: ScriptedWebSocket });
    const options = await createDesktopMainOptions(productionEnv);
    options.buildGatewayLaunchOptions(18795);

    await expect(options.probeCapabilities(18795, new AbortController().signal)).rejects.toMatchObject({
      code: "UNSUPPORTED",
      retryable: false,
    });
    await options.dispose?.();
  });
});
