import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const captureDir = resolve(process.env.OPENCLAW_CAPTURE_OUTPUT_DIR ?? "/tmp/uclaw-openclaw-v4-capture/capture");
const fixtureDir = resolve(process.env.OPENCLAW_FIXTURE_OUTPUT_DIR ?? "adapter/fixtures/openclaw-2026.7.1-2");
const packageDir = resolve(process.env.OPENCLAW_PACKAGE_DIR ?? join(homedir(), ".uclaw/core/node_modules/openclaw"));
const harnessPath = resolve("scripts/capture-openclaw-v4.mjs");
const schemaPath = join(packageDir, "dist/schema-BuOFpc7K.js");
const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const uuidMap = new Map();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(name) {
  return JSON.parse(await readFile(join(captureDir, name), "utf8"));
}

function sanitizeString(value) {
  return value
    .replaceAll("/private/tmp/uclaw-openclaw-v4-capture", "/tmp/openclaw-contract")
    .replaceAll("/tmp/uclaw-openclaw-v4-capture", "/tmp/openclaw-contract")
    .replace(uuidPattern, (uuid) => {
      const normalized = uuid.toLowerCase();
      if (!uuidMap.has(normalized)) uuidMap.set(normalized, `00000000-0000-4000-8000-${String(uuidMap.size + 1).padStart(12, "0")}`);
      return uuidMap.get(normalized);
    });
}

function sanitize(value) {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]));
}

function redactToolResult(frame) {
  const sanitized = sanitize(frame);
  if (sanitized.payload?.data?.phase === "result") {
    for (const block of sanitized.payload.data.result?.content ?? []) {
      if (block.type === "text") block.text = "[REDACTED TOOL RESULT]";
    }
  }
  return sanitized;
}

function textLengthCategory(text) {
  if (text.length === 0) return "empty";
  if (text.length <= 80) return "short";
  if (text.length <= 500) return "medium";
  return "long";
}

function redactConversationMessage(message) {
  if (message.role === "toolResult") {
    return { ...message, content: [{ type: "text", text: "[REDACTED TOOL RESULT]" }] };
  }
  if (message.role !== "user" && message.role !== "assistant") return message;
  const redactText = (text) => `[REDACTED ${message.role.toUpperCase()} TEXT:${textLengthCategory(text)}]`;
  if (typeof message.content === "string") return { ...message, content: redactText(message.content) };
  if (!Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.map((block) => block?.type === "text" && typeof block.text === "string"
      ? { ...block, text: redactText(block.text) }
      : block),
  };
}

function patchEvidence(entry) {
  const payload = entry.responseFrame.payload;
  return sanitize({
    requestFrame: entry.requestFrame,
    responseFrame: entry.responseFrame.ok === false
      ? entry.responseFrame
      : {
          type: entry.responseFrame.type,
          id: entry.responseFrame.id,
          ok: true,
          payload: {
            ok: payload.ok,
            key: payload.key,
            entry: {
              sessionId: payload.entry?.sessionId,
              label: payload.entry?.label,
              providerOverride: payload.entry?.providerOverride,
              modelOverride: payload.entry?.modelOverride,
              modelOverrideSource: payload.entry?.modelOverrideSource,
            },
            resolved: {
              modelProvider: payload.resolved?.modelProvider,
              model: payload.resolved?.model,
            },
          },
        },
  });
}

function sessionListEvidence(entry, key) {
  const session = entry.responseFrame.payload?.sessions?.find((candidate) => candidate.key === key);
  return sanitize({
    requestFrame: entry.requestFrame,
    responseFrame: {
      type: entry.responseFrame.type,
      id: entry.responseFrame.id,
      ok: entry.responseFrame.ok,
      payload: {
        sessions: session ? [{
          key: session.key,
          label: session.label,
          modelProvider: session.modelProvider,
          model: session.model,
        }] : [],
      },
    },
  });
}

async function writeFixture(name, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(join(fixtureDir, name), body);
  return sha256(body);
}

await mkdir(fixtureDir, { recursive: true });
const rawNames = ["attachments.json", "approvals.json", "chat.history.json", "chat.message.get.json", "session.tool.json", "sessions.patch.json"];
const rawBodies = Object.fromEntries(await Promise.all(rawNames.map(async (name) => [name, await readFile(join(captureDir, name))])));
const attachments = await readJson("attachments.json");
const approvals = await readJson("approvals.json");
const history = await readJson("chat.history.json");
const messageGet = await readJson("chat.message.get.json");
const sessionTool = await readJson("session.tool.json");
const sessionsPatch = await readJson("sessions.patch.json");

const fixtures = {
  "attachments.json": sanitize({ cases: attachments.cases.map(({ kind, requestFrame, responseFrame }) => ({ kind, requestFrame, responseFrame })) }),
  "approvals.json": sanitize(approvals),
  "chat.history.json": sanitize({
    requestFrame: history.requestFrame,
    responseFrame: {
      ...history.responseFrame,
      payload: {
        ...history.responseFrame.payload,
        messages: history.responseFrame.payload.messages.map(redactConversationMessage),
      },
    },
  }),
  "chat.message.get.json": sanitize({
    success: {
      requestFrame: messageGet.success.requestFrame,
      responseFrame: {
        ...messageGet.success.responseFrame,
        payload: {
          ...messageGet.success.responseFrame.payload,
          message: redactConversationMessage(messageGet.success.responseFrame.payload.message),
        },
      },
    },
    unavailable: { requestFrame: messageGet.unavailable.requestFrame, responseFrame: messageGet.unavailable.responseFrame },
  }),
  "session.tool.json": { start: redactToolResult(sessionTool.start), result: redactToolResult(sessionTool.result) },
  "sessions.patch.json": {
    rename: patchEvidence(sessionsPatch.rename),
    model: patchEvidence(sessionsPatch.model),
    modelReadback: sessionListEvidence(sessionsPatch.modelReadback, "agent:dev:main"),
    baseHash: patchEvidence(sessionsPatch.baseHash),
    duplicateLabel: patchEvidence(sessionsPatch.duplicateLabel),
  },
};

const fixtureSha256 = {};
for (const [name, value] of Object.entries(fixtures)) fixtureSha256[name] = await writeFixture(name, value);

const packageJson = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
const provenance = {
  openClawVersion: packageJson.version,
  buildCommit: "0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c",
  npmTarballSha1: "4583b987ea7277230ce1c7b2b8535d3e219f57ac",
  installedPackageJsonSha256: sha256(await readFile(join(packageDir, "package.json"))),
  installedRuntimeSchema: basename(schemaPath),
  installedRuntimeSchemaSha256: sha256(await readFile(schemaPath)),
  captureHarnessSha256: sha256(await readFile(harnessPath)),
  capturedAt: new Date(fixtures["session.tool.json"].start.payload.ts).toISOString(),
  capture: {
    runtime: `OpenClaw Gateway ${packageJson.version} on Node.js 24.16.0`,
    transport: "GatewayClient through a loopback WebSocket frame-capture proxy",
    model: "loopback OpenAI-compatible deterministic tool-call server",
    redaction: "UUIDs and temporary paths replaced consistently; user/assistant/tool-result text replaced with structured placeholders; synthetic attachment bytes retained; sessions.patch and sessions.list store derived field projections because raw entries contain unrelated prompt/tool diagnostics",
  },
  rawCaptureSha256: Object.fromEntries(rawNames.map((name) => [name, sha256(rawBodies[name])])),
  fixtureSha256,
};
await writeFixture("provenance.json", provenance);
