const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const controlUiDir = path.join(root, "node_modules", "openclaw", "dist", "control-ui");
const assetsDir = path.join(controlUiDir, "assets");
const swPath = path.join(controlUiDir, "sw.js");
const indexHtmlPath = path.join(controlUiDir, "index.html");
const manifestPath = path.join(controlUiDir, "manifest.webmanifest");
const loadingHtmlPath = path.join(root, "src", "loading.html");
const officialIconSvgPath = path.join(root, "assets", "icon.svg");
const officialIconPngPath = path.join(root, "assets", "icon.png");
const officialIconIcoPath = path.join(root, "assets", "icon.ico");

const visibleSkillHubTexts = [
  "搜索技能商店技能…",
  "暂无匹配技能商店技能。",
  "技能商店链接无效",
  "筛选已安装技能",
  "安装中…",
  "UcSkillHubLoadApiSkills",
  "UcSkillHubFallbackSkillsSearch",
  "兼容模式",
  "推荐首页",
  "安装来源",
  "README 暂无",
  "UcSkillHubCategories",
  "UcSkillHubTrustLabel",
  "UcSkillHubQualifiedRef",
  "UcSkillHubDisplayText",
  "UcSkillHubErrorText",
  "changeClawHubQuery(e){this.syncGatewayState()",
  "UcSkillHubApiUrl",
  "this.loadSkillHubHome=async",
  "icon_url",
  "iconURL",
  "logoUrl",
  "imageUrl",
  "推荐首页",
  "UcSkillHubBuildViewModel",
  "UcSkillHubCategoryRegistry",
  "UcSkillHubCategoryPublicApi",
  "UClawSkillHubCategories",
  "UcSkillHubRenderIcon",
  "data-skillhub-icon-img",
  "UcSkillHubInstalledIndex",
  "UcSkillHubInstalledMatch",
  "data-skillhub-installed-badge",
  "skillhub-dense-row",
  "data-skillhub-scroll-shell",
  "data-skillhub-scroll-table",
  "data-skillhub-flex-fill",
  "overscroll-behavior: contain",
  "e.onClawHubInstall?.(t)",
  "UcSkillHubRenderScenePicker",
  "data-skillhub-scene-picker",
  "data-skillhub-scene-option",
  "c=i&&!t.isLocal?UcSkillHubFormatMetric(t.totalItems)",
  "skillhub-scene-icon",
  "data-skillhub-toolbar",
  "data-skillhub-search",
  "data-skillhub-content",
  "data-skillhub-primary-tabs",
  "data-skillhub-single-layer",
  "API Key 不限",
  "场景分类",
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
  "data-skillhub-pagination",
  "data-skillhub-page-button",
  "skillHubPage",
  "skillHubTotal",
  "aria-busy",
  "搜索中…",
  "下一页",
  "技能商店请求超时，请稍后重试。",
  "技能商店搜索失败：${t}",
  "安装中…",
  "等待中",
  "确认风险并安装",
  "作者：",
  "安装 ${n.displayName}",
  "缺少必要条件",
  "完整安全报告",
  "Skill Card 未加载。",
];

