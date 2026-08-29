# 第16节 Bavi-box 全界面改造 PRD

更新时间：2026-08-23

## Problem Statement

边城当前在界面上仍看不到足够明确的 Bavi-box 化结果。虽然 SkillHub、聊天页下拉、首屏品牌、部分命令文案已有补丁与验证，但 OpenClaw 原始品牌、英文状态、分散页面入口、错误/加载/空态、设置页与 Channels/Agents/Tools 等区域仍可能残留，导致用户无法把当前桌面壳判断为完整 Bavi-box 产品。

2026-08-23 截图复核后，当前完成度应修正为约 70%-75%。已完成主要集中在文案、入口、SkillHub 可见性与部分残留扫描；视觉品牌层尚未验收，不能按 80%-85% 口径汇报。明显问题包括：logo 仍像临时红色图标，聊天头像复用该图标；Bavi-box 主色应为 `#1677ff`，问题不是使用蓝色本身，而是主色、背景、侧栏、选中态、按钮、链接、麦克风、SkillHub 下拉未形成统一 Bavi-box 品牌系统；`Assistant` 与 `The agent run failed before producing a reply.` 仍是截图可见残留。

本问题不是重写 OpenClaw。Bavi-box 目标是复用 OpenClaw 原能力，在 `u-claw-app-dev` 内以可恢复、可验证的 UI patch 方式完成产品化外观、文案、入口与验收闭环。

## Solution

以 `scripts/patch-openclaw.js` 为唯一 UI 改造源头，把第 16 节 UI 改造拆成 8 个可并发、可暂停、可验证任务：

1. 全界面可见面审计：列出仍可见 OpenClaw/英文/不一致 Bavi-box 化区域。
2. 全局 Shell 与导航改造：统一首屏、标题、侧栏、顶部、面包屑、登录/断连态。
3. Chat 主体验改造：统一聊天页输入区、命令提示、SkillHub 下拉、空态、错误态。
4. SkillHub/Skills 页改造：保留 OpenClaw runtime，用户侧只呈现 SkillHub 语义与 Bavi-box skill。
5. Agents/Tools/Channels 页改造：只重命名和整理原有能力入口，不展示无权威调用方式的假功能。
6. Settings/Config/Onboarding 改造：配置页、模型默认态、Gateway 断连态、保存/失败提示 Bavi-box 化。
7. Brand Visual System / Logo 与响应式验收：替换正式 Bavi-box logo/头像，统一 primary color、background、sidebar、active state、按钮、链接、麦克风与 SkillHub 下拉视觉，避免文字重叠。
8. 自动验证、重启与包装验收：脚本化残留扫描、patch 幂等、HTTP smoke、Mac/Windows 便携风险记录。

## User Stories

1. As a Bavi-box user, I want the app title, sidebar, topbar, breadcrumb, login and first screen to show Bavi-box, so that I know I opened the intended product.
2. As a Bavi-box user, I want chat empty states and command prompts to use Bavi-box language, so that the main work surface feels coherent.
3. As a Bavi-box user, I want SkillHub controls visible near model/session controls, so that skill choice is discoverable before chatting.
4. As a Bavi-box user, I want unavailable SkillHub states to say they are unavailable, so that blank UI is not mistaken for missing features.
5. As a Bavi-box user, I want Skills page marketplace and installed lists to hide bundled OpenClaw skills, so that I only see product-facing skills.
6. As a Bavi-box user, I want Agents, Tools and Channels pages to use Bavi-box naming while keeping original OpenClaw capabilities intact, so that I can configure without learning internal branding.
7. As a Bavi-box user, I want Settings and Config forms to explain model/Gateway/save failures clearly, so that I can recover from setup issues.
8. As a Bavi-box user, I want loading, error, retry and disconnected states to be localized and consistent, so that every state feels intentionally designed.
9. As a Bavi-box maintainer, I want generated UI assets treated as outputs, so that future OpenClaw upgrades can be patched deterministically.
10. As a Bavi-box maintainer, I want service worker cache markers bumped per visible slice, so that old UI assets do not mask new changes.
11. As a Bavi-box maintainer, I want residual text scans and verifier scripts, so that regressions are caught before manual acceptance.
12. As a Bavi-box maintainer, I want subagents to handle independent audits, so that the long task can proceed faster without overlapping writes.
13. As a Bavi-box maintainer, I want Mac/Windows portable risks recorded, so that UI changes do not silently break P0 startup and text chat baseline.

