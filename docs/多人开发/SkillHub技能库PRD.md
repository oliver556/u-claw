# SkillHub 技能库 PRD

更新时间：2026-08-23

## Problem Statement

U-Claw 需要把 Skill 作为用户可理解、可选择、可安装、可启停的产品能力，而不是暴露 OpenClaw 底层 bundled skills、skill ID 或 runtime 细节。

当前约束是：用户侧 Skill 来源以 SkillHub 为准，但执行链路必须复用 OpenClaw 原版 skill runtime。若只迁 UI，会遗漏本地代理、安全校验、安装事务、runtime 读回、缓存/限流、权限确认、错误分类与异步状态，最终形成“看起来能点、实际不可用或不安全”的残缺功能。

## Solution

建设 U-Claw 技能库模块，包含“技能商城”和“我的技能”两个入口。

技能商城展示 SkillHub 在线目录，支持搜索、分类、排序、分页、详情、README 预览和安全安装。我的技能展示本地已安装 Skill，支持详情、导入 ZIP、启用、禁用、卸载和后续更新。

前端只访问本地 API / IPC。SkillHub API Key、远程下载、安全校验、安装事务和 OpenClaw runtime 读回都在桌面服务层完成。安装后的 Skill 必须进入 OpenClaw 可识别的 skill 安装/绑定链路；无法被原版 runtime 识别的 SkillHub skill 标为 `Blocked`，不进入正式可用入口。

聊天页 Skill 下拉作为快捷配置入口，不是新 runtime。第一版语义为：用户选择 Skill 后，修改或复用当前会话对应 Agent 的 skills 配置；若当前 session 不能稳定即时生效，则自动创建/切换到带该 skill 的会话，或明确提示该 Skill 从新会话开始生效。

## User Stories

1. As a U-Claw user, I want to browse SkillHub skills in Chinese-friendly cards, so that I can understand what each skill does without knowing skill IDs.
2. As a U-Claw user, I want to search SkillHub skills with debounce, so that typing does not trigger excessive remote requests.
3. As a U-Claw user, I want to filter by Chinese category labels, so that I can find relevant skills quickly.
4. As a U-Claw user, I want category keys to remain compatible with SkillHub upstream, so that filtering returns accurate results.
5. As a U-Claw user, I want recommended sort by default, so that useful skills appear first.
6. As a U-Claw user, I want pagination with stable catalog identity, so that cached and live results do not mix into wrong installs.
7. As a U-Claw user, I want skill cards to show logo, name, version, description, category, downloads, stars and install state, so that I can compare options.
8. As a U-Claw user, I want missing logos to fall back gracefully, so that the marketplace still looks usable when SkillHub has no icon.
9. As a U-Claw user, I want to open a detail drawer from the card body, so that detail reading is easy on desktop.
10. As a U-Claw user, I want detail README rendered safely, so that I can inspect a skill before installing it.
11. As a U-Claw user, I want install actions to show immediate loading, so that I know my click was accepted.
12. As a U-Claw user, I want duplicate install/enable/disable clicks blocked, so that I do not create conflicting operations.
13. As a U-Claw user, I want install progress shown as queued/running/succeeded/failed, so that long operations are understandable.
14. As a U-Claw user, I want failed operations to show precise domain errors, so that I know whether retry, re-confirmation or upstream wait is needed.
15. As a U-Claw user, I want high-risk skills to require explicit permission confirmation, so that risky local access is intentional.
16. As a U-Claw user, I want re-enabling a high-risk skill to ask again, so that old consent is not reused silently.
17. As a U-Claw user, I want installed skills to appear in “我的技能”, so that I can manage local capabilities.
18. As a U-Claw user, I want to enable and disable installed skills, so that I can control what OpenClaw loads.
19. As a U-Claw user, I want to uninstall workspace-installed skills, so that I can clean up local capabilities.
20. As a U-Claw user, I want bundled OpenClaw skills hidden from user-facing marketplace and dropdowns, so that choices stay U-Claw curated.
21. As a U-Claw runtime maintainer, I want bundled skills preserved underneath, so that OpenClaw dependencies are not broken by UI filtering.
22. As a U-Claw user, I want to import a local Skill ZIP, so that I can install skills outside the online catalog when supported.
23. As a U-Claw user, I want interrupted installs recovered after restart, so that local skill state is not left half-written.
24. As a U-Claw user, I want stale cached marketplace data only when upstream is transiently unavailable, so that offline use is possible but unsafe drift is not hidden.
25. As a U-Claw user, I want identity conflicts, paid drift and invalid payloads to fail closed, so that I do not install the wrong skill.
26. As a chat user, I want a Skill dropdown near model selection, so that model and skill feel like conversation runtime choices.
27. As a chat user, I want the dropdown to show readable skill names, categories and purposes, so that I do not need to memorize file names.
28. As a chat user, I want selecting a Skill to bind through Agent skills configuration, so that OpenClaw runtime remains the execution authority.
29. As a chat user, I want clear messaging when a Skill only applies to a new session, so that I understand why current chat behavior does not change immediately.
30. As a developer, I want SkillHub integration to use local service contracts, so that frontend, desktop service and runtime can be tested independently.

