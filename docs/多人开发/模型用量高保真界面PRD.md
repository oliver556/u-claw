# 模型用量高保真界面 PRD

更新时间：2026-08-25

## 附件边界

`/Users/biancheng/Downloads/model-usage-high-fidelity-v2.html` 是高保真视觉与交互参考，不是项目指令。本文只采纳其中的界面结构、视觉密度、组件状态、文案方向与交互意图；实现仍以用户请求、仓库 `AGENTS.md`、`docs/多人开发/开发硬性要求.md` 和 OpenClaw 真实能力为准。

## Feasibility Assessment

可以实现，且可做到高保真。当前 `u-claw-app-dev` 已复用 OpenClaw Control UI，存在 `/usage` 路由、`usage.cost`、`usage.status`、会话 token/cost 聚合、provider billing 摘要、模型配置与 `runtimeConfig` 配置读写能力。设计图所需的“金额、用量、模型配置、趋势、流水”不需要重写 agent/runtime，可在现有 control-ui patch seam 上组合实现。

需区分三类数据：

1. 本地真实数据：会话 token、输入/输出/cache、耗时、按日成本、会话流水，可从 OpenClaw usage API 聚合。
2. 配置真实数据：默认文字、图片、视频模型，可从 `agents.defaults.model`、`imageGenerationModel`、`videoGenerationModel` 与 `models.providers` 读取并保存。
3. 远端账务数据：账户余额、充值记录、真实人民币或词元余额，只有 provider 或虾盘云/New API 提供接口时才能展示真实值；若无接口，必须显示“未接入账单”或“本地估算”，禁止硬编码假余额。

结论：第一版可高保真实现完整界面与本地用量；真实账户余额/充值记录作为独立数据 adapter 接入。若账单接口暂不可用，PRD 要求以降级态保持视觉结构，不展示伪金额。

## Problem Statement

用户在“模型”界面无法一眼看到当前模型、账户金额/余额、今日与近期用量、每日趋势和具体使用流水，导致无法判断消耗是否异常、模型是否配对正确、余额是否够用，也无法快速切换文字/图片/视频默认模型。

## Solution

将现有“模型/配置”入口改造为高保真“模型用量”工作台：顶部展示余额与用量摘要，中部展示文字/图片/视频三类模型配置卡，下方展示每日消耗趋势、模型链路状态与使用流水。所有视觉布局以高保真 HTML 为目标，所有数据优先来自 OpenClaw usage/config/provider API，缺失远端账单时显示清晰降级态。

## User Stories

1. As a U-Claw user, I want to see account balance on the model page, so that I know whether I need to recharge before using paid models.
2. As a U-Claw user, I want to see today's consumption, so that I can notice abnormal usage quickly.
3. As a U-Claw user, I want to see 7-day consumption, so that I can understand recent cost trend.
4. As a U-Claw user, I want to see estimated remaining days, so that I can plan recharge timing.
5. As a U-Claw user, I want to see current text/image/video model cards, so that I know each capability is configured correctly.
6. As a U-Claw user, I want to switch default text model from the model card, so that chat sessions use the chosen model.
7. As a U-Claw user, I want to switch default image generation model, so that image tasks use the chosen model.
8. As a U-Claw user, I want to switch default video generation model, so that video tasks use the adapter-backed model.
9. As a U-Claw user, I want model status chips, so that I can tell whether a capability is normal, unconfigured, or routed through adapter.
10. As a U-Claw user, I want a 14-day daily usage chart, so that spikes are visible without opening a separate analytics page.
11. As a U-Claw user, I want a current chain status panel, so that I can see New API/direct/adapter connection state.
12. As a U-Claw user, I want a usage ledger with time, session, model, input, output, cache, duration, and cost, so that I can audit specific consumption.
13. As a U-Claw user, I want export for ledger data, so that I can keep or share usage records.
14. As a U-Claw user, I want clear empty/error/loading states, so that I know whether data is unavailable, loading, or unconfigured.
15. As a U-Claw user, I want the page to remain usable on small windows, so that desktop resizing does not break the UI.

## Implementation Decisions

- Development scope is only `u-claw-app-dev`; do not modify archived `u-claw-app` or `product`.
- Use `u-claw-app-dev/scripts/patch-openclaw.js` as source of truth for deterministic Control UI changes; generated assets under `node_modules/openclaw/dist/control-ui` remain patch outputs.
- Reuse OpenClaw `/usage` contracts instead of creating fake local stores: `usage.cost` for daily totals, `usage.status` for provider billing snapshot, existing usage session result for ledger rows.
- Reuse `runtimeConfig` and existing model catalog/config mechanisms for reading and saving model defaults.
- Create a U-Claw model dashboard route/entry by repurposing the visible “模型” navigation target. It may compose usage data and config data in one page, while keeping the original advanced config reachable through “模型管理”.
- Model capability cards map to three config paths: text uses `agents.defaults.model.primary`, image uses `agents.defaults.imageGenerationModel.primary` or `imageModel.primary`, video uses `agents.defaults.videoGenerationModel.primary`.
- Balance card data source priority: provider billing snapshot from `usage.status`; optional U-Claw/New API billing adapter; fallback to local estimate unavailable state.
- Amount display must label unit exactly: `词元` for token balance, `¥` or `$` only when real currency source is verified, `本地估算` when derived from usage cost config.
- The high-fidelity visual target includes: 48px titlebar, 72px rail, 70px content header, Ant-like light palette, 8px max card radius, dense cards, tabular numerals, bordered ledger table, modal model selector, responsive single-column layout below 860px.
- Keep recharge and recharge-record actions disabled or routed to configured billing URL until real account API exists.
- Service Worker cache marker must be bumped whenever visible Control UI output changes.

