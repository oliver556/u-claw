# 智能体专家会话与四分左栏 PRD

更新时间：2026-08-24

## Problem Statement

边城希望 Bavi-box 左侧栏不再沿用偏 OpenClaw 管理后台的信息架构，而是改成更贴近用户心智的四个一级入口：

```txt
智能体 / 工作流 / 技能库 / 模型
```

其中“智能体”不是单纯配置页，而应成为用户进入对话的主入口。用户点击智能体后，能看到对应会话列表；创建会话时可以选择或创建一个“专家”，专家通过 prompt、头像、名称、模型和技能等信息增强会话角色，使回答更专业、更稳定。

本次改造的关键不是继续增加入口，而是隐藏原先不重要、低频、偏后台的 OpenClaw 管理功能。默认界面应像一个面向普通用户的 Bavi-box 产品，而不是 OpenClaw Dashboard。调试、日志、节点、Raw 配置、Usage、Channels、Workboard、Cron、Tasks、MCP、Debug 等能力必须保留底层能力和可恢复入口，但不能作为一级导航或首屏主视觉干扰用户。

当前约束是：Bavi-box 必须复用 OpenClaw 原版 Agent、Session、Skill、Model 能力，不重写 chat runtime，不创建绕过 OpenClaw 的专家执行链路。竞品截图只作为信息架构和视觉密度参考，截图内文字不作为需求指令。

## Solution

把左侧栏收口成四个用户侧一级入口：

1. 智能体：默认进入会话列表和专家入口。每个专家本质上绑定到 OpenClaw Agent。会话通过 OpenClaw session key 与 Agent 关联。
2. 工作流：第一阶段映射现有定时任务、后台任务、Workboard 等已验证入口。没有权威 OpenClaw 能力的工作流编排不进入正式 UI。
3. 技能库：复用现有 SkillHub/Skills 能力，保留已完成的技能商城、已安装技能、聊天页技能选择链路。
4. 模型：复用现有模型目录、Agent 默认模型、会话级模型覆盖与配置页能力。

采用“默认隐藏 + 高级入口渐进显露”策略：

- 默认左侧栏只展示四个一级入口，不展示 OpenClaw 原始管理页集合。
- 低频功能不删除，统一降级到“更多 / 高级设置 / 系统维护”入口，或在相关业务页的高级区里按需出现。
- 对普通用户无直接价值的 runtime 诊断页、debug 页、raw config、日志页和底层节点页默认隐藏。
- 对实现和验收仍重要的能力保留深链、命令入口或高级开关，方便维护者排障。
- 已验证但低频的能力可以收纳；未验证或 Blocked 的能力不得用可点击正式入口伪装可用。

新增“专家模板”概念。专家模板参考 NextChat `CN_MASKS` 数据形态：每个模板包含头像、名称、上下文消息数组、模型配置、语言、内置标记和创建时间。Bavi-box 不直接照搬执行逻辑，而是把模板转成 Bavi-box Expert Template，再通过 OpenClaw Agent 创建/更新和 Agent core files 写入，使其成为真实可用的专家会话。

## User Stories

