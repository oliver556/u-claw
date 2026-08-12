# OpenClaw 2026.7.1-2 协议审计

## 1. 审计结论

U-Claw 新客户端可以不影响 OpenClaw Agent 和本地能力，但前端不应直接绑定 Dashboard 的 Lit 组件或构建产物。正式集成面是同一 Gateway 端口上的 WebSocket v4 协议和有文档的 HTTP API。

必须通过 U-Claw Adapter 隔离三类能力：

| 类型 | 结论 | U-Claw 策略 |
|---|---|---|
| 对外可用 | Gateway WS/RPC、`/health`、`/ready`、`/tools/invoke`、可选 `/v1/*` | Adapter 直接封装，锁定 OpenClaw 版本并做契约测试 |
| Dashboard 内部 | `controlUi.githubPreview`、Dashboard 本地偏好、Activity 内存投影、内置主题 | 不作为稳定产品契约；U-Claw 自行实现 |
| CLI-only | MCP 运行探测/重载、完整插件安装生命周期、部分 doctor/诊断导出 | Electron 主进程执行锁定 CLI，或后续为 Adapter 增加受控命令层 |

OpenClaw 官方文档明确说明：当前没有可公开安装的 npm 客户端包。U-Claw 不应虚构 `openclaw-client` 依赖，应在 `product/adapter` 内实现最小 WS 客户端。

## 2. 审计对象与可复现性

| 项目 | 值 |
|---|---|
| 仓库锁定版本 | `OPENCLAW_VERSION` = `2026.7.1-2` |
| npm 包 | `openclaw@2026.7.1-2` |
| npm tarball SHA-1 | `4583b987ea7277230ce1c7b2b8535d3e219f57ac` |
| 包内构建 commit | `0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c` |
| 构建时间 | `2026-07-18T03:40:23.395Z` |
| Node 要求 | `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0` |

审计时仓库内没有 `portable/app/core/node_modules/openclaw` 依赖实体。精确版本 tarball 仅下载到系统临时目录，未向仓库写入 `node_modules` 或 lockfile。

下文“包内证据”均相对于 `openclaw@2026.7.1-2` 包根目录。主要证据：

- `docs/gateway/protocol.md`：官方 WS 握手、帧、方法、事件和版本规则。
- `docs/gateway/external-apps.md`：外部应用官方集成路径及“暂无公开 npm client”警告。
- `dist/schema-BuOFpc7K.js`：发布包中的 TypeBox 协议 schema。
- `dist/server-methods-NpEcZnvp.js`：核心 Gateway handler 注册表。
- `dist/server-aux-methods-oZh-aSQp.js`：审批和 secrets 辅助 RPC。
- `dist/server-methods-list-L_OppjbT.js`：广播事件目录。
- `dist/control-ui/assets/gateway-CWCQz7bR.js`：当前 Dashboard 的真实握手、重连和鉴权实现。

## 3. 网络入口

Gateway 在同一端口复用 HTTP 和 WebSocket，默认端口为 `18789`。

| 入口 | 状态 | 用途 | 证据 |
|---|---|---|---|
| `ws://127.0.0.1:18789` / `wss://...` | 始终核心 | Gateway JSON RPC + 事件 | `docs/gateway/protocol.md` |
| `GET /health`, `/healthz` | 始终可用 | 存活，返回 `status: "live"` | `dist/server.impl-qYPVZMND.js` |
| `GET /ready`, `/readyz` | 始终可用 | 启动就绪 | `dist/server.impl-qYPVZMND.js` |
| `POST /tools/invoke` | 始终可用 | 单工具直调，2 MB 默认 body 限制 | `docs/gateway/tools-invoke-http-api.md` |
| `POST /v1/chat/completions` | 默认关闭 | OpenAI Chat Completions 兼容 | `docs/gateway/openai-http-api.md` |
| `GET /v1/models[/id]` | 跟随 `/v1` 配置 | 列出 Agent target，不是原始 provider model | `docs/gateway/openai-http-api.md` |
| `POST /v1/embeddings` | 跟随 `/v1` 配置 | embedding | `docs/gateway/openai-http-api.md` |
| `POST /v1/responses` | 默认关闭 | OpenResponses，支持 SSE | `docs/gateway/openresponses-http-api.md` |
| `/control-ui-config.json` | Dashboard 内部 | Control UI 运行配置，同样受 Gateway auth 保护 | `docs/web/control-ui.md` |
| `/__openclaw__/assistant-media/...` | Dashboard 内部 | Assistant 媒体展示 | `dist/control-ui-CuoxgbYo.js` |
| `/api/chat/media/outgoing/...` | 内部媒体路由 | 受管输出图片 | `dist/server.impl-qYPVZMND.js` |