const preservedRuntimeNames = ["onClawHub", "clawhub"];
const bundledVisibilityTokens = ["source===`openclaw-bundled`", "bundled===!0"];
const skillHubIdentityTokens = [
  "limit:40",
  "function UcSkillHubRefParts",
  "ownerHandle",
  "installSource",
  "source:a.installSource||`clawhub`",
  "slug:a.slug",
];
const chatSkillHubTokens = [
  "function UcSkillHubDropdown",
  "data-chat-skillhub-select",
  "选择你的技能",
  "技能暂不可用",
  "技能商店技能",
  "function UcSkillHubNormalizeText",
  "function UcSkillHubHasCjk",
  "function UcSkillHubPickChinese",
  "function UcSkillHubChineseTitle",
  "description_zh",
  "summary_zh",
  "skills.status",
  "runtimeConfig",
  "已保存，新会话生效",
];
const requiredUiPolishTexts = {
  chat: [
    "正在加载会话",
    "运行状态：",
    "Bavi-box 运行结束但未返回文本。",
    "新消息",
    "正在准备模型...",
    "正在连接语音输入...",
    "正在创建新会话...",
    "**可用命令**",
    "向当前运行注入消息",
    "显示你的发送者 ID。",
    "管理会话级设置",
    "列出、查看、启用或停用插件。",
    "运行宿主机 shell 命令",
    "当前运行或排队消息完成后再开始新会话。",
    "Gateway 未连接",
    "开始新会话？这会重置当前聊天。",
    "显示可用命令。",
    "运行指定技能。",
    "TTS 动作",
  ],
  skillsShared: ["工作区技能", "内置依赖", "已安装技能商店"],
  agents: [
    "按 Agent 管理可见技能与工作区技能，保存后生效。",
    "全部启用",
    "保存中…",
    "function UcExpertTemplates(){return[",
    "function UcExpertExtraTemplates(){return UcExpertExtraTemplateSpecs().map(UcExpertTemplateItem)}",
    "function UcExpertTemplateItem(e){",
    "function UcExpertCatalog(e){",
    "function UcCustomExpertDefaults(){",
    "function UcExpertDefaultAgentId(e){",
    "function UcSetExpertPersona(e,t){",
    "uclaw.expertPersonas.v1",
    "function UcCustomExpertForm(e){",
    "function UcCustomExpertModal(e){",
    "function UcExpertSectionTitle",
    "function UcExpertCategories(){",
    "function UcExpertIconSvg(e){",
    "function UcExpertCategoryRail",
    "expertCategoryFilter:this.expertCategoryFilter",
    "onExpertCategoryChange:e=>{this.expertCategoryFilter=e||`all`",
    "updateComplete?.then",
    "behavior:`auto`",
    "type='button' aria-pressed",
    "preventDefault(),e.onExpertCategoryChange",
    "function UcExpertDirectoryBlock",
    "function UcExpertTemplatePicker",
    "s=i===`all`?n:n.filter",
    "${c} · ${s.length} 个专家模板",
    "function UcExpertTemplateCard",
    "function UcExpertManagement(e,t){",
    "function UcExpertDetail(e,t){",
    "data-uclaw-expert-landing",
    "data-uclaw-expert-create-center",
    "uclaw-expert-directory-shell",
    "uclaw-expert-directory-pane",
    "data-uclaw-expert-scroll-list",
    "uclaw-expert-category-rail",
    "uclaw-expert-card--directory",
    "data-uclaw-custom-expert-form",
    "data-uclaw-custom-expert-modal",
    "专家目录",
    "创建并进入会话",
    "模型与技能",
    "表单失败不会清空",
    "文案写手",
    "小红书写手",
    "社群文案",
    "短视频脚本",
    "职业顾问",
    "简历写手",
    "面试教练",
    "学习教练",
    "产品经理",
    "数据分析师",
    "创业点子王",
    "用户研究",
    "机器学习",
    "代码审查",
    "测试用例专家",
    "架构顾问",
    "会议纪要",
    "翻译润色",
    "汇报策划",
    "文档整理",
    "合同审阅",
    "客服话术",
    "商务邮件",
    "销售顾问",
    "SEO 内容策划",
    "品牌语气官",
    "管理教练",
    "增长分析师",
    "前端架构师",
    "邮件助理",
    "NDA 审阅",
    "客户成功顾问",
    "汇报策划",
    "uclaw-custom-card-head",
    "uclaw-custom-expert-modal",
    "uclaw-form-control",
    "Prompt 已填写",
    "customExpertModalOpen",
    "sessionsResult:this.sessionsResult",
    "this.agentsPanel=`overview`",
    "async createExpertFromTemplate",
    "async createCustomExpert",
    "async createSessionForExpert",
    "continueExpertSession",
    "openExpertSession",
    "editExpert",
    "this.agentsPanel=`files`,this.agentFileActive=`AGENTS.md`",
    "archiveExpert",
    "agents.create",
    "agents.update",
    "agents.files.set",
    "agents.files.get",
    "sessions.create",
    "已在 main 下创建专家会话",
    "已在 main 下创建自定义专家会话",
    "label:i",
    "label:t",
    "AGENTS.md",
    "~/.openclaw/agents/${r}/workspace",
    "存在未保存配置，请先保存或撤销后再创建专家。",
    "runtimeConfig readback",
    "model readback mismatch",
    "skills readback mismatch",
    "agents.list readback",
    "创建中…",
    "onCreateExpert",
    "onCreateCustomExpert",
    "onOpenCustomExpert",
    "onCloseCustomExpert",
    "onCustomExpertField",
    "onCustomExpertSkill",
    "onCustomExpertRefreshSkills",
    "onContinueExpert",
    "onNewExpertSession",
    "onEditExpert",
    "onArchiveExpert",
    "onOpenSession",
    "customExpertForm:this.customExpertForm",
    "expertCreateBusyId",
    "正在加载运行时工具目录…",
    "当前可用",
    "快捷预设",
    "已保存",
    "工具权限",
    "配置有未保存变更。",
    "实时可用",
    "当前会话暂不可用。",
    "备用模型",
    "未设置",
    "插件：",
    "个实时工具",
  ],
  channels: [
    "机器人状态与渠道配置。",
    "macOS 桥接状态与渠道配置。",
    "连接 WhatsApp Web，并监控连接状态。",
    "Socket Mode 状态与渠道配置。",
    "账号 (",
    "配置 schema 不可用，请使用 Raw。",
    "正在加载配置 schema…",
    "资料已发布到 relays。",
    "WhatsApp 二维码",
  ],
  configForm: [
    "label:`环境变量`",
    "description:`API keys 与认证配置`",
    "description:`技能商店技能包与能力`",
    "description:`用户界面偏好`",
    "不支持的 schema，请使用 Raw。",
  ],
  configPage: [
    "Bavi-box 助手",
    "适合日常使用的均衡默认配置。",
    "代码 Agent",
    "Bavi-box 助手身份",
    "`备用 Logo`",
    "保存并发布",
    "尚未配置 MCP servers。",
    "选择 Bavi-box 每次运行注入多少工作区上下文。",
  ],
  overview: [
    "title:`Gateway 错误`",
    "title:`技能缺少依赖`",
    "个技能被阻止",
    "个定时任务失败",
    "个活跃",
    "条消息",
  ],
  index: [
    "配置版本缺失，请重新加载后重试。",
    "配置版本缺失，请刷新后重试。",
    "安装前请复核技能商店风险提示。",
    "Ye=[`agents`,`tasks`,`skills`,`config`]",
    "sidebarPinnedRoutes:[`agents`,`tasks`,`skills`,`config`]",
    "enabledRouteIds(){return[`agents`,`tasks`,`skills`,`config`]}",
    "renderMoreSection(){return l}",
    "function UcIsVisibleSessionAgentId(e)",
    "function UcSidebarSessionName(e,t)",
    "label:UcSidebarSessionName(this,t)",
    "agentIdentity?.get",
    "\"uclaw-expert-copywriter\":`文案写手`",
    "function Ar(e){let t=new Set,n=[],r=r=>{let i=j(r);UcIsVisibleSessionAgentId(i)",
    "config:{titleKey:`tabs.config`,subtitleKey:`subtitles.config`}",
    "id:`nav-workflows`,label:`工作流`,icon:`scrollText`,category:`navigation`,action:`nav:tasks`",
    "id:`nav-models`,label:`模型`,icon:`settings`,category:`navigation`,action:`nav:config`",
    "Wm=`Bavi-box`",
    "assistantIdentity:{agentId:null,name:`Bavi-box`,avatar:null,avatarSource:null,avatarStatus:null,avatarReason:null}",
  ],
  i18n: [
    "agents:`智能体`",
    "tasks:`工作流`",
    "skills:`技能库`",
    "config:`模型`",
    "agents:`专家、会话与身份。`",
    "tasks:`自动任务、子智能体与运行记录。`",
    "skills:`技能库、安装与本地技能管理。`",
    "config:`模型、供应商与默认参数。`",
    "subtitle:`Bavi-box Gateway`",
    "title:`如何连接`",
    "step1:`在主机启动 Gateway：`",
    "stepPaste:`粘贴 openclaw dashboard --no-open 输出的 token",
    "configured:`已配置`",
    "running:`运行中`",
    "title:`渠道健康`",
    "editProfile:`编辑资料`",
  ],
  secondaryI18n: [
    "loadingTitle:`正在加载面板`",
    "title:`Bavi-box 移动端`",
    "instances:{title:`已连接实例`",
    "worktrees:{title:`托管工作树`",
    "sessionsView:{title:`会话`",
    "subtitle:`活跃会话 key 与单会话覆盖项。`",
    "noSessions:`未找到会话。`",
    "dateToday:`今天`",
    "eventArchived:`已归档`",
    "eventUnarchived:`已恢复`",
    "eventStale:`过期会话`",
    "activity:`活动`",
    "tasks:`自动任务、子智能体与运行记录。`",
    "loading:`正在加载任务…`",
    "activity:{title:`活动`",
    "argumentHiddenOne:`1 个参数已隐藏`",
    "logsView:{title:`日志`",
    "disabledHelpStart:`Workboard 已停用。启用`",
  ],
  finalSessionDisplay: [
    "fallbackName:`主会话`",
    "prefix:`子智能体：`",
    "fallbackName:`定时任务：`",
    "fallbackName:`${n[t]} 会话`",
  ],
  finalIndex: [
    "a?`刚刚`:`不到 1 分钟后`",
    "a?`${s} 分钟前`:`${s} 分钟后`",
    "return t===`刚刚`?`刚刚`",
  ],
  finalNodes: [
    "<div class=\"card-title\">Exec 审批</div>",
    "<span class=\"label\">范围</span>",
    "<div class=\"list-title\">目标</div>",
    "<div class=\"list-title\">安全</div>",
    "默认安全模式。",
    "<div class=\"list-title\">询问兜底</div>",
    "<div class=\"list-title\">自动允许 Skill CLI</div>",
    "暂无可用 system.run 节点。",
    "<div class=\"card-title\">设备</div>",
    "已配对设备与实时连接。",
  ],
  finalConfig: [
    "[[`quick`,`简洁`],[`advanced`,`高级`]]",
    "${V(g.brain,`模型与思考`)}",
    "<span class=\"qs-row__label\">模型</span>",
    "<span class=\"qs-row__label\">快速模式</span>",
    "${V(g.send,`渠道`,n)}",
    "${V(g.eye,`安全`,i`<button",
    "${V(g.monitor,`Gateway 主机`)}",
    "<span class=\"qs-row__label\">设备认证</span>",
    "连接 →",
    "配置 →",
    "`已启用`",
    "`无`",
  ],
  secondaryInlineActivity: [
    "b={running:`运行中`,done:`已完成`,error:`失败`}",
    "let r=`${n} 个参数已隐藏`",
  ],
  secondaryInlineNodes: [
    "保存中…",
    ">选择节点</option>",
    "暂无节点声明 exec approvals。",
    "默认 prompt 策略。",
    "重连信息已变更，需要批准",
    "Tokens：无",
  ],
  secondaryInlineInstances: ["暂无实例。", "暂无 presence payload。"],
  secondaryInlineLogs: ["u-claw-logs-${t}-${a}.log"],
  finalSessionsPage: [
    "C=(c(x?.name)??``).replace(/^Assistant$/,`Bavi-box`)",
    "控制台",
    "共 ${o} 行",
    "每页 ${e} 条",
    "上一页",
  ],
  tertiaryI18n: [
    "skills:`技能库、安装与本地技能管理。`",
    "title:`Bavi-box 移动端`",
    "qrAlt:`Bavi-box 移动端配对二维码`",
    "waiting:`Bavi-box 移动端扫码后会自动连接。`",
    "debug:{snapshotsTitle:`快照`",
    "manualRpcTitle:`手动 RPC`",
    "execApprovalNeeded:`需要 Exec 审批`",
    "settings:`设置`",
    "terminal:{title:`终端`",
    "skillWorkshop:{header:{useCurrentChat:`使用当前聊天`",
    "usage:`用量概览`",
    "nav:{previousDay:`前一天`",
    "modelMissing:`缺少视觉模型`",
    "usage:{common:{emptyValue:`—`,unknown:`未知`}",
    "providerUsage:{title:`Provider 套餐与账单`",
    "filters:{title:`筛选`",
    "overview:{title:`用量概览`",
    "quickCreate:{schedules:{everyMorning:{label:`每天早上`",
    "title:`新建定时任务`",
    "jobs:{title:`任务`",
    "emptyTitle:`暂无定时任务。`",
    "runs:{title:`运行历史`",
  ],
  skillWorkshopPage: [
    "k={all:`全部`,pending:`待复核`,applied:`已应用`,rejected:`已拒绝`,quarantined:`已隔离`,stale:`已过期`}",
    'aria-label="暂无技能商店工坊提案"',
    '<p class="sw-empty-state__eyebrow">技能商店工坊</p>',
    "<h2>暂无提案</h2>",
    "当前 Agent 尚未起草任何技能商店提案。",
    "新提案会出现在这里等待复核。",
    "<span>看板</span>",
    "<span>今日</span>",
  ],
  deepAgentsChatI18n: [
    "agents:{noAgents:`暂无 Agent`",
    "context:{title:`Agent 上下文`",
    "subtitle:`Gateway 全局渠道状态快照。`",
    "cronPanel:{schedulerTitle:`调度器`",
    "files:{emptyDraft:`空草稿`",
    "chat:{disconnected:`Gateway 已断开。`",
    "sidebar:{allSessions:`全部会话`",
    "welcome:{ready:`Bavi-box 已就绪`",
    "runControls:{newSession:`新会话`",
    "composer:{placeholder:`给 {name} 发消息`",
    "selectors:{agentFilter:`按 Agent 筛选会话`",
    "workspaceFiles:{label:`会话工作区`",
  ],
  css: [
    "/* Bavi-box UI polish v1 */",
    "--uclaw-navy: #10162b",
    "--uclaw-claw: #69b1ff",
    "--accent: #1677ff",
    "--primary: #1677ff",
    "--bg-content: #f7f9fc",
    "--border-hover: #91caff",
    "--uclaw-teal: #4096ff",
    "object-fit: contain",
    "background: #ffffff",
    "width:min(100%,760px)",
    ".sidebar-brand__title",
    ".agent-chat__avatar--logo",
    ".nav-item--active",
    ".agent-chat__input-btn--talk",
    "chat-composer-controls-polish-3",
    "background: #e6f4ff !important",
    "border-color: #91caff !important",
    ".agent-chat__input-btn--talk:hover:not(:disabled)",
    ".agent-chat__input-btn--talk[aria-pressed=\"true\"]",
    "flex: 0 1 224px",
    "agents-layout > .uclaw-expert-landing ~ *",
    "grid-template-columns: repeat(3, minmax(260px, 1fr))",
    ".uclaw-expert-options.wide",
    "grid-column: 1 / -1",
    ".content openclaw-agents-page",
    "openclaw-agents-page .uclaw-expert-directory-pane",
    "openclaw-agents-page .uclaw-expert-directory-list",
    "openclaw-agents-page .uclaw-expert-category-block",
    "grid-template-columns: 172px minmax(0, 1fr)",
    "grid-auto-rows: max-content",
    "align-content: start",
    "width: 100%",
    "background: transparent",
    "cursor: pointer",
    "overflow-y: auto",
    "overscroll-behavior: contain",
    "padding-bottom: 28px",
    "openclaw-skills-page [data-skillhub-scene-option=\"true\"]",
    "color: #1f2937",
    "color: rgba(255, 255, 255, 0.86)",
    "openclaw-skills-page .content-header",
    "max-height: none",
    "min-height: 54px",
    "padding-top: 0",
    "openclaw-skills-page .page-sub,",
    "flex: 0 0 auto",
    "max-width: none",
    "repeat(auto-fit, minmax(min(100%, 340px), 1fr))",
    "background: #ffffff",
    "-webkit-line-clamp: 2",
    "-webkit-line-clamp: 3",
    "height: 32px",
    "width: 44px",
    ".chat-controls__skillhub .chat-controls__inline-select-trigger",
    ".chat-controls__inline-select-option--selected",
    "button[aria-label*=\"麦克风\"]",
    "openclaw-skills-page .statusDot.warn",
    "openclaw-skills-page .statusDot.ok",
    "openclaw-channels-page .account-count",
    ".content {",
    ".content:not(.content--chat):not(.content--workboard)",
    "background-image: linear-gradient(180deg, #f8fafc 0%, #f7f9fc 100%)",
    ".ov-card__label",
    ".sw-empty-state__eyebrow",
    ".data-table-wrapper",
    ".chat-controls__inline-select-menu",
    "@media (max-width: 640px)",
  ],
};

