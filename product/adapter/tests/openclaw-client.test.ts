import { UClawErrorSchema } from "@uclaw/shared";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type z } from "zod";

import { AsyncEventQueue, OPENCLAW_IMPLEMENTED_METHODS, OpenClawClient, UClawUnsupportedError, type OpenClawTransport } from "../src/openclaw-client.js";
import { AttachmentManager, AttachmentServiceError, createControlledAttachmentResolver } from "../src/attachments.js";
import { ManualClock } from "../src/mock/mock-client.js";
import { ReconnectPolicy } from "../src/reconnect.js";
import type { HelloOk } from "../src/transport/gateway-websocket.js";
import { RpcProtocolError, RpcRemoteError, type EventFrame, type JsonValue } from "../src/transport/rpc-router.js";

describe("P4 system voice capability filter", () => {
  it("advertises Talk, TTS, Voice Wake, and agent.wait without advertising Push", () => {
    expect(OPENCLAW_IMPLEMENTED_METHODS).toEqual(expect.arrayContaining([
      "talk.session.create", "talk.session.close", "talk.client.create", "talk.client.toolCall", "talk.client.steer",
      "tts.status", "tts.providers", "tts.setProvider", "tts.personas", "tts.setPersona", "tts.speak",
      "voicewake.get", "voicewake.set", "voicewake.routing.get", "voicewake.routing.set", "agent.wait",
    ]));
    expect(OPENCLAW_IMPLEMENTED_METHODS).not.toEqual(expect.arrayContaining(["push.web.subscribe"]));
  });
});

class FakeTransport implements OpenClawTransport {
  state = "idle" as const;
  readonly calls: string[] = [];
  readonly requests: Array<{ method: string; params: JsonValue }> = [];
  readonly fixtures = new Map<string, JsonValue>();
  readonly fixtureQueues = new Map<string, JsonValue[]>();
  readonly requestGates = new Map<string, Promise<JsonValue>>();
  readonly requestGateQueues = new Map<string, Array<Promise<JsonValue>>>();
  readonly eventListeners = new Set<{ event: string; listener: (frame: EventFrame) => void }>();
  readonly sequenceGapListeners = new Set<(gap: { expected: number; received: number }) => void>();
  readonly closeListeners = new Set<(error: Error) => void>();
  readonly connectFailures: Error[] = [];
  helloMethods = ["sessions.list", "chat.send", "chat.abort", "exec.approval.list", "plugin.approval.list"];
  policy = { maxPayload: 65_536, maxBufferedBytes: 131_072 };
  helloEvents = ["chat"];
  resetSequences: Array<number | undefined> = [];
  connectCalls = 0;
  private lastSequence: number | undefined;

  async connect(): Promise<HelloOk> {
    this.connectCalls += 1;
    const failure = this.connectFailures.shift();
    if (failure !== undefined) throw failure;
    return {
      type: "hello-ok" as const,
        protocol: 4 as const,
        server: { version: "2026.7.1-2" },
      features: { methods: this.helloMethods, events: this.helloEvents },
      policy: this.policy,
    };
  }

  close(): void {
    this.lastSequence = undefined;
    for (const listener of [...this.closeListeners]) listener(new Error("closed"));
  }

  emit(event: string, payload: JsonValue, seq: number): void {
    if (this.lastSequence !== undefined) {
      if (seq <= this.lastSequence) return;
      const expected = this.lastSequence + 1;
      this.lastSequence = seq;
      if (seq !== expected) {
        for (const listener of this.sequenceGapListeners) listener({ expected, received: seq });
        return;
      }
    } else {
      this.lastSequence = seq;
    }
    const frame = { type: "event" as const, event, payload, seq };
    for (const registered of this.eventListeners) {
      if (registered.event === event) registered.listener(frame);
    }
  }

  readonly router = {
    request: async <T>(method: string, params: JsonValue, schema: z.ZodType<T>): Promise<T> => {
      this.calls.push(method);
      this.requests.push({ method, params });
      const queued = this.fixtureQueues.get(method)?.shift();
      const gated = this.requestGateQueues.get(method)?.shift() ?? this.requestGates.get(method);
      return schema.parse(await (gated ?? Promise.resolve(queued ?? this.fixtures.get(method))));
    },
    onEvent: (event: string, listener: (frame: EventFrame) => void) => {
      const registered = { event, listener };
      this.eventListeners.add(registered);
      return () => this.eventListeners.delete(registered);
    },
    onSequenceGap: (listener: (gap: { expected: number; received: number }) => void) => {
      this.sequenceGapListeners.add(listener);
      return () => this.sequenceGapListeners.delete(listener);
    },
    onClose: (listener: (error: Error) => void) => {
      this.closeListeners.add(listener);
      return () => this.closeListeners.delete(listener);
    },
    resetSequence: (sourceSequence?: number) => {
      this.lastSequence = sourceSequence;
      this.resetSequences.push(sourceSequence);
    },
  };
}