U-Claw 桌面客户端应以 WS/RPC 为主。`/v1/chat/completions` 不能替代 WS，因为它不覆盖会话管理、审批、渠道、配置和 Gateway 事件。

## 4. WebSocket 握手、鉴权和重连

### 4.1 帧格式

```json
{"type":"req","id":"...","method":"chat.send","params":{}}
{"type":"res","id":"...","ok":true,"payload":{}}
{"type":"event","event":"chat","payload":{},"seq":1,"stateVersion":1}
```

- 文本 WebSocket + JSON。
- 首个客户端请求必须是 `connect`。
- 副作用 RPC 需要幂等键。
- 连接前帧最大 64 KiB；连接后以 `hello-ok.policy.maxPayload` 和 `maxBufferedBytes` 为准。

### 4.2 握手序列

1. Gateway 发送 `connect.challenge`，包含 `nonce` 和 `ts`。
2. 客户端请求 `connect`，宣告 `minProtocol: 4`、`maxProtocol: 4`、client、role、scopes、auth 和 device 签名。
3. Gateway 返回 `hello-ok`，含 server、`features.methods/events`、snapshot、auth 和 policy。

Dashboard 的当前真实参数：

- `client.id = "openclaw-control-ui"`
- `client.mode = "webchat"`
- `role = "operator"`
- `caps = ["tool-events"]`
- 请求协议范围固定为 `4..4`
- 默认请求 scopes：`operator.admin/read/write/approvals/pairing`

U-Claw 应使用自己的 client id，例如 `u-claw-desktop`，不应伪装 Dashboard。

### 4.3 鉴权方式

| 方式 | WS connect 字段 | 备注 |
|---|---|---|
| Gateway token | `auth.token` | U-Claw 本机启动的主路径 |
| Gateway password | `auth.password` | Dashboard 不持久化 password |
| Device token | `auth.deviceToken` | 首次配对后由 `hello-ok.auth.deviceToken` 发放 |
| Tailscale Serve | 可依赖受信头 | 需 `gateway.auth.allowTailscale` |
| trusted proxy | 依赖代理注入身份 | 用于远程部署 |

Operator scope 闭集：`operator.read`、`operator.write`、`operator.admin`、`operator.approvals`、`operator.pairing`、`operator.talk.secrets`。`config.*`、`exec.approvals.*`、`wizard.*`、`update.*` 保留为 admin 方法族。

本地 loopback Dashboard 可自动通过设备配对；LAN/远程浏览器通常需要一次性审批。U-Claw 仍应保留 device identity，不要依赖“loopback 永远放行”作为安全设计。

### 4.4 重连

Dashboard 当前实现：

- 基础退避 800 ms，每次乘 1.7，上限 15 s。
- 连接打开后等待 challenge；750 ms 未收到则执行兼容性 connect fallback。
- `startup-sidecars` 返回可重试 `UNAVAILABLE` 时，使用 `retryAfterMs`（限制在 100..2000 ms）。
- auth 缺失/错误、协议不匹配、配对待批等错误会暂停无意义的自动重连。
- 事件 `seq` 出现缺口时会通知 gap。协议没有通用“从 seq 补发”方法，Adapter 必须重拉 session/history/status 状态。