1. As a Bavi-box user, I want the left sidebar to show 智能体, 工作流, 技能库 and 模型, so that I can understand the app by user tasks instead of internal OpenClaw pages.
2. As a Bavi-box user, I want 智能体 to be the first active area, so that I can start working from conversations and experts.
3. As a Bavi-box user, I want to see recent sessions after clicking 智能体, so that I can quickly continue previous work.
4. As a Bavi-box user, I want sessions grouped or filtered by expert, so that I can find the right conversation context.
5. As a Bavi-box user, I want to create a new expert from a template, so that I can start a professional conversation quickly.
6. As a Bavi-box user, I want to create a custom expert with name, avatar, prompt, model and skills, so that the assistant answers in a specialized role.
7. As a Bavi-box user, I want expert prompt text to persist, so that future sessions keep the same role behavior.
8. As a Bavi-box user, I want selecting an expert to create or switch into an Agent-bound session, so that the runtime uses real OpenClaw Agent behavior.
9. As a Bavi-box user, I want model choice visible when creating or editing an expert, so that the expert can use a suitable model.
10. As a Bavi-box user, I want skill choice visible when creating or editing an expert, so that the expert can use relevant SkillHub skills.
11. As a Bavi-box user, I want built-in expert templates such as 文案写手, 机器学习, 职业顾问, 英专写手, 语言检测器, 小红书写手, 简历写手, 创业点子王 and 互联网写手, so that I have useful starting points.
12. As a Bavi-box user, I want unsafe or policy-risk templates excluded or marked unavailable, so that Bavi-box does not ship jailbreak-like expert presets.
13. As a Bavi-box user, I want high-stakes expert templates such as medical, legal, financial or psychological advice clearly bounded, so that I do not mistake them for professional services.
14. As a Bavi-box user, I want each expert card to show name, avatar, description, model and enabled skills, so that I can choose confidently.
15. As a Bavi-box user, I want “继续会话” and “新建会话” actions on each expert, so that I can either preserve history or start fresh.
16. As a Bavi-box user, I want renamed sessions to remain linked to their expert, so that session organization survives later edits.
17. As a Bavi-box user, I want deleting or archiving a session not to delete the expert, so that templates and conversations have separate lifecycles.
18. As a Bavi-box user, I want editing an expert not to silently mutate old transcripts, so that old conversations remain auditable.
19. As a Bavi-box user, I want 工作流 to show only verified capabilities, so that I do not click dead or fake automation features.
20. As a Bavi-box user, I want 技能库 to keep current SkillHub marketplace behavior, so that existing install and selection flows keep working.
21. As a Bavi-box user, I want 模型 to expose model status and defaults without API key leakage, so that model setup is understandable and safe.
22. As a Bavi-box user, I want low-frequency OpenClaw management pages hidden by default, so that I am not distracted by developer-only controls.
23. As a Bavi-box user, I want advanced tools still available from a clear advanced area, so that support or maintenance tasks remain possible when needed.
24. As a Bavi-box user, I want hidden items not to appear in search or command surfaces unless advanced mode is enabled, so that the product does not feel cluttered.
25. As a maintainer, I want hidden OpenClaw capabilities preserved underneath, so that troubleshooting and runtime compatibility do not regress.
26. As a maintainer, I want this feature built through OpenClaw Gateway methods and config paths, so that P0 chat, portable data and packaging stay stable.
27. As a maintainer, I want expert templates represented as data, not hard-coded UI strings, so that later we can add, remove, localize and migrate templates safely.
28. As a maintainer, I want deterministic patch and verifier coverage, so that OpenClaw bundle upgrades fail fast instead of silently breaking navigation.
29. As a maintainer, I want cache markers bumped after visible UI changes, so that the desktop app does not show stale sidebar or expert UI.

## Implementation Decisions

- Development stays inside the active Bavi-box development app. Archived OpenClaw and product directories remain read-only.
- The feature reuses OpenClaw Agent as the expert runtime unit. A Bavi-box expert is not a new runtime.
- The feature reuses OpenClaw Session as the conversation lifecycle unit. A Bavi-box expert session is an Agent-bound session.
- The feature reuses OpenClaw Skill and SkillHub binding. Expert skills are written through the same Agent skills configuration path used by the existing chat SkillHub dropdown.
- The feature reuses OpenClaw model catalog and model override behavior. Expert model choice maps to Agent default model or session-level override.
- The four left-sidebar entries are user-facing navigation groups. They may route to existing OpenClaw pages or Bavi-box-patched pages, but must not expose unverified capabilities as usable.
- The default IA hides low-frequency OpenClaw management pages. Hidden means removed from first-level navigation and ordinary user surfaces, not deleted from runtime.
- Advanced capabilities are grouped under a secondary maintenance surface. Candidate hidden entries include Debug, Logs, Nodes, Raw Config, Usage, Channels, Workboard, Cron, Tasks, MCP, Instances, Worktrees, Activity and plugin diagnostics unless a later user-facing story promotes one of them.
- Search, command palette and quick links should follow the same visibility model: ordinary mode lists user task entries; advanced mode may expose maintenance entries.
- Deep links to hidden pages may continue to work for maintainers if the backing OpenClaw route is stable. Broken or unverified deep links must fail closed with a clear unavailable state.
- Expert templates are imported into a local Bavi-box seed catalog. The seed catalog should be treated as curated product data, not a live dependency on NextChat.
- NextChat data is used only as a reference for shape and initial template ideas. Do not ship unsafe templates such as jailbreak prompts.
- Template import maps source fields into this internal shape:

```ts
type UClawExpertTemplate = {
  id: string;
  name: string;
  avatar: string;
  description: string;
  category: string;
  prompt: string;
  starterMessages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  modelDefaults?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    sendMemory?: boolean;
    historyMessageCount?: number;
  };
  safety: {
    status: "allowed" | "restricted" | "blocked";
    reason?: string;
  };
};
```

- When a template contains multiple context messages, the first durable role instruction becomes the expert prompt. Starter user/assistant examples may be used as onboarding examples, but should not pollute every runtime conversation unless OpenClaw Agent files require that behavior.
- Expert creation flow should first create or update the Agent, then write prompt/core instruction content, then optionally patch model and skills, then create or switch to the corresponding session.
- Expert editing should support save, cancel, dirty state, failure display and readback. Save is successful only after the OpenClaw Agent list or config readback matches the intended state.
- Expert deletion is separate from session deletion. First version may support hiding custom experts rather than deleting underlying Agent if OpenClaw delete semantics are risky.
- 工作流 first version is an information architecture regrouping over existing tasks, cron and workboard capabilities. A new workflow builder is out of scope until its OpenClaw authority is verified.
- 技能库 first version should preserve all existing SkillHub verifiers and acceptance behavior.
- 模型 first version should avoid touching model provider config internals unless already supported by existing config forms and model list.

## Current Implementation Status

截至 2026-08-24，已完成的实现状态如下：

| Area | Status | Implemented Behavior | Remaining Gap |
|---|---|---|---|
| 四分左栏 | Done | 普通模式首层固定 `智能体 / 工作流 / 技能库 / 模型`，旧本地 pin 偏好不再影响顺序，一级“更多”隐藏 | 需要后续设计显式高级/维护入口 |
| 智能体首页 | Partial | 展示专家工作台、自定义专家表单、专家列表、专家详情、最近会话，并复用 OpenClaw Agent / Session 数据 | 需要补内置专家 fork 与更完整编辑表单 |
| 创建专家 | Partial | 模板与自定义创建均走真实链路：`agents.create/update`、prompt core file 写入与读回、模型/技能 config readback、`sessions.create` | 温度/上下文等高级项暂未进入首版表单 |
| 专家会话命名与身份 | Done | 专家会话创建时默认 label 为专家名；左侧栏遇到 `agent:*` fallback 时按 `agentIdentity -> agentsList -> 内置模板 id` 反查专家名；聊天页使用 Agent identity 展示专家名称 | 需要 connected UI 截图证明旧会话也不再露 raw key |
| 专家模板 | Partial | 已放入安全内置模板并启用模板创建入口 | 需要把模板数据独立成 catalog，补 schema verifier 与安全过滤记录 |
| 专家管理 V2 | Partial | 已支持专家列表/详情、继续会话、新建会话、打开 `AGENTS.md` 编辑、自定义专家本地归档隐藏 | 需要补内置专家 fork 和可恢复的归档管理 |
| 工作流 | Placeholder | 一级入口映射现有 `tasks` route，不新增伪工作流 builder | 需要把已验证 task/cron/workboard 能力整理成用户能理解的工作流视图 |
| 技能库 | Done | 保持 SkillHub store、安装、卸载、聊天页技能选择链路；专家创建页复用 `skills.status` 读取可选技能 | 需要后续补技能选择的 connected end-to-end 截图 |
| 模型 | Placeholder | 一级入口映射现有 `config` route；专家创建页复用现有 model catalog 下拉 | 需要做模型概览页或直达模型 section，并与专家默认模型联动 |
| 验证与打包 | Done | 静态 verifier、SkillHub home、connected UI acceptance 和 mac arm64 package 已通过 | 需要补截图验收记录和手动 UI viewport 记录 |

## Next Development Slices

### Slice 7: Expert Management V2

目标：让“智能体”从模板创建页升级为可持续管理专家的工作区。