describe("OpenClawClient", () => {
  const contractFixture = (name: string): any => JSON.parse(readFileSync(resolve(import.meta.dirname, `../fixtures/openclaw-2026.7.1-2/${name}`), "utf8"));
  it("negotiates hello capabilities and maps session list", async () => {
    const transport = new FakeTransport();
    transport.fixtures.set("sessions.list", {
      sessions: [
        { key: "agent:main:main", label: "Main Session", updatedAt: 1786129711212, pinned: false },
        { key: "session-1", label: "Chat", updatedAt: 1786129711211, pinned: false },
      ],
      nextOffset: null,
      hasMore: false,
    });
    const client = new OpenClawClient({ transport });

    const capabilities = await client.gateway.negotiate();
    expect(capabilities.methods.has("sessions.list")).toBe(true);
    await client.gateway.negotiate();
    expect(transport.connectCalls).toBe(1);
    await expect(client.sessions.list()).resolves.toMatchObject({ items: [{ id: "session-1" }] });
  });

  it("negotiates and maps the locked configured model catalog without leaking upstream fields", async () => {
    const models = contractFixture("models.list.json");
    const transport = new FakeTransport();
    transport.helloMethods.push("models.list");
    const payload = structuredClone(models.configured.responseFrame.payload);
    payload.models[0].available = false;
    payload.models[0].apiKey = ["sk", "contract", "secret"].join("-");
    payload.models[0].baseUrl = "https://secret.example/v1";
    transport.fixtures.set("models.list", payload);
    const client = new OpenClawClient({ transport });

    const capabilities = await client.gateway.negotiate();
    expect(capabilities.methods.has("models.list")).toBe(true);
    await expect(client.models.list()).resolves.toEqual([
      {
        id: "contract/contract-alt-model",
        label: "Contract Alt Model",
        providerId: "contract",
        available: false,
        locality: "unknown",
        capabilities: ["text"],
        unavailableReason: {
          code: "MODEL_UNAVAILABLE",
          message: "Model is unavailable in the current OpenClaw runtime.",
          retryable: false,
        },
      },
      {
        id: "contract/contract-model",
        label: "Contract Model",
        providerId: "contract",
        available: true,
        locality: "unknown",
        capabilities: ["text"],
      },
    ]);
    expect(transport.requests).toEqual([
      { method: "models.list", params: models.configured.requestFrame.params },
    ]);
    expect(JSON.stringify(await client.models.list())).not.toMatch(/sk-contract-secret|secret\.example|openai-completions/);
  });

  it("maps the real tools.catalog groups response to the product tool directory", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("tools.catalog");
    transport.fixtures.set("tools.catalog", {
      agentId: "main",
      profiles: [{ id: "coding", label: "Coding" }],
      groups: [{
        id: "core",
        label: "Core tools",
        source: "core",
        tools: [{
          id: "read",
          label: "Read",
          description: "Read a file",
          source: "core",
          risk: "low",
          defaultProfiles: ["coding", "full"],
        }],
      }, {
        id: "plugin-calendar",
        label: "Calendar",
        source: "plugin",
        pluginId: "calendar",
        tools: [{
          id: "calendar.list",
          label: "List events",
          description: "List calendar events",
          source: "plugin",
          pluginId: "calendar",
          defaultProfiles: ["full"],
        }],
      }],
    });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await expect(client.tools.list()).resolves.toEqual([
      {
        id: "read", name: "Read", description: "Read a file", source: "built-in",
        available: true, risk: "low",
      },
      {
        id: "calendar.list", name: "List events", description: "List calendar events", source: "plugin",
        sourceId: "calendar", available: true, risk: "unknown",
      },
    ]);
    expect(transport.requests.at(-1)).toEqual({ method: "tools.catalog", params: {} });
  });

  it("accepts an empty real tools.catalog groups response", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("tools.catalog");
    transport.fixtures.set("tools.catalog", { agentId: "main", profiles: [], groups: [] });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await expect(client.tools.list()).resolves.toEqual([]);
  });

  it("maps real session pagination, filters, ordering, and duplicate rows", async () => {
    const transport = new FakeTransport();
    transport.fixtures.set("sessions.list", {
      count: 3, totalCount: 4, offset: 2, nextOffset: 5, hasMore: true,
      sessions: [
        { key: "agent:dev:new", label: "New", updatedAt: 1786129711211, pinned: false },
        { key: "agent:dev:new", label: "Duplicate", updatedAt: 1786129711211, pinned: false },
        { key: "agent:dev:old", displayName: "Old", updatedAt: 1786129700000, pinned: false },
      ],
    });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await expect(client.sessions.list({ cursor: "2", limit: 3, query: "release" })).resolves.toMatchObject({
      items: [{ id: "agent:dev:new", title: "New" }, { id: "agent:dev:old", title: "Old" }],
      nextCursor: "5", hasMore: true,
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "sessions.list",
      params: { offset: 2, limit: 3, search: "release", includeDerivedTitles: true, includeLastMessage: true },
    });
  });

  it.each([
    { cursor: undefined, nextOffset: 0 },
    { cursor: "2", nextOffset: 1 },
    { cursor: undefined, nextOffset: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid sessions.list nextOffset $nextOffset from cursor $cursor", async ({ cursor, nextOffset }) => {
    const transport = new FakeTransport();
    transport.fixtures.set("sessions.list", { sessions: [], nextOffset, hasMore: true });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await expect(client.sessions.list(cursor === undefined ? undefined : { cursor })).rejects.toBeInstanceOf(RpcProtocolError);
  });

  it("uses describe for get and authoritative readback after create and rename", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("sessions.describe", "sessions.create", "sessions.patch");
    transport.fixtures.set("sessions.create", { ok: true, key: "agent:dev:created", sessionId: "upstream-created", entry: {} });
    transport.fixtures.set("sessions.patch", { ok: true, key: "agent:dev:created", entry: {} });
    transport.fixtureQueues.set("sessions.describe", [
      { session: { key: "agent:dev:existing", label: "Existing", updatedAt: 1786129700000, pinned: false } },
      { session: { key: "agent:dev:created", label: "Created", updatedAt: 1786129710000, pinned: false } },
      { session: { key: "agent:dev:created", label: "Renamed", updatedAt: 1786129720000, pinned: false } },
    ]);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await expect(client.sessions.get("agent:dev:existing")).resolves.toMatchObject({ title: "Existing" });
    await expect(client.sessions.create({ title: "Created", modelId: "contract/model" })).resolves.toMatchObject({ id: "agent:dev:created" });
    await expect(client.sessions.rename?.("agent:dev:created", "Renamed")).resolves.toMatchObject({ title: "Renamed" });
    expect(transport.requests).toEqual([
      { method: "sessions.describe", params: { key: "agent:dev:existing", includeDerivedTitles: true, includeLastMessage: true } },
      { method: "sessions.create", params: { label: "Created", model: "contract/model" } },
      { method: "sessions.describe", params: { key: "agent:dev:created", includeDerivedTitles: true, includeLastMessage: true } },
      { method: "sessions.patch", params: { key: "agent:dev:created", label: "Renamed" } },
      { method: "sessions.describe", params: { key: "agent:dev:created", includeDerivedTitles: true, includeLastMessage: true } },
    ]);
  });

  it("refuses fake revision protection when renaming", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("sessions.describe", "sessions.patch");
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await expect(client.sessions.rename?.("agent:dev:created", "Renamed", "fake-cas")).rejects.toBeInstanceOf(UClawUnsupportedError);
    expect(transport.requests).toEqual([]);
  });

  it("rejects a rename response for a different session", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("sessions.describe", "sessions.patch");
    transport.fixtures.set("sessions.patch", { ok: true, key: "agent:dev:other" });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await expect(client.sessions.rename?.("agent:dev:created", "Renamed")).rejects.toBeInstanceOf(RpcProtocolError);
    expect(transport.calls).toEqual(["sessions.patch"]);
  });

  it("deletes with the locked sessions.delete shape and refuses fake revision protection", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("sessions.delete");
    transport.fixtures.set("sessions.delete", { ok: true, key: "agent:dev:old", deleted: true, archived: [] });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await client.sessions.remove("agent:dev:old");
    expect(transport.requests.at(-1)).toEqual({ method: "sessions.delete", params: { key: "agent:dev:old", deleteTranscript: true } });
    await expect(client.sessions.remove("agent:dev:old", "fake-cas")).rejects.toBeInstanceOf(UClawUnsupportedError);
  });

  it("rejects a delete response for a different session", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("sessions.delete");
    transport.fixtures.set("sessions.delete", { ok: true, key: "agent:dev:other", deleted: true, archived: [] });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await expect(client.sessions.remove("agent:dev:old")).rejects.toBeInstanceOf(RpcProtocolError);
  });

  it("rejects a sessions.describe response for a different session", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("sessions.describe");
    transport.fixtures.set("sessions.describe", {
      session: { key: "agent:dev:other", label: "Other", updatedAt: 1786129700000, pinned: false },
    });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await expect(client.sessions.get("agent:dev:expected")).rejects.toBeInstanceOf(RpcProtocolError);
  });

  it("maps offset history pages in chronological order without duplicate ids", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("chat.history");
    transport.fixtures.set("chat.history", {
      sessionKey: "agent:dev:main", sessionId: "upstream-session", offset: 0, nextOffset: 3, hasMore: true, totalMessages: 5,
      messages: [
        { role: "assistant", content: "later", timestamp: 1786129712000, __openclaw: { id: "message-2", recordTimestampMs: 1786129712000, seq: 2 } },
        { role: "user", content: "earlier", timestamp: 1786129711000, __openclaw: { id: "message-1", recordTimestampMs: 1786129711000, seq: 1 } },
        { role: "user", content: "duplicate", timestamp: 1786129711000, __openclaw: { id: "message-1", recordTimestampMs: 1786129711000, seq: 1 } },
      ],
    });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await expect(client.chat.list("agent:dev:main", { limit: 3 })).resolves.toMatchObject({
      items: [{ id: "message-1" }, { id: "message-2" }], nextCursor: "3", hasMore: true,
    });
    expect(transport.requests.at(-1)).toEqual({ method: "chat.history", params: { sessionKey: "agent:dev:main", limit: 3, offset: 0 } });
  });

  it("restores only controlled local-action user injections to the user role", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("chat.history");
    transport.fixtures.set("chat.history", {
      sessionKey: "agent:dev:main", sessionId: "upstream-session",
      messages: [
        { role: "assistant", provider: "openclaw", model: "gateway-injected", content: [{ type: "text", text: "[uclaw-local-user-v1]\n\n帮我打开 WPS" }], timestamp: 1, __openclaw: { id: "local-user", recordTimestampMs: 1, seq: 1 } },
        { role: "assistant", provider: "openclaw", model: "gateway-injected", content: [{ type: "text", text: "[uclaw-local-result-v1]\n\nWPS 已打开。" }], timestamp: 2, __openclaw: { id: "local-result", recordTimestampMs: 2, seq: 2 } },
        { role: "assistant", content: [{ type: "text", text: "[untrusted]\n\n普通注入" }], timestamp: 3, __openclaw: { id: "other", recordTimestampMs: 3, seq: 3 } },
        { role: "assistant", provider: "uclaw-development-gpt", model: "gpt-5.6-sol", content: [{ type: "text", text: "[uclaw-local-user-v1]\n\n伪造内容" }], timestamp: 4, __openclaw: { id: "spoofed", recordTimestampMs: 4, seq: 4 } },
      ],
    });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await expect(client.chat.list("agent:dev:main")).resolves.toMatchObject({ items: [
      { id: "local-user", role: "user", blocks: [{ text: "帮我打开 WPS" }] },
      { id: "local-result", role: "assistant", blocks: [{ text: "WPS 已打开。" }] },
      { id: "other", role: "assistant", blocks: [{ text: "[untrusted]\n\n普通注入" }] },
      { id: "spoofed", role: "assistant", blocks: [{ text: "[uclaw-local-user-v1]\n\n伪造内容" }] },
    ] });
  });

  it("maps assistant MEDIA lines through the configured Gateway and portable data root", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("chat.history");
    transport.fixtures.set("chat.history", {
      sessionKey: "agent:dev:main", sessionId: "upstream-session",
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "生成完成。\nMEDIA:U:\\.uclaw\\data\\workspace\\.media\\images\\image_003.png" }],
        timestamp: 1,
        __openclaw: { id: "assistant-media", recordTimestampMs: 1, seq: 1 },
      }],
    });
    const client = new OpenClawClient({
      transport,
      gatewayOrigin: () => "http://127.0.0.1:18789",
      dataRoot: () => "U:\\.uclaw\\data",
    });
    await client.gateway.negotiate();

    await expect(client.chat.list("agent:dev:main")).resolves.toMatchObject({ items: [{ blocks: [
      { type: "text", text: "生成完成。" },
      {
        type: "image",
        sourceUrl: "http://127.0.0.1:18789/__openclaw__/assistant-media?source=U%3A%5C.uclaw%5Cdata%5Cworkspace%5C.media%5Cimages%5Cimage_003.png",
      },
    ] }] });
  });

  it.each([
    { cursor: undefined, nextOffset: 0 },
    { cursor: "2", nextOffset: 1 },
    { cursor: undefined, nextOffset: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid chat.history nextOffset $nextOffset from cursor $cursor", async ({ cursor, nextOffset }) => {
    const transport = new FakeTransport();
    transport.helloMethods.push("chat.history");
    transport.fixtures.set("chat.history", {
      sessionKey: "agent:dev:main", sessionId: "upstream-session", messages: [], nextOffset, hasMore: true,
    });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const request = cursor === undefined ? undefined : { cursor };
    await expect(client.chat.list("agent:dev:main", request)).rejects.toBeInstanceOf(RpcProtocolError);
  });

  it("shares an in-flight negotiation", async () => {
    const transport = new FakeTransport();
    const client = new OpenClawClient({ transport });
    await Promise.all([client.gateway.negotiate(), client.gateway.negotiate()]);
    expect(transport.connectCalls).toBe(1);
  });

  it("keeps create closed but preserves model patch when describe readback is unavailable", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("sessions.create", "sessions.patch");
    const capabilities = await new OpenClawClient({ transport }).gateway.negotiate();
    expect(capabilities.methods.has("sessions.create")).toBe(false);
    expect(capabilities.methods.has("sessions.patch")).toBe(true);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    await expect(client.sessions.rename!("agent:dev:main", "Renamed")).rejects.toMatchObject({
      uclawError: { code: "UNSUPPORTED", causeDetails: { capability: "sessions.describe" } },
    });
    expect(transport.requests).toEqual([]);
  });

  it("reports partial approval and tool event capabilities independently", async () => {
    const transport = new FakeTransport();
    const approvals = contractFixture("approvals.json");
    transport.helloMethods.push("exec.approval.resolve");
    transport.helloEvents.push("exec.approval.requested", "session.tool");
    transport.fixtures.set("exec.approval.list", approvals.exec.allowOnce.listing.responseFrame.payload);
    transport.helloMethods = transport.helloMethods.filter((method) => method !== "plugin.approval.list");
    const client = new OpenClawClient({ transport });
    const capabilities = await client.gateway.negotiate();

    expect(capabilities.features).toMatchObject({
      execApproval: true,
      pluginApproval: false,
      approvalResolve: false,
      toolTrace: true,
    });
    await expect(client.approvals.listPending()).resolves.toMatchObject([{ family: "exec" }]);
    expect(transport.calls).toEqual(["exec.approval.list"]);
  });

  it("exposes implemented channel status while keeping remaining management capabilities closed", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push(
      "models.list",
      "skills.status", "channels.status", "files.list", "files.readText", "diagnostics.list", "logs.tail",
    );
    const client = new OpenClawClient({ transport });
    const capabilities = await client.gateway.negotiate();
    const sessionId = "session-1";

    const stream = client.chat.send({ sessionId, clientRequestId: "request-1", blocks: [{ type: "attachment", attachmentId: "attachment-1" }] });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(UClawUnsupportedError);
    expect(capabilities.methods.has("exec.approval.resolve")).toBe(false);
    expect(capabilities.methods.has("plugin.approval.resolve")).toBe(false);
    expect([...capabilities.methods]).toEqual(["sessions.list", "chat.send", "chat.abort", "exec.approval.list", "plugin.approval.list", "models.list", "channels.status", "logs.tail"]);
    expect(transport.calls).toEqual([]);
  });

  it("maps only authoritative Doctor repair actions and does not expose an upstream repair RPC", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("diagnostics.doctor", "diagnostics.repair");
    transport.fixtures.set("diagnostics.doctor", { status: "issues", checks: [{
      id: "gateway", title: "Gateway", severity: "error", status: "fail",
      summary: "Gateway is unavailable.", suggestion: "Restart the managed Gateway.",
      repair: { actionId: "gateway-restart", label: "Restart Gateway" },
      command: "unsafe renderer-visible command",
    }, {
      id: "runtime", title: "Runtime", severity: "error", status: "fail",
      summary: "Runtime issue.", repair: { actionId: "runtime-restart", label: "Unsafe unknown action" },
    }] });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await expect(client.diagnostics.doctor!()).resolves.toEqual({ status: "issues", checks: [{
      id: "gateway", title: "Gateway", severity: "error", status: "fail",
      summary: "Gateway is unavailable.", suggestion: "Restart the managed Gateway.",
      repair: { actionId: "gateway-restart", label: "Restart Gateway" },
    }, {
      id: "runtime", title: "Runtime", severity: "error", status: "fail", summary: "Runtime issue.",
    }] });
    expect("repair" in client.diagnostics).toBe(false);
    expect(transport.requests).toEqual([
      { method: "diagnostics.doctor", params: {} },
    ]);
    expect((await client.gateway.negotiate()).methods.has("diagnostics.repair")).toBe(false);
  });

  it("fails doctor closed before transport when OpenClaw has no structured adapter", async () => {
    const transport = new FakeTransport();
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    await expect(client.diagnostics.doctor!()).rejects.toMatchObject({ uclawError: { code: "UNSUPPORTED" } });
    expect(transport.requests).toEqual([]);
  });

  it("maps prepared attachments to the locked OpenClaw v4 fixture", async () => {
    const fixture = contractFixture("attachments.json").cases.find((item: { kind: string }) => item.kind === "text");
    const transport = new FakeTransport();
    transport.fixtures.set("chat.send", fixture.responseFrame.payload);
    const attachments = new AttachmentManager();
    const attachment = await attachments.import({
      name: fixture.requestFrame.params.attachments[0].fileName,
      mediaType: fixture.requestFrame.params.attachments[0].mimeType,
      size: 8,
      contentBase64: fixture.requestFrame.params.attachments[0].content,
    });
    const client = new OpenClawClient({ transport, attachments });
    await client.gateway.negotiate();

    const iterator = client.chat.send({
      sessionId: fixture.requestFrame.params.sessionKey,
      clientRequestId: fixture.requestFrame.params.idempotencyKey,
      blocks: [
        { type: "text", text: fixture.requestFrame.params.message, format: "plain" },
        { type: "attachment", attachmentId: attachment.id },
      ],
    })[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();

    expect(transport.requests.at(-1)).toEqual({ method: "chat.send", params: fixture.requestFrame.params });
    expect(await attachments.get(attachment.id)).toMatchObject({ state: "attached", progress: 1 });
  });

  it("keeps selected model on the session and omits unsupported modelId from OpenClaw v4 chat.send", async () => {
    const transport = new FakeTransport();
    transport.fixtures.set("chat.send", { runId: "run-commercial", status: "accepted" });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const iterator = client.chat.send({
      sessionId: "agent:main:commercial",
      clientRequestId: "commercial-request",
      modelId: "uclaw-commercial/gpt-5.5",
      blocks: [{ type: "text", text: "hello", format: "plain" }],
    })[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();

    expect(transport.requests.at(-1)).toEqual({
      method: "chat.send",
      params: {
        sessionKey: "agent:main:commercial",
        message: "hello",
        idempotencyKey: "commercial-request",
      },
    });
  });

  it.each([
    ["video/mp4", Buffer.from("000000186674797069736f6d00000000", "hex")],
    ["video/quicktime", Buffer.from("00000018667479707174202000000000", "hex")],
    ["video/webm", Buffer.from("1a45dfa39f4286810100000000000000", "hex")],
  ])("sends text and %s from controlled cache in one idempotent chat.send", async (mediaType, bytes) => {
    const dataRoot = await mkdtemp(join(tmpdir(), "uclaw-adapter-video-"));
    const id = "video-1";
    const relativePath = `uclaw/attachments/objects/${id}/content`;
    const contentPath = join(dataRoot, relativePath);
    await mkdir(resolve(contentPath, ".."), { recursive: true });
    await writeFile(contentPath, bytes);
    const source = {
      get: vi.fn(async () => ({
        id,
        file: { id, name: "clip.mov", mediaType, size: bytes.length, kind: "attachment" as const, relativePath },
        category: "video" as const,
        state: "ready" as const,
      })),
      prepare: vi.fn(), cancel: vi.fn(), remove: vi.fn(), import: vi.fn(),
    };
    const transport = new FakeTransport();
    transport.policy = { maxPayload: 1_000_000, maxBufferedBytes: 2_000_000 };
    transport.fixtures.set("chat.send", { runId: "run-video", status: "started" });
    const attachments = createControlledAttachmentResolver({ dataRoot, source });
    const client = new OpenClawClient({ transport, attachments });
    await client.gateway.negotiate();

    const iterator = client.chat.send({
      sessionId: "agent:main:main",
      clientRequestId: "stable-video-key",
      blocks: [{ type: "text", text: "分析视频", format: "plain" }, { type: "attachment", attachmentId: id }],
    })[Symbol.asyncIterator]();
    await iterator.next();

    expect(transport.requests.at(-1)).toEqual({
      method: "chat.send",
      params: {
        sessionKey: "agent:main:main",
        message: "分析视频",
        attachments: [{ type: "file", fileName: "clip.mov", mimeType: mediaType, content: bytes.toString("base64") }],
        idempotencyKey: "stable-video-key",
      },
    });
    await rm(dataRoot, { recursive: true, force: true });
  });

  it.each(["missing", "replaced", "mime-mismatch", "oversized"])("fails closed for %s controlled video cache", async (failure) => {
    const dataRoot = await mkdtemp(join(tmpdir(), "uclaw-adapter-video-fail-"));
    const id = "video-fail";
    const relativePath = `uclaw/attachments/objects/${id}/content`;
    const contentPath = join(dataRoot, relativePath);
    const valid = Buffer.from("000000186674797069736f6d00000000", "hex");
    await mkdir(resolve(contentPath, ".."), { recursive: true });
    if (failure !== "missing") await writeFile(contentPath, failure === "mime-mismatch" ? Buffer.alloc(valid.length, 0x78) : valid);
    const source = {
      get: vi.fn(async () => ({
        id,
        file: { id, name: "clip.mp4", mediaType: "video/mp4", size: failure === "oversized" ? 500 * 1024 * 1024 + 1 : valid.length, kind: "attachment" as const, relativePath },
        category: "video" as const,
        state: "ready" as const,
      })),
      prepare: vi.fn(), cancel: vi.fn(), remove: vi.fn(), import: vi.fn(),
    };
    const transport = new FakeTransport();
    const attachments = createControlledAttachmentResolver({
      dataRoot,
      source,
      afterInspect: failure === "replaced" ? async () => {
        const replacement = `${contentPath}.replacement`;
        await writeFile(replacement, valid);
        await rename(replacement, contentPath);
      } : undefined,
    });
    const client = new OpenClawClient({ transport, attachments });
    await client.gateway.negotiate();

    const send = client.chat.send({ sessionId: "agent:main:main", clientRequestId: "stable-fail-key", blocks: [
      { type: "text", text: "must not send alone", format: "plain" },
      { type: "attachment", attachmentId: id },
    ]})[Symbol.asyncIterator]();
    await expect(send.next()).rejects.toBeDefined();
    expect(transport.requests.some((request) => request.method === "chat.send")).toBe(false);
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("rejects a controlled video that cannot fit the negotiated Gateway frame before reading it", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "uclaw-adapter-video-policy-"));
    const id = "video-policy";
    const source = {
      get: vi.fn(async () => ({
        id,
        file: { id, name: "clip.mp4", mediaType: "video/mp4", size: 20 * 1024 * 1024, kind: "attachment" as const, relativePath: `uclaw/attachments/objects/${id}/content` },
        category: "video" as const,
        state: "ready" as const,
      })),
      prepare: vi.fn(), cancel: vi.fn(), remove: vi.fn(), import: vi.fn(),
    };
    const beforeRead = vi.fn();
    const transport = new FakeTransport();
    transport.policy = { maxPayload: 25 * 1024 * 1024, maxBufferedBytes: 50 * 1024 * 1024 };
    const client = new OpenClawClient({ transport, attachments: createControlledAttachmentResolver({ dataRoot, source, beforeRead }) });
    await client.gateway.negotiate();

    const send = client.chat.send({ sessionId: "agent:main:main", clientRequestId: "video-policy-key", blocks: [
      { type: "text", text: "分析视频", format: "plain" },
      { type: "attachment", attachmentId: id },
    ] })[Symbol.asyncIterator]();
    await expect(send.next()).rejects.toMatchObject({ uclawError: { code: "FILE_TOO_LARGE" } });
    expect(beforeRead).not.toHaveBeenCalled();
    expect(transport.requests.some((request) => request.method === "chat.send")).toBe(false);
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("resolves a selected Skill through the authoritative command catalog before chat.send", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("commands.list");
    transport.fixtures.set("commands.list", { commands: [{ name: "document_writer", textAliases: ["/document_writer"], description: "Document writer", source: "skill", scope: "text", acceptsArgs: true }] });
    transport.fixtures.set("chat.send", { runId: "run-skill", status: "started" });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const iterator = client.chat.send({
      sessionId: "agent:main:main", clientRequestId: "skill-1", skillId: "Document Writer",
      blocks: [{ type: "text", text: "整理需求", format: "plain" }],
    })[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();

    expect(transport.requests).toEqual(expect.arrayContaining([
      { method: "commands.list", params: { agentId: "main", scope: "text", includeArgs: false } },
      { method: "chat.send", params: expect.objectContaining({ message: "/document_writer 整理需求" }) },
    ]));
  });

  it("fails closed when a selected Skill has no unique authoritative command", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("commands.list");
    transport.fixtures.set("commands.list", { commands: [{ name: "other", description: "Other", source: "skill", scope: "text", acceptsArgs: true }] });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const iterator = client.chat.send({
      sessionId: "agent:main:main", clientRequestId: "skill-missing", skillId: "Document Writer",
      blocks: [{ type: "text", text: "整理需求", format: "plain" }],
    })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ uclawError: { code: "UNAVAILABLE" } });
    expect(transport.requests.some((request) => request.method === "chat.send")).toBe(false);
  });

  it("sends multiple attachments in one request when cumulative payload fits policy", async () => {
    const transport = new FakeTransport();
    transport.fixtures.set("chat.send", { runId: "run-multi", status: "started" });
    const attachments = new AttachmentManager({ createId: (() => { let id = 0; return () => String(++id); })() });
    const first = await attachments.import({ name: "one.txt", mediaType: "text/plain", size: 3, contentBase64: "b25l" });
    const second = await attachments.import({ name: "two.txt", mediaType: "text/plain", size: 3, contentBase64: "dHdv" });
    const client = new OpenClawClient({ transport, attachments });
    await client.gateway.negotiate();
    const iterator = client.chat.send({
      sessionId: "session-1", clientRequestId: "multi-1",
      blocks: [{ type: "attachment", attachmentId: first.id }, { type: "attachment", attachmentId: second.id }],
    })[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(transport.requests.at(-1)).toMatchObject({ method: "chat.send", params: { attachments: [{ fileName: "one.txt" }, { fileName: "two.txt" }] } });
  });

  it("rejects attachment count and small Gateway policy before chat.send", async () => {
    const transport = new FakeTransport();
    const attachments = new AttachmentManager({ createId: (() => { let id = 0; return () => String(++id); })() });
    const imported = [];
    for (let index = 0; index < 9; index += 1) {
      imported.push(await attachments.import({ name: `${index}.txt`, mediaType: "text/plain", size: 1, contentBase64: "eA==" }));
    }
    const client = new OpenClawClient({ transport, attachments });
    await client.gateway.negotiate();
    const tooMany = client.chat.send({
      sessionId: "session-1", clientRequestId: "too-many",
      blocks: imported.map((attachment) => ({ type: "attachment" as const, attachmentId: attachment.id })),
    })[Symbol.asyncIterator]();
    await expect(tooMany.next()).rejects.toBeInstanceOf(AttachmentServiceError);
    expect(transport.requests).toEqual([]);

    transport.policy = { maxPayload: 180, maxBufferedBytes: 256 };
    await client.gateway.reconnect();
    const one = imported[0];
    const smallPolicy = client.chat.send({
      sessionId: "session-1", clientRequestId: "small-policy",
      blocks: [{ type: "text", text: "payload", format: "plain" }, { type: "attachment", attachmentId: one.id }],
    })[Symbol.asyncIterator]();
    const error = await smallPolicy.next().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AttachmentServiceError);
    expect((error as AttachmentServiceError).uclawError.code).toBe("FILE_TOO_LARGE");
    expect(transport.requests).toEqual([]);
    expect(await attachments.get(one.id)).toMatchObject({ state: "ready", progress: 0 });
    const prepared = [];
    for await (const state of attachments.prepare(one.id)) prepared.push(state.state);
    expect(prepared).toEqual(["ready"]);

    transport.policy = { maxPayload: 65_536, maxBufferedBytes: 131_072 };
    transport.fixtures.set("chat.send", { runId: "run-after-limit", status: "started" });
    await client.gateway.reconnect();
    const retry = client.chat.send({
      sessionId: "session-1", clientRequestId: "after-limit",
      blocks: [{ type: "attachment", attachmentId: one.id }],
    })[Symbol.asyncIterator]();
    await expect(retry.next()).resolves.toMatchObject({ value: { type: "started", runId: "run-after-limit" } });
    await retry.return?.();
  });

  it("reports upload progress and preserves a retryable failed attachment", async () => {
    const transport = new FakeTransport();
    let acceptSend: (value: JsonValue) => void = () => undefined;
    transport.requestGates.set("chat.send", new Promise((resolve) => { acceptSend = resolve; }));
    const attachments = new AttachmentManager();
    const attachment = await attachments.import({ name: "fixture.txt", mediaType: "text/plain", size: 8, contentBase64: "Y29udHJhY3Q=" });
    const client = new OpenClawClient({ transport, attachments });
    await client.gateway.negotiate();
    const iterator = client.chat.send({ sessionId: "session-1", clientRequestId: "retry-key", blocks: [{ type: "attachment", attachmentId: attachment.id }] })[Symbol.asyncIterator]();
    const started = iterator.next();
    await vi.waitFor(async () => expect(await attachments.get(attachment.id)).toMatchObject({ state: "uploading", progress: 0 }));
    acceptSend({ runId: "run-upload", status: "started" });
    await expect(started).resolves.toMatchObject({ value: { type: "started", runId: "run-upload" } });
    expect(await attachments.get(attachment.id)).toMatchObject({ state: "attached", progress: 1 });
    await iterator.return?.();

    let rejectSend: (error: Error) => void = () => undefined;
    transport.requestGates.set("chat.send", new Promise((_resolve, reject) => { rejectSend = reject; }));
    const retry = client.chat.send({ sessionId: "session-1", clientRequestId: "retry-key", blocks: [{ type: "attachment", attachmentId: attachment.id }] })[Symbol.asyncIterator]();
    const failed = retry.next();
    const leakedToken = ["sk", "secret123"].join("-");
    rejectSend(new RpcRemoteError("UNAVAILABLE", `C:\\Users\\alice\\secret.txt /home/alice/private.txt token=${leakedToken} prompt=private-body`, true));
    await expect(failed).rejects.toBeInstanceOf(RpcRemoteError);
    const failedAttachment = await attachments.get(attachment.id);
    expect(failedAttachment).toMatchObject({ state: "failed", error: { message: "附件发送失败。", retryable: true } });
    expect(JSON.stringify(failedAttachment)).not.toMatch(/Users|\/home|sk-secret123|private-body/);
    const states = [];
    for await (const state of attachments.prepare(attachment.id)) states.push(state.state);
    expect(states).toEqual(["validating", "ready"]);
  });

  it("maps real history and chat.message.get envelopes", async () => {
    const history = contractFixture("chat.history.json");
    const messageGet = contractFixture("chat.message.get.json");
    const transport = new FakeTransport();
    transport.helloMethods.push("chat.history", "chat.message.get");
    transport.fixtures.set("chat.history", history.responseFrame.payload);
    transport.fixtures.set("chat.message.get", messageGet.success.responseFrame.payload);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const page = await client.chat.list("agent:dev:main");
    expect(page.items.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(page.items)).not.toMatch(/toolCall|toolResult|REDACTED TOOL RESULT/);
    expect(page).toMatchObject({ nextCursor: null, hasMore: false });
    const messageId = messageGet.success.requestFrame.params.messageId;
    await expect(client.chat.get("agent:dev:main", messageId)).resolves.toMatchObject({
      id: messageId,
      sessionId: "agent:dev:main",
      role: "user",
    });
    transport.fixtures.set("chat.message.get", messageGet.unavailable.responseFrame.payload);
    const unavailable = await client.chat.get("agent:dev:main", "message-contract-missing").catch((error: unknown) => error);
    expect(UClawErrorSchema.parse((unavailable as { uclawError: unknown }).uclawError).code).toBe("NOT_FOUND");
  });

  it("rejects chat.history responses for a different session", async () => {
    const history = contractFixture("chat.history.json");
    const mismatched = structuredClone(history.responseFrame.payload);
    mismatched.sessionKey = "agent:dev:other";
    const transport = new FakeTransport();
    transport.helloMethods.push("chat.history");
    transport.fixtures.set("chat.history", mismatched);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const error = await client.chat.list("agent:dev:main").catch((reason: unknown) => reason) as { uclawError: unknown };
    expect(UClawErrorSchema.parse(error.uclawError)).toMatchObject({ code: "PROTOCOL_MAPPING_FAILED", retryable: false });
    expect(transport.requests.at(-1)).toEqual({ method: "chat.history", params: { sessionKey: "agent:dev:main" } });
  });

  it("resolves observed approval decisions, rejects allow-session, and selects a model", async () => {
    const approvals = contractFixture("approvals.json");
    const tools = contractFixture("session.tool.json");
    const transport = new FakeTransport();
    transport.helloMethods.push("exec.approval.resolve", "plugin.approval.resolve", "sessions.describe", "sessions.patch");
    transport.fixtures.set("exec.approval.resolve", { ok: true });
    transport.fixtures.set("plugin.approval.resolve", { ok: true });
    transport.fixtures.set("sessions.patch", { ok: true, key: "session-1" });
    transport.fixtures.set("sessions.list", {
      sessions: [{ key: "session-1", modelProvider: "provider", model: "model-1" }],
    });
    const execOther = structuredClone(approvals.exec.allowOnce.event.payload);
    execOther.id = "exec-other-session";
    execOther.request.sessionKey = "agent:dev:other";
    const pluginOther = structuredClone(approvals.plugin.allowOnce.event.payload);
    pluginOther.id = "plugin-other-session";
    pluginOther.request.sessionKey = "agent:dev:other";
    transport.fixtures.set("exec.approval.list", [...approvals.exec.allowOnce.listing.responseFrame.payload, execOther]);
    transport.fixtures.set("plugin.approval.list", [...approvals.plugin.allowOnce.listing.responseFrame.payload, pluginOther]);
    const approvalChanges: string[] = [];
    const client = new OpenClawClient({
      transport,
      onApprovalsChanged: (sessionId) => { approvalChanges.push(sessionId); },
    });
    await client.gateway.negotiate();

    await expect(client.approvals.listPending("agent:dev:main")).resolves.toMatchObject([
      { family: "exec", choices: ["allow-once", "deny"] },
      { family: "plugin", choices: ["allow-once", "deny"] },
    ]);
    await expect(client.approvals.listPending("agent:dev:other")).resolves.toMatchObject([
      { id: "exec-other-session", family: "exec" },
      { id: "plugin-other-session", family: "plugin" },
    ]);
    const execId = approvals.exec.allowOnce.event.payload.id;
    const pluginId = approvals.plugin.allowOnce.event.payload.id;
    const toolStart = structuredClone(tools.start.payload);
    toolStart.data.toolCallId = approvals.plugin.allowOnce.event.payload.request.toolCallId;
    const watch = client.chat.watch("agent:dev:main")[Symbol.asyncIterator]();
    const observedTool = watch.next();
    transport.emit("session.tool", toolStart, 1);
    await expect(observedTool).resolves.toMatchObject({ value: { type: "tool", tool: { state: "running" } } });
    await client.approvals.resolveExec({ ref: { family: "exec", id: execId }, decision: "allow-once" });
    await client.approvals.resolvePlugin({ ref: { family: "plugin", id: pluginId }, decision: "deny" });
    expect(approvalChanges).toEqual(["agent:dev:main", "agent:dev:main"]);
    await expect(watch.next()).resolves.toMatchObject({ value: { type: "tool", tool: { state: "cancelled" } } });
    await watch.return?.();
    await client.models.selectForSession("session-1", "provider/model-1");
    const unsupported = await client.approvals.resolveExec({ ref: { family: "exec", id: "exec-1" }, decision: "allow-session" }).catch((error: unknown) => error);
    expect(unsupported).toBeInstanceOf(UClawUnsupportedError);
    expect((unsupported as UClawUnsupportedError).uclawError.code).toBe("UNSUPPORTED");
    expect(transport.requests.slice(4)).toEqual([
      { method: "exec.approval.resolve", params: { id: execId, decision: "allow-once" } },
      { method: "plugin.approval.resolve", params: { id: pluginId, decision: "deny" } },
      { method: "sessions.patch", params: { key: "session-1", model: "provider/model-1" } },
      { method: "sessions.list", params: {} },
    ]);
  });

  it("verifies a session model against the locked sessions.patch readback", async () => {
    const patchFixture = contractFixture("sessions.patch.json");
    const transport = new FakeTransport();
    transport.helloMethods.push("sessions.patch");
    transport.fixtures.set("sessions.patch", patchFixture.model.responseFrame.payload);
    transport.fixtures.set("sessions.list", patchFixture.modelReadback.responseFrame.payload);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await client.models.selectForSession("agent:dev:main", "contract/contract-alt-model");

    expect(transport.requests).toEqual([
      { method: "sessions.patch", params: patchFixture.model.requestFrame.params },
      { method: "sessions.list", params: patchFixture.modelReadback.requestFrame.params },
    ]);
  });

  it("reports MODEL_UNAVAILABLE when sessions.patch accepts but readback has another model", async () => {
    const patchFixture = contractFixture("sessions.patch.json");
    const transport = new FakeTransport();
    transport.helloMethods.push("sessions.patch");
    transport.fixtures.set("sessions.patch", patchFixture.model.responseFrame.payload);
    const mismatchedReadback = structuredClone(patchFixture.modelReadback.responseFrame.payload);
    mismatchedReadback.sessions[0].model = "contract-other-model";
    transport.fixtures.set("sessions.list", mismatchedReadback);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const error = await client.models.selectForSession("agent:dev:main", "contract/contract-alt-model").catch((reason: unknown) => reason) as { uclawError: unknown };

    expect(UClawErrorSchema.parse(error.uclawError)).toMatchObject({ code: "MODEL_UNAVAILABLE", retryable: false });
    expect(transport.requests).toEqual([
      { method: "sessions.patch", params: patchFixture.model.requestFrame.params },
      { method: "sessions.list", params: patchFixture.modelReadback.requestFrame.params },
    ]);
  });

  it("finds the selected session model on a later sessions.list page", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("sessions.patch");
    transport.fixtures.set("sessions.patch", { ok: true, key: "agent:dev:target" });
    transport.fixtureQueues.set("sessions.list", [
      {
        sessions: [{ key: "agent:dev:other", modelProvider: "contract", model: "contract-other" }],
        nextCursor: "page-2",
        hasMore: true,
      },
      {
        sessions: [{ key: "agent:dev:target", modelProvider: "contract", model: "contract-target" }],
        nextCursor: null,
        hasMore: false,
      },
    ]);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await client.models.selectForSession("agent:dev:target", "contract/contract-target");

    expect(transport.requests).toEqual([
      { method: "sessions.patch", params: { key: "agent:dev:target", model: "contract/contract-target" } },
      { method: "sessions.list", params: {} },
      { method: "sessions.list", params: { cursor: "page-2" } },
    ]);
  });

  it("rejects a repeated sessions.list readback cursor", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("sessions.patch");
    transport.fixtures.set("sessions.patch", { ok: true, key: "agent:dev:target" });
    transport.fixtureQueues.set("sessions.list", [
      { sessions: [], nextCursor: "page-2", hasMore: true },
      { sessions: [], nextCursor: "page-2", hasMore: true },
    ]);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const error = await client.models.selectForSession("agent:dev:target", "contract/contract-target").catch((reason: unknown) => reason) as { uclawError: unknown };

    expect(UClawErrorSchema.parse(error.uclawError)).toMatchObject({ code: "PROTOCOL_MAPPING_FAILED" });
    expect(transport.requests).toEqual([
      { method: "sessions.patch", params: { key: "agent:dev:target", model: "contract/contract-target" } },
      { method: "sessions.list", params: {} },
      { method: "sessions.list", params: { cursor: "page-2" } },
    ]);
  });

  it("reports MODEL_UNAVAILABLE when sessions.patch rejects a selected model", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("sessions.patch");
    transport.requestGates.set("sessions.patch", Promise.reject(new RpcRemoteError("INVALID_REQUEST", "Selected model is unavailable")));
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const error = await client.models.selectForSession("agent:dev:main", "contract/missing-model").catch((reason: unknown) => reason) as { uclawError: unknown };

    expect(UClawErrorSchema.parse(error.uclawError)).toMatchObject({ code: "MODEL_UNAVAILABLE", retryable: false });
    expect(transport.requests).toEqual([
      { method: "sessions.patch", params: { key: "agent:dev:main", model: "contract/missing-model" } },
    ]);
  });

  it("preserves non-model INVALID_REQUEST errors from sessions.patch", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("sessions.patch");
    transport.requestGates.set("sessions.patch", Promise.reject(new RpcRemoteError(
      "INVALID_REQUEST",
      "invalid sessions.patch params: at root: unexpected property 'baseHash'",
    )));
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const error = await client.models.selectForSession("agent:dev:main", "contract/contract-alt-model").catch((reason: unknown) => reason) as { uclawError: unknown };

    expect(UClawErrorSchema.parse(error.uclawError)).toMatchObject({
      code: "OPERATION_FAILED",
      message: "invalid sessions.patch params: at root: unexpected property 'baseHash'",
      causeDetails: { upstreamCode: "INVALID_REQUEST" },
    });
  });

  it("serializes model patch and readback globally across sessions", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("sessions.patch");
    let releaseFirstPatch: (value: JsonValue) => void = () => undefined;
    transport.requestGateQueues.set("sessions.patch", [
      new Promise((resolve) => { releaseFirstPatch = resolve; }),
      Promise.resolve({ ok: true, key: "agent:dev:other" }),
    ]);
    transport.fixtureQueues.set("sessions.list", [
      { sessions: [{ key: "agent:dev:main", modelProvider: "contract", model: "contract-main" }] },
      { sessions: [{ key: "agent:dev:other", modelProvider: "contract", model: "contract-alt" }] },
    ]);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const first = client.models.selectForSession("agent:dev:main", "contract/contract-main");
    await Promise.resolve();
    await Promise.resolve();
    const second = client.models.selectForSession("agent:dev:other", "contract/contract-alt");
    await Promise.resolve();
    await Promise.resolve();

    expect(transport.requests).toEqual([
      { method: "sessions.patch", params: { key: "agent:dev:main", model: "contract/contract-main" } },
    ]);

    releaseFirstPatch({ ok: true, key: "agent:dev:main" });
    await Promise.all([first, second]);
    expect(transport.requests).toEqual([
      { method: "sessions.patch", params: { key: "agent:dev:main", model: "contract/contract-main" } },
      { method: "sessions.list", params: {} },
      { method: "sessions.patch", params: { key: "agent:dev:other", model: "contract/contract-alt" } },
      { method: "sessions.list", params: {} },
    ]);
  });

  it("continues the global model write queue after a failed selection", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("sessions.patch");
    transport.requestGateQueues.set("sessions.patch", [
      Promise.reject(new RpcRemoteError("INVALID_REQUEST", "invalid sessions.patch params")),
      Promise.resolve({ ok: true, key: "agent:dev:second" }),
    ]);
    transport.fixtures.set("sessions.list", {
      sessions: [{ key: "agent:dev:second", modelProvider: "contract", model: "contract-second" }],
    });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const first = client.models.selectForSession("agent:dev:first", "contract/contract-first");
    const second = client.models.selectForSession("agent:dev:second", "contract/contract-second");

    await expect(first).rejects.toMatchObject({ uclawError: { code: "OPERATION_FAILED" } });
    await expect(second).resolves.toBeUndefined();
    expect(transport.requests).toEqual([
      { method: "sessions.patch", params: { key: "agent:dev:first", model: "contract/contract-first" } },
      { method: "sessions.patch", params: { key: "agent:dev:second", model: "contract/contract-second" } },
      { method: "sessions.list", params: {} },
    ]);
  });

  it("stops local stream waiting when AbortSignal aborts", async () => {
    const transport = new FakeTransport();
    transport.fixtures.set("chat.send", { runId: "run-1", status: "accepted" });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const controller = new AbortController();
    const iterator = client.chat.send({ sessionId: "session-1", clientRequestId: "request-1", blocks: [{ type: "text", text: "hello", format: "plain" }] }, controller.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "started" } });
    const waiting = iterator.next();
    controller.abort();
    await expect(waiting).resolves.toEqual({ value: undefined, done: true });
  });

  it("recovers a missing chat final event from agent.wait and authoritative history", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("agent.wait", "chat.history");
    transport.fixtures.set("chat.send", { runId: "run-wait", status: "accepted" });
    transport.fixtures.set("agent.wait", { runId: "run-wait", status: "ok", endedAt: 2 });
    transport.fixtureQueues.set("chat.history", [
      {
        sessionKey: "session-1",
        sessionId: "session-1",
        messages: [
          {
            role: "user",
            content: "hello",
            timestamp: 1,
            idempotencyKey: "request-wait:user",
            __openclaw: { id: "message-user", idempotencyKey: "request-wait:user", recordTimestampMs: 1, seq: 1 },
          },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-time", name: "session_status", arguments: {} }],
            timestamp: 2,
            __openclaw: { id: "message-tool-call", recordTimestampMs: 2, seq: 2 },
          },
          {
            role: "toolResult",
            content: [{ type: "text", text: "12:53 PM" }],
            timestamp: 3,
            __openclaw: { id: "message-tool-result", recordTimestampMs: 3, seq: 3 },
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "history answer" }],
            timestamp: 4,
            __openclaw: { id: "message-assistant", recordTimestampMs: 4, seq: 4 },
          },
          {
            role: "user",
            content: "next turn",
            timestamp: 5,
            __openclaw: { id: "message-next-user", recordTimestampMs: 5, seq: 5 },
          },
        ],
      },
    ]);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const events = [];
    for await (const event of client.chat.send({
      sessionId: "session-1",
      clientRequestId: "request-wait",
      blocks: [{ type: "text", text: "hello", format: "plain" }],
    })) events.push(event);

    expect(events).toMatchObject([
      { type: "started", runId: "run-wait" },
      { type: "tool", runId: "run-wait", tool: { id: "call-time", toolId: "session_status", state: "running" } },
      { type: "final", runId: "run-wait", message: { role: "assistant", blocks: [expect.objectContaining({ text: "history answer" })] } },
    ]);
    expect(transport.requests).toEqual(expect.arrayContaining([
      { method: "agent.wait", params: { runId: "run-wait", timeoutMs: 10_000 } },
      { method: "chat.history", params: { sessionKey: "session-1" } },
    ]));
  });

  it("maps transcript toolCall and toolResult records to canonical tool events during recovery", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("agent.wait", "chat.history");
    transport.fixtures.set("chat.send", { runId: "run-tool-recovery", status: "accepted" });
    transport.fixtures.set("agent.wait", { runId: "run-tool-recovery", status: "ok" });
    transport.fixtures.set("chat.history", {
      sessionKey: "session-1",
      sessionId: "session-1",
      messages: [
        {
          role: "user", content: "read package", timestamp: 1,
          idempotencyKey: "request-tool-recovery:user",
          __openclaw: { id: "user-tool-recovery", idempotencyKey: "request-tool-recovery:user", recordTimestampMs: 1, seq: 1 },
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "package.json" } }],
          stopReason: "toolUse",
          timestamp: 2,
          __openclaw: { id: "assistant-tool-call", recordTimestampMs: 2, seq: 2 },
        },
        {
          role: "toolResult", toolCallId: "call-read", toolName: "read", isError: false,
          content: [{ type: "text", text: "package content" }], timestamp: 3,
          __openclaw: { id: "tool-result", recordTimestampMs: 3, seq: 3 },
        },
        {
          role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 4,
          __openclaw: { id: "assistant-final", recordTimestampMs: 4, seq: 4 },
        },
      ],
    });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const events = [];
    for await (const event of client.chat.send({
      sessionId: "session-1",
      clientRequestId: "request-tool-recovery",
      blocks: [{ type: "text", text: "read package", format: "plain" }],
    })) events.push(event);

    expect(events).toMatchObject([
      { type: "started", runId: "run-tool-recovery" },
      { type: "tool", runId: "run-tool-recovery", tool: { id: "call-read", toolId: "read", state: "running" } },
      { type: "tool", runId: "run-tool-recovery", tool: { id: "call-read", toolId: "read", state: "succeeded" } },
      { type: "final", runId: "run-tool-recovery", message: { blocks: [{ text: "done" }] } },
    ]);
  });

  it("trusts an authoritative successful assistant reply when agent.wait reports an earlier tool error", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("agent.wait", "chat.history");
    transport.fixtures.set("chat.send", { runId: "run-recovered-tool", status: "accepted" });
    transport.fixtures.set("agent.wait", { runId: "run-recovered-tool", status: "error" });
    transport.fixtures.set("chat.history", {
      sessionKey: "session-1", sessionId: "session-1",
      messages: [
        {
          role: "user", content: "帮我打开 WPS", timestamp: 1,
          idempotencyKey: "request-recovered-tool:user",
          __openclaw: { id: "user-recovered-tool", idempotencyKey: "request-recovered-tool:user", recordTimestampMs: 1, seq: 1 },
        },
        {
          role: "assistant", content: [{ type: "text", text: "WPS 已打开。" }], timestamp: 2,
          __openclaw: { id: "assistant-recovered-tool", recordTimestampMs: 2, seq: 2 },
        },
      ],
    });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const events = [];
    for await (const event of client.chat.send({
      sessionId: "session-1", clientRequestId: "request-recovered-tool",
      blocks: [{ type: "text", text: "帮我打开 WPS", format: "plain" }],
    })) events.push(event);

    expect(events).toMatchObject([
      { type: "started", runId: "run-recovered-tool" },
      { type: "final", runId: "run-recovered-tool", message: { blocks: [{ text: "WPS 已打开。" }] } },
    ]);
  });

  it("terminates chat send with an error when missing-final recovery fails", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("agent.wait", "chat.history");
    transport.fixtures.set("chat.send", { runId: "run-failed", status: "accepted" });
    transport.requestGates.set("agent.wait", Promise.reject(new RpcRemoteError("UNAVAILABLE", "wait failed", true)));
    transport.fixtures.set("chat.history", { sessionKey: "session-1", sessionId: "session-1", messages: [] });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const events = [];
    for await (const event of client.chat.send({
      sessionId: "session-1",
      clientRequestId: "request-failed",
      blocks: [{ type: "text", text: "hello", format: "plain" }],
    })) events.push(event);

    expect(events).toMatchObject([
      { type: "started", runId: "run-failed" },
      { type: "error", runId: "run-failed", error: { code: "UNAVAILABLE", retryable: true } },
    ]);
  });

  it("reports an upstream provider rejection instead of a protocol mapping failure", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("agent.wait", "chat.history");
    transport.fixtures.set("chat.send", { runId: "run-provider-blocked", status: "accepted" });
    transport.fixtures.set("agent.wait", { runId: "run-provider-blocked", status: "error" });
    transport.fixtures.set("chat.history", {
      sessionKey: "session-1",
      sessionId: "session-1",
      messages: [
        {
          role: "user", content: "blocked", timestamp: 1, idempotencyKey: "request-provider-blocked:user",
          __openclaw: { id: "user-provider-blocked", idempotencyKey: "request-provider-blocked:user", recordTimestampMs: 1, seq: 1 },
        },
        {
          role: "assistant", content: [], timestamp: 2, errorMessage: "403 Your request was blocked.",
          __openclaw: { id: "assistant-provider-blocked", recordTimestampMs: 2, seq: 2 },
        },
      ],
    });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const events = [];
    for await (const event of client.chat.send({
      sessionId: "session-1",
      clientRequestId: "request-provider-blocked",
      blocks: [{ type: "text", text: "blocked", format: "plain" }],
    })) events.push(event);

    expect(events).toMatchObject([
      { type: "started", runId: "run-provider-blocked" },
      {
        type: "error",
        runId: "run-provider-blocked",
        error: {
          code: "OPERATION_FAILED",
          message: "模型服务拒绝了此次请求（403）。请修改消息后重试。",
          retryable: true,
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("PROTOCOL_MAPPING_FAILED");
  });

  it("does not recover another concurrent turn after the next user message", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("agent.wait", "chat.history");
    transport.fixtures.set("chat.send", { runId: "run-target", status: "accepted" });
    transport.fixtures.set("agent.wait", { runId: "run-target", status: "ok" });
    transport.fixtures.set("chat.history", {
      sessionKey: "session-1",
      sessionId: "session-1",
      messages: [
        {
          role: "user", content: "target", timestamp: 1, idempotencyKey: "request-target:user",
          __openclaw: { id: "user-target", idempotencyKey: "request-target:user", recordTimestampMs: 1, seq: 1 },
        },
        {
          role: "user", content: "other", timestamp: 2, idempotencyKey: "request-other:user",
          __openclaw: { id: "user-other", idempotencyKey: "request-other:user", recordTimestampMs: 2, seq: 2 },
        },
        {
          role: "assistant", content: [{ type: "text", text: "other answer" }], timestamp: 3,
          __openclaw: { id: "assistant-other", recordTimestampMs: 3, seq: 3 },
        },
      ],
    });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const events = [];
    for await (const event of client.chat.send({
      sessionId: "session-1",
      clientRequestId: "request-target",
      blocks: [{ type: "text", text: "target", format: "plain" }],
    })) events.push(event);

    expect(events).toMatchObject([
      { type: "started", runId: "run-target" },
      { type: "error", runId: "run-target", error: { code: "PROTOCOL_MAPPING_FAILED" } },
    ]);
    expect(JSON.stringify(events)).not.toContain("other answer");
  });

  it("aborts a late accepted run after local pre-start cancellation", async () => {
    const transport = new FakeTransport();
    transport.fixtures.set("chat.abort", {});
    let acceptSend: (value: JsonValue) => void = () => undefined;
    transport.requestGates.set("chat.send", new Promise((resolve) => { acceptSend = resolve; }));
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const controller = new AbortController();
    const iterator = client.chat.send({
      sessionId: "session-1", clientRequestId: "request-late-accepted", blocks: [{ type: "text", text: "cancel", format: "plain" }],
    }, controller.signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    await Promise.resolve();

    controller.abort();
    const localResult = await Promise.race([
      first,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 20)),
    ]);
    acceptSend({ runId: "run-late-accepted", status: "accepted" });

    expect(localResult).toEqual({ value: undefined, done: true });
    await vi.waitFor(() => expect(transport.requests).toContainEqual({ method: "chat.abort", params: { runId: "run-late-accepted" } }));
  });

  it("removes chat listener when send RPC rejects", async () => {
    const transport = new FakeTransport();
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const iterator = client.chat.send({ sessionId: "session-1", clientRequestId: "request-fail", blocks: [{ type: "text", text: "hello", format: "plain" }] })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow();
    expect(transport.eventListeners.size).toBe(0);
  });

  it("fails active watch and send streams when their router closes", async () => {
    const transport = new FakeTransport();
    transport.fixtures.set("chat.send", { runId: "run-1", status: "accepted" });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const watch = client.chat.watch("session-1")[Symbol.asyncIterator]();
    const watchWaiting = watch.next();
    const send = client.chat.send({ sessionId: "session-1", clientRequestId: "request-1", blocks: [{ type: "text", text: "hello", format: "plain" }] })[Symbol.asyncIterator]();
    await send.next();
    const sendWaiting = send.next();
    transport.close();
    const watchError = await watchWaiting.catch((error: unknown) => error);
    const sendError = await sendWaiting.catch((error: unknown) => error);
    expect(UClawErrorSchema.parse((watchError as { uclawError: unknown }).uclawError).code).toBe("GATEWAY_DISCONNECTED");
    expect(UClawErrorSchema.parse((sendError as { uclawError: unknown }).uclawError).code).toBe("GATEWAY_DISCONNECTED");
  });

  it("allows a new watch subscription after reconnect", async () => {
    const transport = new FakeTransport();
    const clock = new ManualClock();
    const client = new OpenClawClient({ transport, reconnectPolicy: new ReconnectPolicy({ clock, random: () => 0.5 }) });
    await client.gateway.negotiate();
    const reconnect = client.gateway.reconnect();
    await clock.advance(800);
    await reconnect;
    const iterator = client.chat.watch("session-1")[Symbol.asyncIterator]();
    const event = iterator.next();
    transport.emit("chat", { state: "delta", runId: "run-1", sessionKey: "session-1", deltaText: "A" }, 1);
    await expect(event).resolves.toMatchObject({ value: { type: "delta", text: "A" } });
    await iterator.return?.();
  });

  it("streams shared gateway status changes with stable since values", async () => {
    const transport = new FakeTransport();
    const times = ["2026-08-07T12:00:00.000Z", "2026-08-07T12:00:01.000Z", "2026-08-07T12:00:02.000Z"];
    const client = new OpenClawClient({ transport, now: () => times.shift() ?? "2026-08-07T12:00:02.000Z" });
    const first = client.gateway.watchStatus()[Symbol.asyncIterator]();
    const second = client.gateway.watchStatus()[Symbol.asyncIterator]();
    expect((await first.next()).value?.connectionState).toBe("idle");
    expect((await second.next()).value?.connectionState).toBe("idle");
    const negotiation = client.gateway.negotiate();
    expect((await first.next()).value?.connectionState).toBe("connecting");
    expect((await second.next()).value?.connectionState).toBe("connecting");
    await negotiation;
    const ready = (await first.next()).value;
    expect(ready?.connectionState).toBe("ready");
    expect((await client.gateway.getStatus()).since).toBe(ready?.since);
    await first.return?.();
    await second.return?.();
  });

  it("reports safe idle process and USB defaults without a production status projection", async () => {
    const client = new OpenClawClient({ transport: new FakeTransport() });

    await expect(client.gateway.getStatus()).resolves.toMatchObject({
      connectionState: "idle",
      processAlive: false,
      usb: { state: "missing", dataWritable: false },
    });
  });

  it("uses the injected production process and USB status projection", async () => {
    const client = new OpenClawClient({
      transport: new FakeTransport(),
      statusProjection: () => ({
        processAlive: true,
        usb: { state: "read-only", dataWritable: false, displayName: "U-Claw Data" },
      }),
    });

    await expect(client.gateway.getStatus()).resolves.toMatchObject({
      processAlive: true,
      usb: { state: "read-only", dataWritable: false, displayName: "U-Claw Data" },
    });
  });

  it("routes tool and separate approval families into message watch", async () => {
    const tools = contractFixture("session.tool.json");
    const approvals = contractFixture("approvals.json");
    const transport = new FakeTransport();
    const approvalChanges: string[] = [];
    transport.fixtures.set("exec.approval.list", []);
    transport.fixtures.set("plugin.approval.list", approvals.plugin.allowOnce.listing.responseFrame.payload);
    transport.fixtures.set("chat.send", { runId: "run-approval-1", status: "accepted" });
    const client = new OpenClawClient({ transport, onApprovalsChanged: (sessionId) => { approvalChanges.push(sessionId); } });
    await client.gateway.negotiate();
    await client.approvals.listPending("agent:dev:main");
    const send = client.chat.send({
      sessionId: "agent:dev:main",
      clientRequestId: "request-approval-1",
      blocks: [{ type: "text", text: "approve", format: "plain" }],
    })[Symbol.asyncIterator]();
    await expect(send.next()).resolves.toMatchObject({ value: { type: "started", runId: "run-approval-1" } });
    const iterator = client.chat.watch("agent:dev:main")[Symbol.asyncIterator]();
    const toolEvent = structuredClone(tools.start.payload);
    toolEvent.runId = "run-approval-1";
    toolEvent.data.toolCallId = "tool-call-approval-1";
    const watchedTool = iterator.next();
    const sentTool = send.next();
    transport.emit("session.tool", toolEvent, 1);
    await expect(watchedTool).resolves.toMatchObject({ value: { type: "tool", runId: "run-approval-1" } });
    await expect(sentTool).resolves.toMatchObject({ value: { type: "tool", runId: "run-approval-1" } });

    const exactPlugin = structuredClone(approvals.plugin.allowOnce.event.payload);
    exactPlugin.request.toolCallId = "tool-call-approval-1";
    const watchedWaiting = iterator.next();
    const sentWaiting = send.next();
    transport.emit("plugin.approval.requested", exactPlugin, 2);
    await expect(watchedWaiting).resolves.toMatchObject({ value: { type: "tool", tool: { state: "waiting-authorization" } } });
    await expect(sentWaiting).resolves.toMatchObject({ value: { type: "tool", tool: { state: "waiting-authorization" } } });
    const watchedApproval = iterator.next();
    const sentApproval = send.next();
    await expect(watchedApproval).resolves.toMatchObject({ value: { type: "approval", runId: "run-approval-1", approval: { id: exactPlugin.id, family: "plugin" } } });
    await expect(sentApproval).resolves.toMatchObject({ value: { type: "approval", runId: "run-approval-1", approval: { id: exactPlugin.id, family: "plugin" } } });

    const otherSessionExec = structuredClone(approvals.exec.allowOnce.event.payload);
    otherSessionExec.id = "exec-other-session-event";
    otherSessionExec.request.sessionKey = "agent:dev:other";
    transport.emit("exec.approval.requested", otherSessionExec, 3);
    transport.emit("exec.approval.requested", approvals.exec.allowOnce.event.payload, 4);
    await Promise.resolve();
    expect(approvalChanges).toEqual(["agent:dev:main"]);
    await send.return?.();
    await iterator.return?.();
  });

  it("correlates approvals by tool call across concurrent sends in one session", async () => {
    const tools = contractFixture("session.tool.json");
    const approvals = contractFixture("approvals.json");
    const transport = new FakeTransport();
    const approvalChanges: string[] = [];
    transport.fixtureQueues.set("chat.send", [
      { runId: "run-concurrent-1", status: "accepted" },
      { runId: "run-concurrent-2", status: "accepted" },
    ]);
    const client = new OpenClawClient({ transport, onApprovalsChanged: (sessionId) => { approvalChanges.push(sessionId); } });
    await client.gateway.negotiate();
    const input = (clientRequestId: string) => ({
      sessionId: "agent:dev:main",
      clientRequestId,
      blocks: [{ type: "text" as const, text: "concurrent", format: "plain" as const }],
    });
    const first = client.chat.send(input("concurrent-1"))[Symbol.asyncIterator]();
    const second = client.chat.send(input("concurrent-2"))[Symbol.asyncIterator]();
    await first.next();
    await second.next();

    const toolEvent = (runId: string, toolCallId: string) => {
      const event = structuredClone(tools.start.payload);
      event.runId = runId;
      event.data.toolCallId = toolCallId;
      return event;
    };
    transport.emit("session.tool", toolEvent("run-concurrent-1", "tool-concurrent-1"), 1);
    transport.emit("session.tool", toolEvent("run-concurrent-2", "tool-concurrent-2"), 2);
    await expect(first.next()).resolves.toMatchObject({ value: { type: "tool", runId: "run-concurrent-1" } });
    await expect(second.next()).resolves.toMatchObject({ value: { type: "tool", runId: "run-concurrent-2" } });

    const approvalEvent = (id: string, toolCallId: string) => {
      const event = structuredClone(approvals.plugin.allowOnce.event.payload);
      event.id = id;
      event.request.toolCallId = toolCallId;
      return event;
    };
    transport.emit("plugin.approval.requested", approvalEvent("plugin-concurrent-1", "tool-concurrent-1"), 3);
    transport.emit("plugin.approval.requested", approvalEvent("plugin-concurrent-2", "tool-concurrent-2"), 4);
    await expect(first.next()).resolves.toMatchObject({ value: { type: "tool", runId: "run-concurrent-1", tool: { state: "waiting-authorization" } } });
    await expect(second.next()).resolves.toMatchObject({ value: { type: "tool", runId: "run-concurrent-2", tool: { state: "waiting-authorization" } } });
    await expect(first.next()).resolves.toMatchObject({ value: { type: "approval", runId: "run-concurrent-1", approval: { id: "plugin-concurrent-1" } } });
    await expect(second.next()).resolves.toMatchObject({ value: { type: "approval", runId: "run-concurrent-2", approval: { id: "plugin-concurrent-2" } } });

    transport.emit("exec.approval.requested", approvals.exec.allowOnce.event.payload, 5);
    await Promise.resolve();
    expect(approvalChanges).toEqual(["agent:dev:main"]);
    const finalMessage = (runId: string) => ({
      state: "final",
      runId,
      sessionKey: "agent:dev:main",
      message: {
        id: `message-${runId}`,
        sessionKey: "agent:dev:main",
        runId,
        role: "assistant",
        status: "completed",
        blocks: [],
        createdAt: "2026-08-08T00:00:00.000Z",
      },
    });
    transport.emit("chat", finalMessage("run-concurrent-1"), 6);
    transport.emit("chat", finalMessage("run-concurrent-2"), 7);
    await expect(first.next()).resolves.toMatchObject({ value: { type: "final", runId: "run-concurrent-1" } });
    await expect(second.next()).resolves.toMatchObject({ value: { type: "final", runId: "run-concurrent-2" } });
    await first.return?.();
    await second.return?.();
  });

  it("buffers a correlated approval received before chat.send responds", async () => {
    const tools = contractFixture("session.tool.json");
    const approvals = contractFixture("approvals.json");
    const transport = new FakeTransport();
    let acceptSend: (value: JsonValue) => void = () => undefined;
    transport.requestGates.set("chat.send", new Promise((resolve) => { acceptSend = resolve; }));
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const send = client.chat.send({
      sessionId: "agent:dev:main",
      clientRequestId: "request-race",
      blocks: [{ type: "text", text: "race", format: "plain" }],
    })[Symbol.asyncIterator]();
    const started = send.next();
    await Promise.resolve();
    const tool = structuredClone(tools.start.payload);
    tool.runId = "run-race";
    tool.data.toolCallId = "tool-race";
    transport.emit("session.tool", tool, 1);
    const approval = structuredClone(approvals.plugin.allowOnce.event.payload);
    approval.request.toolCallId = "tool-race";
    transport.emit("plugin.approval.requested", approval, 2);
    acceptSend({ runId: "run-race", status: "accepted" });
    await expect(started).resolves.toMatchObject({ value: { type: "started", runId: "run-race" } });
    transport.emit("chat", {
      state: "final",
      runId: "run-race",
      sessionKey: "agent:dev:main",
      message: {
        id: "message-race",
        sessionKey: "agent:dev:main",
        runId: "run-race",
        role: "assistant",
        status: "completed",
        blocks: [],
        createdAt: "2026-08-08T00:00:00.000Z",
      },
    }, 3);
    await expect(send.next()).resolves.toMatchObject({ value: { type: "tool", runId: "run-race" } });
    await expect(send.next()).resolves.toMatchObject({ value: { type: "tool", runId: "run-race", tool: { state: "waiting-authorization" } } });
    await expect(send.next()).resolves.toMatchObject({ value: { type: "approval", runId: "run-race" } });
    await expect(send.next()).resolves.toMatchObject({ value: { type: "final", runId: "run-race" } });
  });

  it("keeps identical tool call ids isolated across sessions", async () => {
    const tools = contractFixture("session.tool.json");
    const approvals = contractFixture("approvals.json");
    const transport = new FakeTransport();
    const approvalChanges: string[] = [];
    const client = new OpenClawClient({ transport, onApprovalsChanged: (sessionId) => { approvalChanges.push(sessionId); } });
    await client.gateway.negotiate();
    const first = client.chat.watch("agent:dev:first")[Symbol.asyncIterator]();
    const second = client.chat.watch("agent:dev:second")[Symbol.asyncIterator]();
    const toolEvent = (sessionKey: string, runId: string) => {
      const event = structuredClone(tools.start.payload);
      event.sessionKey = sessionKey;
      event.runId = runId;
      event.data.toolCallId = "shared-tool-call";
      return event;
    };
    const firstTool = first.next();
    const secondTool = second.next();
    transport.emit("session.tool", toolEvent("agent:dev:first", "run-first"), 1);
    transport.emit("session.tool", toolEvent("agent:dev:second", "run-second"), 2);
    await expect(firstTool).resolves.toMatchObject({ value: { type: "tool", runId: "run-first" } });
    await expect(secondTool).resolves.toMatchObject({ value: { type: "tool", runId: "run-second" } });

    const approvalEvent = (sessionKey: string, id: string) => {
      const event = structuredClone(approvals.plugin.allowOnce.event.payload);
      event.id = id;
      event.request.sessionKey = sessionKey;
      event.request.toolCallId = "shared-tool-call";
      return event;
    };
    const firstWaiting = first.next();
    const secondWaiting = second.next();
    transport.emit("plugin.approval.requested", approvalEvent("agent:dev:first", "approval-first"), 3);
    transport.emit("plugin.approval.requested", approvalEvent("agent:dev:second", "approval-second"), 4);
    await Promise.resolve();
    expect(approvalChanges).toEqual([]);
    await expect(firstWaiting).resolves.toMatchObject({ value: { type: "tool", runId: "run-first", tool: { state: "waiting-authorization" } } });
    await expect(secondWaiting).resolves.toMatchObject({ value: { type: "tool", runId: "run-second", tool: { state: "waiting-authorization" } } });
    await expect(first.next()).resolves.toMatchObject({ value: { type: "approval", runId: "run-first", approval: { id: "approval-first" } } });
    await expect(second.next()).resolves.toMatchObject({ value: { type: "approval", runId: "run-second", approval: { id: "approval-second" } } });
    await first.return?.();
    await second.return?.();
  });

  it("does not bind late approvals after a run reaches a terminal event", async () => {
    const tools = contractFixture("session.tool.json");
    const approvals = contractFixture("approvals.json");
    const transport = new FakeTransport();
    const approvalChanges: string[] = [];
    transport.fixtures.set("chat.send", { runId: "run-terminal", status: "accepted" });
    const client = new OpenClawClient({ transport, onApprovalsChanged: (sessionId) => { approvalChanges.push(sessionId); } });
    await client.gateway.negotiate();
    const send = client.chat.send({
      sessionId: "agent:dev:main",
      clientRequestId: "request-terminal",
      blocks: [{ type: "text", text: "terminal", format: "plain" }],
    })[Symbol.asyncIterator]();
    await send.next();
    const tool = structuredClone(tools.start.payload);
    tool.runId = "run-terminal";
    tool.data.toolCallId = "tool-terminal";
    transport.emit("session.tool", tool, 1);
    await send.next();
    transport.emit("chat", {
      state: "final",
      runId: "run-terminal",
      sessionKey: "agent:dev:main",
      message: {
        id: "message-terminal",
        sessionKey: "agent:dev:main",
        runId: "run-terminal",
        role: "assistant",
        status: "completed",
        blocks: [],
        createdAt: "2026-08-08T00:00:00.000Z",
      },
    }, 2);
    await send.next();

    const watch = client.chat.watch("agent:dev:main")[Symbol.asyncIterator]();
    const next = watch.next();
    const lateApproval = structuredClone(approvals.plugin.allowOnce.event.payload);
    lateApproval.request.toolCallId = "tool-terminal";
    transport.emit("plugin.approval.requested", lateApproval, 3);
    transport.emit("chat", { state: "delta", runId: "run-other", sessionKey: "agent:dev:main", deltaText: "next" }, 4);
    await expect(next).resolves.toMatchObject({ value: { type: "delta", runId: "run-other" } });
    expect(approvalChanges).toEqual(["agent:dev:main"]);
    await watch.return?.();
  });

  it("keeps a denied approval cancelled when tool start arrives late", async () => {
    const tools = contractFixture("session.tool.json");
    const approvals = contractFixture("approvals.json");
    const transport = new FakeTransport();
    transport.helloMethods.push("plugin.approval.resolve");
    transport.fixtures.set("plugin.approval.resolve", { ok: true });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const watch = client.chat.watch("agent:dev:main")[Symbol.asyncIterator]();
    const next = watch.next();
    const approval = structuredClone(approvals.plugin.deny.event.payload);
    transport.emit("plugin.approval.requested", approval, 1);
    await client.approvals.resolvePlugin({ ref: { family: "plugin", id: approval.id }, decision: "deny" });
    const start = structuredClone(tools.start.payload);
    start.data.toolCallId = approval.request.toolCallId;
    transport.emit("session.tool", start, 2);
    await expect(next).resolves.toMatchObject({ value: { type: "tool", tool: { state: "cancelled" } } });
    await watch.return?.();
  });

  it("keeps colon-bearing session and tool ids isolated during denial and terminal cleanup", async () => {
    const tools = contractFixture("session.tool.json");
    const approvals = contractFixture("approvals.json");
    const transport = new FakeTransport();
    transport.helloMethods.push("plugin.approval.resolve");
    transport.fixtures.set("plugin.approval.resolve", { ok: true });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const first = client.chat.watch("a:b")[Symbol.asyncIterator]();
    const firstTool = first.next();
    const approval = structuredClone(approvals.plugin.deny.event.payload);
    approval.id = "approval-colon-collision";
    approval.request.sessionKey = "a:b";
    approval.request.toolCallId = "c";
    transport.emit("plugin.approval.requested", approval, 1);
    await client.approvals.resolvePlugin({ ref: { family: "plugin", id: approval.id }, decision: "deny" });

    const second = client.chat.watch("a")[Symbol.asyncIterator]();
    const secondTool = second.next();
    const start = (sessionKey: string, toolCallId: string, runId: string) => {
      const event = structuredClone(tools.start.payload);
      event.sessionKey = sessionKey;
      event.data.toolCallId = toolCallId;
      event.runId = runId;
      return event;
    };
    transport.emit("session.tool", start("a", "b:c", "run-second"), 2);
    await expect(secondTool).resolves.toMatchObject({ value: { type: "tool", tool: { state: "running" } } });

    const terminal = second.next();
    transport.emit("chat", {
      state: "aborted", runId: "run-second", sessionKey: "a", errorMessage: "stopped",
    }, 3);
    await expect(terminal).resolves.toMatchObject({ value: { type: "aborted", runId: "run-second" } });

    transport.emit("session.tool", start("a:b", "c", "run-first"), 4);
    await expect(firstTool).resolves.toMatchObject({ value: { type: "tool", tool: { state: "cancelled" } } });
    await first.return?.();
    await second.return?.();
  });

  it("clears tool approval associations across disconnect and reconnect", async () => {
    const tools = contractFixture("session.tool.json");
    const approvals = contractFixture("approvals.json");
    const transport = new FakeTransport();
    const clock = new ManualClock();
    const approvalChanges: string[] = [];
    const client = new OpenClawClient({
      transport,
      reconnectPolicy: new ReconnectPolicy({ clock, random: () => 0.5 }),
      onApprovalsChanged: (sessionId) => { approvalChanges.push(sessionId); },
    });
    await client.gateway.negotiate();
    const watch = client.chat.watch("agent:dev:main")[Symbol.asyncIterator]();
    const first = watch.next();
    const tool = structuredClone(tools.start.payload);
    tool.runId = "run-disconnected";
    tool.data.toolCallId = "tool-disconnected";
    transport.emit("session.tool", tool, 1);
    await first;
    const closed = watch.next();
    transport.close();
    await closed.catch(() => undefined);
    const reconnect = client.gateway.reconnect();
    await clock.advance(800);
    await reconnect;

    const afterReconnect = client.chat.watch("agent:dev:main")[Symbol.asyncIterator]();
    const next = afterReconnect.next();
    const lateApproval = structuredClone(approvals.plugin.allowOnce.event.payload);
    lateApproval.request.toolCallId = "tool-disconnected";
    transport.emit("plugin.approval.requested", lateApproval, 1);
    transport.emit("chat", { state: "delta", runId: "run-new", sessionKey: "agent:dev:main", deltaText: "new" }, 2);
    await expect(next).resolves.toMatchObject({ value: { type: "delta", runId: "run-new" } });
    expect(approvalChanges).toEqual(["agent:dev:main"]);
    await afterReconnect.return?.();
  });

  it("triggers resync instead of mapping a source sequence gap", async () => {
    const transport = new FakeTransport();
    const gaps: Array<{ expected: number; received: number }> = [];
    const controller = new AbortController();
    const client = new OpenClawClient({ transport, onResyncRequired: (gap) => { gaps.push(gap); } });
    await client.gateway.negotiate();
    const iterator = client.chat.watch("session-1", controller.signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    transport.emit("chat", { state: "delta", runId: "run-1", sessionKey: "session-1", deltaText: "A" }, 7);
    await first;
    const waiting = iterator.next();
    transport.emit("chat", { state: "delta", runId: "run-1", sessionKey: "session-1", deltaText: "C" }, 9);
    await Promise.resolve();
    expect(gaps).toEqual([{ expected: 8, received: 9 }]);
    await Promise.resolve();
    expect(transport.resetSequences).toEqual([9]);
    controller.abort();
    await waiting;
  });

  it("reconnects when sequence resync rejects", async () => {
    const transport = new FakeTransport();
    const clock = new ManualClock();
    const client = new OpenClawClient({
      transport,
      reconnectPolicy: new ReconnectPolicy({ clock, random: () => 0.5 }),
      onResyncRequired: () => { throw new Error("resync failed"); },
    });
    await client.gateway.negotiate();
    transport.emit("chat", { state: "delta", runId: "run-1", sessionKey: "session-1", deltaText: "A" }, 10);
    transport.emit("chat", { state: "delta", runId: "run-1", sessionKey: "session-1", deltaText: "C" }, 12);
    await Promise.resolve();
    await clock.advance(800);
    await Promise.resolve();
    expect(transport.connectCalls).toBe(2);
  });

  it("drops buffered events after a terminal event", async () => {
    const transport = new FakeTransport();
    let acceptSend: (value: JsonValue) => void = () => undefined;
    transport.requestGates.set("chat.send", new Promise((resolve) => { acceptSend = resolve; }));
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const iterator = client.chat.send({ sessionId: "session-1", clientRequestId: "request-1", blocks: [{ type: "text", text: "hello", format: "plain" }] })[Symbol.asyncIterator]();
    const started = iterator.next();
    await Promise.resolve();
    transport.emit("chat", {
      state: "final", runId: "run-1", sessionKey: "session-1",
      message: { id: "message-1", sessionKey: "session-1", runId: "run-1", role: "assistant", status: "completed", blocks: [], createdAt: "2026-08-07T12:00:00.000Z" },
    }, 1);
    transport.emit("chat", { state: "delta", runId: "run-1", sessionKey: "session-1", deltaText: "late" }, 2);
    acceptSend({ runId: "run-1", status: "accepted" });
    await expect(started).resolves.toMatchObject({ value: { type: "started" } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "final" } });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("settles every pending queue waiter when a terminal value arrives", async () => {
    const queue = new AsyncEventQueue<number>();
    const first = queue.next();
    const second = queue.next();
    queue.push(1, true);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { value: 1, done: false },
      { value: undefined, done: true },
    ]);
  });

  it("rejects extra fields in known page responses", async () => {
    const transport = new FakeTransport();
    transport.fixtures.set("sessions.list", { sessions: [], nextCursor: null, hasMore: false, extra: true });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    await expect(client.sessions.list()).rejects.toThrow();
  });

  it("uses injected backoff before reconnecting", async () => {
    const transport = new FakeTransport();
    const clock = new ManualClock();
    const client = new OpenClawClient({ transport, reconnectPolicy: new ReconnectPolicy({ clock, random: () => 0.5 }) });
    await client.gateway.negotiate();
    const statuses = client.gateway.watchStatus()[Symbol.asyncIterator]();
    await statuses.next();
    const reconnect = client.gateway.reconnect();
    await expect(statuses.next()).resolves.toMatchObject({ value: { connectionState: "reconnecting", attempt: 1 } });
    expect(transport.connectCalls).toBe(1);
    await clock.advance(800);
    await reconnect;
    expect(transport.connectCalls).toBe(2);
    await expect(statuses.next()).resolves.toMatchObject({ value: { connectionState: "connecting", attempt: 1 } });
    const ready = (await statuses.next()).value;
    expect(ready).toMatchObject({ connectionState: "ready", attempt: 0 });
    expect(await client.gateway.getStatus()).toEqual(ready);
    await statuses.return?.();
  });

  it("honors bounded startup retryAfterMs before negotiating again", async () => {
    const transport = new FakeTransport();
    transport.connectFailures.push(new RpcRemoteError("UNAVAILABLE", "starting", true, 20));
    const clock = new ManualClock();
    const client = new OpenClawClient({ transport, reconnectPolicy: new ReconnectPolicy({ clock, random: () => 0.5 }) });
    const negotiation = client.gateway.negotiate();
    await Promise.resolve();
    expect(transport.connectCalls).toBe(1);
    await clock.advance(100);
    await negotiation;
    expect(transport.connectCalls).toBe(2);
  });

  it("bounds approval indexes and terminal run dedupe state", async () => {
    const approvals = contractFixture("approvals.json");
    const transport = new FakeTransport();
    const entries = Array.from({ length: 300 }, (_, index) => {
      const entry = structuredClone(approvals.exec.allowOnce.event.payload);
      entry.id = `approval-bounded-${index}`;
      entry.request.toolCallId = `tool-bounded-${index}`;
      return entry;
    });
    transport.fixtures.set("exec.approval.list", entries);
    transport.fixtures.set("plugin.approval.list", []);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    await client.approvals.listPending();
    const internal = client as unknown as {
      approvalRequests: Map<unknown, unknown>;
      approvalToolIndex: Map<unknown, unknown>;
      terminalRuns: Set<unknown>;
    };
    expect(internal.approvalRequests.size).toBeLessThanOrEqual(256);
    expect(internal.approvalToolIndex.size).toBeLessThanOrEqual(256);

    const watch = client.chat.watch("agent:dev:main")[Symbol.asyncIterator]();
    for (let index = 0; index < 300; index += 1) {
      transport.emit("chat", {
        state: "aborted", runId: `run-bounded-${index}`, sessionKey: "agent:dev:main", errorMessage: "stopped",
      }, index + 1);
    }
    expect(internal.terminalRuns.size).toBeLessThanOrEqual(256);
    await watch.return?.();
  });

  it("replaces a stale tool-call index when an approval snapshot is remapped", async () => {
    const approvals = contractFixture("approvals.json");
    const transport = new FakeTransport();
    const entry = structuredClone(approvals.exec.allowOnce.event.payload);
    entry.request.toolCallId = "tool-original";
    transport.fixtures.set("exec.approval.list", [entry]);
    transport.fixtures.set("plugin.approval.list", []);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    await client.approvals.listPending();

    const remapped = structuredClone(entry);
    remapped.request.toolCallId = "tool-remapped";
    transport.fixtures.set("exec.approval.list", [remapped]);
    await client.approvals.listPending();

    const internal = client as unknown as { approvalToolIndex: Map<string, string> };
    const toolKey = (sessionId: string, toolCallId: string) => `${sessionId.length}:${sessionId}${toolCallId.length}:${toolCallId}`;
    expect(internal.approvalToolIndex.has(toolKey(entry.request.sessionKey, entry.request.toolCallId))).toBe(false);
    expect(internal.approvalToolIndex.get(toolKey(remapped.request.sessionKey, remapped.request.toolCallId))).toBe(`exec:${entry.id}`);
  });

  it("patches only the target mcp.servers entry with CAS and strict transport secrets", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("config.get", "config.patch");
    transport.fixtureQueues.set("config.get", [
      { hash: "config-hash", valid: true, config: {} },
      { hash: "config-hash-1", valid: true, config: { mcp: { servers: {
        header: { enabled: true, transport: "http", url: "https://header.example.com/mcp", headers: { "X-MCP-Key": "[REDACTED]" } },
      } } } },
    ]);
    transport.fixtures.set("config.patch", { ok: true });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const mcp = (client as any).mcp;
    const signal = new AbortController().signal;
    const header = {
      id: "header", name: "Header", enabled: true, transport: "http",
      url: "https://header.example.com/mcp", authentication: { type: "header", headerName: "X-MCP-Key", secret: "header-secret" },
    };

    await mcp.configure(header, signal);

    const patches = transport.requests.filter(({ method }) => method === "config.patch").map(({ params }) => params as any);
    expect(patches.map(({ baseHash }) => baseHash)).toEqual(["config-hash"]);
    expect(patches.map(({ raw }) => JSON.parse(raw))).toEqual([
      { mcp: { servers: { header: { enabled: true, transport: "http", url: "https://header.example.com/mcp", headers: { "X-MCP-Key": "header-secret" } } } } },
    ]);
    expect(transport.calls).toEqual(["config.get", "config.patch", "config.get"]);
  });

  it("uses exact replace paths and verifies authoritative readback for MCP update", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("config.get", "config.patch");
    transport.fixtureQueues.set("config.get", [
      { hash: "before", valid: true, config: { mcp: { servers: { local: { enabled: true, transport: "stdio", command: "node", args: ["old.mjs"], env: {} } } } } },
      { hash: "after", valid: true, config: { mcp: { servers: { local: { enabled: true, transport: "stdio", command: "node", args: ["new.mjs"], env: {} } } } } },
    ]);
    transport.fixtures.set("config.patch", { ok: true });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await client.mcp.configure({
      id: "local", name: "Local", enabled: true, transport: "stdio",
      executableId: "node", args: ["new.mjs"], env: {},
    }, new AbortController().signal);

    expect(transport.requests.find(({ method }) => method === "config.patch")?.params).toMatchObject({
      baseHash: "before", replacePaths: ["mcp.servers.local.args"],
    });
    expect(transport.calls).toEqual(["config.get", "config.patch", "config.get"]);
  });

  it("uses exact replace paths and verifies authoritative readback for MCP removal", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("config.get", "config.patch");
    transport.fixtureQueues.set("config.get", [
      { hash: "before", valid: true, config: { mcp: { servers: { local: { enabled: true, transport: "stdio", command: "node", args: ["server.mjs"], env: {} } } } } },
      { hash: "after", valid: true, config: { mcp: { servers: {} } } },
    ]);
    transport.fixtures.set("config.patch", { ok: true });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await client.mcp.remove({
      id: "local", name: "Local", enabled: true, transport: "stdio",
      executableId: "node", args: ["server.mjs"], env: {},
    }, new AbortController().signal);

    expect(transport.requests.find(({ method }) => method === "config.patch")?.params).toMatchObject({
      baseHash: "before", replacePaths: ["mcp.servers.local.args"],
    });
    expect(transport.calls).toEqual(["config.get", "config.patch", "config.get"]);
  });

  it("fails closed when MCP authoritative readback drops secret-bearing structure", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("config.get", "config.patch");
    transport.fixtureQueues.set("config.get", [
      { hash: "before", valid: true, config: {} },
      { hash: "after", valid: true, config: { mcp: { servers: { local: {
        enabled: true, transport: "stdio", command: "node", args: ["server.mjs"], env: {},
      } } } } },
    ]);
    transport.fixtures.set("config.patch", { ok: true });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await expect(client.mcp.configure({
      id: "local", name: "Local", enabled: true, transport: "stdio",
      executableId: "node", args: ["server.mjs"], env: { MCP_TOKEN: "secret" },
    }, new AbortController().signal)).rejects.toBeInstanceOf(RpcProtocolError);
  });

  it("mounts the managed channel runtime with logout and message operations", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push(
      "config.get", "config.patch", "channels.status", "channels.start", "channels.stop",
      "channels.logout", "tools.invoke",
    );
    transport.fixtures.set("channels.logout", { channel: "discord", accountId: "discord-main", loggedOut: true });
    transport.fixtureQueues.set("channels.status", [
      {
        ts: 1_786_129_711_211,
        channelOrder: ["discord"],
        channelLabels: { discord: "Discord" },
        channels: { discord: {} },
        channelAccounts: { discord: [{ accountId: "discord-main", enabled: true, configured: false, running: false, connected: false }] },
        channelDefaultAccountId: { discord: "discord-main" },
      },
    ]);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const runtime = client.channels as any;
    const discord = {
      id: "discord-main", kind: "discord", name: "Discord", mode: "bot", enabled: true,
      credentials: { botToken: "discord-secret" },
    };

    expect(runtime.capability("discord")).toBe(true);
    await expect(runtime.logout(discord, new AbortController().signal)).resolves.toBeUndefined();
    expect(transport.requests.map(({ method }) => method)).toEqual(["channels.logout", "channels.status"]);
  });

  it("rejects authenticated MCP configuration without a secret before Gateway access", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("config.get", "config.patch");
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const server = {
      id: "remote", name: "Remote", enabled: true, transport: "streamable-http" as const,
      url: "https://mcp.example.com/rpc", authentication: { type: "bearer" as const },
    };
    const signal = new AbortController().signal;

    for (const operation of [client.mcp.configure, client.mcp.start]) {
      await expect(operation(server, signal)).rejects.toMatchObject({
        uclawError: { code: "INVALID_ARGUMENT", retryable: false },
      });
    }
    expect(transport.calls).toEqual([]);
  });

  it("maps authoritative logs, health, system, stability, and audit RPCs", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("logs.tail", "health", "status", "system.info", "diagnostics.stability", "audit.list");
    transport.helloMethods.push("config.get");
    transport.fixtures.set("logs.tail", {
      cursor: 42, reset: false, truncated: false, size: 512,
      lines: [JSON.stringify({ 0: '{"subsystem":"gateway"}', 1: "Bearer private-log", _meta: { date: "2026-08-12T00:00:00.000Z", logLevelName: "INFO", name: '{"subsystem":"gateway"}' } })],
    });
    transport.fixtures.set("health", { ok: true, agents: [], channels: {}, sessions: {} });
    transport.fixtures.set("status", { runtimeVersion: "2026.7.1-2", tasks: {}, taskAudit: {} });
    transport.fixtures.set("system.info", { platform: "darwin", arch: "arm64", uptimeMs: 1000, nodeVersion: "24.15.0" });
    transport.fixtures.set("diagnostics.stability", { count: 3, dropped: 1, summary: { byType: { "diagnostic.phase.completed": 3 } }, events: [] });
    transport.fixtures.set("audit.list", {
      events: [{ eventId: "audit-1", sequence: 1, sourceSequence: 1, occurredAt: Date.now(), kind: "tool_action", action: "tool.execute", status: "succeeded", actor: { type: "operator", id: "private-actor" }, agentId: "main", runId: "private-run", redaction: "metadata_only" }],
    });
    transport.fixtures.set("config.get", { hash: "config-hash", valid: true, config: { gateway: { port: 18789, token: "secret" } } });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await expect(client.diagnostics.listLogs({ limit: 10 })).resolves.toMatchObject({
      items: [{ timestamp: "2026-08-12T00:00:00.000Z", level: "info", source: "gateway", message: "Gateway info event." }],
      nextCursor: "42", hasMore: false,
    });
    await client.diagnostics.listLogs({ cursor: "42", limit: 10 });
    await expect(client.diagnostics.system!()).resolves.toMatchObject({ health: { state: "ready" }, status: { state: "ready" }, info: { platform: "darwin", architecture: "arm64" } });
    await expect(client.diagnostics.stability!()).resolves.toMatchObject({ state: "degraded", score: null, incidents: [
      { id: "dropped-events", level: "warning" }, { id: "diagnostic.phase.completed", level: "info", summary: "最近记录 3 次。" },
    ] });
    await expect(client.diagnostics.audit!()).resolves.toMatchObject({ state: "passed", findings: [{ id: "audit-1", severity: "info", summary: "tool.execute：succeeded" }] });
    await expect(client.diagnostics.config!()).resolves.toMatchObject({ gateway: { port: 18789, token: "secret" } });
    expect(transport.requests.map((request) => request.method)).toEqual([
      "logs.tail", "logs.tail", "health", "status", "system.info", "diagnostics.stability", "audit.list", "config.get",
    ]);
    expect(transport.requests[1]?.params).toMatchObject({ cursor: 42 });
  });

  it("keeps logs.tail forward cursor without treating truncation as pagination", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push("logs.tail");
    transport.fixtures.set("logs.tail", { cursor: 91, reset: false, truncated: true, size: 2048, lines: [] });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await expect(client.diagnostics.listLogs()).resolves.toMatchObject({ nextCursor: "91", hasMore: false });
  });
});