/**
 * Reads a generated OpenClaw UI file as UTF-8 text for deterministic assertions.
 */
function readUtf8(file) {
  return fs.readFileSync(file, "utf8");
}

function assertSameFile(errors, source, target, label) {
  if (!fs.existsSync(source)) {
    errors.push(`Missing source ${label}: ${source}`);
    return;
  }

  if (!fs.existsSync(target)) {
    errors.push(`Missing patched ${label}: ${target}`);
    return;
  }

  const sourceBytes = fs.readFileSync(source);
  const targetBytes = fs.readFileSync(target);
  if (!sourceBytes.equals(targetBytes)) {
    errors.push(`${path.relative(root, target)} does not match ${path.relative(root, source)}`);
  }
}

/**
 * Finds all generated skills page assets patched by scripts/patch-openclaw.js.
 */
function listSkillsAssets() {
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`Missing OpenClaw control-ui assets directory: ${assetsDir}`);
  }

  const files = fs
    .readdirSync(assetsDir)
    .filter((name) => /^skills-page-.*\.js$/.test(name))
    .sort()
    .map((name) => path.join(assetsDir, name));

  if (files.length === 0) {
    throw new Error(`Missing skills-page asset in ${assetsDir}`);
  }

  return files;
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
 * Records a missing token with the relative file path so failures are actionable.
 */