### 4.5 广播事件目录

`dist/server-methods-list-L_OppjbT.js` 注册的核心事件为：

`connect.challenge`、`agent`、`chat`、`session.message`、`session.operation`、`session.tool`、`sessions.changed`、`presence`、`tick`、`talk.mode`、`talk.event`、`shutdown`、`health`、`heartbeat`、`cron`、`task`、`node.pair.requested`、`node.pair.resolved`、`node.invoke.request`、`device.pair.requested`、`device.pair.resolved`、`voicewake.changed`、`voicewake.routing.changed`、`exec.approval.requested`、`exec.approval.resolved`、`plugin.approval.requested`、`plugin.approval.resolved`、`terminal.data`、`terminal.exit`、`update.available`。

客户端不应因收到未识别事件而断开。应忽略未支持事件并记录去敏诊断，同时用 `hello-ok.features.events` 完成能力检测。

## 5. 会话、消息和流式事件

### 5.1 对话主链路

| 需求 | RPC / 事件 | 稳定性 |
|---|---|---|
| 加载可见历史 | `chat.history` | 外部可用，UI 展示归一化投影 |
| 取单条完整消息 | `chat.message.get` | 外部可用，有 2,000,000 字符上限 |
| 发送 | `chat.send` | 外部可用，必须幂等 |
| 取消 | `chat.abort` | 外部可用，可指定 `runId` |
| 注入合成消息 | `chat.inject` | 外部可用，不应用于正常用户发送 |
| 流式文本 | `chat` event | 外部可用 |
| 订阅会话变更 | `sessions.subscribe/unsubscribe` | 外部可用 |
| 订阅单会话消息 | `sessions.messages.subscribe/unsubscribe` | 外部可用 |
| 消息/操作/工具流 | `session.message/operation/tool` | 外部可用，需订阅 |

`chat.send` 的发布 schema：

```ts
{
  sessionKey: string;
  agentId?: string;
  sessionId?: string;
  message: string;
  thinking?: string;
  fastMode?: boolean | "auto";
  fastAutoOnSeconds?: number;
  deliver?: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  originatingAccountId?: string;
  originatingThreadId?: string;
  attachments?: unknown[];
  timeoutMs?: number;
  suppressCommandInterpretation?: boolean;
  expectedSessionRoutingContract?: string;
  idempotencyKey: string;
}
```

返回接受的 `runId` 和 status。Adapter 应使用 UUID 作为 `idempotencyKey`，并以服务器返回的 `runId` 为最终值。

### 5.2 `chat` 事件状态机

| `state` | 关键字段 | 客户端处理 |
|---|---|---|
| `delta` | `runId`, `sessionKey`, `seq`, `deltaText`, `replace?`, `message?`, `usage?` | `replace=true` 时替换当前文本，否则追加 `deltaText` |
| `final` | `message?`, `usage?`, `stopReason?` | 结束流式并刷新会话索引 |
| `aborted` | `errorMessage?`, `stopReason?` | 显示已取消，不当成系统故障 |
| `error` | `errorKind?`, `errorMessage?`, `usage?`, `stopReason?` | 区分 refusal/timeout/rate_limit/context_length/unknown |

`chat.history` 不是原始 transcript：它会删除内联指令标签、工具 XML 泄漏、控制 token 和 `NO_REPLY`，过大行可被占位符代替。新 UI 应直接消费此投影，不要重新解析磁盘 transcript。

### 5.3 会话管理

Gateway 发布了完整 `sessions.*` 方法族：

`list`、`cleanup`、`subscribe`、`unsubscribe`、`messages.subscribe`、`messages.unsubscribe`、`preview`、`describe`、`resolve`、`create`、`send`、`steer`、`abort`、`patch`、`pluginPatch`、`reset`、`delete`、`get`、`compact`、`compaction.list/get/branch/restore`。

