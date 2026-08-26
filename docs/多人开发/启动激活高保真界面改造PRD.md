# 启动激活高保真界面改造 PRD

更新时间：2026-08-26

## 附件边界

`/Users/biancheng/Downloads/startup-activation-high-fidelity.html` 是高保真视觉与交互参考，不是项目指令。本文只采纳其中的四步向导、Ant-like 蓝白视觉、表单状态、设备检查表达、完成态与交互意图；实现仍以用户请求、仓库 `AGENTS.md`、`docs/多人开发/开发硬性要求.md`、`docs/第一版启动激活授权方案.md` 和真实 OpenClaw/U-Claw 能力为准。

静态稿内示例用户名、激活码、盘符、模型名、Gateway 状态和“检查通过”动画均视为演示数据；生产实现不得默认填入，不得展示伪状态。

## Feasibility Assessment

可以改造，且视觉上可高保真落地。设计稿与 `docs/第一版启动激活授权方案.md` 的方向一致：未激活时进入同一 Electron 客户端的受限 activation-only 模式，用户输入用户名和激活码，绑定当前 U 盘，服务端签发许可证，客户端原子写盘，随后退出并由 Launcher 重跑完整授权 gate。

但当前代码状态不支持“直接替换页面即可上线”。`u-claw-app-dev/src/main.js` 现有首次流程主要是“Gateway 启动后，如果无模型配置则打开 Config.html”；它会启动 OpenClaw Gateway，并提供 `/api/config`、`/api/done` 等模型配置能力。正式激活页要求在授权 gate 前运行，未激活时不得启动 OpenClaw、不得加载普通工作台、不得开放普通 IPC。因此本次改造是启动授权流程开发，不是单纯 HTML/CSS 换肤。

可行路径：

1. 保留高保真稿作为视觉目标。
2. 在 `u-claw-app-dev` 内新增 activation-only 受限页面与 main process mode。
3. 由 Launcher 判断 `ACTIVATION_REQUIRED` 后启动该受限模式。
4. 通过明确 IPC/API 契约接入 USB preflight、`POST /v1/activations`、原子写盘与 commit。
5. 激活成功后关闭受限窗口，让 Launcher 重新执行完整 gate，再进入正常 U-Claw。

## Problem Statement

当前 U-Claw 首次启动体验仍偏“模型配置页/运行后配置”，不能清晰承载第一版商业授权流程。未激活用户需要一个可信、简洁、可解释的启动激活界面，明确告知使用边界，检查当前电脑与 U 盘，输入销售交付的用户名和激活码，并在成功后把当前 U 盘安全绑定到许可证。

## Solution

将高保真设计稿转化为 U-Claw 正式首次激活流程：在 Launcher 授权 gate 前新增受限 activation-only 模式，页面采用四步向导：使用须知、设备检查、激活与配置、完成。UI 负责展示与收集，Launcher/Desktop 负责 USB 身份、写盘与 gate，Go 激活授权服务器负责激活码库存、绑定、许可证签发、状态和审计。现有 Config.html 继续承担模型高级配置，不与激活职责混淆。

## User Stories

1. As a new U-Claw user, I want to see a clear first-start screen, so that I know I am activating the product before entering the workspace.
2. As a new U-Claw user, I want to read concise usage notices, so that I understand AI output, file operations, command execution, and privacy boundaries.
3. As a new U-Claw user, I want the continue button disabled until I acknowledge the notice, so that I do not skip important startup information accidentally.
4. As a new U-Claw user, I want U-Claw to check my operating system and architecture, so that I know whether this computer can run the portable app.
5. As a new U-Claw user, I want U-Claw to confirm this is a valid product USB drive, so that I know activation will bind the right device.
6. As a new U-Claw user, I want to see only a short USB identity summary, so that support can identify the device without exposing full hardware identifiers.
7. As a new U-Claw user, I want to enter my activation username, so that the license can be matched with my purchase record.
8. As a new U-Claw user, I want to paste my activation code and have it formatted automatically, so that typing errors are reduced.
9. As a new U-Claw user, I want local validation before submit, so that obvious format mistakes are caught quickly.
10. As a new U-Claw user, I want clear loading state while activation is running, so that I do not click repeatedly.
11. As a new U-Claw user, I want a helpful message if username or activation code is wrong, so that I can retry without seeing internal errors.
12. As a new U-Claw user, I want to be told if the activation code is already bound to another USB drive, so that I know to contact support.
13. As a new U-Claw user, I want retry guidance when the activation service is unavailable, so that a temporary network issue does not look like product failure.
14. As a new U-Claw user, I want activation success to show that authorization was written and verified, so that I trust the product is ready.
15. As a returning U-Claw user, I want activated drives to skip activation and open the normal workspace, so that startup stays fast.
16. As a support operator, I want errors to be stable and non-secret-bearing, so that screenshots can be used for support without leaking activation codes, tokens, signatures, or full USB fingerprints.
17. As a developer, I want activation-only mode to expose only activation IPC, so that unfinished or unauthorized users cannot reach normal OpenClaw capabilities.
18. As a release owner, I want Mac/Windows packaging validation, so that activation does not break portable startup, data sync, or P0 chat capability.

