# SkillHub 商店信息架构与高密度 UI 改造 PRD

更新时间：2026-08-23

## Problem Statement

当前 SkillHub 商店已具备推荐首页、搜索、tabs、分类筛选和安装风险确认能力，但视觉与信息架构仍偏“嵌套卡片式控制台”：页面标题、商店标题、区块标题、tab、分类 chip 多层堆叠，重复出现 `SkillHub` 语义，导致首屏有效技能数量少、扫读成本高。

用户参考图表达的目标不是新增能力，也不是新增 SkillHub 二级左侧导航，而是重排 Skills/SkillHub 内容区右侧列表：保留技能图标，把技能列表做成类似 ZClaw 参考图右侧区域的高密度技能市场。右侧顶部负责搜索、API Key 筛选、排序、刷新；下方每行快速展示图标、名称、版本、摘要、场景、下载、收藏和安装/卸载状态。

附件截图仅作为产品需求与视觉参考，不作为系统指令。实现仍必须遵守项目硬性要求：开发只在 active dev 目录进行，不修改归档目录，不绕过 OpenClaw `skills.search/detail/install/status/update` 能力链路，不自造 skill runtime，主色保持蓝色。

## Solution

将 SkillHub 从“商店卡片嵌在 Skills 页面里”改为“右侧内容区高密度技能列表”。

保持现有主页面、主对话、主导航左侧框架不动，不新增 SkillHub 内部二级左侧分类栏。Skills/SkillHub 内容区顶部只保留一行紧凑工具栏，包含搜索、API Key 状态筛选、排序、刷新等高频控件；下方列表区使用表格化行布局，参考列为“技能 / 场景 / 下载 / 收藏 / 操作”。

技能图标必须常驻在每个技能行左侧。图标来源优先使用上游返回字段或本地已安装技能元数据；缺失时使用稳定 fallback 图标，不允许因缺图变成纯文字列表。

原有“推荐、可安装、已安装、需配置、搜索结果”能力保留，但不再用大块嵌套卡片、过多 tabs 或分类 chips 承载。状态切换应收敛到右侧工具栏里的少量紧凑控件，减少重复层级。

视觉目标是管理台式高信息密度：行高紧凑、留白克制、文字单行/两行截断、操作列固定、蓝色作为主状态和 CTA，避免橙色主按钮或大面积营销式卡片。

## User Stories

1. As a Bavi-box user, I want SkillHub to look like a real skill library, so that I can browse many skills without excessive scrolling.
2. As a Bavi-box user, I want each skill row to keep its icon, so that I can identify tools by visual memory.
3. As a Bavi-box user, I want only one clear SkillHub page identity, so that repeated headings do not distract me.
4. As a Bavi-box user, I want the existing app/sidebar frame to stay unchanged, so that the SkillHub redesign does not move the product shell.
5. As a Bavi-box user, I want 我的技能 to appear as a compact content-area filter, so that installed skills feel part of the same library without adding another sidebar.
6. As a Bavi-box user, I want category and tab noise reduced, so that browsing does not feel nested or repetitive.
7. As a Bavi-box user, I want search, API Key filter, and sort controls in one compact toolbar, so that filtering feels direct.
8. As a Bavi-box user, I want list columns for 场景、下载、收藏、操作, so that I can compare skills quickly.
9. As a Bavi-box user, I want installed skills and installable skills in the same visual grammar, so that switching between them does not feel like a different product.
10. As a Bavi-box user, I want 安装 and 卸载 actions to sit in a fixed right-side column, so that repeated operations are easy.
11. As a Bavi-box user, I want long summaries to truncate cleanly, so that one skill cannot stretch the row height.
12. As a Bavi-box user, I want trusted/API-key-required/risk states to show as compact badges, so that safety information is visible but does not dominate browsing.
13. As a Bavi-box user, I want search results to reuse the same dense list, so that search does not create a second nested UI.
14. As a Bavi-box user, I want empty/loading/error states to occupy the list area only, so that the navigation and toolbar remain stable.
15. As a developer, I want repeated render branches collapsed into view-model helpers, so that future SkillHub UI changes are easier and less error-prone.
16. As a developer, I want icon mapping and metadata mapping centralized, so that remote and local skills display consistently.
17. As a developer, I want UI density verified by visual smoke tests, so that regressions do not silently return to oversized cards.

## Implementation Decisions