## Implementation Decisions

- Active development happens only in `u-claw-app-dev`.
- Archived directories remain read-only: `u-claw-app` and `product`.
- UI patch source of truth is `scripts/patch-openclaw.js`.
- Verification source of truth starts from `scripts/verify-skillhub-branding.js`; add focused verifier scripts only when they reduce real manual risk.
- Generated `node_modules/openclaw/dist/control-ui/...` files are patch outputs, not hand-edited source.
- Preserve OpenClaw runtime names, Gateway methods, config schema and bundled skill directories.
- User-facing language may say Bavi-box / SkillHub; technical calls may remain OpenClaw / ClawHub when required by upstream runtime.
- No fake UI for `Unknown` or `Blocked` capabilities. If no OpenClaw method/event/CLI/config is verified, mark it blocked and keep it out of formal UI.
- Service worker cache marker must change after visible bundle patch changes.
- Subagents may run read-only audits or disjoint verifier/doc slices. Main agent owns PRD, source patch, integration and final validation.

## Testing Decisions

- Syntax checks: run `node --check` on every changed JS script.
- Patch checks: run `npm run patch-openclaw` and repeat when idempotency matters.
- Static verification: run `node scripts/verify-skillhub-branding.js` and any newly added verifier.
- Residual scan: search active control UI assets for `OpenClaw`, `ClawHub`, common English status strings and page labels.
- HTTP smoke: verify local control UI returns `200 OK`.
- Manual UI acceptance: inspect desktop/browser page after restart, especially first screen, Chat, Skills, Agents, Tools, Channels and Settings.
- Packaging acceptance: record Mac/Windows portable status when package-level validation is run; do not claim success without platform checks.

## Out of Scope

- Rewriting OpenClaw agent/runtime capabilities.
- Changing model/API chain, New API adapter, pricing config or provider auth.
- Modifying `src/main.js`, `package.json`, `setup.sh`, `setup.bat` without explicit authorization.
- Deleting bundled OpenClaw skills or changing OpenClaw package version.
- Directly using old `product` SkillHub API as authority.
- Building WeChat or any channel feature without verified OpenClaw authority.
- Hand-editing generated UI bundle as permanent source.

## Task Breakdown

### Task 1: 全界面可见面审计

目标：建立剩余 UI 改造清单。

完成标准：

- 审计 `index.html`、`sw.js` 与 active assets 中 Chat、Skills、Agents、Tools、Channels、Config/Shell 相关 bundle。
- 输出残留品牌、英文文案、空态/错误态、入口不一致、响应式风险。
- 标明每项对应后续任务，不直接扩大实现范围。

### Task 2: 全局 Shell 与导航改造

目标：所有第一视觉入口统一为 Bavi-box。

完成标准：

- 标题、侧栏、顶部、面包屑、登录/断连/加载态完成 Bavi-box 化。
- 不影响 Gateway 连接、路由与原菜单能力。
- 验证脚本覆盖品牌残留与 cache marker。

### Task 3: Chat 主体验改造

目标：聊天页成为用户可见第一工作面。

完成标准：

- 输入区、命令菜单、SkillHub 下拉、空态、错误态、模型状态文案统一。
- 不改会话协议，不自造 skill executor。
- 保存/失败/断连语义可验证。

### Task 4: SkillHub/Skills 页改造

目标：Skills 页按 Bavi-box SkillHub 语义收口。

完成标准：

- marketplace、detail、install、installed list、empty/loading/error 状态统一。
- bundled skills 用户侧隐藏，底层保留。
- 与能力矩阵状态一致。

### Task 5: Agents/Tools/Channels 页改造

