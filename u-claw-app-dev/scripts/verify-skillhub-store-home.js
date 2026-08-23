const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const controlUiDir = path.join(root, "node_modules", "openclaw", "dist", "control-ui");
const assetsDir = path.join(controlUiDir, "assets");

const homepageSeedQueries = [
  "agent",
  "browser",
  "automation",
  "lark",
  "coding",
  "data",
  "productivity",
  "communication",
];

const tabLabels = ["推荐", "全部", "可用", "需配置", "已停用"];

const bundledFilterTokens = ["source===`openclaw-bundled`", "bundled===!0"];
const strictInstallableToken = "trust?.installability===`installable`";

const denseUiTokens = [
  "__uclaw__/skillhub/skills",
  "UcSkillHubApiUrl",
  "UcSkillHubApiCategoryMap",
  "UcSkillHubApiCategory",
  "UcSkillHubLoadApiSkills",
  "UcSkillHubFallbackSkillsSearch",
  "skills.search",
  "兼容模式",
  "UcSkillHubNormalizeApiSkill",
  "icon_url",
  "iconURL",
  "logoUrl",
  "imageUrl",
  "skillHubPage",
  "skillHubPageSize",
  "skillHubTotal",
  "skillHubPageError",
  "UcSkillHubBuildViewModel",
  "UcSkillHubRenderIcon",
  "data-skillhub-icon-img",
  "UcSkillHubRenderSkillRow",
  "UcSkillHubSceneLabels",
  "office-efficiency",
  "knowledge-management",
  "dev-programming",
  "UcSkillHubRenderPagination",
  "skillhub-dense-row",
  "data-skillhub-dense-list",
  "data-skillhub-toolbar",
  "data-skillhub-search",
  "data-skillhub-pagination",
  "data-skillhub-page-button",
  "data-skillhub-page-summary",
  "data-skillhub-content",
  "data-skillhub-primary-tabs",
  "data-skillhub-single-layer",
  "技能",
  "场景",
  "下载",
  "收藏",
  "操作",
  "API Key 不限",
  "场景筛选",
  "全部场景",
  "办公效率",
  "知识管理",
  "开发编程",
  "数据分析",
  "仅看已配置",
  "仅看需配置",
  "排序 推荐精选",
  "下载最多",
  "收藏最多",
  "名称 A-Z",
  "data-skillhub-loading",
  "data-skillhub-next-page-button",
  "data-skillhub-prev-page-button",
  "data-skillhub-load-more-message",
  "aria-busy",
  "搜索中…",
  "正在加载第",
  "第 ${t.page} / ${t.pageCount} 页",
  "共",
  "下一页",
  "data-skillhub-install-message-close",
  "覆盖重装",
];

const forbiddenLeftCategoryNavTokens = [
  "UcSkillHubRenderCategoryNav",
  "skillhub-workspace",
  "data-skillhub-category-nav",
  "data-skillhub-workspace",
  "让 AI 从通用走向专用",
  "最多 40 项",
  "<div class=\"card-title\">SkillHub 商店</div>",
];

const forbiddenAutoLoadMoreTokens = [
  "UcSkillHubShouldLoadMore",
  "UcSkillHubMaybeLoadMore",
  "skillHubWindowScrollHandler",
  "window.addEventListener(`scroll`",
  "继续下滑加载更多",
  "UcSkillHubRequestSeeds",
  "skillHubLoadedSeedIndex",
  "skillHubSearchSeedIndex",
  "skillHubVisibleCount",
  "skillHubCanLoadMore",
  "skillHubSearchCanLoadMore",
  "UcSkillHubAppendResults",
  "正在请求更多技能商店数据",
  "本页没有新增结果",
];

const identityRefTokens = ["UcSkillHubQualifiedRef", "ownerHandle"];
const identityRefAlternatives = [
  ["install?.reference", "install.reference", "install?.[`reference`]"],
  ["@${", "startsWith(`@`)", 'startsWith("@")'],
];

const orangePrimaryTokens = [
  "#ff6b35",
  "#ff8f65",
  "#e95420",
  "#ff7a45",
  "#ffb088",
  "--uclaw-orange",
  "--primary-orange",
  "var(--orange",
  "cta-orange",
  "primary-orange",
];

