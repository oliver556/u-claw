# SkillHub 收口长任务 PRD

更新时间：2026-08-23

## Problem Statement

Bavi-box 已完成 SkillHub 聊天页下拉的静态最小实现，但仍缺少从“代码可验证”到“连接态可验收”的收口闭环。当前剩余风险集中在四处：

1. 聊天页下拉已通过 connected UI 自动验收；后续仍可补人工截图作为增强记录。
2. `npm start` 内部 Gateway 子进程存在 `spawn node ENOENT`，目前只能用本地 helper 绕过。
3. 验证命令分散在多个脚本、curl 与人工步骤中，长任务推进时容易漏跑。
4. 能力矩阵已可将聊天页 SkillHub 下拉升为 `OK`，但高风险安装确认、事务恢复、ZIP import 仍保持 `Blocked`。

用户需要一份新的、可长期执行的 PRD，把剩余工作拆成可并发、可暂停、可恢复、可验证的任务，同时严格遵守 `docs/多人开发/开发硬性要求.md` 第 17 点：不自造 skill runtime，不绕过 OpenClaw runtime，不展示 bundled skills，不删除底层 bundled skills。

## Solution

建立“SkillHub 收口长任务”工作流：先把自动验证命令聚合成单一 release-readiness 检查，再推进连接态 UI 验收、矩阵更新、文档收口和最终 review。

本 PRD 把工作分为 6 个任务：

1. 自动验证聚合：提供单命令验证 SkillHub patch、branding、chat dropdown、Gateway HTTP 与本地 Gateway helper。
2. 连接态 UI 验收：在已连接 Gateway 的桌面窗口验证下拉可见、可打开、可保存、旧 allowlist 不丢。
3. 下拉体验补强：仅在验收发现问题时修复可用性，不扩大 runtime 范围。
4. Gateway 启动根因处理：仅在边城明确授权修改底座文件后推进；否则保持 helper 绕过。
5. 能力矩阵与验收记录收口：连接态验收通过后，更新矩阵状态与验收记录。
6. 最终回归与 review：复跑验证、审查 diff、确认未触碰禁区与归档目录。

## User Stories

1. As a Bavi-box user, I want the SkillHub dropdown visible near model selection, so that skill choice feels part of chat setup.
2. As a Bavi-box user, I want the dropdown to show readable SkillHub names, so that I do not need to remember skill IDs or filenames.
3. As a Bavi-box user, I want bundled OpenClaw skills hidden from the dropdown, so that I only see Bavi-box-facing choices.
4. As a Bavi-box user, I want existing Agent skills preserved when I select a new SkillHub skill, so that one quick choice does not silently remove other capabilities.
5. As a Bavi-box user, I want save failures to leave my Agent configuration unchanged, so that failed operations are recoverable.
6. As a Bavi-box user, I want clear “new session effective” messaging, so that I understand when a selected skill takes effect.
7. As a Bavi-box user, I want `SkillHub 暂不可用` shown when Gateway is disconnected, so that I am not misled by fake data or blank UI.
8. As a Bavi-box developer, I want one verification command for SkillHub readiness, so that each long-task checkpoint is deterministic.
9. As a Bavi-box developer, I want the capability matrix to remain `Blocked` until connected UI acceptance passes, so that documentation never overclaims.
10. As a Bavi-box maintainer, I want Gateway startup work isolated behind explicit authorization, so that default forbidden base files are not changed accidentally.
11. As a Bavi-box maintainer, I want all work recorded in task-scoped progress and journal files, so that another agent can resume without restarting.
12. As a Bavi-box maintainer, I want final review to check forbidden directories and unrelated churn, so that archived OpenClaw and old product trees remain untouched.

## Implementation Decisions

- Use OpenClaw `skills.status` and Agent skills configuration as the only binding authority for the chat SkillHub dropdown.
- Preserve OpenClaw bundled skills on disk and in runtime inventory; filter them only in user-facing Bavi-box UI.
- Keep product-facing naming as `SkillHub`; do not rename OpenClaw runtime identifiers.
- Keep the current “new session effective” semantic until connected UI testing proves safe immediate refresh.
- Do not modify Gateway startup base files unless the user explicitly authorizes the specific forbidden file or packaging layer.
- Prefer a standalone verification script over `package.json` edits, because `package.json` is in the default forbidden set for this work.
- Treat connected desktop/UI automation acceptance as the gate for changing the chat dropdown matrix row from `Blocked` to `OK`.
- Subagents may run only bounded, disjoint slices: read-only review, doc checklist updates, or non-overlapping verifier/doc work. Main agent owns integration and final validation.