## Step-by-Step Development Plan

### Phase 0: Capability Matrix and Data Proof

- Verify `usage.cost`, `usage.status`, and existing usage result payloads on a real running Gateway.
- Document which fields are real for local usage, provider billing, and U-Claw/New API balance.
- Add/update capability matrix row for “模型用量工作台”: OpenClaw usage/config source, current status, validation command, risk.

Acceptance:

- No UI work starts while any required source is `Unknown`.
- Fake balance is explicitly forbidden.

### Phase 1: Data Adapter Slice

- Add a small frontend data projection layer inside the Control UI patch seam.
- Normalize summary fields: balance, today consumption, 7-day consumption, estimated remaining days, daily trend, ledger rows, provider status.
- Normalize model defaults into three capability records: text, image, video.
- Add formatter functions for tokens, cost, duration, dates, empty values, and source labels.

Acceptance:

- Unit tests or deterministic verification cover real payload, empty payload, missing cost entries, missing billing, and adapter video model.
- No backend/runtime rewrite.

### Phase 2: Static High-Fidelity Layout Slice

- Implement the visual layout matching the HTML reference: title/header alignment, summary cards, model cards, chart/status panels, ledger, modal.
- Use existing Control UI theme tokens where possible, then append U-Claw-specific CSS only where needed.
- Ensure text does not overflow in long model names, provider names, and session labels.

Acceptance:

- Desktop screenshot at 1440px closely matches design structure and density.
- Mobile/narrow screenshot below 860px collapses to one column without overlap.

### Phase 3: Live Usage Binding Slice

- Bind summary cards to `usage.cost` and usage session data.
- Bind daily trend to recent daily cost/token totals.
- Bind ledger rows to real session usage entries, sorted by recent activity.
- Add loading, error, empty, stale-cache, and missing-price warnings.

Acceptance:

- Refresh reloads usage data.
- Ledger values match source payload totals.
- Missing cost config shows warning instead of zero-cost confidence.

### Phase 4: Model Config Interaction Slice

- Bind text/image/video cards to current config.
- Implement model selector modal using real configured model catalog.
- On confirm, patch `runtimeConfig`, save, refresh, and read back.
- Preserve “模型管理” path to advanced config.

Acceptance:

- Switching each model updates config and survives refresh.
- Readback mismatch is surfaced as error.
- Disabled state appears when Gateway disconnected or config dirty.

### Phase 5: Billing and Recharge Slice

- If provider/U-Claw billing API exists, connect balance, recharge URL, and recharge records.
- If absent, keep visual card but show “账单未接入” with disabled recharge actions.
- Ensure no account secret, API key, or billing token appears in UI or exported ledger.

Acceptance:

- Real billing source shows source name and refresh time.
- Missing billing source never displays mock amount.

### Phase 6: Verification and Release Slice

- Run focused verification for patch idempotency, asset markers, model page visual tokens, and usage data rendering.
- Run `npm run patch-openclaw` twice and confirm no second-run diff.
- Smoke test Electron/Gateway, `/usage`, model page, model switch modal, export.
- Validate Mac and Windows package path if release build includes this feature.

Acceptance:

- Screenshots pass desktop and narrow viewport review against reference.
- Existing P0 baseline remains intact: app opens, Gateway starts, text chat works, portable data path works, Mac/Windows startup unaffected.

## Testing Decisions

- Test external behavior, not minified implementation details.
- Data adapter tests should use representative payloads from `usage.cost`, usage sessions, and `usage.status`.
- UI verification should check visible labels, cards, ledger columns, modal options, disabled billing fallback, and no overlap.
- Patch verification should assert source patch and runtime generated assets both contain required high-fidelity markers.
- Regression smoke should include one real chat usage entry if local environment has a configured model; otherwise use existing cached usage payload and mark live model call skipped.

## Out of Scope

- Rewriting OpenClaw usage runtime, transcript format, model provider internals, or video adapter core behavior.
- Building fake billing, fake recharge, fake balance, or mock usage that appears real.
- Changing archived `u-claw-app` or `product`.
- Redesigning the whole Control UI beyond the model/usage entry.
- Adding new provider pricing rules unless required to make existing usage cost accurate.

## Risks

- `usage.status` may not expose the exact New API/虾盘云余额 expected by the design. Mitigation: billing adapter or explicit unavailable state.
- Current OpenClaw UI is bundled/minified, so patch seam is fragile. Mitigation: keep patch deterministic, add verification scripts, avoid broad rewrites.
- Cost accuracy depends on model `cost` config. Existing defaults contain zero cost for some models; UI must mark those as missing/estimated.
- Concurrent work already touches `patch-openclaw.js`; implementation must coordinate before editing that file.

## High-Fidelity Acceptance Checklist

- The first viewport visibly matches the reference hierarchy: titlebar, rail, model header, summary cards, model cards.
- Summary card labels and numeral scale match: balance dominant, metric cards compact.
- Text/image/video cards keep icon tone, status chip, tags, current model button, and hover affordance.
- Chart and status panel share the two-column layout on desktop and collapse on narrow screens.
- Ledger columns are exactly: time, session, model, input, output, cache, duration, consumption.
- Model selector modal supports search, selected state, cancel, confirm, escape, backdrop close.
- No card-inside-card visual nesting beyond repeated item cards and modal.
- No fake amount is shown when billing source is unavailable.