目标：辅助页面不再显露混杂品牌。

完成标准：

- Agents/Tools/Channels 的标题、空态、按钮、错误态统一。
- 仅呈现 OpenClaw 已有能力，不新增假入口。
- 未确认能力标注为不可用或不展示。

### Task 6: Settings/Config/Onboarding 改造

目标：配置与首次使用路径可读、可恢复。

完成标准：

- Settings/Config 保存、默认模型、Gateway 断连、API key 缺失等文案 Bavi-box 化。
- 不触碰模型链路和底座文件。
- 错误态可复扫。

### Task 7: 视觉系统与响应式验收

目标：先完成 Brand Visual System / Logo，再继续界面密度、控件、文字溢出与移动/窄屏表现验收。

完成标准：

- 正式 Bavi-box logo / app avatar / chat assistant avatar 不再使用临时红色图标。
- 以 `#1677ff` 作为 Bavi-box primary color，background、sidebar、active state、按钮、链接、麦克风、SkillHub 下拉形成统一 Bavi-box 品牌视觉，避免临时橙色主色或零散默认态。
- 右侧 workspace 背景采用冷灰 `#f7f9fc/#f8fafc`，卡片保持白色，用层级替代纯白大面积铺底，避免回退到原 light theme 暖灰/肤色 `#f4f1ec`。
- 截图可见的 `Assistant` 与 `The agent run failed before producing a reply.` 被纳入文案修复与 verifier。
- 无明显文字重叠、按钮挤压、超宽卡片、单色主题失衡。
- 关键页面 desktop 与窄屏截图可验。
- UI 控件符合当前应用习惯，不做营销页。

### Task 8: 自动验证、重启与包装验收

目标：把第 16 节 UI 改造变成可重复交付。

完成标准：

- 一组命令可复现 patch、静态验证、残留扫描、HTTP smoke。
- 本地服务重启后可由边城验证。
- 包装层风险与未验证项写入验收记录。

## Acceptance Criteria

- 新 PRD 已落地，任务边界清晰，可供主 agent 与子 agent 并发执行。
- Task 1 审计产物已生成，并能驱动下一最小 UI 补丁切片。
- 每个实现切片都通过 syntax、patch、verifier、residual scan 与 HTTP smoke 中相关部分。
- Brand Visual System / Logo 切片完成前，整体完成度按 70%-75% 记录，不宣称视觉品牌层已验收。
- 未经授权不修改底座文件与归档目录。
- 连接态 UI 验收前，不把未验能力写成 `OK`。

## Current Status 2026-08-23

- Step 16 UI 收尾已完成，当前完成度可按约 90%-95% 记录；剩余风险主要是 Mac/Windows 打包验收，而不是 Control UI 首屏改造。
- 已完成 Brand Visual System、`#1677ff` 主色、冷灰 workspace 背景、logo/头像、SkillHub、Chat、Overview、Config、Sessions、Nodes、Logs 等 connected 可见页验收。
- `final-ui-polish-6` 为当前 UI cache marker；后续若再改可见 UI，必须继续 bump marker 并更新 verifier。
- 保留底层运行时契约：`openclaw.json`、`openclaw gateway run`、`exec host=node`、`system.run`、`clawhub` runtime key、raw log `openclaw-control-ui` 不作为用户侧文案强改对象。
- 下一阶段应进入 Task 8 打包验收：Mac/Windows 启动、Gateway ready、文本对话、U 盘 data 同步、配置读取；未测前不得宣称打包完成。

## Further Notes

本 PRD 可作为长任务执行。推荐并发方式：

- 主 agent：维护 PRD、改 `patch-openclaw.js`、更新 verifier、集成与最终验收。
- 子 agent A：审计 Chat/Shell/Config 可见文本。
- 子 agent B：审计 Skills/Agents/Tools/Channels 可见文本与能力边界。
- 子 agent C：运行验证/残留扫描并给出最小失败摘要。

并发只允许读-only 审计或 disjoint write set；任何涉及 UI patch 源头的写入由主 agent 收口。