- 专家列表区展示内置专家和用户创建的专家，区分 `built-in`、`custom`、`recently used`。
- 专家详情区展示名称、头像、说明、prompt 摘要、默认模型、启用技能、最近会话。
- 支持“新建会话”和“继续最近会话”。继续会话优先选择该专家最近一次 session；没有历史时创建新 session。
- 支持编辑 custom expert 的 name、avatar、description、prompt、model、skills。
- 内置专家默认不可直接覆盖；用户编辑内置专家时创建 fork/custom copy。
- 删除 first version 采用“隐藏 custom expert”或“归档 expert”，不直接删除底层 Agent，避免破坏已有会话。
- 编辑保存必须走 `agents.update`、agent core file 写入、配置 readback；任何一步失败都展示明确错误，不跳转会话。

### Slice 8: Expert Create Form

目标：补齐“自定义专家”而不是只从模板创建。

- 表单字段：名称、头像、描述、系统 prompt、模型、技能、温度/上下文数量等高级项。
- 必填项：名称、prompt。模型和技能可继承默认值。
- prompt 输入区支持较长文本、保存中状态、错误态和取消确认。
- 技能选择复用现有 SkillHub dropdown / installed skills 数据，不重新造技能配置链路。
- 模型选择复用 OpenClaw model catalog / config 数据，不暴露 API key。
- 创建成功后进入该专家新会话；失败时保留用户输入。

### Slice 9: Workflow First Usable View

目标：把“工作流”从 OpenClaw `tasks` 的直译，变成用户可理解的自动化入口。

用户目标：

- 普通用户看到“工作流”时，应理解这里是自动化、计划执行、后台任务的入口，而不是内部 task/debug 页面。
- 用户可以知道当前有哪些任务、哪些在运行、最近是否失败，以及能否手动触发已验证任务。
- 用户不会看到没有真实 runtime 支撑的“新建可视化流程”按钮。

首版页面结构：

- 顶部状态：任务总数、运行中、最近失败、最近完成时间。
- 分组列表：计划任务、手动任务、看板任务。只有读到来源数据时显示对应分组。
- 行内信息：名称、状态、触发方式、最近执行时间、最近结果。
- 行内动作：只保留已验证动作，例如查看详情、打开原任务页、运行已验证任务。
- 空状态：没有任务时说明“暂无可用工作流”，不展示假创建按钮。

权威数据来源：

- `tasks` route / Gateway tasks state 作为首个落点。
- `cron` 能力仅在可读、可触发路径明确后进入“计划任务”分组。
- `workboard` 能力仅在可读路径明确后进入“看板任务”分组。

验收重点：

- 所有可点击动作都有对应 OpenClaw 原能力或清晰 disabled 状态。
- 普通模式不出现 Debug/Logs/Nodes/Raw Config 等维护入口。
- 不新增 workflow builder runtime。
- 不影响已有 task runtime 与 session/chat runtime。

### Slice 10: Model Overview

目标：让“模型”入口不再只是配置页，而是模型状态概览。

用户目标：

- 用户能看懂当前默认用哪个模型、哪些 provider 已配置、专家是否覆盖了默认模型。
- 用户能从模型入口跳到配置编辑，但普通概览本身不隐式保存任何配置。

首版页面结构：

- 当前默认：系统默认模型、当前聊天 Agent 默认模型、当前会话覆盖模型。
- Provider 状态：按 provider 展示已配置/未配置、模型数量、最近错误。
- 模型列表：名称、provider、上下文能力、是否可用于聊天。
- 专家模型继承：展示“系统默认 -> Agent 默认 -> 会话覆盖”的最终生效模型。
- 编辑入口：跳转现有 config form 对应位置；不在概览页直接改 API key。

安全规则：

- API key、base URL secret、token 不在概览页完整显示。
- 概览页只读；任何写入必须进入现有配置表单并显式保存。
- 专家创建页选择模型时，只写 Agent model override，不碰 provider auth。

验收重点：

- 刷新后模型状态仍可读。
- 没有隐式 config mutation。
- 专家默认模型显示与 `runtimeConfig` readback 一致。

### Slice 11: Advanced Maintenance Entry

目标：在隐藏一级“更多”后，为维护者补一个明确、低干扰的高级入口。

用户目标：

- 普通用户不会被维护功能干扰。
- 维护者仍能进入 Debug、Logs、Nodes、Raw Config 等已验证原页面排障。

首版入口候选：