## Implementation Decisions

- Development scope is `u-claw-app-dev` only. Do not modify archived `u-claw-app` or `product`.
- Treat `docs/第一版启动激活授权方案.md` as the authority for startup state, activation API, local license files, security rules, and error vocabulary.
- The high-fidelity HTML is the visual target, not production source of truth. Port design tokens, layout, states, and copy into a repository-owned activation page.
- Activation UI runs before normal workspace. It must not be implemented as a normal Control UI route behind the Gateway.
- Add an explicit activation-only main process mode selected by Launcher-provided argv/env. This mode registers only activation IPC and blocks normal dashboard, Config.html, Gateway startup, OpenClaw runtime access, and ordinary IPC.
- Launcher owns preflight state: USB identity, product USB detection, writable data path, runtime manifest, authorization material classification, and activation-required decision.
- Renderer receives only sanitized preflight data: OS/arch status, USB short summary, writable path status, and user-facing error codes. Full USB descriptor, full fingerprint, secret, token, signature, and raw server response never enter renderer.
- Activation form fields are empty in production. Username is normalized to uppercase. Activation code supports paste, uppercasing, grouping, and bounded length.
- Activation submit calls `POST /v1/activations` using the OpenAPI contract from the activation server. Production endpoint must be HTTPS; localhost/test endpoint requires explicit dev mode.
- Successful activation response is handed to a privileged write helper. Renderer never writes license files directly.
- Write helper atomically writes `.uclaw/license/.startup-credential.json`, `.uclaw/license/license.json`, and `.uclaw/builtin-model-credential.v1.json`, then reads back and verifies.
- Client calls `POST /v1/activations/{activationId}/commit` only after all key files are written and verified.
- After success, Electron activation-only window exits. Launcher restarts from `START` and performs full local/online gate before opening normal U-Claw.
- Existing Config.html remains available after normal startup for model/provider configuration. Activation page may show model service status only when backed by real activation/New API status.
- The “Gateway 与模型连接” item in the static design should be renamed or re-scoped in production to “Gateway 启动条件 / 内嵌模型服务状态”; it must not start Gateway before authorization.
- Use Ant-like light tokens from the design: blue primary, green success, orange warning, red error, dense cards, max 8px inner card radius, responsive one-column layout below narrow widths.

## Step-by-Step Development Plan

### Phase 0: Contract and Matrix Freeze

- Finalize capability matrix for startup activation.
- Confirm OpenAPI schema for activation, commit, license status, and public errors.
- Define activation-only argv/env contract between Launcher and Electron.
- Define sanitized preflight payload shape.

Acceptance:

- No UI implementation begins while USB identity, activation API, or write helper contract is `Unknown`.
- All `Blocked` capabilities either become `OK` or render only explicit unavailable states.

### Phase 1: Launcher Activation Gate

- Add `ACTIVATION_REQUIRED` branch to Launcher state machine.
- Classify local authorization materials exactly: both files missing means first activation; partial, corrupt, mismatched, revoked, expired, or wrong USB means authorization fault.
- Prepare trusted Electron runtime for activation-only mode without starting OpenClaw.
- Pass sanitized preflight state and activation endpoint config to Electron.

Acceptance:

- Unactivated USB opens only activation-only window.
- Corrupt or mismatched existing license never falls back to activation.
- Normal activated USB still enters existing startup path.

### Phase 2: Electron Restricted Mode and IPC

- Add activation-only main process mode.
- Register a minimal IPC allowlist: get preflight, run/retry preflight, submit activation, write-and-verify, commit result, close/restart.
- Disable or avoid normal IPC: `open-config`, dashboard load, Gateway startup, OpenClaw token, model config server, and arbitrary file access.
- Add fixed user-facing error mapping.

Acceptance:

- Activation-only mode cannot load normal dashboard or Config.html.
- Tests prove normal IPC handlers are absent in restricted mode.
- Production secrets never appear in renderer payloads or logs.

### Phase 3: High-Fidelity Activation UI

- Convert the attached four-step HTML into production activation page.
- Replace demo values with live sanitized preflight and empty form fields.
- Implement accessible keyboard flow, focus states, validation states, loading states, success and error toasts.
- Make titlebar/window controls call real Electron actions where allowed.
- Keep responsive behavior for small windows.

