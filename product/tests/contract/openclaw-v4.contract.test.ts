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
  OpenClawSessionToolFixtureSchema,
  OpenClawSessionsPatchFixtureSchema,
  mapOpenClawAttachmentEvidence,
  mapOpenClawExecApproval,
  mapOpenClawHistoryResponse,
  mapOpenClawMessageGetResponse,
  mapOpenClawPluginApproval,
  mapOpenClawSessionToolEvent,
  mapOpenClawSessionsPatchEvidence,
} from "../../adapter/src/index.js";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../adapter/fixtures/openclaw-2026.7.1-2");
const productDir = resolve(fixturesDir, "../../..");
const fixtureNames = ["attachments.json", "approvals.json", "chat.history.json", "chat.message.get.json", "session.tool.json", "sessions.patch.json", "provenance.json"];

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), "utf8"));
}

function sha256(name: string): string {
  return createHash("sha256").update(readFileSync(resolve(fixturesDir, name))).digest("hex");
}

describe("OpenClaw 2026.7.1-2 protocol-v4 contract gates", () => {
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
    expect(mapOpenClawMessageGetResponse(messageGet.success.responseFrame.payload)).toMatchObject({ role: "user" });
    expect(mapOpenClawMessageGetResponse(messageGet.unavailable.responseFrame.payload)).toBeUndefined();
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

  it("locks package, runtime schema, capture harness, raw captures, and fixture hashes", () => {
    const provenance = fixture("provenance.json") as {
      openClawVersion: string;
      buildCommit: string;
      captureHarnessSha256: string;
      sanitizerSha256: string;
      npmTarballResolved: string;
      npmTarballIntegrity: string;
      capture: { runtime: string };
      rawCaptureSha256: Record<string, string>;
      fixtureSha256: Record<string, string>;
    };
    expect(provenance).toMatchObject({
      openClawVersion: "2026.7.1-2",
      buildCommit: "0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c",
      npmTarballResolved: expect.stringMatching(/\/openclaw-2026\.7\.1-2\.tgz$/),
      npmTarballIntegrity: "sha512-ycF3yPcbjN6bUPeaUx6Mh6vze1hQWoD3CT/wWcmD7a8xaHHHRUaAlaq+lFxMHf1ssEgODVAwjlzYqp2twkYZ7g==",
      capture: { runtime: "OpenClaw Gateway 2026.7.1-2 on Node.js 24.15.0" },
    });
    expect(provenance.captureHarnessSha256).toBe(createHash("sha256").update(readFileSync(resolve(productDir, "scripts/capture-openclaw-v4.mjs"))).digest("hex"));
    expect(provenance.sanitizerSha256).toBe(createHash("sha256").update(readFileSync(resolve(productDir, "scripts/sanitize-openclaw-v4-capture.mjs"))).digest("hex"));
    expect(Object.keys(provenance.rawCaptureSha256)).toHaveLength(6);
    for (const [name, expected] of Object.entries(provenance.fixtureSha256)) expect(sha256(name)).toBe(expected);
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