function assertContains(errors, file, source, token, reason) {
  if (!source.includes(token)) {
    errors.push(`${path.relative(root, file)} missing ${reason}: ${JSON.stringify(token)}`);
  }
}

/**
 * Records a forbidden token so generated minified code cannot regress into known runtime crashes.
 */
function assertNotContains(errors, file, source, token, reason) {
  if (source.includes(token)) {
    errors.push(`${path.relative(root, file)} contains ${reason}: ${JSON.stringify(token)}`);
  }
}

/**
 * Verifies first-screen shell branding visible before and after the app mounts.
 */
function verifyControlUiBranding(errors) {
  if (!fs.existsSync(indexHtmlPath)) {
    errors.push(`Missing OpenClaw control-ui HTML: ${indexHtmlPath}`);
    return;
  }

  const html = readUtf8(indexHtmlPath);
  assertContains(errors, indexHtmlPath, html, "<title>Bavi-box Control</title>", "Bavi-box document title");
  assertContains(errors, indexHtmlPath, html, "Bavi-box Control UI", "Bavi-box fallback title");

  for (const file of listAssets(/^index-.*\.js$/, "index js")) {
    const source = readUtf8(file);
    assertContains(
      errors,
      file,
      source,
      '<span class="sidebar-brand__title">Bavi-box</span>',
      "Bavi-box sidebar brand",
    );
    assertContains(
      errors,
      file,
      source,
      '<span class="topbar-brand__title">Bavi-box</span>',
      "Bavi-box topbar brand",
    );
    assertContains(errors, file, source, "                  Bavi-box\n                </a>", "Bavi-box breadcrumb link");
    assertContains(errors, file, source, 'aria-label="Bavi-box"', "Bavi-box accessible brand");
    assertContains(errors, file, source, 'alt="Bavi-box"', "Bavi-box logo alt text");
    assertContains(
      errors,
      file,
      source,
      '<div class="login-gate__title">Bavi-box</div>',
      "Bavi-box login brand",
    );
  }
}

/**
 * Verifies PWA/install metadata no longer exposes the OpenClaw product name.
 */
function verifyControlUiManifest(errors) {
  if (!fs.existsSync(manifestPath)) {
    errors.push(`Missing OpenClaw control-ui manifest: ${manifestPath}`);
    return;
  }

  const source = readUtf8(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    errors.push(`${path.relative(root, manifestPath)} is not valid JSON: ${error.message}`);
    return;
  }

  if (manifest.name !== "Bavi-box Control") {
    errors.push(`${path.relative(root, manifestPath)} name is not Bavi-box Control`);
  }
  if (manifest.short_name !== "Bavi-box") {
    errors.push(`${path.relative(root, manifestPath)} short_name is not Bavi-box`);
  }
  if (source.includes("OpenClaw Control") || source.includes('"OpenClaw"')) {
    errors.push(`${path.relative(root, manifestPath)} still contains OpenClaw product metadata`);
  }
}

/**
 * Verifies user-facing SkillHub copy changed while ClawHub runtime names survived.
 */
function verifySkillsAsset(file, errors) {
  const source = readUtf8(file);

  for (const text of visibleSkillHubTexts) {
    assertContains(errors, file, source, text, "SkillHub branding text");
  }

  for (const name of preservedRuntimeNames) {
    assertContains(errors, file, source, name, "preserved ClawHub runtime name");
  }

  for (const token of bundledVisibilityTokens) {
    assertContains(errors, file, source, token, "bundled skills visibility filter");
  }
}

/**
 * Verifies marketplace search/detail/install requests preserve SkillHub identity.
 */
function verifySkillHubIdentityRequests(errors) {
  for (const file of listAssets(/^index-.*\.js$/, "index js")) {
    const source = readUtf8(file);
    for (const token of skillHubIdentityTokens) {
      assertContains(errors, file, source, token, "SkillHub identity-safe request token");
    }
  }
}

/**
 * Verifies the service worker cache key includes the SkillHub branding patch marker.
 */