U-Claw 的“新会话、重命名、置顶、分组、归档、删除、模型覆盖、分叉和恢复”都应映射到这一方法族，而不是只保存在 React 本地状态。

## 6. 工具调用、授权和附件

### 6.1 工具事件

- `session.tool` 是新 UI 的主要工具流。
- Dashboard Activity 页仅是从 `session.tool` 派生的浏览器内存视图，不是新 endpoint、持久审计流或指标流。
- `audit.list` 可提供 30 天、最多 100,000 条的 metadata-only 账本，但不保存 prompt、tool args、tool result 或原始错误。
- `tools.catalog` 列出 core/plugin 工具；`tools.effective(sessionKey)` 返回最终策略下的 core/plugin/channel/MCP 工具投影。

### 6.2 Exec 和插件授权

| 流程 | 请求/事件 | 要求 |
|---|---|---|
| 待批执行 | `exec.approval.requested` | 只发给有 `operator.approvals` 的客户端 |
| 列出/取单条 | `exec.approval.list/get` | 用于断线后恢复待批卡片 |
| 决策 | `exec.approval.resolve` | 需 `operator.approvals` |
| 结果 | `exec.approval.resolved` | 清理待批 UI |
| 插件待批 | `plugin.approval.requested` | 与 exec 独立的审批族 |
| 插件决策 | `plugin.approval.resolve` | 不能误用 exec resolve |

Gateway 还公布 `waitDecision`、`request`和审批策略 `exec.approvals.get/set`、`exec.approvals.node.get/set`。Adapter 必须在重连后调用 list/get 恢复待批状态，不能只监听实时 event。

### 6.3 附件

`chat.send` 接受 `attachments?: unknown[]`，但发布的 Gateway schema 没有把元素形状固定为公开类型。这是当前协议的明显脆弱点。

Adapter v1 不应将 Dashboard 的附件对象直接泄漏给 React。应自定义稳定类型，并由针对 `2026.7.1-2` 的转换器输出 OpenClaw 形状：

```ts
type UClawAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  source: { kind: "bytes"; dataBase64: string } | { kind: "path"; path: string };
};
```

本地 `path` 不能直接从 renderer 发送；必须由 Electron IPC 检查路径和大小，读取为受控 bytes，再交给 Adapter。附件转换是必须先写契约测试的部分。

## 7. 功能域映射

| 功能域 | Gateway 可用面 | Dashboard 实际使用/限制 | U-Claw 实现结论 |
|---|---|---|---|
| Agent | `agent`, `agent.wait`, `agent.identity.get`, `agents.*` | 有 Agent 列表、身份、workspace 文件 | 直接接入 |
| Model | `models.list(view?)`, `models.authStatus/authLogout`, `sessions.patch` | picker 通常用 configured/default view；all 用于诊断 | 直接接入；Key 不进 renderer |
| Skill | `skills.status/search/detail/install/update/...` | Dashboard 支持库搜索、安装、更新、安全结论和 proposal | 直接接入；install/update 需 admin |
| Plugin | `plugins.uiDescriptors`, `plugins.sessionAction`, `plugin.approval.*`, `config.*` | 完整 install/search/update/uninstall/doctor 主要在 CLI | 展示和启停可走配置；完整生命周期走受控 CLI |
| MCP | `config.get/patch/apply`, `tools.effective` | MCP 页只管 `mcp.servers` 配置，不启动 transport；暖会话时可投影 MCP tools | 配置直连 RPC；`status --verbose`、`doctor --probe`、`reload` 为 CLI-only |
| Channel | `channels.status/start/stop/logout`, `web.login.start/wait`, `send`, `message.action`, `poll`, `config.*` | 账号配置由 config schema 驱动 | 直接接入；二维码登录需状态机 |
| Config | `config.get/schema/schema.lookup/set/patch/apply/openFile` | Dashboard 是 schema-driven form + raw editor | 必须绕过 renderer 秘密暴露；优先 patch |
| Logs | `logs.tail` | Dashboard 展示 JSONL tail | 直接接入；限制容量与自动跟随 |
| Diagnostics | `health`, `status`, `system.info`, `diagnostics.stability`, `audit.list` | 更完整 export/doctor 仍有 CLI 路径 | 常用视图直连；导出通过受控 CLI |
| Usage | `usage.status/cost`, `sessions.usage*` | Dashboard 有细分和时序 | 直接接入 |
| Task | `tasks.list/get/cancel`, `task` event | 后台 subagent/cron/CLI/ACP 任务 | 直接接入 |
| File/artifact | `agents.workspace.list/get`, `sessions.files.list/get`, `artifacts.list/get/download` | workspace RPC 仅读，限制在 realpath workspace root | 直接接入读取；写入只用明确 RPC/IPC |
| Update | `update.status/run` | admin 面，成功后可计划重启 | 后续接入，必须加 U-Claw 版本验证与回滚 |

