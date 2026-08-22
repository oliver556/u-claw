const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const assetsDir = path.join(root, "node_modules", "openclaw", "dist", "control-ui", "assets");

const requiredTokens = [
  "function UcSkillHubDropdown",
  "function UcSkillHubItems",
  "data-chat-skillhub-select",
  "data-chat-skillhub-option",
  "skills.status",
  "runtimeConfig",
  "[`agents`,`list`,a,`skills`]",
  "source===`openclaw-bundled`",
  "bundled===!0",
  "选择你的技能",
  "技能暂不可用",
  "已保存，新会话生效",
  "UcSkillHubDropdown(e.skillHub)",
  "onSelect?.(u.name)",
];

const forbiddenTokens = [
  "chat-level skill",
  "skillRuntime",
  "api.skillhub.cn/api/v1/skills",
  "选择 SkillHub",
  "SkillHub 暂不可用",
  "l(t,e=>e.name,e=>s",
  "t.find(e=>u.name===n)",
];

/**
 * Counts exact token occurrences in one generated bundle.
 */
function countToken(source, token) {
  return source.split(token).length - 1;
}

/**
 * Extracts a bounded minified method body so broad bundle tokens do not hide regressions.
 */
function extractBetween(source, startToken, endToken) {
  const start = source.indexOf(startToken);
  if (start === -1) {
    return null;
  }

  const end = source.indexOf(endToken, start + startToken.length);
  if (end === -1) {
    return null;
  }

  return source.slice(start, end);
}

/**
 * Checks the save handler keeps the existing Agent skill allowlist safe.
 */
function verifySkillSelectionHandler(source, relative, errors) {
  const handler = extractBetween(
    source,
    "this.selectUclawSkillHubSkill=async",
    "this.handleCommandPaletteSlashCommand=",
  );

  if (!handler) {
    errors.push(`${relative} missing SkillHub selection handler`);
    return;
  }

  if (/patchForm\(\[`agents`,`list`,[^)]*?,`skills`\],\[r\]\)/.test(handler)) {
    errors.push(`${relative} must not overwrite Agent skills allowlist with [r]`);
  }

  if (!/\bSet\b/.test(handler)) {
    errors.push(`${relative} missing merge/dedupe indicator for Agent skills allowlist`);
  }

  const skillPatchCalls = handler.match(/patchForm\(\[`agents`,`list`,[^)]*?,`skills`\]/g) ?? [];
  if (!handler.includes("removeFormValue") && skillPatchCalls.length < 2) {
    errors.push(`${relative} missing rollback indicator for failed SkillHub selection save`);
  }
}

/**
 * Checks the dropdown helper does not capture the option loop variable outside its scope.
 */
function verifyDropdownHelper(source, relative, errors) {
  const helper = extractBetween(source, "function UcSkillHubDropdown(e){", "<details");

  if (!helper) {
    errors.push(`${relative} missing SkillHub dropdown helper body`);
    return;
  }

  if (!helper.includes("t.find(e=>e.name===n)")) {
    errors.push(`${relative} SkillHub dropdown selected lookup must use its find callback argument`);
  }

  if (/\bu\./.test(helper)) {
    errors.push(`${relative} SkillHub dropdown header must not reference option variable u`);
  }
}

/**
 * Finds generated chat page assets for the installed OpenClaw control UI build.
 */
function listChatAssets() {
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`Missing OpenClaw control-ui assets directory: ${assetsDir}`);
  }

  const files = fs
    .readdirSync(assetsDir)
    .filter((name) => /^chat-page-.*\.js$/.test(name))
    .sort()
    .map((name) => path.join(assetsDir, name));

  if (files.length === 0) {
    throw new Error(`Missing chat-page asset in ${assetsDir}`);
  }

  return files;
}

/**
 * Checks one generated chat asset for the SkillHub dropdown invariants.
 */
function verifyChatAsset(file, errors) {
  const source = fs.readFileSync(file, "utf8");
  const relative = path.relative(root, file);

  for (const token of requiredTokens) {
    if (!source.includes(token)) {
      errors.push(`${relative} missing required token: ${JSON.stringify(token)}`);
    }
  }

  for (const token of forbiddenTokens) {
    if (source.includes(token)) {
      errors.push(`${relative} contains forbidden token: ${JSON.stringify(token)}`);
    }
  }

  const statusCalls = source.match(/skills\.status/g) ?? [];
  if (statusCalls.length !== 1) {
    errors.push(`${relative} expected exactly one skills.status call, found ${statusCalls.length}`);
  }

  const modelSelectCount = countToken(source, "data-chat-model-select");
  if (modelSelectCount !== 1) {
    errors.push(`${relative} expected exactly one data-chat-model-select, found ${modelSelectCount}`);
  }

  verifySkillSelectionHandler(source, relative, errors);
  verifyDropdownHelper(source, relative, errors);
}

/**
 * Runs all chat SkillHub dropdown checks and exits non-zero on invariant drift.
 */
function main() {
  const errors = [];

  try {
    for (const file of listChatAssets()) {
      verifyChatAsset(file, errors);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (errors.length > 0) {
    console.error("SkillHub chat dropdown verification failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log("OK SkillHub chat dropdown patch verified");
}

main();
