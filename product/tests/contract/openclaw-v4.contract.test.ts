import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  OpenClawAttachmentFixtureSchema,
  OpenClawApprovalsFixtureSchema,
  OpenClawHistoryFixtureSchema,
  OpenClawMessageGetFixtureSchema,
  OpenClawModelsListFixtureSchema,
  OpenClawSessionToolFixtureSchema,
  OpenClawSessionsPatchFixtureSchema,
  mapOpenClawAttachmentEvidence,
  mapOpenClawExecApproval,
  mapOpenClawHistoryResponse,
  mapOpenClawMessageGetResponse,
  mapOpenClawModel,
  mapOpenClawPluginApproval,
  mapOpenClawSessionToolEvent,
  mapOpenClawSessionsPatchEvidence,
  RawOpenClawModelsListResponseSchema,
} from "../../adapter/src/index.js";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../adapter/fixtures/openclaw-2026.7.1-2");
const productDir = resolve(fixturesDir, "../../..");
const fixtureNames = ["attachments.json", "approvals.json", "chat.history.json", "chat.message.get.json", "models.list.json", "session.tool.json", "sessions.patch.json", "provenance.json"];
const captureArtifactTrustAnchor = "openclaw-2026.7.1-2-protocol-v4-node-24.15.0-20260808T193154952Z";
const rawCaptureTrustAnchor = {
  "attachments.json": "b0b615e0d4a341e271d61cfa92f31e89e58eee45bc811bddf8435b588b924088",
  "approvals.json": "1682555a2460ef3545ebb2e14e146dc0b687395f2f9e78a364d55d4e8e2e87c2",
  "chat.history.json": "ef401e0bb57be5fbc55819f799e33a1b15c922e366c0f2d8052b5b564c89f32d",
  "chat.message.get.json": "ea9d4066af2e49b3708b9f7a7738a41b80415748363be6a0f80c5fb4ada4dc21",
  "models.list.json": "f4c95f4babdb5c77ba24c4fb6d3907da514e029c0095815c797cd8dcff3af297",
  "session.tool.json": "35431f0d4ed3cf5220e18d1eaa8c3a228f473b920b815034f234c8e5aad1b0eb",
  "sessions.patch.json": "e621c16f1d7ba9bbb37afced2cfc15f55e3370f25a3c1eb7e9953daef77542b7",
} as const;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), "utf8"));
}

function sha256(name: string): string {
  return createHash("sha256").update(readFileSync(resolve(fixturesDir, name))).digest("hex");
}

function expectTrustedRawCapture(provenance: { captureArtifact?: unknown; rawCaptureSha256?: unknown }): void {
  expect(provenance.captureArtifact).toEqual({ id: captureArtifactTrustAnchor, kind: "raw-wire-json-v1" });
  expect(provenance.rawCaptureSha256).toEqual(rawCaptureTrustAnchor);
}

