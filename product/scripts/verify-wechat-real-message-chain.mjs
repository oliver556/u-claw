import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const EXPECTED_PACKAGE = "@tencent-weixin/openclaw-weixin";
const EXPECTED_VERSION = "2.4.6";

const required = {
  "src/messaging/process-message.ts": [
    ["account-bound route", "accountId: deps.accountId"],
    ["peer-bound route", "peer: { kind: \"direct\", id: ctx.To }"],
    ["gateway session propagation", "ctx.SessionKey = route.sessionKey"],
    ["inbound session record", "recordInboundSession"],
    ["gateway reply dispatch", "dispatchReplyFromConfig"],
  ],
  "src/messaging/inbound.ts": [
    ["account-peer context key", "contextTokenKey(accountId, userId)"],
    ["quoted message support", "ref_msg"],
    ["image input", "MessageItemType.IMAGE"],
    ["voice input", "MessageItemType.VOICE"],
    ["file input", "MessageItemType.FILE"],
    ["video input", "MessageItemType.VIDEO"],
  ],
  "src/messaging/send.ts": [
    ["text recipient binding", "to_user_id: to"],
    ["context token propagation", "context_token: opts.contextToken"],
    ["image output", "MessageItemType.IMAGE"],
    ["video output", "MessageItemType.VIDEO"],
    ["file output", "MessageItemType.FILE"],
  ],
  "src/messaging/send-media.ts": [
    ["video media route", "mime.startsWith(\"video/\")"],
    ["image media route", "mime.startsWith(\"image/\")"],
    ["file media fallback", "uploadFileAttachmentToWeixin"],
  ],
  "src/channel.ts": [
    ["direct chat capability", "chatTypes: [\"direct\"]"],
    ["media capability", "media: true"],
    ["explicit outbound account", "ctx.accountId || resolveOutboundAccountId"],
    ["outbound context token", "getContextToken(accountId!, ctx.to)"],
  ],
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function inspectWechatMessageChain(pluginDir) {
  const packageJson = JSON.parse(await readFile(join(pluginDir, "package.json"), "utf8"));
  if (packageJson.name !== EXPECTED_PACKAGE || packageJson.version !== EXPECTED_VERSION) {
    throw new Error(`unexpected WeChat plugin ${packageJson.name}@${packageJson.version}`);
  }

  const files = {};
  const failures = [];
  for (const [relative, checks] of Object.entries(required)) {
    const source = await readFile(join(pluginDir, relative), "utf8");
    files[relative] = { bytes: Buffer.byteLength(source), sha256: sha256(source) };
    for (const [label, needle] of checks) {
      if (!source.includes(needle)) failures.push(`${relative}: ${label}`);
    }
  }
  if (failures.length) throw new Error(`message chain contract failed:\n${failures.join("\n")}`);
  return {
    package: EXPECTED_PACKAGE,
    version: EXPECTED_VERSION,
    chain: "ilink getUpdates -> plugin inbound -> Gateway route(accountId, direct peer) -> Agent -> plugin sendMessage",
    sessionBoundary: "accountId + direct peer id + Gateway route.sessionKey",
    media: {
      text: "bidirectional",
      image: "bidirectional",
      video: "bidirectional",
      file: "bidirectional",
      voice: "inbound-only; outbound plugin contract has no voice item",
      quote: "inbound quoted context; outbound quote preservation not claimed",
    },
    files,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pluginDir = process.env.UCLAW_WECHAT_PLUGIN_DIR ?? process.argv[2];
  if (!pluginDir) {
    console.error("Usage: UCLAW_WECHAT_PLUGIN_DIR=/path/to/openclaw-weixin node scripts/verify-wechat-real-message-chain.mjs");
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(await inspectWechatMessageChain(resolve(pluginDir)), null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