- 左下角状态/设置区域增加“高级维护”入口。
- 模型或设置页内增加“维护工具”二级入口。
- 进入前显示维护提示，说明这些页面面向调试和支持。

可展示内容：

- 只列 verified original routes。
- 每个入口显示名称、用途、风险级别、是否只读。
- 未验证 route 不展示；blocked route 不展示。

搜索与命令面板：

- 普通模式 command palette 不暴露维护项。
- 高级模式 enabled 后才暴露维护项。
- 高级模式状态需可见，避免用户不知道自己处在维护界面。

验收重点：

- 普通模式首屏仍只有四个一级入口。
- 高级入口可达 verified route。
- 深链失败时显示不可用状态，不白屏。

### Slice 12: Expert Polish and Connected Acceptance

目标：把专家能力从“可创建”推进到“可证明稳定可用”。

- 补内置专家 fork：编辑内置专家时创建 custom copy，不覆盖内置模板。
- 补归档恢复：已归档 custom expert 可在维护区恢复。
- 补专家编辑表单：支持编辑 name/avatar/description/prompt/model/skills，并做 readback。
- 补专家会话截图验收：左栏会话名显示专家名，聊天页 welcome/composer 显示专家名。
- 补前置信息验收：创建专家后读回 `AGENTS.md`，发送测试消息验证回答遵循专家 prompt。
- 补 connected acceptance：临时创建专家、选择模型/技能、创建 session、验证左栏命名、归档清理。
- 补模板 catalog 化：把内置模板从 patch 字符串中沉淀为可验证 catalog 数据，增加 schema/safety verifier。

## Testing Decisions

- Tests should verify external behavior through the same user-facing seams: sidebar navigation, expert creation, Agent readback, session creation, model selection and skill binding.
- Static verifier should assert that the generated UI contains exactly the four primary labels and no old primary navigation entries leak into the first-level sidebar.
- Static verifier should assert that hidden low-frequency labels do not appear as first-level sidebar items, including Debug, Logs, Nodes, Usage, Cron, Tasks, Workboard, Instances, Worktrees, Activity, MCP and Raw Config.
- Static verifier should assert that hidden routes remain backed by existing OpenClaw mechanisms when reachable through advanced mode or direct deep links.
- Static verifier should assert that expert creation uses OpenClaw Agent/Session/Config methods and does not introduce a chat-level expert runtime.
- Static verifier should assert that SkillHub dropdown invariants still hold after expert UI changes.
- Template catalog tests should validate unique ids, non-empty names, safe prompt text, blocked unsafe templates, valid avatar values and sane model defaults.
- Template import tests should parse the NextChat-like data shape and produce Bavi-box expert templates without copying unsafe templates into enabled presets.
- Connected UI acceptance should create a temporary expert, verify Agent readback, verify prompt/core file readback when available, create or switch to a session, then restore local config.
- Connected UI acceptance should verify expert session sidebar label defaults to the expert name and never exposes raw `agent:*` keys in ordinary mode.
- Connected UI acceptance should verify the chat welcome state and composer placeholder use the expert name after switching into an Agent-bound session.
- Connected UI acceptance should select one skill for an expert and confirm existing Agent skill allowlist entries are preserved.
- Connected UI acceptance should choose a model for an expert and confirm the UI shows the selected model after refresh.
- Visual acceptance should cover desktop and narrow widths: sidebar labels, selected state, expert list, session list, create expert modal/drawer, SkillHub and model controls.
- Regression acceptance must include Gateway HTTP smoke, text chat send, existing SkillHub marketplace verifier, chat SkillHub dropdown verifier and patch idempotency.
- Slice 7 acceptance must verify expert list readback, expert detail rendering, create new session, continue recent session, edit custom expert, and fork built-in expert.
- Slice 8 acceptance must verify custom expert form validation, failed save keeps input, model/skill selections persist, and successful creation jumps into an Agent-bound session.
- Slice 9 acceptance must verify every visible workflow action maps to an existing OpenClaw task/cron/workboard capability or is explicitly disabled.
- Slice 10 acceptance must verify model overview is read-only for secrets and does not mutate provider config without an explicit save action.
- Slice 11 acceptance must verify hidden maintenance routes stay absent from ordinary sidebar/search/command palette, while advanced mode can reach verified maintenance routes.