const unsafeOwnerHandleDetailPattern = /skills\.detail[`"'][\s\S]{0,180}ownerHandle/;

/**
 * Reads a generated OpenClaw UI file as UTF-8 text.
 */
function readUtf8(file) {
  return fs.readFileSync(file, "utf8");
}

/**
 * Formats an asset path relative to the active app root.
 */
function relative(file) {
  return path.relative(root, file);
}

/**
 * Finds generated assets by hashed file prefix.
 */
function listAssets(pattern, label) {
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`Missing OpenClaw control-ui assets directory: ${assetsDir}`);
  }

  const files = fs
    .readdirSync(assetsDir)
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => path.join(assetsDir, name));

  if (files.length === 0) {
    throw new Error(`Missing ${label} asset in ${assetsDir}`);
  }

  return files;
}

/**
 * Finds generated Skills page chunks.
 */
function listSkillsAssets() {
  return listAssets(/^skills-page-.*\.js$/, "skills-page");
}

/**
 * Finds route chunks that may hold `skills.search` request helpers.
 */
function listSkillHubRouteAssets() {
  const files = new Set([...listSkillsAssets(), ...listAssets(/^index-.*\.js$/, "index js")]);
  return [...files].sort();
}

/**
 * Records a missing token with file and reason.
 */
function assertContains(errors, file, source, token, reason) {
  if (!source.includes(token)) {
    errors.push(`${relative(file)} missing ${reason}: ${JSON.stringify(token)}`);
  }
}

/**
 * Records a forbidden token with file and reason.
 */
function assertNotContains(errors, file, source, token, reason) {
  if (source.includes(token)) {
    errors.push(`${relative(file)} contains forbidden ${reason}: ${JSON.stringify(token)}`);
  }
}

/**
 * Checks a token that may be represented by one of several minified forms.
 */
function assertAnyContains(errors, file, source, tokens, reason) {
  if (!tokens.some((token) => source.includes(token))) {
    errors.push(`${relative(file)} missing ${reason}: one of ${tokens.map(JSON.stringify).join(", ")}`);
  }
}

/**
 * Finds all quoted JavaScript string literals for a static value.
 */
function findQuotedLiterals(source, value) {
  const forms = [`\`${value}\``, `"${value}"`, `'${value}'`];
  const positions = [];

  for (const form of forms) {
    let cursor = 0;
    while (true) {
      const current = source.indexOf(form, cursor);
      if (current === -1) {
        break;
      }

      positions.push(current);
      cursor = current + form.length;
    }
  }

  return positions.sort((left, right) => left - right);
}

/**
 * Verifies a set of static literals appear close enough to be one UI/request group.
 */
function assertGroupedLiterals(errors, file, source, values, reason, maxSpan) {
  const positionSets = values.map((value) => ({ value, positions: findQuotedLiterals(source, value) }));

  for (const { value, positions } of positionSets) {
    if (positions.length === 0) {
      errors.push(`${relative(file)} missing ${reason}: ${JSON.stringify(value)}`);
    }
  }

  if (positionSets.some(({ positions }) => positions.length === 0)) {
    return;
  }

  const rarest = [...positionSets].sort((left, right) => left.positions.length - right.positions.length)[0];
  for (const anchor of rarest.positions) {
    const lower = anchor - maxSpan;
    const upper = anchor + maxSpan;
    const grouped = positionSets.every(({ positions }) => positions.some((position) => position >= lower && position <= upper));
    if (grouped) {
      return;
    }
  }

  errors.push(`${relative(file)} ${reason} tokens are not grouped together within ${maxSpan} chars`);
}

/**
 * Verifies store homepage tokens required by SkillHub store PRD.
 */
function verifyStoreHomeAsset(file, errors) {
  const source = readUtf8(file);

  const tabsStart = source.indexOf("function UcSkillHubRenderTopTabs");
  const tabsEnd = tabsStart >= 0 ? source.indexOf("function UcSkillHubRenderToolbar", tabsStart) : -1;
  const tabsSource = tabsStart >= 0 && tabsEnd > tabsStart ? source.slice(tabsStart, tabsEnd) : "";
  if (!tabsSource) {
    errors.push(`${relative(file)} missing SkillHub primary tabs helper`);
  }
  for (const label of tabLabels) {
    assertContains(errors, file, tabsSource, label, "store primary tab label");
  }

  for (const token of denseUiTokens) {
    assertContains(errors, file, source, token, "high-density SkillHub UI token");
  }

  for (const token of forbiddenLeftCategoryNavTokens) {
    assertNotContains(errors, file, source, token, "left-side SkillHub category nav token");
  }

  for (const token of forbiddenAutoLoadMoreTokens) {
    assertNotContains(errors, file, source, token, "abandoned auto load-more token");
  }

  for (const token of bundledFilterTokens) {
    assertContains(errors, file, source, token, "bundled skills visibility filter");
  }

  assertContains(errors, file, source, strictInstallableToken, "strict installable tab filter");

  for (const token of identityRefTokens) {
    assertContains(errors, file, source, token, "identity-safe SkillHub reference token");
  }

  for (const alternatives of identityRefAlternatives) {
    assertAnyContains(errors, file, source, alternatives, "identity-safe SkillHub reference token");
  }

  for (const token of orangePrimaryTokens) {
    assertNotContains(errors, file, source.toLowerCase(), token.toLowerCase(), "orange primary color token");
  }
}

/**
 * Verifies details stay within the Gateway schema while install keeps owner-qualified refs.
 */
function verifyDetailRequestContract(files, errors) {
  for (const file of files) {
    const source = readUtf8(file);
    if (unsafeOwnerHandleDetailPattern.test(source)) {
      errors.push(`${relative(file)} skills.detail request sends ownerHandle, but Gateway schema only accepts slug`);
    }
  }
}

/**
 * Runs static SkillHub store homepage checks.
 */
function main() {
  const errors = [];

  try {
    const skillsAssets = listSkillsAssets();
    for (const file of skillsAssets) {
      verifyStoreHomeAsset(file, errors);
    }
    const routeAssets = listSkillHubRouteAssets();
    verifyDetailRequestContract(routeAssets, errors);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (errors.length > 0) {
    console.error("SkillHub store homepage verification failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log("OK SkillHub store homepage verified");
}

main();