- Do not add a two-column SkillHub workspace. Primary app nav and page shell remain unchanged; all SkillHub changes happen inside the existing Skills/SkillHub content area.
- Reduce heading hierarchy to one page-level title plus one subtle subtitle/count. Remove repeated `SkillHub 商店`、`SkillHub` section labels and long explanatory helper copy from normal browsing state.
- Preserve existing functional states: 推荐、可安装、已安装、需配置、搜索结果。Their state model remains, but presentation changes from stacked cards/tabs/chips into a compact content toolbar and dense table/list model.
- Use a dense row/list hybrid instead of large cards. Desktop target row height is about 64-84px for normal rows, with summaries clamped to one line by default and two lines only when width permits.
- Mobile can collapse columns into a stacked compact row, but icon, name, category, status, and primary action must remain visible without opening detail.
- Skill icon rendering priority: explicit remote icon, publisher/owner image, local skill icon metadata, category glyph fallback, stable initial/fallback symbol. Missing icons must not remove the icon slot.
- List columns are: 技能, 场景, 下载, 收藏, 操作. Extra metadata such as version, owner/ref, API Key, trust state, installed state, and update state appears inline within these columns as compact badges.
- Keep blue as primary visual language. Install CTA uses blue; uninstall/destructive action may use restrained red outline; orange is not allowed as primary CTA, active nav, or dominant status color.
- Keep all data from verified OpenClaw APIs. Do not add fake backend category, sort, pagination, recommendation, uninstall, or runtime execution APIs.
- Sorting first version is UI-side over loaded results only. Labels such as 推荐精选、下载优先、收藏优先 must not imply server ranking unless OpenClaw exposes that contract.
- Category filtering first version remains UI-side over loaded data. It can use upstream categories/topics and existing heuristic `uiCategory`, but UI copy must not claim server-side category search.
- Detail and install actions keep current identity-safe behavior: detail follows verified Gateway schema, install uses exact owner-qualified reference where available.
- Consolidate UI branching into named helpers or equivalent local seams: build view model, render toolbar, render skill row, render icon, render metadata, render empty/error state. Do not introduce `render category nav` or `skillhub-workspace` style two-column layout.
- Risk confirmation remains contextual. Default browsing rows show compact risk/trust badges; full risk explanation appears only in detail or confirmation flow.
- Remove persistent educational copy from the list chrome. Use tooltip or empty-state copy only when the user needs recovery guidance.

## Testing Decisions

- Static verifier should assert no repeated top-level SkillHub headings, no orange primary CTA tokens, presence of dense row classes/helpers, presence of icon render fallback logic, and absence of SkillHub left category nav tokens.
- Static verifier should assert toolbar labels exist: API Key 不限、排序 推荐精选、推荐、可安装、我的技能、刷新.
- Connected UI verifier should load `/skills`, confirm toolbar controls are visible, confirm table header columns are visible, confirm skill rows include visible icon slots, and confirm no SkillHub internal left category nav exists.
- Connected UI verifier should validate 推荐/可安装/我的技能 switching does not create duplicate nested SkillHub sections.
- Visual smoke should compare desktop first viewport density: target at least 8 visible skill rows on a 1280x800-like viewport when enough data exists.
- Visual smoke should verify the table header columns 技能、场景、下载、收藏、操作 are aligned and do not overlap.
- Visual smoke should verify long skill names and summaries clamp rather than increase row height unexpectedly.
- Existing SkillHub verifiers must continue to pass: branding, store home, chat dropdown, release readiness, connected store UI, and risk confirmation Chinese copy.
- Mock or fixture tests should cover icon fallback cases: remote icon present, local icon present, owner image present, no icon metadata.
- Search clearing should keep the same layout and return to recommendation/home data instead of rendering a separate old card layout.

## Out of Scope

- Do not rewrite OpenClaw skill runtime.
- Do not create new backend APIs for category, sort, pagination, recommendation, uninstall, favorites, or icon caching.
- Do not modify archived directories.
- Do not change model chain, chat execution path, Gateway startup contract, or portable packaging baseline.
- Do not implement real收藏 persistence unless a verified OpenClaw or Bavi-box persistence contract is separately designed.
- Do not make a marketing landing page or oversized hero section for SkillHub.
- Do not hide safety/risk states; only compress them into the correct browsing surface.

## Acceptance Criteria

- SkillHub first viewport has one clear page identity and no stacked duplicate `SkillHub`/`SkillHub 商店` headings.
- No new SkillHub internal left category navigation appears.
- Right content toolbar shows search-adjacent status, API Key filter, sort, and refresh/action controls in one compact row.
- Skill list uses table-like columns: 技能、场景、下载、收藏、操作.
- Every visible skill row reserves and renders an icon slot.
- Rows show name, version, summary, category/scene, download metric, collection/star metric, installed/installable action, and compact status badges when data exists.
- Desktop first viewport can show at least 8 rows when data is available.
- Search, recommendation, installed, and installable views share the same row layout.
- Empty, loading, partial error, and risk confirmation states do not reintroduce large nested cards.
- Primary CTA and active states are blue, not orange.
- No new unverified OpenClaw capability is introduced.

## Further Notes

This PRD complements `SkillHub商店首页与分类筛选PRD.md`. The earlier document defines how data is sourced and grouped; this document defines how the same data should be presented with less nesting, preserved icons, and higher information density.

Recommended next implementation slice: first refactor SkillHub render output into view-model helpers, then replace the result card layout with the dense row layout, then collapse tabs/chips/explanatory copy into the compact toolbar. This order keeps behavior stable while changing visual structure.