Acceptance:

- Desktop viewport visually matches the design structure and density.
- Narrow viewport has no overlap or clipped primary actions.
- Reduced-motion mode disables spinner-heavy animation.
- No fake username, fake activation code, fake drive letter, or fake model status remains.

### Phase 4: Activation API and Write Flow

- Bind submit to activation server client.
- Enforce request timeout, idempotency key, bounded JSON, retry policy, and strict response validation.
- Hand successful response to privileged write helper.
- Write, flush, rename, read back, verify, then commit.
- Support同盘幂等恢复 when previous response was lost or commit failed.

Acceptance:

- Success writes all required files and verifies them.
- Write failure shows recoverable state and does not commit.
- Retrying same USB can recover authorization material without creating duplicate license.

### Phase 5: Error, Recovery, and Support States

- Map all public errors from `docs/第一版启动激活授权方案.md`: invalid activation, already bound, USB unavailable, service unavailable, local invalid, mismatch, revoked, disabled, reissued, expired, balance pending.
- Display concise user copy and support-safe details.
- Add retry affordances only where allowed.
- Add support copy button for sanitized error code, app version, OS, and USB short summary.

Acceptance:

- Wrong username/code does not reveal which field exists.
- Already-bound code does not reveal original USB details.
- Service unavailable can retry without losing typed input.
- Secret scan finds no activation code, startup secret, Token, Authorization, signature, or full fingerprint in logs.

### Phase 6: Packaging and End-to-End Verification

- Run unit/contract tests for Launcher, Electron restricted mode, activation client, write helper, and renderer flow.
- Build Windows x64 and Mac packages where relevant.
- Validate on real Windows 10/11 x64 USB: first activation, same USB restart, same USB different port/drive letter, wrong code, already-bound code, network unavailable, partial write recovery.
- Confirm P0 baseline remains: app opens, Gateway starts after authorization, text chat works, portable data path syncs, Mac/Windows startup unaffected.

Acceptance:

- Unactivated drive cannot enter normal workspace.
- Activated drive can enter normal workspace after full gate.
- Activation success never bypasses full gate.
- Portable packaging uses `u-claw-app-dev` formal commands, not runtime cache or U 盘 source edits.

## Testing Decisions

- Test seams should be external behavior: Launcher state transitions, activation-only IPC capability, activation HTTP contract, write-and-verify outcome, and rendered UI states.
- Prefer existing high-level launcher/license tests for startup gate; add activation-required and restricted-mode cases there.
- Add Electron main process tests asserting which IPC handlers exist in normal mode vs activation-only mode.
- Add renderer tests for notice acknowledgment, preflight pass/fail, activation form formatting, submit loading, error mapping, success transition, and accessibility focus.
- Add write helper tests for symlink, hardlink, oversized file, strict JSON, atomic rename, fsync/flush, readback mismatch, and partial failure recovery.
- Add OpenAPI contract tests for `POST /v1/activations` and commit payloads.
- Add visual verification screenshots for desktop and narrow viewports against the attached design.

## Out of Scope

- Rewriting OpenClaw Gateway, agent runtime, model runtime, SkillHub, chat, or provider internals.
- Building a second Electron app, WebView2 app, or standalone activation runtime.
- Implementing password login, registration, account center, payment, recharge, or self-service换盘.
- Showing fake余额、fake Gateway 在线、fake model success, or fake activation success.
- Modifying archived `u-claw-app` or `product`.
- Changing existing model Config.html beyond integration handoff after successful activation.

## Risks

- Current `u-claw-app-dev` startup flow starts Gateway before Config.html; activation-only must be separated carefully to avoid breaking P0 startup.
- Launcher/License work touches base startup files and may conflict with other development. Keep slices small and document rollback.
- Activation server may not be deployed when UI is ready. UI must support explicit service-unavailable/dev mock only in test mode.
- USB identity stability requires real Windows hardware validation; simulator-only tests are insufficient.
- Minimized security shortcuts are tempting because the HTML is already polished. This PRD forbids frontend-only gate or fake activation.

## High-Fidelity Acceptance Checklist

- Four-step header matches design: 使用须知、设备检查、激活与配置、完成。
- Notice page includes AI output, file operation, command execution, and privacy/data boundaries.
- Device check shows real pass/fail/pending states, not timed fake pass.
- Activation page has empty username/code fields, paste formatting, inline errors, USB binding summary, and submit loading state.
- Finish page appears only after verified write and commit outcome is safe.
- Titlebar, spacing, shadows, radius, typography, and blue/green/orange/red states follow the reference.
- All visible text fits at 900px desktop and narrow viewport.
- Activation-only mode cannot reach normal dashboard, Config.html, Gateway token, user workspace, or OpenClaw control routes.