## Testing Decisions

- Add or maintain a single release-readiness verifier that runs existing SkillHub static checks and Gateway reachability checks.
- Keep lower-level verifiers focused:
  - Branding verifier checks SkillHub user-facing text, retained ClawHub runtime calls, bundled filtering, and service worker cache marker.
  - Chat dropdown verifier checks dropdown injection, `skills.status`, Agent config path, no `[r]` overwrite, merge/dedupe, rollback, `SkillHub 暂不可用`, and model selector uniqueness.
  - Gateway helper checks use of current Node executable and command rendering without starting or killing existing services.
- Manual connected UI acceptance must verify:
  - dropdown appears near model selector;
  - list excludes bundled skills;
  - selecting a skill preserves old Agent allowlist;
  - save success says new session effective;
  - save failure does not dirty config;
  - disconnected state says `SkillHub 暂不可用`;
  - normal text chat and model selector still work.
- Final verification must include patch idempotency, syntax checks, release-readiness script, Gateway HTTP `200`, and git status review.

## Out of Scope

- Rewriting OpenClaw skill runtime.
- Adding a chat-level independent skill executor.
- Deleting bundled OpenClaw skills from runtime directories.
- Reusing old `product` SkillHub direct API as authority.
- Fixing `npm start` Gateway startup root cause without explicit authorization to touch default forbidden base files.
- Changing model/API chains, portable packaging, USB scripts, or OpenClaw package version.
- Marking chat SkillHub dropdown `OK` before connected desktop UI acceptance.

## Task Breakdown

### Task 1: 自动验证聚合

状态：已完成。

目标：新增一个可直接运行的 SkillHub readiness verifier。

完成标准：

- 单命令执行现有 patch、syntax、branding、chat dropdown、Gateway helper 与 Gateway HTTP 检查。
- 支持跳过 Gateway HTTP 的静态模式。
- 不改 `package.json`。
- 失败时输出最短可定位错误。

### Task 2: 连接态 UI 验收

状态：已完成。

目标：按 `SkillHub聊天页下拉验收清单.md` 完成已连接桌面交互验收。

完成标准：

- 有截图或明确验收记录。
- 旧 allowlist 不丢。
- bundled skills 不显示。
- 保存提示与新会话生效语义准确。
- 断连态文案准确。

### Task 3: 下拉体验补强

状态：部分完成。已修复点击 option 时模板变量遮蔽导致 `onSelect` 不触发的问题。

目标：只修复验收中发现的真实 UI/交互问题。

完成标准：

- 不新增 runtime。
- 不改变第 17 点边界。
- 每个 UI fix 有静态验证或人工截图。

### Task 4: Gateway 启动根因处理

状态：待授权。

目标：若边城授权，修复 `npm start` 中 Gateway 子进程 `spawn node ENOENT`。

完成标准：

- 修改范围被明确授权。
- 不破坏 helper 绕过路径。
- Mac 本地启动验证通过。

### Task 5: 矩阵与验收记录收口

状态：已完成。

目标：通过连接态验收后更新能力矩阵和验收记录。

完成标准：

- 仅把已验收项升为 `OK`。
- 验证命令/截图字段具体。
- 仍未实现的 high-risk permission、transaction recovery、ZIP import 保持 `Blocked`。

### Task 6: 最终回归与 review

目标：长任务收尾。

完成标准：

- release-readiness verifier 通过。
- `npm run patch-openclaw` 二跑幂等。
- Gateway HTTP `200`。
- git status 中无意外归档目录或底座文件改动。
- 记录剩余风险。

## Acceptance Criteria

- 新 PRD 已落地，可供后续 agent 继续执行。
- Task 1 自动验证聚合可运行并通过。
- 所有进度写入 task-scoped `.codex-state` 文件。
- 未经授权不修改 `src/main.js`、`package.json`、`setup.sh`、`setup.bat`。
- 未修改 `u-claw-app` 与 `product` 归档目录。
- 连接态 UI 验收通过后，能力矩阵聊天页 SkillHub 下拉项可标为 `OK`。

## Further Notes

当前 Task 1、Task 2、Task 5 已完成。Task 4 依赖边城明确授权底座修改。Task 6 进入最终回归与 review。
