# SkillHub 商店首页与分类筛选 PRD

更新时间：2026-08-23

## Problem Statement

当前 SkillHub 商店已能通过 OpenClaw `skills.search` 拉取远端技能，但用户进入页面时仍像一个搜索工具，而不是一个可浏览的商店：缺少推荐主页、缺少清晰 tab、缺少分类筛选，也缺少“为何没有数据”的可理解路径。

实测空 query 返回空结果，OpenClaw Gateway `skills.search` 当前契约只稳定支持 `query` 和 `limit`。因此不能把“推荐、分类、可用”做成假服务端能力；必须基于真实搜索结果、本地 `skills.status` 状态、返回字段中的 `categories/topics/trust/installability` 做 UI 层组织。

## Research Findings

1. OpenClaw 原能力可用：`skills.search`、`skills.detail`、`skills.install`、`skills.status`、`skills.update` 已在能力矩阵中标为 `OK`，商店必须沿用这些链路。
2. `skills.search` schema 只接受 `query` 和 `limit`；源码 handler 也是把二者传给 `searchSkillsFromClawHub`，没有服务端 category/sort/page contract。
3. CLI 实测 `skills search --json --limit 3` 返回 `results: []`；空 query 不能作为首页数据源。
4. CLI 实测 `agent`、`browser`、`lark`、`automation` 关键词均可返回 SkillHub 数据，且结果含 `ownerHandle`、`slug`、`displayName`、`summary`、`downloads`、`metrics`、`native.skill.categories`、`native.skill.topics`、`trust.installability`、`install.reference` 等字段。
5. 本地 `skills list --json` 可返回 `eligible`、`disabled`、`blockedByAgentFilter`、`modelVisible`、`source`、`bundled`、`missing` 等字段；可用于“已安装/可用/需配置”状态，但用户侧需过滤 bundled skills。
6. 底层 `fetchClawHubSkillDetail` 支持 `ownerHandle`，但当前 Gateway `skills.detail` schema 只声明 `slug`。同 slug 多作者场景要在实现前验证 owner-qualified detail 能否通过 Gateway，否则详情与安装身份存在漂移风险。

## Solution

把 Skills 页里的 SkillHub 区域改造成“商店首页 + 搜索结果 + 本地可用状态”的信息架构。

首屏不再只执行单个 `agent` 默认搜索，而是展示推荐主页：并发请求一组经过验证的种子关键词，聚合去重后生成推荐、热门分类和精选列表。用户可通过 tab 切换“推荐”“可安装”“已安装”“需配置”，并用分类 chips 在已加载结果内筛选。用户输入搜索词后进入搜索结果模式，仍调用真实 `skills.search({ query, limit: 40 })`。

分类筛选第一版为 UI 层筛选：优先使用 SkillHub 返回的 `categories/topics/tags`；字段缺失时使用关键词映射派生 `uiCategory`，并在实现注释和 PRD 中明确它不是服务端分类能力。

视觉上沿用 Bavi-box 蓝色主色，不使用橙色作为主 CTA 或主状态色。页面应像工具商店，不像调试面板：顶部有推荐入口、tab、分类筛选、搜索框；结果区可独立滚动；无数据时给出重试、换关键词、查看已安装技能等可行动路径。

## User Stories

1. As a Bavi-box user, I want to see recommended SkillHub skills when opening the store, so that I can browse without knowing search keywords.
2. As a Bavi-box user, I want the store to show real remote results, so that installed skills are not based on fake catalog data.
3. As a Bavi-box user, I want a 推荐 tab, so that I can start from curated useful skills.
4. As a Bavi-box user, I want a 可安装 tab, so that blocked or untrusted results do not mix with normal install choices.
5. As a Bavi-box user, I want an 已安装 tab, so that I can see local SkillHub skills separately from the online catalog.
6. As a Bavi-box user, I want a 需配置 tab, so that I can find skills that need env, bins, config, or agent changes before use.
7. As a Bavi-box user, I want category chips in Chinese, so that I can filter by purpose instead of reading every card.
8. As a Bavi-box user, I want category filters to work even when upstream has partial metadata, so that browsing still feels useful.
9. As a Bavi-box user, I want search results to be separate from the homepage recommendation state, so that clearing search returns me to the store homepage.
10. As a Bavi-box user, I want duplicate skills from different recommendation queries to merge by exact `@owner/slug`, so that the page does not show repeated cards.
11. As a Bavi-box user, I want same-slug different-owner skills to remain distinct, so that I do not inspect or install the wrong package.
12. As a Bavi-box user, I want loading states per section, so that slow recommendation queries do not make the entire page look broken.
13. As a Bavi-box user, I want partial failures to be visible but non-blocking, so that one failed keyword does not erase all homepage content.
14. As a Bavi-box user, I want blocked or review-required skills marked clearly, so that installation risk is visible before clicking.
15. As a Bavi-box user, I want empty states with retry and suggested keywords, so that “拉不到数据” has a next step.
16. As a developer, I want implementation to stay on OpenClaw Gateway methods, so that Bavi-box does not fork the skill runtime.
17. As a developer, I want the PRD to separate real backend ability from UI-derived grouping, so that future agents do not build fake category APIs.

## Implementation Decisions