## Out of Scope

- Rewriting OpenClaw chat, Agent, Session, Skill or Model runtime.
- Creating a separate expert executor outside OpenClaw Agent.
- Shipping jailbreak, policy bypass or unsafe persona presets.
- Claiming medical, legal, financial or psychological professional advice without explicit safety boundaries.
- Building a new visual workflow editor.
- Changing model provider auth, New API adapter, pricing config or portable data startup.
- Modifying archived directories.
- Removing bundled OpenClaw skills from runtime directories.
- Replacing the current SkillHub marketplace implementation.

## Acceptance Criteria

- Left sidebar shows exactly 智能体, 工作流, 技能库, 模型 as primary user-facing entries.
- Left sidebar keeps the fixed primary order 智能体 / 工作流 / 技能库 / 模型 even when an older local `sidebarPinnedRoutes` preference exists.
- First-level sidebar does not show OpenClaw internal or low-frequency entries such as Debug, Logs, Nodes, Usage, Cron, Tasks, Workboard, Instances, Worktrees, Activity, MCP or Raw Config.
- First-level sidebar does not render the old “更多” expansion row in ordinary mode. Hidden routes remain deep-linkable only as verified maintenance surfaces.
- Hidden OpenClaw capabilities are not deleted and remain available through a documented advanced/maintenance access path when verified.
- Ordinary command/search surfaces do not promote hidden maintenance entries unless advanced mode is active.
- 智能体 opens an experience where session list and expert list are visible without navigating through internal settings.
- Creating an expert from a built-in template persists name, avatar, prompt and default settings.
- Creating a custom expert persists user-entered prompt and can start a new session bound to that expert.
- Expert session label defaults to the expert name in the sidebar. Raw `agent:*` session keys must not be visible as ordinary session names.
- Expert chat page shows the expert name in breadcrumb, welcome state and composer placeholder when the Agent identity is available.
- Expert prompt/core file is written to `AGENTS.md` and read back before session creation is considered successful.
- Expert session send path uses existing OpenClaw chat/session mechanisms.
- Expert skill binding uses existing Agent skills configuration path and preserves existing skills unless user explicitly changes them.
- Expert model binding uses existing Agent/session model mechanisms and never writes API keys into template data.
- Unsafe seed templates are blocked or absent from enabled presets.
- 工作流 only exposes verified existing capabilities or clearly disabled placeholders.
- 技能库 keeps existing SkillHub store, install, installed list and chat dropdown behavior.
- 模型 uses existing model list/config behavior and does not alter model chain.
- Patch script is idempotent.
- Service worker cache marker changes for this visible UI slice.
- New or updated verifiers pass.
- Existing SkillHub branding and connected UI verifiers still pass.
- Manual UI check shows no text overlap at 960x640, 1440x900 and 1920x1080.

## Rollout Plan

### Slice 1: PRD and Capability Matrix

- Document four-entry IA and expert lifecycle.
- Add capability matrix rows for Agent creation, Agent file write, session creation, model binding and skill binding.
- Mark unknown workflow builder capabilities as Blocked.

### Slice 2: Sidebar IA UI-only

- Patch primary sidebar labels and active states.
- Hide low-frequency OpenClaw entries from first-level sidebar.
- Add advanced/maintenance access path for verified hidden entries.
- Keep routes backed by existing pages.
- Add verifier for four primary entries, hidden-entry absence and cache marker.

### Slice 3: 智能体 Landing

- Make 智能体 show expert list plus session list.
- Reuse existing sessions list and Agent list data.
- No expert creation yet.

### Slice 4: Expert Template Catalog

- Add curated built-in templates from safe NextChat-inspired data.
- Validate template schema and block unsafe presets.
- Display templates in creation flow.

### Slice 5: Expert Creation and Readback

- Create/update OpenClaw Agent.
- Write prompt/core instruction through Agent file interface where available.
- Patch model and skill settings through existing config interfaces.
- Create/switch to Agent-bound session.

### Slice 6: Connected Verification and Polish

- Add reversible connected acceptance.
- Check text chat, SkillHub dropdown, model selector and session continuity.
- Force the primary sidebar order to ignore stale local pin preferences from earlier OpenClaw/Bavi-box builds.
- Hide the first-level “更多” row in ordinary mode while preserving underlying routes for future advanced/maintenance access.
- Capture screenshots and update acceptance record.

