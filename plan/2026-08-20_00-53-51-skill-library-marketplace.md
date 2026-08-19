# 技能库商城首切片实施计划

### Goal
基于 ZUXO 技能库行为，在现有 U-Claw Skill IPC 上交付“技能商城 + 我的技能”用户闭环。

### Scope
- 用户可见 `SkillManager publicView` 增加商城与已安装双视图。
- 复用 `skills.search/detail/install/operation/installed/runtime-status`。
- 支持 300ms 搜索、防重复分页、分类、API Key、排序、详情、安全 Markdown、异步安装。
- 保留导入 ZIP、启用/禁用、运行状态与本地详情。

### Plan
- [x] 对照外部文档与现有实现
- [x] TDD：商城首屏与筛选
- [x] TDD：详情抽屉与异步安装
- [x] 响应式样式与桌面视觉验证
- [x] 测试、typecheck、build、review、commit

### Deferred
- 图片本地 cache。

### Delivered beyond first slice
- 搜索 cache 30 分钟，详情/README cache 24 小时；跨重启持久化、请求去重、stale fallback。
- 429 `Retry-After` 与指数退避，单次等待封顶 30 秒。
- cache 容量上限：搜索 200 条、详情 500 条。
- SkillHub loose metadata 安全投影 `ownerName/downloads/stars/requiresKey/updatedAt`，并透传受控排序。
- Marketplace README 禁止远程图片请求，避免 tracking pixel。

### Rollback
回退 `InstalledSkillWorkbench.tsx`、相关 CSS 与新增测试；IPC/backend 契约不变。