### 7.1 MCP 特别说明

`tools.effective` 对 MCP 是只读投影：它可以返回暖会话中已发现的 MCP tool catalog，但不会创建 MCP runtime、连接 transport 或发出 `tools/list`。无暖缓存时可能返回 `mcp-not-yet-connected`、`mcp-not-yet-listed` 或 `mcp-stale-catalog`。

因此新 UI 的 MCP 状态必须分为：

1. 已配置/已启用：来自 `config.get`。
2. 已投影工具：来自 `tools.effective`。
3. 实时探测成功：只能由 `openclaw mcp doctor --probe` 等 CLI 结果证明。

三者不能在 UI 中合并成一个虚假的“已连接”标记。

## 8. 配置与秘密边界

`config.get` 在服务端调用 `redactConfigSnapshot`，`config.patch/apply` 的返回也使用 `redactConfigObject`。写入时会恢复原有被打码值，并用 base hash 防止并发覆盖。

U-Claw 必须遵守：

- renderer 只获取打码后配置和“是否已配置”状态。
- 新 Key 由受限 IPC 一次性传到 Electron/Adapter，不进 Redux/Pinia/localStorage/日志。
- 常规编辑用 `config.patch` + base hash，不默认全量 `config.apply`。
- 数组路径删除需显式 `replacePaths`确认，不能静默丢数据。
- 根据响应的 restart/reload plan 展示“已热更新”或“需重启”，不得猜测。

`/tools/invoke` 与 `/v1/*` 的 bearer token/password 代表完整 operator 信任，不是细粒度多用户 token。这些 HTTP 入口只应绑定 loopback/tailnet/private ingress。

## 9. Adapter v1 建议契约

### 9.1 必须首批实现

1. `connect/disconnect/reconnect`：握手 v4、device identity、token/password、scope、退避和 gap 恢复。
2. `chat`：history/send/abort/message.get + `chat` event 状态机。
3. `sessions`：list/create/patch/reset/delete/compact/subscribe/messages.subscribe。
4. `tools`：`session.tool`、catalog/effective，工具结果展示。
5. `approvals`：exec/plugin list/get/resolve + requested/resolved 事件。
6. `models/agents`：models.list/authStatus、agents.list/identity、session model patch。
7. `config`：get/schema/lookup/patch，严格打码。
8. `status`：health/status/system.info/channels.status/logs.tail。

### 9.2 第二批可并行实现

- skills 全生命周期。
- channels 启停、logout、login 和消息 action。
- MCP 配置 + 受控 CLI 诊断。
- plugin 展示/审批 + 受控 CLI 生命周期。
- tasks、artifacts、workspace files、usage、cron、diagnostics、update。

### 9.3 不应复制的 Dashboard 实现

- Lit 页面组件和构建 hash 文件名。
- `controlUi.githubPreview`。
- 浏览器本地主题、字号、侧栏固定项和 Activity 内存存储。
- Dashboard 中没有写入 Gateway 的个人头像覆盖等本地偏好。
- 任意 raw RPC 调试面板。正式产品 UI 只暴露 Adapter 允许的方法。