### Slice 7: Expert Management V2

- Add expert list/detail states.
- Add “新建会话 / 继续会话” behavior per expert.
- Add custom expert editing with readback.
- Add built-in expert fork behavior.
- Add safe archive/hide behavior for custom experts.

2026-08-24 implementation note:

- Done: expert list/detail states are rendered from built-in templates plus existing `uclaw-expert-*` Agents.
- Done: “继续会话” opens the latest matching expert session when present, otherwise creates a new Agent-bound session.
- Done: “新建会话” calls `sessions.create` with the expert Agent id and opens the returned session.
- Done: “编辑” selects the Agent and opens `AGENTS.md` in the existing Agent files panel for prompt editing.
- Done: custom experts can be locally archived from the expert list without deleting the underlying OpenClaw Agent or sessions.
- Remaining: built-in expert fork behavior and archive restore UI stay in later polish.

### Slice 8: Custom Expert Create Form

- Done: add custom expert form with name/avatar/description/prompt.
- Done: model selector reuses existing OpenClaw model option renderer and model catalog; API key fields are not exposed.
- Done: skill selector reuses existing `skills.status` report and saves selected skills through Agent config.
- Done: save chain creates or updates the Agent, writes and reads back `AGENTS.md`, saves model/skills, refreshes config, verifies readback, then creates an Agent-bound session.
- Done: validation and catch paths keep the form state; successful creation clears the form and opens the new expert session.
- Done: expert session label defaults to the expert name, and sidebar fallback maps raw `agent:*` keys back to expert identity/name.
- Remaining: temperature/context advanced fields are deferred until their existing config authority is mapped and verified.

### Slice 9: Workflow First Usable View

- Replace raw tasks-first impression with verified workflow summary.
- Group task/cron/workboard only when source data is available.
- Keep unknown builder features blocked.
- Add verifier for no fake workflow actions.

### Slice 10: Model Overview

- Add user-facing model status and inheritance overview.
- Keep provider secrets hidden.
- Link to original config form for edits.
- Add verifier that overview does not write config implicitly.

### Slice 11: Advanced Maintenance Entry

- Add explicit advanced/maintenance access path for hidden routes.
- Keep ordinary mode uncluttered.
- Expose only verified original OpenClaw routes.
- Add command/search visibility tests for ordinary vs advanced mode.

### Slice 12: Expert Polish and Connected Acceptance

- Add built-in expert fork behavior.
- Add archived custom expert restore UI.
- Add full edit form with readback.
- Add connected acceptance for expert naming, prompt readback, model/skill persistence and session creation.
- Move built-in template data toward catalog/schema verifier.

## Further Notes

- Reference source: NextChat `CN_MASKS` at commit `defdcdb55d850cd12c4c657eb83729fd66e215c0`, especially the `BuiltinMask` objects beginning with “文案写手”. The source shows expert-like masks with `avatar`, `name`, `context`, `modelConfig`, `lang`, `builtin` and `createdAt`.
- Bavi-box should treat that source as inspiration for data shape and initial useful expert categories, not as a direct runtime dependency.
- Existing project rule remains dominant: no fake UI for Unknown or Blocked capabilities, and no bypass of OpenClaw Gateway/config/runtime authority.
- 2026-08-24 Slice 6 package note: visible IA cache marker is `primary-nav-ia-2`; retest package is `u-claw-app-dev/release/Bavi-box-2.1.17-arm64.dmg`.
- 2026-08-24 PRD continuation note: next implementation should start at Slice 7, not restart from sidebar IA. Sidebar IA is considered locked unless manual retest finds a regression.
- 2026-08-24 Slice 7 package note: visible expert management cache marker is `expert-management-1`.
- 2026-08-24 Slice 8 implementation note: custom expert form cache marker is `expert-custom-form-1`; model/skill selection uses existing OpenClaw model catalog and `skills.status` data, then persists through Agent config readback.
- 2026-08-24 expert session naming note: cache marker is `expert-session-label-1`; session label defaults to expert name and sidebar raw `agent:*` fallback is mapped through `agentIdentity`, `agentsList` and built-in template ids.