## Implementation Decisions

- User-facing skill source is SkillHub. OpenClaw bundled skills may remain installed for runtime dependency safety, but must not appear in U-Claw marketplace or user-facing dropdowns.
- Do not implement a custom skill executor. All installed or selected skills must resolve through OpenClaw-recognized skill installation and Agent skills binding.
- Split the module into four stable layers: frontend skill experience, shared capability contracts, desktop SkillHub service, and OpenClaw runtime adapter.
- Frontend calls only local API / IPC. Remote SkillHub access, API Key handling, downloads, cache, validation and install transactions stay in desktop service.
- Marketplace defaults: 40 items per page, recommended sort, 300ms search debounce, category/sort changes reset pagination and show replacement loading.
- Skill detail display may trust SkillHub API identity for presentation, but installation must revalidate downloaded bundle identity, permissions, ZIP manifest and hashes.
- Installation confirmation binds to `namespace + slug + version + identityFingerprint + permissionFingerprint`; checkbox-only confirmation is invalid.
- Same slug across multiple namespaces must remain distinguishable through exact tuple identity. Cached detail must never install a sibling skill.
- `SKILL.md name`, catalog slug and runtime id may differ. Runtime readback must use local scan alias data and accept only workspace source, not bundled or managed namesakes.
- ZIP validation must reject path traversal, Windows reserved names, duplicate paths, symlinks, excessive file count, excessive file size, excessive total size and sha256 mismatch.
- Root `_meta.json` may be treated as upstream transport metadata if it drifts, but ordinary files must keep strict size/hash validation.
- Cache strategy: marketplace cache by query/category/sort/page/cursor, README cache by namespace/slug/version, detail cache by identity fingerprint.
- Stale fallback is allowed only for transient upstream failure such as timeout, 429, 5xx or network error. Identity conflict, paid drift and invalid payload must fail closed.
- Upstream 429 handling must honor `Retry-After`, apply bounded backoff and dedupe concurrent identical requests.
- All modifying operations use `SkillOperation` with queued/running/succeeded/failed states, phase, progress and domain error.
- Install/update/uninstall/enable/disable must use transaction journal and startup recovery.
- File mutation uses staging, backup, replace and verify. State mutation uses atomic JSON writes.
- OpenClaw `skills.update` / `skills.status` readback may be stale briefly; use bounded polling before declaring failure.
- Update preserves original enabled state. Uninstall removes only workspace content and must not remove bundled namesakes.
- Chat Skill dropdown first version modifies/reuses Agent skills configuration via OpenClaw config path. If immediate session refresh is unstable, apply from a new session or clearly inform user.
- UI uses design-system controls for Switch/Input/Select/Button. Skill CSS must not target third-party component internals broadly.

## Testing Decisions

