#!/usr/bin/env node

/**
 * Verifies that Bavi-box's model usage dashboard is patched into the Config quick page.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const assetsDir = path.join(root, "node_modules/openclaw/dist/control-ui/assets");
const configFile = fs.readdirSync(assetsDir).find((name) => /^config-page-.*\.js$/.test(name));
const usageFile = fs.readdirSync(assetsDir).find((name) => /^usage-page-.*\.js$/.test(name));
const indexFile = fs.readdirSync(assetsDir).find((name) => /^index-.*\.js$/.test(name));
const cssFile = fs.readdirSync(assetsDir).find((name) => /^index-.*\.css$/.test(name));
const swPath = path.join(root, "node_modules/openclaw/dist/control-ui/sw.js");
const configHtmlPath = path.join(root, "resources/Config.html");
const portableConfigPath = path.join(root, "../portable/config-server/public/index.html");

if (!configFile || !usageFile || !indexFile || !cssFile) {
  throw new Error("Missing Control UI config, usage, index, or CSS asset");
}

const configSource = fs.readFileSync(path.join(assetsDir, configFile), "utf8");
const usageSource = fs.readFileSync(path.join(assetsDir, usageFile), "utf8");
const indexSource = fs.readFileSync(path.join(assetsDir, indexFile), "utf8");
const cssSource = fs.readFileSync(path.join(assetsDir, cssFile), "utf8");
const swSource = fs.readFileSync(swPath, "utf8");
const configHtmlSource = fs.readFileSync(configHtmlPath, "utf8");
const portableConfigSource = fs.readFileSync(portableConfigPath, "utf8");

const checks = [
  [configSource, "function UcQuickModelDashboard(", "config quick dashboard renderer"],
  [configSource, "data-uclaw-config-model-dashboard", "config dashboard root marker"],
  [configSource, "账户余额", "money balance card"],
  [configSource, "今日消耗", "today compute metric"],
  [configSource, "已消耗", "used quota metric"],
  [configSource, "请求次数", "request count metric"],
  [configSource, "requestCount", "New API request count field"],
  [configSource, "used_quota", "New API used quota label"],
  [configSource, "accountBalanceCompute", "New API account balance compute field"],
  [configSource, "function UcQuickFmtQuotaYuan(", "quota to CNY helper"],
  [configSource, "todayCompute", "New API today compute field"],
  [configSource, "last7DaysCompute", "New API 7-day compute field"],
  [configSource, "cumulativeCompute", "New API cumulative compute field"],
  [configSource, "computeUnitsPerCny", "Bavi-box compute conversion ratio"],
  [configSource, "newapiQuotaPerCny", "New API quota conversion ratio"],
  [configSource, "function UcQuickQuotaToCompute(", "New API quota to compute helper"],
  [configSource, "function UcQuickCloudDaily(", "New API daily compute chart helper"],
  [configSource, "function UcQuickRecordSource(", "New API ledger source helper"],
  [configSource, "function UcQuickFmtMs(", "New API use time formatter"],
  [configSource, "模型能力", "model capability cards"],
  [configSource, "使用流水", "usage ledger"],
  [configSource, "sessions.usage", "sessions usage RPC"],
  [configSource, "usage.cost", "cost RPC"],
  [configSource, "usage.status", "provider status RPC"],
  [configSource, "getModelUsageSummary", "cloud New API usage bridge"],
  [configSource, "cloudSummary", "cloud usage summary state"],
  [configSource, "New API 数据暂不可用", "cloud usage fallback message"],
  [configSource, "1 元 = 600w 算力", "cloud compute conversion label"],
  [configSource, "账户余额", "cloud money metric label"],
  [configSource, "文本对话", "specific text capability tag"],
  [configSource, "图片编辑", "specific image capability tag"],
  [configSource, "任务轮询", "specific video capability tag"],
  [configSource, "groupBy:`family`", "valid sessions.usage grouping"],
  [configSource, "setDate(n.getDate()-13)", "14-day usage window"],
  [configSource, "function UcQuickSessionDaily(", "session daily fallback"],
  [configSource, "onRefreshModelUsage", "refresh callback"],
  [configSource, "同步模型", "cloud catalog sync button"],
  [configSource, "refreshModelCatalog", "cloud catalog refresh bridge"],
  [configSource, "onRefreshModelCatalog:()=>this.uclawRefreshModelCatalog()", "cloud catalog sync callback"],
  [cssSource, ".uclaw-config-model-head-actions{display:flex", "cloud catalog action group CSS"],
  [configSource, "kind:`image`", "model card kind marker"],
  [configSource, "async uclawChangeModel(e,t)", "direct model change method"],
  [configSource, "uclawRefreshModelCatalog({silent:!0})", "model change refreshes cloud catalog"],
  [configSource, "n?.capabilities", "model candidates use cloud capabilities"],
  [configSource, "e?.silent", "silent cloud catalog refresh mode"],
  [configSource, "onModelChange:(e,t)=>this.uclawChangeModel(e,t)", "model card change callback"],
  [configSource, "[`agents`,`defaults`,`model`,`primary`]", "text model config path"],
  [configSource, "[`agents`,`defaults`,`imageGenerationModel`,`primary`]", "image generation model config path"],
  [configSource, "[`agents`,`defaults`,`imageModel`,`primary`]", "image model config path"],
  [configSource, "[`agents`,`defaults`,`videoGenerationModel`,`primary`]", "video model config path"],
  [configSource, "uclawModelCandidates(e,t)", "model candidate builder"],
  [configSource, "let c={text:[o.model],image:[o.imageGenerationModel,o.imageModel],video:[o.videoGenerationModel]}[e]??[]", "model picker uses kind-specific defaults"],
  [configSource, "o.includes(`text`)&&!o.includes(`image`)&&!o.includes(`video`)", "text picker excludes image and video capabilities"],
  [configSource, "uclawApplyModelChoice(e,t)", "model selector save method"],
  [configSource, "o.className=`uclaw-model-picker`", "model selector modal root"],
  [configSource, "placeholder=\"搜索或输入模型 id（当前", "model selector search input keeps current as hint"],
  [configSource, "）\" value=\"\"", "model selector starts unfiltered"],
  [configSource, "没有匹配项，可直接确认输入的模型 id。", "model selector empty state"],
  [configSource, "t.key===`Escape`", "model selector escape close"],
  [configSource, "t.key===`Enter`", "model selector enter confirm"],
  [configSource, "r.patchForm(e,i)", "model selector config patch"],
  [configSource, "r.save()", "model change save"],
  [configSource, "r.apply?.()", "model change apply"],
  [indexSource, "id:`nav-models`,label:`模型`,icon:`settings`,category:`navigation`,action:`nav:config`", "model navigation points to config"],
  [cssSource, "uclaw-config-model-dashboard", "config dashboard CSS"],
  [cssSource, ".content:has(.uclaw-config-model-dashboard) .config-view-toggle", "hidden simple/advanced toggle"],
  [cssSource, ".settings-workspace:has(.uclaw-config-model-dashboard)>.settings-section-nav", "hidden settings section nav"],
  [configSource, "uclaw-config-model-advanced", "advanced config button class"],
  [cssSource, ".uclaw-config-model-advanced{display:none!important}", "hidden advanced config button"],
  [configSource, "uclaw-config-model-tags", "non-wrapping model tag row"],
  [configSource, "uclaw-config-model-change", "model change chip"],
  [cssSource, ".uclaw-config-model-tags{display:flex;flex-wrap:nowrap", "model tags do not wrap"],
  [cssSource, ".uclaw-config-model-card b,.uclaw-config-model-change{flex:0 0 auto;white-space:nowrap}", "model tags fixed width"],
  [cssSource, ".uclaw-config-model-card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(255px,1fr))", "responsive model card grid"],
  [cssSource, ".uclaw-config-model-card div>span:first-child{flex:0 0 auto;white-space:nowrap", "model card title no wrap"],
  [cssSource, ".uclaw-config-model-card div .uclaw-config-model-card-tools{flex:0 0 auto", "model card tools no shrink"],
  [cssSource, ".uclaw-config-model-card div em{white-space:nowrap", "model status no wrap"],
  [cssSource, "@media (max-width:1420px){.uclaw-config-model-main{grid-template-columns:1fr}.uclaw-config-model-summary{grid-template-columns:repeat(3,minmax(0,1fr))}}", "small screen stacks model sections"],
  [cssSource, ".uclaw-model-picker{position:fixed;inset:0", "model selector modal CSS"],
  [cssSource, ".uclaw-model-picker__option:hover,.uclaw-model-picker__option.is-selected", "model selector selected state CSS"],
  [cssSource, ".uclaw-model-picker__list{max-height:260px;min-height:0;overflow:auto;display:flex;flex-direction:column", "compact model selector list"],
  [cssSource, ".uclaw-model-picker__option{min-height:66px", "compact model selector option"],
  [swSource, "config-model-dashboard-1", "service worker cache marker"],
];

for (const [source, needle, label] of checks) {
  if (!source.includes(needle)) {
    throw new Error(`Missing ${label}: ${needle}`);
  }
}

const forbiddenByFile = [
  [usageSource, "data-uclaw-model-usage-dashboard", "old /usage dashboard root"],
  [usageSource, "function UcModelUsageDashboard(", "old /usage dashboard renderer"],
  [indexSource, "action:`nav:usage`", "model navigation to wrong route"],
  [indexSource, "sidebarPinnedRoutes:[`agents`,`tasks`,`skills`,`usage`]", "usage route pinned as model page"],
  [indexSource, "enabledRouteIds(){return[`agents`,`tasks`,`skills`,`usage`]}", "usage route enabled as primary model page"],
  [cssSource, "uclaw-model-usage-dashboard", "old /usage dashboard CSS"],
  [swSource, "model-usage-dashboard-1", "old service worker cache marker"],
  [configHtmlSource, "openModelUsage", "Electron config center wrong shortcut"],
  [configHtmlSource, "/usage#token=uclaw", "Electron config center wrong route"],
  [portableConfigSource, "openModelUsage", "portable config center wrong shortcut"],
  [portableConfigSource, "/usage#token=uclaw", "portable config center wrong route"],
  [configSource, "42,982,186", "fake billing token"],
  [configSource, "data-fake-billing", "fake billing marker"],
  [configSource, "groupBy:`day`", "invalid sessions.usage grouping"],
  [configSource, "let i={startDate:n,endDate:n", "today-only usage window"],
  [configSource, "globalThis.prompt?.", "browser prompt model selector"],
  [cssSource, ".uclaw-config-model-card p{display:flex;flex-wrap:wrap", "wrapping model tags"],
  [cssSource, ".uclaw-config-model-card-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))", "fixed squeezed model card grid"],
  [cssSource, ".uclaw-model-picker__list{min-height:180px;overflow:auto;display:grid", "stretched model selector list"],
];

for (const [source, needle, label] of forbiddenByFile) {
  if (source.includes(needle)) {
    throw new Error(`Forbidden ${label}: ${needle}`);
  }
}

console.log("config model usage dashboard verified");