## 10. 必须的契约测试

| 测试 | 通过标准 |
|---|---|
| 握手 | challenge 签名、v4 connect、hello-ok 解析通过 |
| 鉴权错误 | token/password/device/pairing/protocol 错误均映射为明确状态，不死循环 |
| 启动中 | `startup-sidecars` 按 `retryAfterMs` 重试 |
| 流式文本 | delta 追加、replace 替换、final/error/aborted 收敛正确 |
| 重复发送 | 相同 idempotency key 不产生两次用户操作 |
| 取消 | 指定 runId 取消且收到 aborted/final 终态 |
| seq gap | 触发 history/session/status 重拉，不继续伪装完整流 |
| 工具事件 | running/done/error 和多工具并发正确 |
| 断线审批 | 重连后 list/get 恢复待批项，resolve 使用正确审批族 |
| 附件 | 图片、文本、过大文件、非法路径和不支持 MIME 均有实测 |
| 配置并发 | base hash 过期时拒绝覆盖并重拉 |
| 秘密 | 响应、renderer state、日志和错误中无明文 Key |
| MCP | 区分 configured/projected/probed，不虚报 connected |

## 11. 升级策略

OpenClaw 当前提供的是“可用且有文档的外部 Gateway 协议”，但不是已发布独立 client SDK 的强语义版本化 API。官方建议也是锁定已测版本，升级时重新检查 RPC 参考。

U-Claw 每次升级必须：

1. 只更改 `OPENCLAW_VERSION` 锁定值，不使用 `latest` 直接进入正式包。
2. 对比 `features.methods/events`、协议版本、schema 和 Dashboard 实际请求。
3. 运行本文第 10 节的 Adapter 契约测试。
4. 在 Windows U 盘真实路径上验证文件、工具、授权、重连和数据落盘。
5. 通过后才更新产品内置版本，并保留上一版 runtime 回滚能力。

## 12. 发布包核心 RPC 目录

下表来自 `dist/server-methods-NpEcZnvp.js` 的核心 handler 注册和 `dist/server-aux-methods-oZh-aSQp.js` 的辅助方法。它用于防止功能盘点漏项，不代表一个具体连接必然有权调用所有方法。运行时仍必须以 `hello-ok.features.methods`、operator scope、role 和动态插件/渠道注册为准。`device.pair.setupCode` 存在 handler，但官方文档明确说它会故意从 advertised discovery 中省略。