- Homepage recommendation uses multi-query aggregation, not empty search. Initial seed queries: `agent`、`browser`、`automation`、`lark`、`coding`、`data`、`productivity`、`communication`。Each query requests up to 20 items; aggregate caps at 40 visible items unless the UI explicitly shows more.
- Deduplication key is `@ownerHandle/slug` when owner exists; fallback is `install.reference`; last fallback is `slug` only when no owner identity exists.
- Ranking for 推荐 is UI-derived: trust installable first, then higher downloads/stars/recent installs, then query bucket order. Do not call it server ranking.
- Tabs:
  - `推荐`: aggregated homepage results.
  - `可安装`: loaded remote results with `trust.installability === "installable"` or equivalent safe state.
  - `已安装`: local non-bundled skills from `skills.status` / `skills list`.
  - `需配置`: local non-bundled skills with `eligible === false` or non-empty `missing`.
  - `搜索结果`: shown only while search query is active.
- Category chips first version: 全部、Agent、浏览器、自动化、办公协作、开发、数据、沟通、多模态、研究、效率、工具、其他。
- Category mapping priority: upstream `native.skill.categories` -> upstream `categories` -> upstream `native.skill.topics/topics` -> keyword/summary/name heuristic. Heuristic output must be marked internal as `uiCategory`.
- Category filters apply to the already loaded recommendation/search/local result set. Do not send `category` to `skills.search` until OpenClaw exposes a verified contract.
- “可安装” tab must exclude `blocked` trust state from primary cards; review-required skills may appear only with clear `需复核` badge and OpenClaw risk confirmation path.
- Installed/local tabs must filter `source === "openclaw-bundled"` or `bundled === true` from user-facing lists while keeping runtime data untouched.
- Search input remains debounced at 300ms and calls `skills.search({ query, limit: 40 })`; clearing search returns to homepage aggregation state.
- Detail and install actions must use identity-safe display references. Before implementation, verify whether Gateway `skills.detail` accepts `ownerHandle`; if not, either add a safe adapter through existing OpenClaw-supported route or constrain detail behavior so installation still uses exact `@owner/slug`.
- Installation remains `skills.install({ source: "clawhub", slug: "@owner/slug" })` or current verified OpenClaw reference form. No custom executor.
- State model should distinguish `idle`、`loadingHomepage`、`homepageReady`、`searching`、`searchReady`、`partialError`、`empty`、`offline`，so UI does not confuse “no result” with “not loaded”.

## Testing Decisions

- CLI probes remain part of pre-implementation validation: `skills search agent/browser/lark/automation --json --limit 3` must return non-empty results; empty query returning empty must be documented as expected.
- Static verifier should assert the generated Skills asset contains homepage seeds, tab labels, category labels, bundled filtering, limit 40, and no orange primary CTA tokens.
- Connected UI verifier should load `/skills`, wait for homepage recommendation cards, switch tabs, apply category chips, run a search, clear search, and confirm homepage returns.
- Identity verifier should use fixture-like mocked records with same slug and different owners to confirm dedupe keeps distinct `@owner/slug` identities.
- Local status verifier should check bundled skills are filtered from user-facing installed/available tabs but remain present in raw `skills.status` data.
- Empty/error verifier should simulate all recommendation queries empty, one query failed, Gateway disconnected, and 429/timeout text mapping.
- Runtime smoke verifier must execute patched helper paths, not only `node --check`; it should catch wrong variable captures in generated minified assets such as helper functions referencing an outer `e` instead of their argument.
- Visual smoke should cover desktop and narrow viewport: tabs and category chips wrap without overlapping; result list scrolls independently; blue visual system remains dominant.

## Out of Scope

- Do not add fake server-side category, sort, pagination, or recommendation APIs.
- Do not call old `product` SkillHub API shape directly.
- Do not rewrite OpenClaw skill runtime or create a chat-level skill executor.
- Do not expose OpenClaw bundled skills as user-facing SkillHub items.
- Do not delete bundled skill directories to hide them.
- Do not implement uninstall, ZIP import, full transaction recovery, or high-risk permission fingerprint in this PRD unless a separate PRD/adapter validates those `Blocked` capabilities.
- Do not touch model chain, Gateway startup, portable data, or Mac/Windows packaging baseline.

## Acceptance Criteria

- Opening SkillHub store shows a 推荐 homepage with real remote cards without requiring user input.
- Empty query is not used as the homepage data source.
- Homepage aggregates multiple real `skills.search` queries, deduped by identity.
- Tabs include 推荐、可安装、已安装、需配置, and 搜索结果 appears only when search is active.
- Category chips filter visible results and use Chinese labels.
- Filtering never claims to be server-side category search.
- Search still debounces 300ms and requests at most 40 records.
- Clearing search restores homepage recommendation state.
- Same slug across owners remains distinct in card identity, detail intent, and install intent.
- Cards show name, owner/reference, summary, categories/topics, downloads/stars/installs when present, trust state, detail action, and install action.
- Local tabs use `skills.status` / list data and filter bundled skills from user-facing display.
- `blocked` skills do not appear in normal 可安装 results.
- Partial homepage query failures leave successful categories visible and show a compact retry affordance.
- No-data states show actionable retry/suggested keyword options.
- UI primary color is blue, not orange.
- Generated patch is repeatable through the existing patch script.
- Existing validation for branding, chat dropdown, release readiness, and connected UI continues to pass.
- Existing verifier gaps must be closed where they only check static tokens; critical patched helpers need runtime assertions.

## Further Notes

This PRD refines, rather than replaces, `SkillHub技能库PRD.md`. The earlier PRD defines full SkillHub product/security target; this PRD scopes the next UX slice: homepage recommendation, tabs, category filtering, and no-data recovery.

Implementation should remain a minimal patch over OpenClaw Control UI until a safer first-class frontend extension seam exists. All durable behavior must remain traceable to OpenClaw `skills.*` methods or documented UI-only grouping.