function verifyServiceWorker(errors) {
  if (!fs.existsSync(swPath)) {
    errors.push(`Missing OpenClaw service worker: ${swPath}`);
    return;
  }

  const source = readUtf8(swPath);
  const match = source.match(/const EMBEDDED_CACHE_VERSION = "([^"]+)";/);
  if (!match) {
    errors.push(`${path.relative(root, swPath)} missing EMBEDDED_CACHE_VERSION declaration`);
    return;
  }

  if (!match[1].includes("skillhub-branding-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing skillhub-branding-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("bundled-filter-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing bundled-filter-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("ui-polish-7")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing ui-polish-7: ${match[1]}`,
    );
  }

  if (!match[1].includes("ui-polish-8")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing ui-polish-8: ${match[1]}`,
    );
  }

  if (!match[1].includes("ui-polish-9")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing ui-polish-9: ${match[1]}`,
    );
  }

  if (!match[1].includes("ui-polish-10")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing ui-polish-10: ${match[1]}`,
    );
  }

  if (!match[1].includes("ui-polish-11")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing ui-polish-11: ${match[1]}`,
    );
  }

  if (!match[1].includes("chat-skillhub-dropdown-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing chat-skillhub-dropdown-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("visible-shell-branding-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing visible-shell-branding-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("chat-command-i18n-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing chat-command-i18n-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("config-overview-i18n-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing config-overview-i18n-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("chat-index-channels-i18n-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing chat-index-channels-i18n-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("i18n-login-channels-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing i18n-login-channels-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("responsive-polish-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing responsive-polish-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("ui-polish-12")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing ui-polish-12: ${match[1]}`,
    );
  }

  if (!match[1].includes("secondary-pages-i18n-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing secondary-pages-i18n-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("ui-polish-13")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing ui-polish-13: ${match[1]}`,
    );
  }

  if (!match[1].includes("ui-polish-14")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing ui-polish-14: ${match[1]}`,
    );
  }

  if (!match[1].includes("tertiary-pages-i18n-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing tertiary-pages-i18n-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("visible-tertiary-i18n-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing visible-tertiary-i18n-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("deep-agents-chat-i18n-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing deep-agents-chat-i18n-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("skillhub-store-discovery-6")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing skillhub-store-discovery-6: ${match[1]}`,
    );
  }

  if (!match[1].includes("skillhub-dense-ui-6")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing skillhub-dense-ui-6: ${match[1]}`,
    );
  }

  if (!match[1].includes("skillhub-installed-memory-2")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing skillhub-installed-memory-2: ${match[1]}`,
    );
  }
  if (!match[1].includes("skillhub-list-scroll-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing skillhub-list-scroll-1: ${match[1]}`,
    );
  }
  if (!match[1].includes("skillhub-list-flex-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing skillhub-list-flex-1: ${match[1]}`,
    );
  }
  if (!match[1].includes("skillhub-viewport-fix-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing skillhub-viewport-fix-1: ${match[1]}`,
    );
  }
  if (!match[1].includes("skillhub-page-scroll-reset-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing skillhub-page-scroll-reset-1: ${match[1]}`,
    );
  }
  if (!match[1].includes("skillhub-category-registry-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing skillhub-category-registry-1: ${match[1]}`,
    );
  }
  if (!match[1].includes("skillhub-scene-picker-2")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing skillhub-scene-picker-2: ${match[1]}`,
    );
  }
  if (!match[1].includes("skillhub-scene-font-color-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing skillhub-scene-font-color-1: ${match[1]}`,
    );
  }
  if (!match[1].includes("skillhub-page-header-safe-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing skillhub-page-header-safe-1: ${match[1]}`,
    );
  }
  if (!match[1].includes("skillhub-compact-header-wrap-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing skillhub-compact-header-wrap-1: ${match[1]}`,
    );
  }
  if (!match[1].includes("skillhub-active-scene-count-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing skillhub-active-scene-count-1: ${match[1]}`,
    );
  }
  if (!match[1].includes("expert-directory-scroll-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing expert-directory-scroll-1: ${match[1]}`,
    );
  }
  if (!match[1].includes("expert-directory-responsive-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing expert-directory-responsive-1: ${match[1]}`,
    );
  }
  if (!match[1].includes("expert-directory-bottom-padding-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing expert-directory-bottom-padding-1: ${match[1]}`,
    );
  }
  if (!match[1].includes("expert-category-compact-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing expert-category-compact-1: ${match[1]}`,
    );
  }
  if (!match[1].includes("expert-category-filter-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing expert-category-filter-1: ${match[1]}`,
    );
  }
  if (!match[1].includes("expert-category-whitespace-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing expert-category-whitespace-1: ${match[1]}`,
    );
  }
  if (!match[1].includes("expert-templates-108-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing expert-templates-108-1: ${match[1]}`,
    );
  }
  if (!match[1].includes("expert-custom-button-removed-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing expert-custom-button-removed-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("skillhub-field-map-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing skillhub-field-map-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("skillhub-proxy-fallback-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing skillhub-proxy-fallback-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("ui-polish-15")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing ui-polish-15: ${match[1]}`,
    );
  }

  if (!match[1].includes("brand-visual-system-4")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing brand-visual-system-4: ${match[1]}`,
    );
  }

  if (!match[1].includes("workspace-background-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing workspace-background-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("final-ui-polish-8")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing final-ui-polish-8: ${match[1]}`,
    );
  }

  if (!match[1].includes("chat-composer-controls-polish-3")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing chat-composer-controls-polish-3: ${match[1]}`,
    );
  }

  if (!match[1].includes("primary-nav-ia-2")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing primary-nav-ia-2: ${match[1]}`,
    );
  }

  if (!match[1].includes("expert-landing-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing expert-landing-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("expert-create-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing expert-create-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("expert-management-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing expert-management-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("expert-custom-form-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing expert-custom-form-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("expert-session-label-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing expert-session-label-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("expert-create-modal-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing expert-create-modal-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("expert-main-session-2")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing expert-main-session-2: ${match[1]}`,
    );
  }

  if (!match[1].includes("expert-visual-density-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing expert-visual-density-1: ${match[1]}`,
    );
  }

  if (!match[1].includes("expert-modal-layout-1")) {
    errors.push(
      `${path.relative(root, swPath)} EMBEDDED_CACHE_VERSION missing expert-modal-layout-1: ${match[1]}`,
    );
  }

  assertContains(errors, swPath, source, 'title: "Bavi-box"', "Bavi-box push fallback title");
  assertContains(errors, swPath, source, 'data.title || "Bavi-box"', "Bavi-box push default title");
}

/**
 * Verifies the official product logo assets replaced the default Control UI icons.
 */
function verifyBrandAssets(errors) {
  assertSameFile(errors, officialIconSvgPath, path.join(controlUiDir, "favicon.svg"), "favicon.svg");
  assertSameFile(errors, officialIconPngPath, path.join(controlUiDir, "apple-touch-icon.png"), "apple-touch-icon.png");
  assertSameFile(errors, officialIconPngPath, path.join(controlUiDir, "favicon-32.png"), "favicon-32.png");
  assertSameFile(errors, officialIconIcoPath, path.join(controlUiDir, "favicon.ico"), "favicon.ico");

  const svg = readUtf8(officialIconSvgPath);
  for (const token of ["Bavi-box logo", "data:image/png;base64"]) {
    if (!svg.includes(token)) {
      errors.push(`${path.relative(root, officialIconSvgPath)} missing product logo token: ${token}`);
    }
  }
  for (const token of ["YanJian Tech logo", "#ff6b35", "#ff8f65", "#e95420", "#ff7a45", "#ffb088"]) {
    if (svg.toLowerCase().includes(token.toLowerCase())) {
      errors.push(`${path.relative(root, officialIconSvgPath)} contains old logo token: ${token}`);
    }
  }
}

/**
 * Verifies the Electron startup loading page uses Bavi-box assets and brand color.
 */
function verifyStartupLoadingBranding(errors) {
  if (!fs.existsSync(loadingHtmlPath)) {
    errors.push(`Missing Electron startup loading page: ${loadingHtmlPath}`);
    return;
  }

  const source = readUtf8(loadingHtmlPath);
  const requiredTokens = [
    "../assets/icon.svg",
    "#00b9c5",
    "#4b5563",
    "Bavi-box AI 工作空间",
    "正在启动 Bavi-box 工作空间...",
    "Bavi-box 已就绪",
  ];
  for (const token of requiredTokens) {
    assertContains(errors, loadingHtmlPath, source, token, "startup loading Bavi-box branding");
  }

  const forbiddenTokens = [
    "#ff6b35",
    "#ff8f65",
    "OpenClaw",
    "AI Assistant / AI 助手",
    "Starting OpenClaw engine",
  ];
  for (const token of forbiddenTokens) {
    if (source.includes(token)) {
      errors.push(`${path.relative(root, loadingHtmlPath)} contains startup brand residual: ${JSON.stringify(token)}`);
    }
  }
}

/**
 * Verifies the existing Skills route is discoverable as a first-level skill library.
 */
function verifySkillHubNavigation(errors) {
  const checks = [
    {
      files: listAssets(/^i18n-.*\.js$/, "base i18n"),
      tokens: [
        "agents:`智能体`",
        "tasks:`工作流`",
        "skills:`技能库`",
        "config:`模型`",
        "skillWorkshop:`技能商店工坊`",
        "agents:`专家、会话与身份。`",
        "tasks:`自动任务、子智能体与运行记录。`",
        "skills:`技能库、安装与本地技能管理。`",
        "config:`模型、供应商与默认参数。`",
      ],
    },
    {
      files: listAssets(/^zh-CN-.*\.js$/, "zh-CN i18n"),
      tokens: [
        "agents:`智能体`",
        "tasks:`工作流`",
        "skills:`技能库`",
        "config:`模型`",
        "skillWorkshop:`技能商店工坊`",
        "agents:`专家、会话与身份。`",
        "tasks:`自动任务、子智能体与运行记录。`",
        "skills:`技能库、安装与本地技能管理。`",
        "config:`模型、供应商与默认参数。`",
      ],
    },
  ];

  for (const check of checks) {
    for (const file of check.files) {
      const source = readUtf8(file);
      for (const token of check.tokens) {
        assertContains(errors, file, source, token, "SkillHub navigation text");
      }
    }
  }
}

/**
 * Verifies the first-level navigation hides low-frequency OpenClaw routes.
 */
function verifyPrimaryNavigationProjection(errors) {
  for (const file of listAssets(/^index-.*\.js$/, "index js")) {
    const source = readUtf8(file);
    assertContains(errors, file, source, "enabledRouteIds(){return[`agents`,`tasks`,`skills`,`config`]}", "primary navigation projection");
    assertContains(errors, file, source, "sidebarPinnedRoutes:[`agents`,`tasks`,`skills`,`config`]", "fixed primary navigation order");
    assertContains(errors, file, source, "renderMoreSection(){return l}", "hidden first-level more section");
    assertContains(errors, file, source, "config:{titleKey:`tabs.config`,subtitleKey:`subtitles.config`}", "model route label source");

    const start = source.indexOf("function Hc(){return[");
    const end = source.indexOf("function Uc(){return Hc()}", start);
    if (start < 0 || end < 0) {
      errors.push(`${path.relative(root, file)} missing command palette navigation function`);
      continue;
    }

    const palette = source.slice(start, end);
    for (const token of ["nav-agents", "nav-workflows", "nav-skills", "nav-models"]) {
      if (!palette.includes(token)) {
        errors.push(`${path.relative(root, file)} command palette missing primary item: ${token}`);
      }
    }

    for (const token of ["nav-overview", "nav-sessions", "nav-cron", "nav-config"]) {
      if (palette.includes(token)) {
        errors.push(`${path.relative(root, file)} command palette still exposes low-priority route: ${token}`);
      }
    }
  }
}

/**
 * Verifies first-pass Bavi-box UI polish survived in generated UI assets.
 */
function verifyUiPolish(errors) {
  const checks = [
    { label: "chat", files: listAssets(/^chat-page-.*\.js$/, "chat-page") },
    { label: "skillsShared", files: listAssets(/^skills-shared-.*\.js$/, "skills-shared") },
    { label: "agents", files: listAssets(/^agents-page-.*\.js$/, "agents-page") },
    { label: "channels", files: listAssets(/^channels-page-.*\.js$/, "channels-page") },
    { label: "configForm", files: listAssets(/^config-form-(?!utils).*\.js$/, "config-form") },
    { label: "configPage", files: listAssets(/^config-page-.*\.js$/, "config-page") },
    { label: "overview", files: listAssets(/^overview-page-.*\.js$/, "overview-page") },
    { label: "index", files: listAssets(/^index-.*\.js$/, "index js") },
    { label: "finalIndex", files: listAssets(/^index-.*\.js$/, "index js") },
    { label: "i18n", files: listAssets(/^i18n-.*\.js$/, "i18n") },
    { label: "secondaryI18n", files: listAssets(/^zh-CN-.*\.js$/, "zh-CN locale") },
    { label: "finalSessionDisplay", files: listAssets(/^session-display-.*\.js$/, "session-display") },
    { label: "finalNodes", files: listAssets(/^nodes-page-.*\.js$/, "nodes-page") },
    { label: "finalConfig", files: listAssets(/^config-page-.*\.js$/, "config-page") },
    { label: "secondaryInlineActivity", files: listAssets(/^activity-page-.*\.js$/, "activity-page") },
    { label: "secondaryInlineNodes", files: listAssets(/^nodes-page-.*\.js$/, "nodes-page") },
    { label: "secondaryInlineInstances", files: listAssets(/^instances-page-.*\.js$/, "instances-page") },
    { label: "secondaryInlineLogs", files: listAssets(/^logs-page-.*\.js$/, "logs-page") },
    { label: "finalSessionsPage", files: listAssets(/^sessions-page-.*\.js$/, "sessions-page") },
    { label: "tertiaryI18n", files: listAssets(/^(?:i18n|zh-CN)-.*\.js$/, "base and zh-CN i18n") },
    { label: "skillWorkshopPage", files: listAssets(/^skill-workshop-page-.*\.js$/, "skill-workshop-page") },
    { label: "deepAgentsChatI18n", files: listAssets(/^i18n-.*\.js$/, "i18n") },
    { label: "css", files: listAssets(/^index-.*\.css$/, "index css") },
  ];

  for (const check of checks) {
    for (const file of check.files) {
      const source = readUtf8(file);
      for (const token of requiredUiPolishTexts[check.label]) {
        assertContains(errors, file, source, token, "Bavi-box UI polish text");
      }
      if (check.label === "agents") {
        assertNotContains(errors, file, source, "自定义创建已关闭", "custom expert disabled button must be removed");
        assertNotContains(errors, file, source, "uclaw-open-custom-expert", "custom expert disabled button class must be removed");
        assertNotContains(errors, file, source, "let a=UcExpertPrompt(t)", "expert template TDZ regression");
        assertNotContains(errors, file, source, "sessions.create`,{agentId:r,label:i}", "expert sessions must be created under main");
        assertNotContains(errors, file, source, "sessions.create`,{agentId:i,label:t}", "custom expert sessions must be created under main");
        assertNotContains(errors, file, source, "sessions.create`,{agentId:o,label:i,category:", "sessions.create schema must not include category");
        assertNotContains(errors, file, source, "sessions.create`,{agentId:u,label:i,category:", "expert sessions.create schema must not include category");
        assertNotContains(errors, file, source, "sessions.create`,{agentId:l,label:i,category:", "legacy expert sessions.create schema must not include category");
        assertNotContains(errors, file, source, "sessions.create`,{agentId:C,label:t,category:", "custom sessions.create schema must not include category");
      }
      if (check.label === "index") {
        assertNotContains(errors, file, source, "for(let t of e.agentsList?.agents??[])r(t.id)", "expert agents must not appear as sidebar branches");
      }
    }
  }
}

/**
 * Verifies the chat microphone button is locked to the Bavi-box primary blue system.
 */
function verifyChatVoiceButtonBlue(errors) {
  for (const file of listAssets(/^index-.*\.css$/, "index css")) {
    const source = readUtf8(file);
    const talkButtonRules = [...source.matchAll(/\.agent-chat__input-btn--talk[^{]*\{([^}]+)\}/g)].map((match) => match[1]);
    const combinedRules = talkButtonRules.join("\n");

    if (!combinedRules) {
      errors.push(`${path.relative(root, file)} missing chat voice button CSS rules`);
      continue;
    }

    for (const token of ["#1677ff !important", "#e6f4ff !important", "#91caff !important"]) {
      if (!combinedRules.includes(token)) {
        errors.push(`${path.relative(root, file)} chat voice button missing blue token: ${token}`);
      }
    }

    for (const token of ["var(--uclaw-teal)", "#0f9f9a", "#0d9488", "#14b8a6", "#2dd4bf"]) {
      if (combinedRules.includes(token)) {
        errors.push(`${path.relative(root, file)} chat voice button still contains teal/green token: ${token}`);
      }
    }
  }
}

/**
 * Blocks exact high-risk residual English copy in pages already covered by Bavi-box polish.
 */
function verifyHighRiskResiduals(errors) {
  const checks = [
    {
      files: listAssets(/^i18n-.*\.js$/, "i18n"),
      tokens: [
        "subtitle:`Gateway Dashboard`",
        "showToken:`Show token`",
        "hideToken:`Hide token`",
        "title:`How to connect`",
        "step1:`Start the gateway on your host machine:`",
        "step2:`Get a tokenized dashboard URL:`",
        "step3:`Paste the WebSocket URL and token above, or open the tokenized URL directly.`",
        "copyCommand:`Copy command`",
        "title:`Channel health`",
        "subtitle:`Channel status snapshots from the gateway.`",
        "editProfile:`Edit Profile`",
        "noProfile:`No profile set.`",
        "configured:`Configured`",
        "running:`Running`",
        "save:`Save`",
        "saving:`Saving…`",
      ],
    },
    {
      files: listAssets(/^index-.*\.js$/, "index js"),
      tokens: [
        "Gateway Dashboard",
        "Show token",
        "Hide token",
        "How to connect",
        "Start the gateway on your host machine:",
        "Get a tokenized dashboard URL:",
        "Copy command",
        "a?`just now`:`in <1m`",
        "a?`${s}m ago`:`in ${s}m`",
      ],
    },
    {
      files: listAssets(/^session-display-.*\.js$/, "session-display"),
      tokens: [
        "fallbackName:`Main Session`",
        "prefix:`Subagent:`",
        "fallbackName:`Subagent:`",
        "prefix:`Cron:`",
        "fallbackName:`Cron Job:`",
        "fallbackName:`${n[t]} Session`",
      ],
    },
    {
      files: listAssets(/^channels-page-.*\.js$/, "channels-page"),
      tokens: [
        "`Saving…`:`Save`",
        "Channel config schema unavailable.",
        "Link WhatsApp Web",
        "Refreshing channel status...",
        "Profile published to relays.",
        "Some channel checks failed.",
      ],
    },
    {
      files: listAssets(/^i18n-.*\.js$/, "i18n"),
      tokens: [
        "loadingTitle:`Loading panel`",
        "title:`OpenClaw mobile`",
        "instances:{title:`Connected Instances`",
        "worktrees:{title:`Managed Worktrees`",
        "sessionsView:{title:`Sessions`",
        "subtitle:`Active session keys and per-session overrides.`",
        "eventArchived:`Archived`",
        "eventUnarchived:`Unarchived`",
        "eventStale:`Stale session`",
        "noSessions:`No sessions found.`",
        "activity:`Browser-local tool activity summaries.`",
        "loading:`Loading tasks…`",
        "activity:{title:`Activity`",
        "argumentHiddenOne:`1 argument hidden`",
        "logsView:{title:`Logs`",
        "disabledHelpStart:`Workboard is disabled. Enable`",
      ],
    },
    {
      files: listAssets(/^activity-page-.*\.js$/, "activity-page"),
      tokens: ["var b={running:`running`,done:`completed`,error:`failed`}", "argument${n===1?``:`s`} hidden"],
    },
    {
      files: listAssets(/^nodes-page-.*\.js$/, "nodes-page"),
      tokens: [
        "<div class=\"card-title\">Exec approvals</div>",
        "Allowlist and approval policy for",
        "${e.saving?`保存中…`:`Save`}",
        "<div class=\"list-title\">Target</div>",
        "Gateway edits local approvals; node edits the selected node.",
        "Default security mode.",
        "<span class=\"label\">Scope</span>",
        "Defaults",
        "<div class=\"list-title\">Security</div>",
        "<span>Mode</span>",
        "<div class=\"list-title\">Ask fallback</div>",
        "<div class=\"list-title\">Auto-allow skill CLIs</div>",
        "No nodes advertise exec approvals yet.",
        "No nodes with system.run available.",
        "Default prompt policy.",
        "reconnect details changed; approval required",
        "Tokens: none",
        "<div class=\"card-title\">Devices</div>",
        "Pairing requests + role tokens.",
        ">Paired</div>",
      ],
    },
    {
      files: listAssets(/^instances-page-.*\.js$/, "instances-page"),
      tokens: ["No instances yet.", "No presence payload."],
    },
    {
      files: listAssets(/^sessions-page-.*\.js$/, "sessions-page"),
      tokens: ["Assistant (dashboard)", "Previous", "per page", "of ${o} row"],
    },
    {
      files: listAssets(/^logs-page-.*\.js$/, "logs-page"),
      tokens: ["openclaw-logs-${t}-${a}.log"],
    },
    {
      files: listAssets(/^(?:i18n|zh-CN)-.*\.js$/, "base and zh-CN i18n"),
      tokens: [
        "skills:`Skills and API keys.`",
        "skills:`SkillHub 商店、安装与本地技能管理。`",
        "debug:{snapshotsTitle:`Snapshots`",
        "manualRpcTitle:`Manual RPC`",
        "execApprovalNeeded:`Exec approval needed`",
        "settings:`Settings`",
        "terminal:{title:`Terminal`",
        "skillWorkshop:{header:{useCurrentChat:`Use current chat`",
        "nav:{previousDay:`Previous day`",
        "modelMissing:`No vision model`",
        "usage:{common:{emptyValue:`—`,unknown:`unknown`}",
        "providerUsage:{title:`Provider plans & billing`",
        "filters:{title:`Filters`",
        "overview:{title:`Usage Overview`",
        "usage:`Usage`",
        "usage:`使用情况`",
        "usage:`API 使用情况和成本。`",
        "quickCreate:{schedules:{everyMorning:{label:`Every morning`",
        "title:`New Cron Job`",
        "cronJobs:`Cron Jobs`",
        "jobs:{title:`Jobs`",
        "emptyTitle:`No scheduled jobs yet.`",
        "emptyHint:`Create one from a plain-language prompt; advanced fields can wait.`",
        "runs:{title:`Run history`",
        "showArchived:`Show archived cards`",
        "hideArchived:`Hide archived cards`",
        "showArchivedShort:`Archived`",
        "hideArchivedShort:`Hide archived`",
      ],
    },
    {
      files: listAssets(/^skill-workshop-page-.*\.js$/, "skill-workshop-page"),
      tokens: [
        "<span>Board</span>",
        "<span>Today</span>",
        "No proposals yet",
        "New proposals will appear here for review.",
        "Nothing waiting today",
        "proposals waiting",
        "Skill Workshop proposals will appear here",
        "OpenClaw 校验",
      ],
    },
    {
      files: listAssets(/^i18n-.*\.js$/, "i18n"),
      tokens: [
        "agents:{noAgents:`No agents`",
        "context:{title:`Agent Context`",
        "selectSubtitle:`Pick an agent to inspect its workspace and tools.`",
        "subtitle:`Gateway-wide channel status snapshot.`",
        "cronPanel:{schedulerTitle:`Scheduler`",
        "files:{emptyDraft:`Empty draft`",
        "chat:{disconnected:`Disconnected from gateway.`",
        "sidebar:{allSessions:`All sessions`",
        "welcome:{ready:`Ready to chat`",
        "runControls:{newSession:`New session`",
        "composer:{placeholder:`Message {name}`",
        "selectors:{agentFilter:`Filter sessions by agent`",
        "workspaceFiles:{label:`Session workspace`",
      ],
    },
    {
      files: listAssets(/^chat-page-.*\.js$/, "chat-page"),
      tokens: [
        "t?.name?.trim()||`Assistant`",
        "e.assistantName||`Assistant`",
        "assistantName:e.assistantName,assistantAvatar",
        "The agent run failed before producing a reply.",
        "OpenClaw tool call failed",
        "OpenClaw tool call timed out",
        "OpenClaw tool call aborted",
        "OpenClaw finished with no text.",
        "OpenClaw realtime tool call did not return a run id",
      ],
    },
    {
      files: listAssets(/^index-.*\.js$/, "index js"),
      tokens: [
        "Wm=`Assistant`",
        "var Wm=`Assistant`",
        "assistantIdentity:{agentId:null,name:`Assistant`,avatar:null,avatarSource:null,avatarStatus:null,avatarReason:null}",
      ],
    },
    {
      files: listAssets(/^index-.*\.css$/, "index css"),
      tokens: ["#ff6b35", "#e95420", "#ff7a45", "#ffb088"],
    },
    {
      files: listAssets(/^config-page-.*\.js$/, "config-page"),
      tokens: [
        "Personal Assistant",
        "Balanced default for daily use.",
        "Assistant identity",
        "Fallback logo",
        "<span class=\"qs-row__label\">Model</span>",
        "<span class=\"qs-row__label\">Fast mode</span>",
        "${V(g.send,`Channels`,n)}",
        "${V(g.eye,`Security`,i`<button",
        "${V(g.monitor,`Gateway Host`)}",
        "No channels configured",
        "<span class=\"qs-row__label\">Device auth</span>",
        "[[`quick`,`Simple`],[`advanced`,`Advanced`]]",
        "Model & Thinking",
        "Connect →",
        "Configure →",
        "`Enabled`",
        "`None`",
      ],
    },
    {
      files: listAssets(/^overview-page-.*\.js$/, "overview-page"),
      tokens: [
        "p?`${_} jobs`:d(`common.disabled`)",
        "a`<span class=\"danger\">${v} failed</span>`",
        "hint:`${r} tokens · ${i} msgs`",
        "hint:u>0?`${u} blocked`:`${l} active`",
      ],
    },
    {
      files: listAssets(/^(?:i18n|zh-CN)-.*\.js$/, "base and zh-CN i18n"),
      tokens: [
        "title:`OpenClaw mobile`",
        "title:`OpenClaw 移动版`",
        "qrAlt:`OpenClaw mobile pairing QR code`",
        "qrAlt:`OpenClaw 移动版配对二维码`",
        "waiting:`The official OpenClaw mobile app will connect automatically after scan.`",
        "waiting:`官方 OpenClaw 移动应用在扫描后会自动连接。`",
        "subtitle:`Isolated repository checkouts owned by OpenClaw.`",
        "subtitle:`由 OpenClaw 拥有的隔离代码库检出。`",
      ],
    },
    {
      files: listAssets(/^index-.*\.js$/, "index js"),
      tokens: [
        "Review the ClawHub warning before installing this skill.",
        "Acknowledge risk and install",
        "WARNING - ClawHub",
        "ClawHub found security risks",
        "security status is not clean",
      ],
    },
    {
      files: listAssets(/^skills-page-.*\.js$/, "skills-page"),
      tokens: [
        "Acknowledge risk and install",
        "WARNING - ClawHub",
        "ClawHub found security risks",
        "security status is not clean",
        "OpenClaw 安全检查",
      ],
    },
  ];

  for (const check of checks) {
    for (const file of check.files) {
      const source = readUtf8(file);
      for (const token of check.tokens) {
        if (source.includes(token)) {
          errors.push(`${path.relative(root, file)} contains high-risk residual copy: ${JSON.stringify(token)}`);
        }
      }
    }
  }
}

/**
 * Verifies the chat composer includes the SkillHub dropdown without changing runtime names.
 */
function verifyChatSkillHubDropdown(errors) {
  for (const file of listAssets(/^chat-page-.*\.js$/, "chat-page")) {
    const source = readUtf8(file);
    for (const token of chatSkillHubTokens) {
      assertContains(errors, file, source, token, "chat SkillHub dropdown token");
    }
    assertContains(errors, file, source, "e.assistantName&&e.assistantName!==`Assistant`?e.assistantName:`Bavi-box`", "Bavi-box composer assistant name");
    assertContains(errors, file, source, "t?.name?.trim()||`Bavi-box`", "Bavi-box message assistant name");
    assertContains(errors, file, source, "Agent 运行在生成回复前失败。", "localized failed run fallback");
    assertContains(errors, file, source, "正在询问 Bavi-box...", "Bavi-box voice status");
    assertContains(errors, file, source, " 正在回复...", "Bavi-box streaming status");
    assertContains(errors, file, source, "未知命令：", "localized unknown command text");
    for (const token of ["选择 SkillHub", "SkillHub 暂不可用", "SkillHub 配置服务不可用", "保存 SkillHub 选择失败"]) {
      if (source.includes(token)) {
        errors.push(`${path.relative(root, file)} contains old chat skill selector copy: ${JSON.stringify(token)}`);
      }
    }
  }
}

/**
 * Runs all SkillHub branding checks and exits non-zero when any patch invariant fails.
 */
function main() {
  const errors = [];

  try {
    for (const file of listSkillsAssets()) {
      verifySkillsAsset(file, errors);
    }
    verifySkillHubIdentityRequests(errors);
    verifyControlUiBranding(errors);
    verifyControlUiManifest(errors);
    verifyBrandAssets(errors);
    verifyStartupLoadingBranding(errors);
    verifySkillHubNavigation(errors);
    verifyPrimaryNavigationProjection(errors);
    verifyUiPolish(errors);
    verifyChatVoiceButtonBlue(errors);
    verifyChatSkillHubDropdown(errors);
    verifyHighRiskResiduals(errors);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  verifyServiceWorker(errors);

  if (errors.length > 0) {
    console.error("SkillHub branding verification failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log("OK SkillHub branding patch verified");
}

main();