| 域 | 核心方法 |
|---|---|
| 连接/附着 | `connect`; `attach.grant`, `attach.revoke` |
| 健康/系统 | `health`, `status`; `gateway.identity.get`, `last-heartbeat`, `set-heartbeats`, `system-presence`, `system.info`, `system-event` |
| Chat | `chat.history`, `chat.startup`, `chat.metadata`, `chat.message.get`, `chat.abort`, `chat.send`, `chat.inject` |
| Sessions | `sessions.list`, `cleanup`, `subscribe`, `unsubscribe`, `messages.subscribe`, `messages.unsubscribe`, `preview`, `describe`, `resolve`, `create`, `send`, `steer`, `abort`, `patch`, `pluginPatch`, `reset`, `delete`, `get`, `compact`; `sessions.compaction.list/get/branch/restore` |
| Session 文件 | `sessions.files.list`, `sessions.files.get` |
| Agent | `agent`, `agent.identity.get`, `agent.wait`; `agents.list/create/update/delete`; `agents.files.list/get/set`; `agents.workspace.list/get` |
| Model | `models.list`, `models.authLogout`, `models.authStatus` |
| 工具/命令 | `commands.list`, `tools.catalog`, `tools.effective`, `tools.invoke` |
| Skill | `skills.upload.begin/chunk/commit`, `skills.status`, `skills.bins`, `skills.search`, `skills.detail`, `skills.securityVerdicts`, `skills.skillCard`, `skills.install`, `skills.update`, `skills.curator.status/pin/unpin/restore`, `skills.proposals.list/inspect/create/update/revise/requestRevision/apply/reject/quarantine` |
| 配置/向导 | `config.get/schema/schema.lookup/set/patch/apply/openFile`; `wizard.start/next/cancel/status` |
| 渠道/发送 | `channels.status/start/stop/logout`; `web.login.start/wait`; `message.action`, `send`, `poll` |
| 定时任务 | `wake`; `cron.list/status/get/add/update/remove/run/runs` |
| 后台任务 | `tasks.list`, `tasks.get`, `tasks.cancel` |
| 审批策略 | `exec.approvals.get/set`, `exec.approvals.node.get/set` |
| Exec 审批辅助 | `exec.approval.get/list/request/waitDecision/resolve` |
| Plugin 审批辅助 | `plugin.approval.list/request/waitDecision/resolve` |
| Plugin UI/Hook | `plugins.uiDescriptors`, `plugins.sessionAction`, `nativeHook.invoke` |
| Secret 辅助 | `secrets.reload`, `secrets.resolve` |
| 设备配对 | `device.pair.list/approve/reject/remove/setupCode`, `device.token.rotate/revoke` |
| Node | `node.pair.request/list/approve/reject/remove/verify`, `node.rename/list/describe`, `node.pluginSurface.refresh`, `node.pending.pull/ack/drain/enqueue`, `node.invoke`, `node.invoke.result`, `node.event` |
| 日志/诊断/审计 | `logs.tail`, `diagnostics.stability`, `audit.list`; `doctor.memory.status/dreamDiary/backfillDreamDiary/resetDreamDiary/resetGroundedShortTerm/repairDreamingArtifacts/dedupeDreamDiary/remHarness` |
| Usage | `usage.status`, `usage.cost`, `sessions.usage`, `sessions.usage.timeseries`, `sessions.usage.logs` |
| Artifact | `artifacts.list`, `artifacts.get`, `artifacts.download` |
| Environment/worktree | `environments.list/status`; `worktrees.list/create/remove/restore/gc` |
| Terminal | `terminal.open/input/resize/close/attach/list/text` |
| Talk/TTS | `talk.session.create/join/appendAudio/startTurn/endTurn/cancelTurn/cancelOutput/submitToolResult/steer/close`, `talk.client.create/toolCall/steer`, `talk.catalog/config/speak/mode`; `tts.status/enable/disable/convert/speak/setProvider/personas/setPersona/providers` |
| Voice wake | `voicewake.get/set`, `voicewake.routing.get/set` |
| Push | `push.test`, `push.web.vapidPublicKey/subscribe/unsubscribe/test` |
| 更新/重启 | `update.status/run`; `gateway.restart.request/preflight` |
| Dashboard 内部 | `controlUi.githubPreview` |
| 其他内置 | `crestodian.chat`, `crestodian.setup.detect/activate` |

动态 channel plugin 和 Gateway plugin 还可以在运行时增加方法，因此上表不是未来版本的固定枚举。

## 13. 已知缺口

- npm 发布包的 `attachments` 元素仍是 `unknown`，附件转换必须以锁定版本实测为准。
- `docs/gateway/external-apps.md` 称 `/reference/rpc` 为 Gateway RPC 参考，但包内当前 `docs/reference/rpc.md` 主要讲外部 CLI JSON-RPC adapter；完整 Gateway 方法目录实际集中在 `docs/gateway/protocol.md` 和发布代码注册表。升级审计不能只依赖该链接名称。
- MCP live probe/reload 和完整 plugin lifecycle 没有对等的核心 Gateway RPC，不能说新前端仅靠 WS 就已覆盖所有管理能力。
- Dashboard 广播的方法集还会受动态 channel/plugin 注册影响。Adapter 应以 `hello-ok.features.methods/events` 做运行时 capability detection，不能假设每个插件方法始终存在。
