# P2 第二阶段 39 项唯一归属与证据映射

> 输入基线：`codex/integration-p2-t10-local@1e19eab509886ed6caf000c07d08045a481a6ba8`。本表只判定代码与自动化完成；真实 Windows、物理 U 盘、真实账号和外部服务验收统一归属 `P3-T08`，不标记为已通过。

| # | 需求 | 唯一归属 | 代码证据 | 自动化证据 | 代码完成 | `P3-T08` 延期 |
|---:|---|---|---|---|---|---|
| 1 | `CHAT-003` 会话搜索、固定与分组 | `P2-T01` | `product/frontend/src/features/sessions/SessionSidebar.tsx:56` | `product/frontend/tests/SessionOrganizer.test.tsx:32` | 是 | 真实 OpenClaw 会话、物理 U 盘换机 |
| 2 | `CHAT-013` 全局任务活动中心 | `P2-T02` | `product/frontend/src/features/activity/TaskActivityCenter.tsx:58` | `product/desktop/tests/task-snapshot.test.ts:55` | 是 | 真实任务、工具和审批事件 |
| 3 | `CHAT-014` 成果文件页签 | `P2-T02` | `product/frontend/src/features/context/ContextTabs.tsx:185` | `product/frontend/tests/ContextTabs.test.tsx:79` | 是 | 真实成果文件与来源会话 |
| 4 | `MODEL-001` 多 Provider 管理 | `P2-T03` | `product/frontend/src/features/providers/ProviderSettings.tsx:254` | `product/desktop/tests/provider-store.test.ts:50` | 是 | 真实 Provider |
| 5 | `MODEL-002` API Key 管理 | `P2-T03` | `product/desktop/src/providers/provider-store.ts:200` | `product/desktop/tests/provider-store.test.ts:97` | 是 | 真实凭据写入、轮换和脱敏 |
| 6 | `MODEL-003` OpenAI-compatible 自定义服务 | `P2-T03` | `product/frontend/src/features/providers/ProviderSettings.tsx:274` | `product/tests/e2e/providers.spec.ts:49` | 是 | 真实自定义服务请求 |
| 7 | `MODEL-004` 本地模型发现 | `P2-T04` | `product/desktop/src/providers/provider-network.ts:173` | `product/desktop/tests/provider-network.test.ts:22` | 是 | Windows 上 Ollama/LM Studio |
| 8 | `MODEL-005` 模型连通测试 | `P2-T04` | `product/desktop/src/providers/provider-network.ts:205` | `product/desktop/tests/provider-network.test.ts:63` | 是 | 真实网络、认证和模型错误 |
| 9 | `MODEL-006` 代理与 `NO_PROXY` | `P2-T04` | `product/desktop/src/providers/provider-network.ts:219` | `product/desktop/tests/provider-network.test.ts:138` | 是 | 真实内外网和代理环境 |
| 10 | `CAP-001` 已安装技能列表 | `P2-T05` | `product/frontend/src/features/skills/SkillManager.tsx:120` | `product/desktop/tests/skill-service.test.ts:223` | 是 | 真实 OpenClaw 与 U 盘技能目录 |
| 11 | `CAP-002` 技能搜索与目录 | `P2-T05` | `product/desktop/src/skills/skillhub-client.ts:205` | `product/desktop/tests/skillhub-client.test.ts:60` | 是 | SkillHub.cn 真实免费 Skill 数据 |
| 12 | `CAP-003` 技能安装、更新和卸载 | `P2-T05` | `product/frontend/src/features/skills/SkillManager.tsx:138` | `product/desktop/tests/skill-service.test.ts:144` | 是 | 真实 SkillHub、OpenClaw 和物理 U 盘 |
| 13 | `CAP-004` 技能启用和禁用 | `P2-T05` | `product/frontend/src/features/skills/SkillManager.tsx:140` | `product/desktop/tests/skill-service.test.ts:223` | 是 | 真实 OpenClaw 调用行为 |
| 14 | `CAP-005` 插件管理 | `P2-T06` | `product/frontend/src/features/plugins/PluginManager.tsx:93` | `product/desktop/tests/plugin-service.test.ts:55` | 是 | 真实插件包和 OpenClaw 生命周期 |
| 15 | `CAP-006` MCP 服务器管理 | `P2-T07` | `product/adapter/src/openclaw-client.ts:574` | `product/adapter/tests/openclaw-client.test.ts:1418` | 是 | 真实 MCP 服务与工具暴露 |
| 16 | `CAP-007` 能力权限与风险提示 | `P2-T05` | `product/frontend/src/features/skills/SkillManager.tsx:150` | `product/desktop/tests/skill-service.test.ts:83` | 是 | 真实高风险能力确认流程 |
| 17 | `CONN-001` Telegram | `P2-T08` | `product/frontend/src/features/channels/ChannelSettings.tsx:69` | `product/tests/e2e/channels.spec.ts:74` | 是 | 真实 Bot 凭据、连接和消息收发 |
| 18 | `CONN-002` QQ Bot | `P2-T08` | `product/frontend/src/features/channels/ChannelSettings.tsx:70` | `product/tests/e2e/channels.spec.ts:82` | 是 | 真实 Bot、插件和消息收发 |
| 19 | `CONN-003` 飞书 | `P2-T08` | `product/frontend/src/features/channels/ChannelSettings.tsx:71` | `product/frontend/tests/ChannelSettings.test.tsx:195` | 是 | 真实应用凭据、回调和消息收发 |
| 20 | `CONN-004` 企业微信 | `P2-T08` | `product/frontend/src/features/channels/ChannelSettings.tsx:71` | `product/frontend/tests/ChannelSettings.test.tsx:195` | 是 | 真实应用凭据、回调和消息收发 |
| 21 | `CONN-005` 个人微信扫码登录 | `P2-T09` | `product/desktop/src/channels/wechat-login-coordinator.ts:202` | `product/tests/e2e/channels.spec.ts:149` | 是 | Windows 微信客户端和真实账号 |
| 22 | `CONN-006` 渠道统一状态 | `P2-T08` | `product/frontend/src/features/channels/ChannelSettings.tsx:203` | `product/frontend/tests/ChannelSettings.test.tsx:73` | 是 | 全部真实渠道联合验收 |
| 23 | `DATA-001` 工作区文件管理 | `P2-T10` | `product/desktop/src/data/data-service.ts:446` | `product/desktop/tests/data-service.test.ts:91` | 是 | 真实 Windows shell、外部替换攻击和物理 U 盘 |
| 24 | `DATA-002` 记忆查看与管理 | `P2-T10` | `product/desktop/src/data/data-service.ts:513` | `product/desktop/tests/data-service.test.ts:244` | 是 | 真实 OpenClaw 读回和物理 U 盘 |
| 25 | `DATA-007` 备份与恢复 | `P2-T11` | `product/desktop/src/data/maintenance-service.ts:531` | `product/desktop/tests/maintenance-service.test.ts:155` | 是 | 真实 OpenClaw 一致性、恢复回滚和物理 U 盘 |
| 26 | `DATA-008` 存储空间统计与清理 | `P2-T11` | `product/desktop/src/data/maintenance-service.ts:672` | `product/desktop/tests/maintenance-service.test.ts:254` | 是 | 真实 Windows 路径、文件占用和物理 U 盘 |
| 27 | `OPS-001` 运行日志查看 | `P2-T12` | `product/frontend/src/features/system/SystemDiagnostics.tsx:252` | `product/frontend/tests/SystemDiagnostics.test.tsx:21` | 是 | 真实长时间运行日志 |
| 28 | `OPS-002` 日志导出与清理 | `P2-T12` | `product/frontend/src/features/system/SystemDiagnostics.tsx:176` | `product/frontend/tests/SystemDiagnostics.test.tsx:41` | 是 | 真实日志、文件占用和脱敏抽查 |
| 29 | `OPS-003` OpenClaw Doctor | `P2-T13` | `product/desktop/src/main.ts:470` | `product/desktop/tests/diagnostics-service.test.ts:352` | 是 | 真实锁定 runtime Doctor 与授权 repair |
| 30 | `OPS-004` 内网/离线诊断 | `P2-T13` | `product/frontend/src/features/system/SystemDiagnostics.tsx:256` | `product/desktop/tests/diagnostics-service.test.ts:251` | 是 | 真实 DNS、代理、端口、认证和模型环境 |
| 31 | `OPS-005` 系统信息 | `P2-T12` | `product/frontend/src/features/system/SystemDiagnostics.tsx:228` | `product/frontend/tests/SystemDiagnostics.test.tsx:64` | 是 | Windows 真机信息准确性 |
| 32 | `OPS-007` 恢复出厂 | `P2-T13` | `product/desktop/src/data/maintenance-service.ts:788` | `product/desktop/tests/main.test.ts:24` | 是 | 真实 OpenClaw 停写、恢复回滚和 Windows 文件占用 |
| 33 | `OPS-009` 查看原始配置 | `P2-T12` | `product/frontend/src/features/system/SystemDiagnostics.tsx:257` | `product/desktop/tests/diagnostics-service.test.ts:58` | 是 | 真实配置与脱敏导出 |
| 34 | `REL-001` 更新检查 | `P2-T14` | `product/desktop/src/release/release-dispatcher.ts:9` | `product/desktop/tests/release-service.test.ts:79` | 是 | HTTPS production feed |
| 35 | `REL-003` 安全更新、校验和回滚 | `P2-T14` | `product/desktop/src/release/release-service.ts:252` | `product/desktop/tests/release-service.test.ts:152` | 是 | Windows 路径防替换、真实断电和回滚 |
| 36 | `REL-006` CLI/Doctor 快捷入口 | `P2-T14` | `product/frontend/src/features/system/ReleaseCenter.tsx:52` | `product/frontend/tests/ReleaseCenter.test.tsx:78` | 是，批准不迁移 | 无；批准“不迁移”已验收 |
| 37 | `REL-007` 卸载 | `P2-T14` | `product/desktop/src/release/release-service.ts:307` | `product/desktop/tests/release-service.test.ts:239` | 是 | Windows 本机缓存、文件锁和安装/卸载行为 |
| 38 | `SEC-004` runtime 数字签名 | `P2-T14` | `product/desktop/src/release/release-service.ts:110` | `product/desktop/tests/release-service.test.ts:143` | 是 | 正式证书、真实 feed 和 Windows 原生防替换 |
| 39 | `UX-008` Ant Design 暗色主题 | `P2-T15` | `product/frontend/src/theme/tokens.ts:111` | `product/tests/e2e/theme.spec.ts:72` | 是 | Win10/11、缩放和无白闪视觉验收 |

结论：`39/39` 需求各有且仅有一个功能 Task 归属；`P2-T16` 只负责会合，不重复功能归属。`39/39` 已有代码/自动化证据或批准“不迁移”证据。`38/39` 保留 `P3-T08` 真实环境验收，`REL-006` 除外。