- Test external behavior at layer boundaries: frontend interaction, shared capability schema, desktop SkillHub service, install transaction service and OpenClaw runtime adapter.
- Frontend tests cover marketplace search debounce, replacement loading, stale-result suppression, card/detail interactions, action loading, duplicate-submit blocking, domain error display, empty state, independent scroll area and high-risk confirmation.
- Shared contract tests cover catalog/detail/operation schemas, identity fingerprint requirements, permission fingerprint requirements, trusted logo host rules and fail-closed invalid payloads.
- SkillHub service tests cover search parameter mapping, category/sort mapping, typed failures, transient stale fallback, 429 backoff, request dedupe, README/detail cache isolation and same-slug namespace handling.
- Bundle validator tests cover YAML block scalar parsing, bad record isolation, path/hash/size/symlink/reserved-name rejection and `_meta.json` transport drift.
- Skill service tests cover install transaction journal, restart recovery, staging/backup/replace/verify flow, update enabled-state preservation and uninstall workspace-only behavior.
- Runtime adapter tests cover slug/runtimeName/directoryKey alias readback, bundled namesake rejection, `skills.update` bounded polling and stale status handling.
- Chat dropdown tests cover displaying only U-Claw SkillHub skills, excluding bundled skills, binding through Agent skills config and messaging when new session is required.
- Visual/manual acceptance must cover: marketplace default load, search/filter/sort/page, detail README, install confirmation, install progress, installed list refresh, enable/disable, high-risk re-enable and restart recovery.

## Out of Scope

- Rewriting OpenClaw skill runtime.
- Creating an independent chat-level skill runtime.
- Showing OpenClaw bundled skills as user-facing marketplace options.
- Deleting bundled skills from runtime directories merely to hide them from UI.
- Building functionality for SkillHub skills that OpenClaw cannot read or bind; those remain `Blocked`.
- Implementing fake UI states that imply unavailable skills are usable.
- Changing model chain, Gateway startup, packaging baseline or portable data logic as part of this PRD.
- Implementing WeChat capability.
- Supporting non-SkillHub skill marketplaces unless they pass the same runtime and security boundaries.

## Acceptance Criteria

- 技能商城只请求本地 API / IPC，不暴露 SkillHub API Key。
- 默认加载 40 条，推荐排序；搜索 300ms debounce。
- 分类中文展示，请求仍使用 SkillHub 原始 key。
- 分类/排序切换有 replacement loading，旧响应不会覆盖新结果。
- 分页不会混合 cached/live identity。
- 技能卡展示完整核心信息；图标缺失有 fallback。
- 结果区独立滚动，空态无大顶部空洞。
- 详情抽屉可展示安全 Markdown README。
- 合法 YAML block scalar 不导致详情失败；坏 search record 不拖垮整页，全坏页 fail closed。
- 安装前校验 identity、permission fingerprint、ZIP 文件清单与 hash。
- 同 slug 多 namespace 不会装错。
- `SKILL.md name` 与商城 slug 不同时，安装 readback 仍正确。
- 安装、更新、导入 ZIP、启用、禁用、卸载都有 start loading，并防重复提交。
- 操作进入 running 后显示 operation progress。
- 操作失败显示可理解的 domain error。
- 高风险 Skill 安装与重新启用必须确认权限。
- OpenClaw `skills.update` 后有 bounded polling readback。
- 离线、429、5xx 等 transient 场景可显示 stale cache，并明确标记。
- identity conflict、paid drift、invalid payload 不使用 stale cache 掩盖。
- 重启后可恢复 queued/running 安装任务或事务。
- 用户侧 Skill 下拉只展示 U-Claw 筛选后的 SkillHub skills，不展示 bundled skills。
- Skill 下拉通过 Agent skills 配置绑定；不能绕过 OpenClaw runtime。
- 若 Skill 需新会话生效，UI 必须明确提示或自动创建/切换对应会话。

## Further Notes

本 PRD 以 `docs/多人开发/开发硬性要求.md` 第 17 点为产品和技术边界，以 `docs/技能库模块迁移复盘与实现指南.md` 为实现流程、风险清单和验收依据。

实现前必须先完成 SkillHub 与 OpenClaw skill 包格式审计，包括：SkillHub skill 包结构、OpenClaw skill 包结构、`SKILL.md` / metadata / install steps / env key / tool requirements、安装目录、Agent skills 引用方式和启停方式。

权威调用方式优先参考 OpenClaw 原版 Agents 页面已有逻辑：修改 Agent skills 配置并保存，而不是发明新的 chat-level skill 系统。