describe("OpenClaw 2026.7.1-2 protocol-v4 contract gates", () => {
  it("exports a strict models.list fixture schema", () => {
    expect(OpenClawModelsListFixtureSchema.parse(fixture("models.list.json"))).toBeTruthy();
  });

  it("GATE-A01 validates raw chat.send attachment frames and maps outcomes", () => {
    const raw = OpenClawAttachmentFixtureSchema.parse(fixture("attachments.json"));
    const mapped = raw.cases.map(mapOpenClawAttachmentEvidence);

    expect(mapped.map((entry) => entry.kind)).toEqual(["image", "text", "mime-mismatch", "oversized"]);
    expect(mapped.map((entry) => entry.outcome)).toEqual(["accepted", "accepted", "accepted", "rejected"]);
    expect(raw.cases.every((entry) => entry.requestFrame.method === "chat.send" && entry.requestFrame.params.attachments.length === 1)).toBe(true);
    expect(mapped[3]).toMatchObject({ decodedBytes: 1049, error: { code: "INVALID_REQUEST" } });
  });

  it("GATE-A02 validates approval events and every observed decision", () => {
    const raw = OpenClawApprovalsFixtureSchema.parse(fixture("approvals.json"));
    const exec = mapOpenClawExecApproval(raw.exec.allowOnce.event);
    const plugin = mapOpenClawPluginApproval(raw.plugin.allowOnce.event);

    expect(exec).toMatchObject({ family: "exec", choices: ["allow-once", "deny"] });
    expect(plugin).toMatchObject({ family: "plugin", choices: ["allow-once", "deny"] });
    for (const family of [raw.exec, raw.plugin]) {
      expect(family.allowOnce.listing.responseFrame).toMatchObject({ ok: true, payload: [expect.any(Object)] });
      expect(family.allowOnce.resolution.responseFrame).toMatchObject({ ok: true, payload: { ok: true } });
      expect(family.deny.resolution.responseFrame).toMatchObject({ ok: true, payload: { ok: true } });
      expect(family.unavailable.resolution.responseFrame).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
      expect(family.unavailable.cleanup.responseFrame).toMatchObject({ ok: true, payload: { ok: true } });
    }
  });

  it("GATE-A03 maps rename/model/conflict and locks absence of revision protection", () => {
    const raw = OpenClawSessionsPatchFixtureSchema.parse(fixture("sessions.patch.json"));
    expect(mapOpenClawSessionsPatchEvidence(raw)).toEqual({
      renamed: true,
      providerOverride: "contract",
      modelOverride: "contract-alt-model",
      modelOverrideSource: "user",
      readbackModelProvider: "contract",
      readbackModel: "contract-alt-model",
      duplicateLabelConflict: "INVALID_REQUEST",
      baseHashAccepted: false,
      baseHashErrorCode: "INVALID_REQUEST",
      baseHashErrorMessage: "invalid sessions.patch params: at root: unexpected property 'baseHash'",
    });
  });

  it("GATE-A04 maps history, chat.message.get, and real session.tool start/result frames", () => {
    const history = OpenClawHistoryFixtureSchema.parse(fixture("chat.history.json"));
    const messageGet = OpenClawMessageGetFixtureSchema.parse(fixture("chat.message.get.json"));
    const tools = OpenClawSessionToolFixtureSchema.parse(fixture("session.tool.json"));

    expect(mapOpenClawHistoryResponse(history.responseFrame.payload).map((message) => message.role)).toContain("user");
    expect(mapOpenClawMessageGetResponse(
      messageGet.success.responseFrame.payload,
      messageGet.success.requestFrame.params.sessionKey,
    )).toMatchObject({ role: "user", sessionId: messageGet.success.requestFrame.params.sessionKey });
    expect(mapOpenClawMessageGetResponse(
      messageGet.unavailable.responseFrame.payload,
      messageGet.unavailable.requestFrame.params.sessionKey,
    )).toBeUndefined();
    // @ts-expect-error sessionKey is required to preserve request identity.
    expect(() => mapOpenClawMessageGetResponse(messageGet.success.responseFrame.payload)).toThrow();
    expect(mapOpenClawSessionToolEvent(tools.start)).toMatchObject({ toolId: "sessions_list", state: "running" });
    expect(mapOpenClawSessionToolEvent(tools.result)).toMatchObject({ toolId: "sessions_list", state: "succeeded" });

    const serializedConversation = JSON.stringify([history, messageGet.success]);
    expect(serializedConversation).not.toContain("Use sessions_list exactly once");
    expect(serializedConversation).not.toContain("answer done");
    const conversationMessages = [
      ...history.responseFrame.payload.messages,
      ...(messageGet.success.responseFrame.payload.ok ? [messageGet.success.responseFrame.payload.message] : []),
    ];
    const textValues = conversationMessages.flatMap((message) => {
      if (message.role !== "user" && message.role !== "assistant") return [];
      if (typeof message.content === "string") return [message.content];
      return message.content.flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : []);
    });
    expect(textValues.length).toBeGreaterThan(0);
    expect(textValues.every((text) => /^\[REDACTED (?:USER|ASSISTANT) TEXT:(?:empty|short|medium|long)\]$/.test(text))).toBe(true);
    expect(JSON.stringify(conversationMessages)).not.toMatch(/(?:api[_-]?key|authorization|bearer |password|secret|sk-(?:proj-)?[A-Za-z0-9_-]{8,})/i);
  });

  it("keeps raw tool calls and tool results out of the conversation transcript", () => {
    const message = (role: "user" | "assistant" | "toolResult", content: unknown, id: string, seq: number) => ({
      role,
      content,
      timestamp: 1786604000000 + seq,
      __openclaw: { id, recordTimestampMs: 1786604000000 + seq, seq },
    });
    const result = mapOpenClawHistoryResponse({
      sessionKey: "agent:main:dashboard:test",
      sessionId: "test",
      messages: [
        message("user", "规划杭州行程", "user-1", 1),
        message("assistant", [{ type: "toolCall", id: "call-1", name: "web_search", arguments: { query: "杭州" } }], "tool-call-1", 2),
        message("toolResult", [{ type: "text", text: "{\"status\":\"error\",\"tool\":\"web_search\"}" }], "tool-result-1", 3),
        message("assistant", [{ type: "text", text: "杭州两日行程如下。" }], "assistant-1", 4),
      ],
    });

    expect(result.map(({ role, blocks }) => ({ role, blocks }))).toEqual([
      { role: "user", blocks: [{ id: "user-1:text", type: "text", text: "规划杭州行程", format: "plain" }] },
      { role: "assistant", blocks: [{ id: "assistant-1:0", type: "text", text: "杭州两日行程如下。", format: "markdown" }] },
    ]);
  });

  it("ignores oversized chat.history placeholders without timestamps", () => {
    const result = mapOpenClawHistoryResponse({
      sessionKey: "agent:main:dashboard:test",
      sessionId: "test",
      messages: [
        {
          role: "user",
          content: "生成一张花园夕阳氛围的写实美女图",
          timestamp: 1786632848000,
          __openclaw: { id: "user-1", recordTimestampMs: 1786632848000, seq: 38 },
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: "[chat.history omitted: message too large]" }],
          __openclaw: {
            truncated: true,
            reason: "oversized",
            id: "7a0ca708",
            recordTimestampMs: 1786632848960,
            seq: 39,
          },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "生成好了。" }],
          timestamp: 1786632849000,
          __openclaw: { id: "assistant-1", recordTimestampMs: 1786632849000, seq: 40 },
        },
      ],
    });

    expect(result.map(({ role, blocks }) => ({ role, blocks }))).toEqual([
      {
        role: "user",
        blocks: [{ id: "user-1:text", type: "text", text: "生成一张花园夕阳氛围的写实美女图", format: "plain" }],
      },
      {
        role: "assistant",
        blocks: [{ id: "assistant-1:0", type: "text", text: "生成好了。", format: "markdown" }],
      },
    ]);
  });

  it("keeps managed outgoing images in assistant history", () => {
    const result = mapOpenClawHistoryResponse({
      sessionKey: "agent:main:dashboard:test",
      sessionId: "test",
      messages: [{
        role: "assistant",
        content: [{
          type: "image",
          url: "/api/chat/media/outgoing/agent%3Amain%3Adashboard%3Atest/fc0adee3-cf57-47e3-ba7e-e4095976033f/full",
          alt: "portrait.png",
          mimeType: "image/png",
          width: 1024,
          height: 1536,
        }],
        timestamp: 1786604000000,
        __openclaw: { id: "assistant-image-1", recordTimestampMs: 1786604000000, seq: 1 },
      }],
    }, "http://127.0.0.1:18789");

    expect(result).toEqual([expect.objectContaining({
      role: "assistant",
      blocks: [{
        id: "assistant-image-1:0",
        type: "image",
        file: {
          id: "assistant-image-1:0",
          name: "portrait.png",
          mediaType: "image/png",
          size: 0,
          kind: "artifact",
        },
        alt: "portrait.png",
        sourceUrl: "http://127.0.0.1:18789/api/chat/media/outgoing/agent%3Amain%3Adashboard%3Atest/fc0adee3-cf57-47e3-ba7e-e4095976033f/full",
      }],
    })]);
  });

  it.each([
    {
      label: "POSIX",
      dataRoot: "/Users/test/.uclaw/data",
      source: "/Users/test/.uclaw/data/workspace/.media/images/image_003.png",
      encodedSource: "%2FUsers%2Ftest%2F.uclaw%2Fdata%2Fworkspace%2F.media%2Fimages%2Fimage_003.png",
    },
    {
      label: "Windows",
      dataRoot: "U:\\.uclaw\\data",
      source: "U:\\.uclaw\\data\\workspace\\.media\\images\\image_003.png",
      encodedSource: "U%3A%5C.uclaw%5Cdata%5Cworkspace%5C.media%5Cimages%5Cimage_003.png",
    },
  ])("maps an independent assistant MEDIA line under the controlled $label workspace", ({ dataRoot, source, encodedSource }) => {
    const result = mapOpenClawHistoryResponse({
      sessionKey: "agent:main:dashboard:test",
      sessionId: "test",
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: `图片已生成。\nMEDIA:${source}` }],
        timestamp: 1786604000000,
        __openclaw: { id: "assistant-media-1", recordTimestampMs: 1786604000000, seq: 1 },
      }],
    }, "http://127.0.0.1:18789", dataRoot);

    expect(result[0]?.blocks).toEqual([
      { id: "assistant-media-1:0", type: "text", text: "图片已生成。", format: "markdown" },
      {
        id: "assistant-media-1:media:0",
        type: "image",
        file: { id: "assistant-media-1:media:0", name: "image_003.png", mediaType: "image/png", size: 0, kind: "artifact" },
        alt: "image_003.png",
        sourceUrl: `http://127.0.0.1:18789/__openclaw__/assistant-media?source=${encodedSource}`,
      },
    ]);
  });

  it.each([
    "workspace/.media/images/relative.png",
    "/Users/test/.uclaw/data/workspace/../credentials.png",
    "/Users/test/.uclaw/other/image.png",
    "file:///Users/test/.uclaw/data/workspace/.media/images/image.png",
  ])("does not convert an untrusted MEDIA source: %s", (source) => {
    const result = mapOpenClawHistoryResponse({
      sessionKey: "agent:main:dashboard:test",
      sessionId: "test",
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: `MEDIA:${source}` }],
        timestamp: 1786604000000,
        __openclaw: { id: "assistant-media-rejected", recordTimestampMs: 1786604000000, seq: 1 },
      }],
    }, "http://127.0.0.1:18789", "/Users/test/.uclaw/data");

    expect(result[0]?.blocks).toEqual([{
      id: "assistant-media-rejected:0", type: "text", text: `MEDIA:${source}`, format: "markdown",
    }]);
  });

  it("removes a MEDIA line without duplicating an existing managed outgoing image", () => {
    const result = mapOpenClawHistoryResponse({
      sessionKey: "agent:main:dashboard:test",
      sessionId: "test",
      messages: [{
        role: "assistant",
        content: [
          { type: "text", text: "完成。\nMEDIA:/Users/test/.uclaw/data/workspace/.media/images/image.png" },
          { type: "image", url: "/api/chat/media/outgoing/session/fc0adee3-cf57-47e3-ba7e-e4095976033f/full", alt: "image.png", mimeType: "image/png" },
        ],
        timestamp: 1786604000000,
        __openclaw: { id: "assistant-media-managed", recordTimestampMs: 1786604000000, seq: 1 },
      }],
    }, "http://127.0.0.1:18789", "/Users/test/.uclaw/data");

    expect(result[0]?.blocks.filter((block) => block.type === "image")).toHaveLength(1);
    expect(result[0]?.blocks[0]).toMatchObject({ type: "text", text: "完成。" });
  });

  it("GATE-A05 maps the real configured models.list response and locks invalid view rejection", () => {
    const raw = OpenClawModelsListFixtureSchema.parse(fixture("models.list.json"));
    expect(raw.configured.requestFrame).toMatchObject({ method: "models.list", params: { view: "configured" } });
    expect(raw.configured.responseFrame.id).toBe(raw.configured.requestFrame.id);
    const response = RawOpenClawModelsListResponseSchema.parse(raw.configured.responseFrame.payload);
    expect(response.models.map(mapOpenClawModel)).toEqual([
      expect.objectContaining({ id: "contract/contract-alt-model", capabilities: ["text"], available: true }),
      expect.objectContaining({ id: "contract/contract-model", capabilities: ["text"], available: true }),
    ]);
    expect(raw.invalidView).toMatchObject({
      requestFrame: { method: "models.list", params: { view: "invalid" } },
      responseFrame: { ok: false, error: { code: "INVALID_REQUEST" } },
    });
    expect(raw.invalidView.responseFrame.id).toBe(raw.invalidView.requestFrame.id);
  });

  it("rejects session.tool fixtures whose start and result identities differ", () => {
    const mutations = [
      (value: any) => { value.result.payload.sessionKey = "agent:dev:other"; },
      (value: any) => { value.result.payload.runId = "other-run"; },
      (value: any) => { value.result.payload.data.toolCallId = "other-tool-call"; },
      (value: any) => { value.result.payload.data.name = "other_tool"; },
    ];
    for (const mutate of mutations) {
      const tools = structuredClone(fixture("session.tool.json"));
      mutate(tools);
      expect(OpenClawSessionToolFixtureSchema.safeParse(tools).success).toBe(false);
    }
  });

  it("rejects fixtures whose RPC methods do not match their captured operation", () => {
    const history = structuredClone(fixture("chat.history.json")) as any;
    history.requestFrame.method = "chat.send";
    expect(OpenClawHistoryFixtureSchema.safeParse(history).success).toBe(false);

    const messageGet = structuredClone(fixture("chat.message.get.json")) as any;
    messageGet.success.requestFrame.method = "chat.history";
    expect(OpenClawMessageGetFixtureSchema.safeParse(messageGet).success).toBe(false);

    const approvals = structuredClone(fixture("approvals.json")) as any;
    approvals.exec.allowOnce.listing.requestFrame.method = "plugin.approval.list";
    expect(OpenClawApprovalsFixtureSchema.safeParse(approvals).success).toBe(false);

    const sessions = structuredClone(fixture("sessions.patch.json")) as any;
    sessions.modelReadback.requestFrame.method = "sessions.patch";
    expect(OpenClawSessionsPatchFixtureSchema.safeParse(sessions).success).toBe(false);

    const attachments = structuredClone(fixture("attachments.json")) as any;
    attachments.cases[0].requestFrame.method = "chat.history";
    expect(OpenClawAttachmentFixtureSchema.safeParse(attachments).success).toBe(false);
  });

  it("rejects fixtures whose RPC response id does not match the request id", () => {
    const cases: Array<[any, any, (value: any) => any]> = [
      [OpenClawHistoryFixtureSchema, fixture("chat.history.json"), (value) => value],
      [OpenClawMessageGetFixtureSchema, fixture("chat.message.get.json"), (value) => value.success],
      [OpenClawApprovalsFixtureSchema, fixture("approvals.json"), (value) => value.exec.unavailable.cleanup],
      [OpenClawSessionsPatchFixtureSchema, fixture("sessions.patch.json"), (value) => value.model],
      [OpenClawAttachmentFixtureSchema, fixture("attachments.json"), (value) => value.cases[0]],
    ];
    for (const [schema, raw, selectCase] of cases) {
      const mutated = structuredClone(raw);
      selectCase(mutated).responseFrame.id = "mismatched-response-id";
      expect(schema.safeParse(mutated).success).toBe(false);
    }
  });

  it("rejects malformed models.list entries and mismatched captured ids", () => {
    const mutations = [
      (value: any) => { value.configured.requestFrame.method = "sessions.list"; },
      (value: any) => { value.configured.requestFrame.params.view = "all"; },
      (value: any) => { value.configured.responseFrame.id = "mismatched-response-id"; },
      (value: any) => { value.invalidView.requestFrame.params.view = "configured"; },
      (value: any) => { value.invalidView.responseFrame.id = "mismatched-response-id"; },
      (value: any) => { value.configured.responseFrame.payload.models[0].provider = ""; },
      (value: any) => { value.configured.responseFrame.payload.models[0].unknown = "forbidden"; },
      (value: any) => { value.configured.responseFrame.payload.models[0].apiKey = "secret"; },
      (value: any) => { value.configured.responseFrame.payload.models[0].baseUrl = "https://private.invalid"; },
      (value: any) => { value.configured.responseFrame.payload.models[0].params = { secret: true }; },
    ];
    for (const mutate of mutations) {
      const models = structuredClone(fixture("models.list.json"));
      mutate(models);
      expect(OpenClawModelsListFixtureSchema.safeParse(models).success).toBe(false);
    }
  });

  it("rejects chat.history responses captured for another session", () => {
    const history = structuredClone(fixture("chat.history.json")) as any;
    history.responseFrame.payload.sessionKey = "agent:dev:other";
    expect(OpenClawHistoryFixtureSchema.safeParse(history).success).toBe(false);
  });

  it("locks package, runtime schema, capture harness, raw captures, and fixture hashes", () => {
    const provenance = fixture("provenance.json") as {
      openClawVersion: string;
      buildCommit: string;
      captureHarnessSha256: string;
      captureStateHelperSha256: string;
      captureCleanupHelperSha256: string;
      captureWaitHelperSha256: string;
      sanitizerSha256: string;
      npmTarballResolved: string;
      npmTarballIntegrity: string;
      capture: { runtime: string };
      modelCatalogProtocolEvidence: unknown;
      captureArtifact: { id: string; kind: string };
      rawCaptureSha256: Record<string, string>;
      fixtureSha256: Record<string, string>;
    };
    expect(provenance).toMatchObject({
      openClawVersion: "2026.7.1-2",
      buildCommit: "0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c",
      npmTarballResolved: expect.stringMatching(/\/openclaw-2026\.7\.1-2\.tgz$/),
      npmTarballIntegrity: "sha512-ycF3yPcbjN6bUPeaUx6Mh6vze1hQWoD3CT/wWcmD7a8xaHHHRUaAlaq+lFxMHf1ssEgODVAwjlzYqp2twkYZ7g==",
      capture: { runtime: "OpenClaw Gateway 2026.7.1-2 on Node.js 24.15.0" },
      modelCatalogProtocolEvidence: {
        method: "models.list",
        requiredScope: "operator.read",
        pickerRequest: { view: "configured" },
        allowedViews: ["default", "configured", "all"],
        observedAdditionalResponseFields: ["api", "input"],
      },
    });
    expectTrustedRawCapture(provenance);
    expect(provenance.captureHarnessSha256).toBe(createHash("sha256").update(readFileSync(resolve(productDir, "scripts/capture-openclaw-v4.mjs"))).digest("hex"));
    expect(provenance.captureStateHelperSha256).toBe(createHash("sha256").update(readFileSync(resolve(productDir, "scripts/capture-state.mjs"))).digest("hex"));
    expect(provenance.captureCleanupHelperSha256).toBe(createHash("sha256").update(readFileSync(resolve(productDir, "scripts/capture-cleanup.mjs"))).digest("hex"));
    expect(provenance.captureWaitHelperSha256).toBe(createHash("sha256").update(readFileSync(resolve(productDir, "scripts/capture-wait.mjs"))).digest("hex"));
    expect(provenance.sanitizerSha256).toBe(createHash("sha256").update(readFileSync(resolve(productDir, "scripts/sanitize-openclaw-v4-capture.mjs"))).digest("hex"));
    expect(Object.keys(provenance.rawCaptureSha256)).toHaveLength(7);
    for (const [name, expected] of Object.entries(provenance.fixtureSha256)) expect(sha256(name)).toBe(expected);
  });

  it("rejects provenance whose independently anchored raw capture hash is replaced", () => {
    const provenance = structuredClone(fixture("provenance.json")) as any;
    provenance.rawCaptureSha256["chat.history.json"] = "0".repeat(64);
    expect(() => expectTrustedRawCapture(provenance)).toThrow();
  });

  it("keeps every fixture free of machine paths, usernames, and credential material", () => {
    const contents = fixtureNames.map((name) => readFileSync(resolve(fixturesDir, name), "utf8")).join("\n");
    const userName = basename(homedir());
    expect(contents).not.toContain(homedir());
    expect(contents.toLowerCase()).not.toContain(userName.toLowerCase());
    expect(contents).not.toMatch(/\/(?:Users|home|private|var|Volumes)\//);
    expect(contents).not.toMatch(/\/tmp\/(?!openclaw-contract(?:\/|"))/);
    expect(contents).not.toMatch(/(?:gh[pousr]_|github_pat_|AKIA[0-9A-Z]{16}|xox[bp]-|AIza[0-9A-Za-z_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/i);
  });
});
