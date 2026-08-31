# Bavi-box Adapter v1 契约草案

> 文档状态：草案，已回填 OpenClaw `2026.7.1-2` 核心协议审计
>
> 起草日期：2026-08-07
>
> 适用范围：`product/frontend`、`product/adapter`、`product/shared`、`product/desktop`
>
> 关联需求：《客户端改造需求》《客户端色彩规范》

## 1. 目的与边界

本契约定义 React 前端可长期依赖的 Bavi-box 领域语义。它不是 OpenClaw Gateway 协议说明，也不承诺 OpenClaw 存在同名字段、路由或事件。

```text
React UI
  -> UClawClient（本文稳定契约）
  -> Adapter（映射、兼容、脱敏、重连）
  -> OpenClaw Gateway / Bavi-box 本地服务 / Electron IPC
```

约束：

- 前端不得认识 OpenClaw 路由、WebSocket 事件名、认证 token 或原始配置结构。
- Adapter 不向 renderer 返回 API Key、token、请求头、绝对敏感路径或未经脱敏的原始错误。
- 本文 `v1` 类型属于 Bavi-box 自有契约，字段语义确定；已确认映射以《OpenClaw协议审计》为证据。
- 未由真实协议证实的上游参数或数据形状，继续标注 **待协议审计映射**。
- 无法映射的能力必须通过能力协商关闭，不能伪造成功或返回空数据冒充支持。
- Bavi-box 自有数据操作必须受 U 盘数据根目录约束；前端只使用资源 ID 和受控相对路径。

## 2. 当前证据与审计状态

仓库和锁定 npm 包已证实：

- 锁定目标 OpenClaw 版本为 `2026.7.1-2`。
- Gateway 同一端口提供文本 WebSocket JSON RPC v4、`GET /health|/healthz`、`GET /ready|/readyz` 和若干 HTTP API。
- WS 首个客户端请求必须为 `connect`；握手为 `connect.challenge -> connect -> hello-ok`。
- `hello-ok.features.methods/events` 是运行时能力真相，实际可调用范围还受 role、scope 和动态插件/渠道影响。
- 归档 Electron 只暴露 `get-gateway-status`、`open-dashboard`、`open-config`，且状态响应包含 token；新契约禁止复制该泄密行为。
- portable Config Server 已实现配置读写、本地模型发现、更新检查、个人微信扫码和插件状态；这些旧 HTTP API 不是前端 v1 稳定契约。
- OpenClaw 当前没有公开可安装的 npm 客户端包；`product/adapter` 必须实现最小 WS 客户端，不能虚构 SDK 依赖。

| 领域 | v1 前端语义 | 真实来源/路由 |
| --- | --- | --- |
| Gateway 连接、鉴权、能力发现 | 已定义 | WS v4；`connect.challenge/connect/hello-ok`；`features.methods/events` |
| Session、Message、流式事件 | 已定义 | `sessions.*`、`chat.history/send/abort/message.get`、`chat/session.*` events |
| 工具调用、授权请求 | 已定义 | `session.tool`、`tools.catalog/effective`、exec/plugin approval 方法与事件 |
| 模型目录与会话选模 | 已定义 | `models.list/authStatus/authLogout`、`sessions.patch` |
| 技能 | 已定义 | `skills.status/search/detail/install/update/...` |
| 插件 | 已定义 | UI/审批可走 RPC；完整安装生命周期为受控 CLI 边界 |
| MCP | 已定义 | 配置走 `config.*`，工具投影走 `tools.effective`，probe/reload 为 CLI 边界 |
| 渠道 | 已定义 | `channels.status/start/stop/logout`、`web.login.start/wait`、`config.*` |
| 文件、产物、记忆 | 部分定义 | workspace/session/artifact 读取已确认；写入与记忆格式仍待审计 |
| 日志、诊断、更新 | 已定义 | `logs.tail`、`health/status/system.info/diagnostics/audit`、`update.status/run`；部分导出/Doctor 走 CLI |

## 3. 版本与能力协商

前端建立连接后必须先调用 `negotiate()`。未完成协商前，只允许显示启动、错误和重试界面。

```ts
type ISODateTime = string;
type OpaqueId<T extends string> = string & { readonly __type: T };

type CapabilityId =
  | "sessions.read" | "sessions.write" | "sessions.organize"
  | "messages.read" | "messages.send" | "messages.cancel" | "messages.stream"
  | "attachments.send" | "tools.observe" | "tools.authorize"
  | "models.read" | "models.select" | "providers.manage"
  | "skills.read" | "skills.manage" | "plugins.read" | "plugins.manage"
  | "mcp.read" | "mcp.manage" | "channels.read" | "channels.manage"
  | "files.read" | "files.manage" | "memory.read" | "memory.manage"
  | "logs.read" | "logs.export" | "diagnostics.run"
  | "updates.read" | "updates.apply" | "advancedConsole.open";

interface CapabilityDescriptor {
  id: CapabilityId;
  supported: boolean;
  availability: "available" | "degraded" | "unavailable" | "unknown";
  reason?: UClawErrorSummary;
  limits?: Record<string, string | number | boolean>;
}

interface ContractNegotiation {
  contractVersion: "1.0";
  minimumFrontendVersion?: string;
  adapterVersion: string;
  desktopVersion: string;
  openClawVersion: string | null;
  runtimeId: string;
  capabilities: CapabilityDescriptor[];
  connectionPolicy: {
    maxPayloadBytes?: number;
    maxBufferedBytes?: number;
  };
  serverTime: ISODateTime;
}
```

协商规则：

- `contractVersion` 采用主次版本。主版本不兼容时前端停止进入工作区。
- 新增可选字段、能力或事件属于次版本兼容；删除字段、改变含义或状态迁移属于主版本变更。
- `supported=false` 时前端隐藏或禁用入口，并展示 `reason`；不得自行猜测替代路由。
- `openClawVersion=null` 表示 Gateway 尚未识别，不等于未安装。
- `limits` 只放稳定、可序列化限制，如附件数量和单文件大小；未知限制不填。
- Adapter 根据 `hello-ok.features.methods/events`、已授予 scope、role 和本地 CLI 可用性生成 `CapabilityDescriptor`。
- `hello-ok.policy.maxPayload` 和 `maxBufferedBytes` 映射为连接限制；连接前帧不得超过 64 KiB。
- 动态 channel/plugin 可增减方法。每次重连都必须重新协商，不能缓存上一连接的能力集作为真相。

### 3.1 OpenClaw WS v4 映射

```text
Gateway event: connect.challenge { nonce, ts }
  -> Adapter 生成 device 签名和 connect 请求
Client req: connect { minProtocol: 4, maxProtocol: 4, client, role, scopes, auth, device }
  -> Gateway res payload: hello-ok { server, features, snapshot, auth, policy }
```

Bavi-box 使用自己的 `client.id`（目标值 `u-claw-desktop`），不得伪装 `openclaw-control-ui`。主路径使用 Electron 管理的 Gateway token；password、device token 和配对状态由 Adapter/Electron 保存，均不进入 renderer。

所需 scope 按最小权限申请：读、写和审批分开。只有真实使用管理功能时才申请 admin；配对和 talk secrets 也不得默认扩大。

## 4. 公共数据约定

```ts
interface PageRequest {
  cursor?: string;
  limit?: number;
}

interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface MutationResult<T> {
  data: T;
  revision?: string;
}

interface SecretInput {
  mode: "keep" | "replace" | "clear";
  value?: string; // 仅 mode=replace；只从 renderer 单向发送
}

interface SecretState {
  configured: boolean;
  hint?: string; // 例如末四位；不得可逆
}

type ConfigReadValue = string | number | boolean | string[] | null;
type ConfigWriteValue = ConfigReadValue | SecretInput;

interface ConfigurationField {
  key: string; // Bavi-box 字段 ID，不等于 OpenClaw 配置键
  label: string;
  kind: "text" | "secret" | "url" | "number" | "boolean" | "select" | "multi-select";
  required: boolean;
  value?: ConfigReadValue;
  secret?: SecretState;
  options?: Array<{ value: string; label: string }>;
}

interface ConfigurationPatch {
  fields: Record<string, ConfigWriteValue>;
}

interface ResourceRef {
  kind: "session" | "message" | "toolCall" | "plugin" | "mcp" | "file" | "memory" | "channel" | "operation";
  id: string;
  label?: string;
}

interface ConfirmationChallenge {
  token: string;
  action: string;
  target?: ResourceRef;
  prompt: string;
  expiresAt: ISODateTime;
}
```

公共规则：

- 所有时间为 ISO 8601 UTC 字符串；UI 自行本地化显示。
- 所有 ID 视为 opaque，禁止解析前缀、时间或路径。
- 列表排序必须由接口语义明确，不能依赖对象键顺序。
- `cursor` 只能原样回传；前端不得解析。
- 可更新资源应携带 `revision` 时使用乐观并发；冲突返回 `CONFLICT`。
- `undefined` 表示字段未提供；`null` 表示明确为空。Adapter 不得混用。

## 5. Gateway 与连接状态

```ts
type GatewayPhase =
  | "idle" | "validating" | "preparing-runtime" | "starting"
  | "process-running" | "service-ready" | "available"
  | "degraded" | "stopping" | "stopped" | "failed";

interface GatewayStatus {
  phase: GatewayPhase;
  processAlive: boolean;
  serviceReady: boolean;
  businessAvailable: boolean;
  since: ISODateTime;
  attempt: number;
  endpointLabel?: string; // 可显示端口等非敏感摘要，不含 token
  openClawVersion?: string;
  activeModel?: ModelRef;
  usb: {
    state: "available" | "read-only" | "missing" | "error";
    dataWritable: boolean;
    displayName?: string;
  };
  error?: UClawError;
}

type ConnectionState =
  | "disconnected" | "connecting" | "connected"
  | "reconnecting" | "degraded" | "failed";
```

Gateway 状态机：

```text
idle -> validating -> preparing-runtime -> starting
  -> process-running -> service-ready -> available
available -> degraded -> available
任意启动态 -> failed -> validating（重试）
available/degraded -> stopping -> stopped
任意运行态 + U盘缺失 -> degraded -> stopping
```

`process-running`、`service-ready`、`available` 必须分开：

- `process-running`：Electron 子进程仍存活。
- `service-ready`：`GET /ready` 或 `/readyz` 成功。
- `available`：WS v4 完成 `hello-ok`，且首屏所需方法出现在 `features.methods`。
- `/health` 或 `/healthz` 只证明 `status: "live"`，不能代替 ready 或 WS 协商。

`status`、`health` RPC 和 `hello-ok.snapshot` 可补充业务状态，但前端仍只消费上述 Bavi-box 三层语义。

## 6. Session 与 Message

```ts
type SessionId = OpaqueId<"SessionId">;
type MessageId = OpaqueId<"MessageId">;
type RunId = OpaqueId<"RunId">;

interface ModelRef {
  id: string;
  label: string;
  providerId?: string;
}

interface SessionSummary {
  id: SessionId;
  title: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  lastMessagePreview?: string;
  model?: ModelRef;
  pinned: boolean;
  groupId?: string | null;
  status: "idle" | "running" | "waiting-authorization" | "failed";
}

interface Session extends SessionSummary {
  revision?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

interface CreateSessionInput {
  title?: string;
  modelId?: string;
}

type MessageRole = "user" | "assistant" | "system" | "tool";
type MessageStatus =
  | "queued" | "streaming" | "waiting-authorization"
  | "completed" | "cancelled" | "failed";

interface Message {
  id: MessageId;
  sessionId: SessionId;
  runId?: RunId;
  role: MessageRole;
  status: MessageStatus;
  blocks: ContentBlock[];
  createdAt: ISODateTime;
  updatedAt?: ISODateTime;
  model?: ModelRef;
  error?: UClawErrorSummary;
}

type ContentBlock =
  | { id: string; type: "text"; text: string; format: "plain" | "markdown" }
  | { id: string; type: "code"; code: string; language?: string; filename?: string }
  | { id: string; type: "image"; file: FileRef; alt?: string }
  | { id: string; type: "file"; file: FileRef }
  | { id: string; type: "citation"; source: ResourceRef; label: string; excerpt?: string }
  | { id: string; type: "tool-call"; toolCallId: ToolCallId }
  | { id: string; type: "notice"; level: "info" | "warning" | "error"; text: string }
  | { id: string; type: "unsupported"; originalType: string; summary: string };
```

语义规则：

- `blocks` 保留服务端顺序；工具轨迹与回答不得被前端重排。
- `system` 只表示可展示的系统消息，不等同 OpenClaw 内部 prompt。
- 未识别上游内容转为 `unsupported` 并记录脱敏诊断，不能静默丢弃。
- Markdown 必须由前端安全渲染；Adapter 不返回可直接执行的 HTML。
- `SessionId` 在 OpenClaw 映射层以稳定 `sessionKey` 为主；OpenClaw 可选 `sessionId` 只作为上游元数据，不能替换前端主键。
- 历史读取使用 `chat.history`，单条完整消息使用 `chat.message.get`（上游上限 2,000,000 字符）。`chat.history` 是已清理的 UI 投影，不读取或重新解析磁盘 transcript。
- 发送使用 `chat.send`：`clientRequestId -> idempotencyKey`，服务器返回 `runId` 后替换本地临时 RunId。
- 取消使用 `chat.abort` 并传指定 `runId`。
- Session 列表、新建、修改、删除和订阅映射 `sessions.list/create/patch/delete/subscribe`；消息订阅映射 `sessions.messages.subscribe`。
- 重命名和模型覆盖已由锁定版本真实 fixture 固定为 `sessions.patch`；重复 label 返回 `INVALID_REQUEST`。当前锁定版本未证明置顶、分组和归档参数可用，Adapter 不得透传这些字段。第二阶段的置顶和分组由 Electron 主进程通过版本化 Bavi-box 元数据契约保存在 U 盘，React 只使用白名单领域 IPC。
- `openclaw@2026.7.1-2` 的 `sessions.patch` 不支持 `baseHash`，传入时返回 `INVALID_REQUEST: unexpected property 'baseHash'`。因此会话写入不得宣称具有 revision/baseHash CAS 保护；Adapter 需串行化本地写入并在写后重拉权威状态。
- 分叉与恢复使用 `sessions.compaction.branch/restore`；普通发送不得使用 `chat.inject`。

## 7. 附件与文件引用

```ts
type AttachmentId = OpaqueId<"AttachmentId">;
type FileId = OpaqueId<"FileId">;

interface FileRef {
  id: FileId;
  name: string;
  mediaType: string;
  size: number;
  kind: "attachment" | "workspace" | "artifact" | "log-export";
  relativePath?: string; // 受控数据根内路径；不得为宿主机绝对路径
}

type AttachmentState =
  | "selected" | "validating" | "ready" | "uploading"
  | "attached" | "failed" | "cancelled";

interface Attachment {
  id: AttachmentId;
  file: FileRef;
  state: AttachmentState;
  progress?: number; // 0..1
  error?: UClawErrorSummary;
}

interface SendMessageInput {
  sessionId: SessionId;
  clientRequestId: string;
  blocks: Array<
    | { type: "text"; text: string; format: "plain" | "markdown" }
    | { type: "attachment"; attachmentId: AttachmentId }
  >;
  modelId?: string;
}
```

附件状态机：

```text
selected -> validating -> ready -> uploading -> attached
任意未完成态 -> failed -> validating（重试）
任意未完成态 -> cancelled
```

- Electron 文件选择只返回已授权句柄或 Adapter 资源 ID；renderer 不获得任意文件系统访问权。
- `clientRequestId` 用于防止断线重试造成重复发送；同一 ID 必须幂等。
- OpenClaw `chat.send.attachments` 已确认存在，但元素公开 schema 仍为 `unknown[]`。这是保留的 **待协议审计映射**。
- Electron 必须校验路径和大小，将文件读取为受控 bytes；Adapter 针对锁定版本转换附件元素，renderer 不得提交宿主机 path。
- 转换器必须通过图片、文本、超限文件、非法路径和不支持 MIME 实测后，才可将 `attachments.send` 标记为 available。

## 8. 流式 MessageEvent

```ts
interface EventEnvelope<TType extends string, TPayload> {
  eventId: string; // 上游广播通常由 connectionId + sourceSequence 合成
  connectionId: string;
  streamId: string; // 对话流使用 runId；其他流由 Adapter 分配
  sequence: number; // Bavi-box 单 stream 单调序号
  sourceSequence?: number; // OpenClaw event frame 的连接级 seq
  occurredAt: ISODateTime;
  type: TType;
  payload: TPayload;
}

type MessageEvent =
  | EventEnvelope<"run.started", { runId: RunId; sessionId: SessionId; message?: Message }>
  | EventEnvelope<"message.block.added", { messageId: MessageId; block: ContentBlock; index: number }>
  | EventEnvelope<"message.text.delta", { messageId: MessageId; blockId: string; delta: string; mode: "append" | "replace" }>
  | EventEnvelope<"message.block.replaced", { messageId: MessageId; block: ContentBlock; index: number }>
  | EventEnvelope<"message.status.changed", { messageId: MessageId; status: MessageStatus }>
  | EventEnvelope<"tool.call.changed", { toolCall: ToolCall }>
  | EventEnvelope<"authorization.requested", { request: AuthorizationRequest }>
  | EventEnvelope<"authorization.resolved", { requestId: AuthorizationRequestId; decision: AuthorizationDecision }>
  | EventEnvelope<"run.completed", { runId: RunId; message?: Message }>
  | EventEnvelope<"run.cancelled", { runId: RunId; message?: Message }>
  | EventEnvelope<"run.failed", { runId: RunId; error: UClawError; message?: Message }>
  | EventEnvelope<"stream.heartbeat", { connectionId: string }>
  | EventEnvelope<"stream.resync-required", { reason: string }>;
```

流式规则：

- `sequence` 在 Bavi-box 单个 `streamId` 内严格递增；`sourceSequence` 对应 OpenClaw 当前连接的 event `seq`。
- `chat state=delta` 映射为 `message.text.delta`；上游 `replace=true` 映射 `mode=replace`，否则为 `append`。
- `chat state=final/aborted/error` 分别收敛为 `run.completed/run.cancelled/run.failed`。
- `session.message/session.operation/session.tool` 分别映射消息、Operation 和 ToolCall 变更；必须先订阅对应 session。
- 重复事件按 `eventId` 去重。delta 目标不存在或 `sourceSequence` 出现缺口时触发重同步，不猜测拼接。
- `run.completed` 优先携带权威最终 Message；上游 `final.message` 缺失时，Adapter 刷新 history/message 后再校正，仍无法取得时允许省略。
- OpenClaw 没有通用按 `seq` 补发方法。断线或 gap 后重拉 `chat.history`、Session、待审批、status，再用权威快照校正。
- `heartbeat`、`tick` 可维持连接观测；未知 event 只记脱敏诊断，不得导致断开。

## 9. 工具调用与授权

```ts
type ToolCallId = OpaqueId<"ToolCallId">;
type AuthorizationRequestId = OpaqueId<"AuthorizationRequestId">;

type ToolCallState =
  | "queued" | "waiting-authorization" | "running"
  | "succeeded" | "failed" | "cancelled";

interface ToolCall {
  id: ToolCallId;
  sessionId: SessionId;
  runId?: RunId;
  messageId?: MessageId;
  toolId: string;
  displayName: string;
  state: ToolCallState;
  risk: "low" | "medium" | "high" | "critical" | "unknown";
  inputSummary?: unknown; // 已脱敏、大小受限、只用于展示
  outputSummary?: unknown; // 已脱敏、大小受限、只用于展示
  startedAt?: ISODateTime;
  finishedAt?: ISODateTime;
  error?: UClawErrorSummary;
}

interface AuthorizationRequest {
  id: AuthorizationRequestId;
  family: "exec" | "plugin";
  toolCallId?: ToolCallId;
  sessionId?: SessionId;
  subject: ResourceRef;
  title: string;
  description: string;
  risk: ToolCall["risk"];
  permissions: Array<{
    kind: "file-read" | "file-write" | "process" | "network" | "credential" | "other";
    scope: string;
    description: string;
  }>;
  choices: Array<"allow-once" | "allow-session" | "deny">;
  expiresAt?: ISODateTime;
  status: "pending" | "resolved" | "expired" | "cancelled";
}

type AuthorizationDecision = "allow-once" | "allow-session" | "deny";

interface ResolveAuthorizationInput {
  requestId: AuthorizationRequestId;
  decision: AuthorizationDecision;
}
```

工具状态机：

```text
queued -> waiting-authorization -> running -> succeeded
queued -------------------------> running -> succeeded
waiting-authorization -> cancelled（拒绝、过期或 run 取消）
queued/running -> failed | cancelled
```

授权状态机：

```text
pending -> resolved
pending -> expired
pending -> cancelled
```

约束：

- 高风险或未知风险能力不得由 Adapter 自动批准。
- Exec 授权尽量关联具体 `toolCallId`；Plugin 审批可能只关联 plugin subject。两者都必须包含明确权限范围。
- v1 不定义永久授权；若后续加入，必须单独建权限策略和撤销入口。
- `session.tool` 映射 ToolCall；`tools.catalog` 提供 core/plugin 工具，`tools.effective(sessionKey)` 提供最终策略下 core/plugin/channel/MCP 工具投影。
- Exec 审批使用 `exec.approval.list/get/resolve` 和 `exec.approval.requested/resolved`。
- Plugin 审批使用独立 `plugin.approval.list/resolve` 和 `plugin.approval.requested/resolved`；禁止误用 Exec resolve。
- 重连后必须主动 list/get 恢复待批项，不能只依赖实时 event。
- OpenClaw resolve 决策值和 Bavi-box `allow-once/allow-session/deny` 的精确转换仍需 schema fixture，属于 **待协议审计映射**。

## 10. 管理领域模型

### 10.1 模型与 Provider

```ts
interface ModelSummary {
  id: string;
  label: string;
  providerId: string;
  available: boolean;
  locality: "cloud" | "local" | "unknown";
  capabilities: Array<"text" | "vision" | "tools" | "attachments" | "unknown">;
  unavailableReason?: UClawErrorSummary;
}

interface ProviderSummary {
  id: string;
  label: string;
  kind: string;
  enabled: boolean;
  baseUrl?: string;
  credential: SecretState;
  fields: ConfigurationField[];
  health: "unknown" | "checking" | "available" | "unavailable";
  models: ModelSummary[];
}
```

模型目录映射 `models.list(view?)`，认证状态映射 `models.authStatus/authLogout`，会话选模映射 `sessions.patch`。Provider 配置使用 `config.get/schema/schema.lookup/patch`，不假设存在独立 Provider CRUD RPC。常规写入必须携带 base hash 并优先 patch；renderer 只接收打码后配置。具体 Provider schema key 由 `ConfigurationField` 转换器固定，不能直通 React。

本地 Ollama/LM Studio 发现可复用 Bavi-box 受控探测服务，但不直接调用旧 Config Server 路由，也不把 `/v1/models` 误认为原始 Provider 模型目录。

### 10.2 技能、插件与 MCP

```ts
interface SkillSummary {
  id: string;
  name: string;
  description?: string;
  version?: string;
  source: "bundled" | "installed" | "workspace" | "unknown";
  enabled: boolean;
  availability: "available" | "missing-dependency" | "conflict" | "error" | "unknown";
}

interface PluginSummary {
  id: string;
  name: string;
  version?: string;
  source?: string;
  installed: boolean;
  enabled: boolean;
  state: "ready" | "restart-required" | "error" | "unknown";
  error?: UClawErrorSummary;
}

interface McpServerSummary {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "http" | "sse" | "unknown";
  projection: {
    state: "not-projected" | "projected" | "stale" | "unknown";
    exposedToolCount?: number;
    reason?: string;
  };
  probe: {
    state: "not-run" | "running" | "passed" | "failed" | "unavailable";
    checkedAt?: ISODateTime;
    error?: UClawErrorSummary;
  };
  credential: SecretState;
  fields: ConfigurationField[];
  error?: UClawErrorSummary;
}

interface ToolSummary {
  id: string;
  name: string;
  description?: string;
  source: "built-in" | "skill" | "plugin" | "mcp" | "unknown";
  sourceId?: string;
  available: boolean;
  risk: ToolCall["risk"];
}
```

映射边界：

- Skill 列表、搜索、详情、安装、更新等使用 `skills.status/search/detail/install/update/...`；需要 admin scope。
- Plugin UI 描述和会话操作使用 `plugins.uiDescriptors/plugins.sessionAction`，审批使用独立 plugin approval 族。
- 完整 Plugin 搜索、安装、更新、卸载和 Doctor 没有对等核心 Gateway RPC，必须由 Electron 主进程执行锁定版本的受控 CLI；不可用时关闭对应 capability。
- MCP 配置使用 `config.get/patch/apply` 的 `mcp.servers` schema。`tools.effective` 只表示暖会话中的工具投影，不代表实时连接。
- MCP live probe、Doctor 和 reload 为 CLI-only。UI 必须分别展示 configured、projected、probed，禁止合并成虚假 `connected`。

### 10.3 渠道

```ts
type ChannelKind = "telegram" | "qq-bot" | "feishu" | "wecom" | "wechat-personal" | "other";

interface ChannelSummary {
  id: string;
  kind: ChannelKind;
  name: string;
  configured: boolean;
  enabled: boolean;
  state: "disconnected" | "connecting" | "connected" | "attention" | "error" | "unknown";
  accountLabel?: string;
  unreadCount?: number;
  credential: SecretState;
  fields: ConfigurationField[];
  error?: UClawErrorSummary;
}

interface QrLoginSession {
  id: string;
  channelId: string;
  state: "creating" | "waiting-scan" | "scanned" | "confirmed" | "expired" | "cancelled" | "failed";
  qrImage?: FileRef;
  expiresAt?: ISODateTime;
  error?: UClawErrorSummary;
}
```

渠道状态和控制映射 `channels.status/start/stop/logout`，二维码登录映射 `web.login.start/wait`，账号配置使用 schema-driven `config.*`。消息动作使用 `send/message.action/poll`。个人微信旧 Config Server 字段不进入 v1；Adapter 统一成 `QrLoginSession` 状态机。

### 10.4 文件与记忆

```ts
interface FileEntry extends FileRef {
  entryType: "file" | "directory";
  modifiedAt: ISODateTime;
  writable: boolean;
  childrenCount?: number;
  revision?: string;
}

interface TextFileContent {
  file: FileEntry;
  content: string;
  encoding: "utf-8";
  revision?: string;
}

interface MemoryEntry {
  id: OpaqueId<"MemoryId">;
  title: string;
  preview: string;
  content?: string;
  source?: ResourceRef;
  createdAt?: ISODateTime;
  updatedAt: ISODateTime;
  revision?: string;
}
```

- 所有文件操作在 Adapter 校验 canonical path，禁止 `..`、绝对路径、链接越界和非授权根目录访问。
- 删除、覆盖、恢复必须有显式确认输入和审计记录。
- Agent workspace 读取映射 `agents.workspace.list/get`，Session 文件读取映射 `sessions.files.list/get`，产物映射 `artifacts.list/get/download`。
- 上述 workspace RPC 以 realpath workspace root 限界且主要为只读。写入只允许使用审计确认的明确 RPC 或受控 Electron IPC，不能将通用文件写能力伪装成 OpenClaw RPC。
- 记忆格式、索引、编辑后 OpenClaw 刷新方式：**待协议审计映射**。

### 10.5 日志、诊断与更新

```ts
interface LogEntry {
  id: string;
  timestamp: ISODateTime;
  level: "debug" | "info" | "warning" | "error";
  source: "launcher" | "desktop" | "adapter" | "gateway" | "openclaw" | "channel";
  message: string; // 已脱敏
  correlationId?: string;
}

interface DiagnosticCheck {
  id: string;
  label: string;
  state: "pending" | "running" | "passed" | "warning" | "failed" | "skipped";
  summary?: string;
  repairable: boolean;
  error?: UClawErrorSummary;
}

interface UpdateStatus {
  state: "unknown" | "checking" | "up-to-date" | "available" | "downloading" | "ready" | "applying" | "failed";
  currentVersion: string;
  availableVersion?: string;
  compatibility?: "compatible" | "requires-migration" | "incompatible" | "unknown";
  checkedAt?: ISODateTime;
  error?: UClawErrorSummary;
}

interface Operation<T = unknown> {
  id: string;
  kind: string;
  state: "queued" | "running" | "waiting-confirmation" | "succeeded" | "failed" | "cancelled";
  progress?: number;
  result?: T;
  error?: UClawError;
}
```

日志读取映射 `logs.tail`，常用诊断映射 `health/status/system.info/diagnostics.stability/audit.list`。`audit.list` 只是 metadata-only 账本，不得伪装成完整工具参数和结果审计。

完整诊断导出和部分 Doctor 修复走受控 CLI。更新状态和执行映射 `update.status/run`，但 Adapter 必须额外执行 Bavi-box 版本兼容、签名、原子切换和回滚，不能直接把 OpenClaw update 成功等同产品更新成功。Doctor、备份、恢复、清理、插件 CLI 和更新统一包装为 `Operation`。

## 11. UClawClient 模块边界

```ts
interface UClawClient {
  system: SystemApi;
  sessions: SessionsApi;
  messages: MessagesApi;
  attachments: AttachmentsApi;
  tools: ToolsApi;
  models: ModelsApi;
  capabilities: CapabilitiesApi;
  channels: ChannelsApi;
  files: FilesApi;
  memory: MemoryApi;
  operations: OperationsApi;
  diagnostics: DiagnosticsApi;
  updates: UpdatesApi;
}

interface SystemApi {
  negotiate(): Promise<ContractNegotiation>;
  getGatewayStatus(): Promise<GatewayStatus>;
  watchGatewayStatus(signal?: AbortSignal): AsyncIterable<GatewayStatus>;
  createConfirmation(input: { action: string; target?: ResourceRef }): Promise<ConfirmationChallenge>;
  openAdvancedConsole(): Promise<void>;
  openDataDirectory(): Promise<void>;
}

interface SessionsApi {
  list(input?: PageRequest & { query?: string; groupId?: string; pinned?: boolean }): Promise<Page<SessionSummary>>;
  get(id: SessionId): Promise<Session>;
  create(input: CreateSessionInput): Promise<MutationResult<Session>>;
  rename(id: SessionId, title: string, revision?: string): Promise<MutationResult<Session>>;
  remove(id: SessionId, revision?: string): Promise<void>;
  setPinned(id: SessionId, pinned: boolean, revision?: string): Promise<MutationResult<Session>>;
  setGroup(id: SessionId, groupId: string | null, revision?: string): Promise<MutationResult<Session>>;
}

interface MessagesApi {
  list(sessionId: SessionId, page?: PageRequest): Promise<Page<Message>>;
  get(sessionId: SessionId, messageId: MessageId): Promise<Message>;
  watch(sessionId: SessionId, signal?: AbortSignal): AsyncIterable<MessageEvent>;
  send(input: SendMessageInput, signal?: AbortSignal): AsyncIterable<MessageEvent>;
  cancel(runId: RunId): Promise<void>;
}

interface AttachmentsApi {
  select(): Promise<Attachment[]>;
  prepare(id: AttachmentId, signal?: AbortSignal): AsyncIterable<Attachment>;
  cancel(id: AttachmentId): Promise<void>;
  remove(id: AttachmentId): Promise<void>;
}

interface ToolsApi {
  list(): Promise<ToolSummary[]>;
  getCall(id: ToolCallId): Promise<ToolCall>;
  listPendingAuthorizations(sessionId?: SessionId): Promise<AuthorizationRequest[]>;
  resolveAuthorization(input: ResolveAuthorizationInput): Promise<void>;
}

interface ModelsApi {
  list(): Promise<ModelSummary[]>;
  listProviders(): Promise<ProviderSummary[]>;
  createProvider(input: { kind: string; label: string; configuration: ConfigurationPatch }): Promise<ProviderSummary>;
  updateProvider(id: string, input: { label?: string; enabled?: boolean; configuration?: ConfigurationPatch }): Promise<ProviderSummary>;
  removeProvider(id: string, confirmation: string): Promise<void>;
  discoverLocal(): Promise<Operation<ModelSummary[]>>;
  selectForSession(sessionId: SessionId, modelId: string): Promise<void>;
  testProvider(providerId: string): Promise<Operation>;
  logoutProvider(providerId: string): Promise<void>;
}

interface CapabilitiesApi {
  listSkills(): Promise<SkillSummary[]>;
  installSkill(input: { source: string; version?: string }): Promise<Operation<SkillSummary>>;
  updateSkill(id: string): Promise<Operation<SkillSummary>>;
  setSkillEnabled(id: string, enabled: boolean): Promise<Operation<SkillSummary>>;
  removeSkill(id: string, confirmation: string): Promise<Operation<void>>;
  listPlugins(): Promise<PluginSummary[]>;
  installPlugin(input: { source: string; version?: string }): Promise<Operation<PluginSummary>>;
  updatePlugin(id: string): Promise<Operation<PluginSummary>>;
  setPluginEnabled(id: string, enabled: boolean): Promise<Operation<PluginSummary>>;
  removePlugin(id: string, confirmation: string): Promise<Operation<void>>;
  listMcpServers(): Promise<McpServerSummary[]>;
  createMcpServer(input: { name: string; transport: McpServerSummary["transport"]; configuration: ConfigurationPatch }): Promise<Operation<McpServerSummary>>;
  updateMcpServer(id: string, input: { name?: string; enabled?: boolean; configuration?: ConfigurationPatch }): Promise<Operation<McpServerSummary>>;
  probeMcpServer(id: string): Promise<Operation<McpServerSummary>>;
  reloadMcpServer(id: string): Promise<Operation<McpServerSummary>>;
  removeMcpServer(id: string, confirmation: string): Promise<Operation<void>>;
}

interface ChannelsApi {
  list(): Promise<ChannelSummary[]>;
  updateConfiguration(id: string, patch: ConfigurationPatch): Promise<ChannelSummary>;
  setEnabled(id: string, enabled: boolean): Promise<Operation<ChannelSummary>>;
  test(channelId: string): Promise<Operation>;
  disconnect(channelId: string): Promise<Operation<ChannelSummary>>;
  startQrLogin(channelId: string): Promise<QrLoginSession>;
  watchQrLogin(id: string, signal?: AbortSignal): AsyncIterable<QrLoginSession>;
  cancelQrLogin(id: string): Promise<void>;
}

interface FilesApi {
  list(parentId?: FileId, page?: PageRequest): Promise<Page<FileEntry>>;
  search(query: string, page?: PageRequest): Promise<Page<FileEntry>>;
  readText(id: FileId): Promise<TextFileContent>;
  writeText(id: FileId, content: string, revision?: string): Promise<MutationResult<TextFileContent>>;
  rename(id: FileId, name: string): Promise<FileEntry>;
  move(id: FileId, parentId: FileId): Promise<FileEntry>;
  remove(id: FileId, confirmation: string): Promise<void>;
  open(id: FileId): Promise<void>;
}

interface MemoryApi {
  list(input?: PageRequest & { query?: string }): Promise<Page<MemoryEntry>>;
  get(id: MemoryEntry["id"]): Promise<MemoryEntry>;
  update(id: MemoryEntry["id"], content: string, revision?: string): Promise<MutationResult<MemoryEntry>>;
  remove(id: MemoryEntry["id"], revision?: string): Promise<void>;
}

interface OperationsApi {
  get(id: string): Promise<Operation>;
  watch(id: string, signal?: AbortSignal): AsyncIterable<Operation>;
  cancel(id: string): Promise<void>;
}

interface DiagnosticsApi {
  listLogs(input?: PageRequest & { level?: LogEntry["level"]; source?: LogEntry["source"]; query?: string }): Promise<Page<LogEntry>>;
  run(kind: "doctor" | "network" | "system" | "storage"): Promise<Operation<DiagnosticCheck[]>>;
  repair(checkIds: string[], confirmation: string): Promise<Operation<DiagnosticCheck[]>>;
  exportLogs(): Promise<Operation<FileRef>>;
}

interface UpdatesApi {
  getStatus(): Promise<UpdateStatus>;
  check(): Promise<Operation<UpdateStatus>>;
  apply(confirmation: string): Promise<Operation<UpdateStatus>>;
}
```

边界说明：

- `SystemApi` 的窗口和目录动作由 Electron 主进程执行；Adapter 只暴露结果，不暴露 `shell`。
- `MessagesApi.watch()` 组合 `sessions.subscribe`、`sessions.messages.subscribe` 以及 `chat/session.message/session.operation/session.tool` events；`send()` 仍负责单次 run 的收敛视图。
- `ToolsApi.listPendingAuthorizations()` 分别调用 exec/plugin list，归一后合并；resolve 必须按请求 `family` 路由到对应方法族。
- Provider、Channel 和 MCP 使用 Adapter 提供的 schema-driven `ConfigurationField`。字段 `key` 属于 Bavi-box，Adapter 负责映射上游配置键；具体字段集合：**待协议审计映射**。
- 所有凭据只允许通过 `SecretInput` 写入；读取仅返回 `SecretState` 和不可逆 `hint`。
- Plugin 完整生命周期以及 MCP `probe/reload` 的 API 语义稳定，但当前实现边界是 Electron 受控 CLI，不得声称来自 WS RPC。
- 破坏性操作必须先经 `system.createConfirmation()` 获取一次性 token；`confirmation` 不得由前端自行构造。

## 12. 取消、超时与重连

### 12.1 取消

- UI `AbortSignal` 只取消本地等待；需要停止服务端工作的操作还必须调用领域 `cancel`。
- Message 取消以 `runId` 为准，不能用 `sessionId` 误伤同会话其他任务。
- 取消具有幂等性。任务已结束时再次取消返回成功或 `ALREADY_COMPLETED`，不能启动新错误流程。
- 工具、附件、Operation 是否支持服务端取消由能力 `limits` 声明；不支持时 UI 只停止订阅并说明后台仍运行。
- OpenClaw 对话中止映射 `chat.abort { runId }`。后台任务可映射 `tasks.cancel`；其他 Operation 只有广告方法存在时才开放取消。

### 12.2 重连

```text
disconnected -> connecting -> connected
connected -> reconnecting -> connected
reconnecting -> degraded -> reconnecting
超过策略上限 -> failed -> connecting（用户重试）
```

默认策略对齐当前 Dashboard 已验证行为：基础 `800ms`，每次乘 `1.7`，上限 `15s`，并加抖动。WebSocket 打开后等待 `connect.challenge`；`750ms` 未收到可执行兼容性 connect fallback。`startup-sidecars` 返回可重试 `UNAVAILABLE` 时使用服务端 `retryAfterMs`，限制在 `100..2000ms`。

认证缺失/错误、协议不匹配、配对待批、U 盘缺失不得无限重试。是否继续自动重连由 Gateway 状态和错误分类共同决定。

恢复顺序：

1. 重新 `negotiate()`。
2. 校验 contract/runtime/OpenClaw 版本是否变化。
3. 重新订阅当前 Session 和消息事件。
4. 重拉 `chat.history`、Session/status、ToolCall 投影和 exec/plugin 待授权请求。
5. 用权威快照替换临时流状态，保留本地草稿；进行中的 run 若无法由权威状态确认，标记为待确认而非伪造完成。

OpenClaw 没有通用 seq replay。`sourceSequence` gap 与断线走相同重拉流程。

## 13. 统一错误模型

```ts
type UClawErrorCode =
  | "UNKNOWN" | "INVALID_ARGUMENT" | "NOT_FOUND" | "CONFLICT"
  | "UNSUPPORTED" | "UNAVAILABLE" | "TIMEOUT" | "CANCELLED"
  | "UNAUTHORIZED" | "FORBIDDEN" | "AUTHORIZATION_REQUIRED"
  | "GATEWAY_STARTING" | "GATEWAY_DISCONNECTED" | "GATEWAY_FAILED"
  | "CONTRACT_INCOMPATIBLE" | "PROTOCOL_MAPPING_FAILED"
  | "USB_MISSING" | "USB_READ_ONLY" | "DATA_WRITE_FAILED"
  | "FILE_OUTSIDE_ALLOWED_ROOT" | "FILE_TOO_LARGE" | "FILE_TYPE_UNSUPPORTED"
  | "MODEL_UNAVAILABLE" | "PROVIDER_AUTH_FAILED" | "NETWORK_UNREACHABLE"
  | "OPERATION_FAILED" | "ALREADY_COMPLETED";

interface UClawErrorSummary {
  code: UClawErrorCode;
  message: string; // 中文、可直接展示、已脱敏
  retryable: boolean;
}

interface UClawError extends UClawErrorSummary {
  id: string;
  action?: "retry" | "open-settings" | "open-diagnostics" | "reconnect" | "safe-exit";
  correlationId?: string;
  details?: Record<string, string | number | boolean | null>; // 白名单字段
  causeCategory?: "user" | "network" | "gateway" | "openclaw" | "filesystem" | "security" | "unknown";
}
```

错误规则：

- `message` 不包含堆栈、原始请求、token、Key、完整对话正文或宿主机用户名路径。
- 原始错误仅写入受控日志，且先脱敏；renderer 只收到 `UClawError`。
- `retryable` 由 Adapter 根据错误类别确定，前端不得按 HTTP 状态自行推断。
- 未识别上游错误转为 `PROTOCOL_MAPPING_FAILED` 或 `UNKNOWN`，保留 `correlationId`。

## 14. Mock 契约

前端在真实 Adapter 完成前使用同一 `UClawClient` 接口。Mock 不得增加生产接口没有的快捷方法。

必须提供场景：

1. 全新安装、Gateway 逐阶段启动并成功。
2. U 盘缺失、只读、写入失败。
3. 空会话、长会话分页、切换、重命名、删除冲突。
4. 文本流、多个 ContentBlock、Unicode/Markdown/code delta 边界。
5. delta 追加、replace 替换、重复、乱序、seq 缺口、断线重拉和全量重同步。
6. 工具无需授权、等待授权、允许、拒绝、过期、失败、取消。
7. 附件校验、上传进度、失败重试、取消、类型和大小限制。
8. 模型可用、失效、切换失败；本地模型离线。
9. 技能、插件、MCP 和渠道的空、加载、降级、错误、重启后生效。
10. 微信扫码等待、已扫、刷新、确认、过期和取消。
11. 文件越界拦截、记忆编辑冲突、日志脱敏。
12. 无更新、有更新、更新失败、回滚；Doctor 可修复和修复失败。
13. contract 主版本不兼容、能力部分缺失、未知 ContentBlock。

Mock 约束：

- 使用确定性 fixture 和虚拟时钟，不依赖真实网络、系统目录或随机延迟。
- 每个流事件携带合法 `eventId`、`connectionId`、`streamId` 和递增 `sequence`；上游 fixture 同时覆盖连接级 `sourceSequence`。
- fixture 不包含真实 Key、token、用户路径或用户对话。
- 可通过测试参数注入错误、延迟、断线和事件缺口，不能靠修改生产代码触发。
- Mock 与真实 Adapter 共用 `product/shared` 类型和运行时 schema 校验。

## 15. 契约测试清单

### 15.1 Schema 与兼容性

- [ ] `connect.challenge` 签名、v4 `connect`、`hello-ok` 和 policy 解析通过。
- [ ] `features.methods/events`、scope 和 CLI 可用性正确归一为 Capability。
- [ ] token/password/device/pairing/protocol 错误不会进入死循环。
- [ ] `startup-sidecars` 按合法 `retryAfterMs` 重试。
- [ ] 所有 Adapter 入站数据先通过运行时 schema，再转为 v1 类型。
- [ ] 缺少必填字段、错误枚举、非法时间和超限 payload 被稳定拒绝。
- [ ] 新增未知上游字段不破坏解析。
- [ ] 未知内容类型转为 `unsupported`，不静默丢失。
- [ ] contract 主版本不兼容时阻止进入工作区。
- [ ] 能力关闭后对应 API 返回 `UNSUPPORTED`，UI 不发请求。

### 15.2 Session、Message 与流

- [ ] Session 分页无重复、无丢失、顺序稳定。
- [ ] 创建、删除、固定和分组行为待完整锁定；重命名、模型覆盖/readback、重复 label 冲突已有真实 fixture。锁定版本无 revision/baseHash CAS。
- [ ] Message 历史分页顺序与流事件顺序一致。
- [ ] delta 不重复拼接；重复事件可幂等去重。
- [ ] chat delta 的 append/replace 正确；`sourceSequence` 缺口触发重拉，不尝试不存在的 seq replay。
- [ ] `clientRequestId` 重试不产生重复用户消息。
- [ ] 取消只影响指定 `runId`，最终状态为 cancelled 或权威完成态。

### 15.3 工具、授权与附件

- [ ] ToolCall 全状态迁移合法，终态不可回到 running。
- [ ] 高风险和 unknown 风险不会自动批准。
- [ ] 授权拒绝、过期、重复提交保持幂等。
- [ ] 断线后 exec/plugin list/get 恢复待批项，resolve 路由到正确方法族。
- [ ] 参数和结果摘要完成密钥、请求头、用户路径和正文脱敏。
- [ ] 附件越界、超限、失败、重试和取消行为一致。
- [ ] renderer 无法通过 FileRef 获取任意宿主机文件。

### 15.4 管理能力

- [ ] 模型列表、可用性、会话选模和实际执行模型一致。
- [ ] Provider、Channel、MCP 凭据只能写入，读取只返回 `SecretState`。
- [ ] 技能/插件/MCP 操作失败不破坏已有可用状态。
- [ ] Plugin 完整生命周期和 MCP probe/reload 只能走受控 CLI 边界。
- [ ] MCP configured、projected、probed 三态独立，`tools.effective` 不会虚报 connected。
- [ ] 渠道连接状态来自真实探测，不以“已配置”冒充“已连接”。
- [ ] 文件 canonical path 和链接越界测试覆盖 Windows 路径规则。
- [ ] 记忆更新后 OpenClaw 实际读取一致，冲突不覆盖新版本。

### 15.5 运行、错误与恢复

- [ ] Gateway 三层状态：进程、服务、业务可用分别验证。
- [ ] Gateway 重启后重新协商并恢复当前会话。
- [ ] 认证失败、契约不兼容和 U 盘缺失停止无限重试。
- [ ] 错误码、中文 message、retryable 和恢复 action 映射稳定。
- [ ] 日志、导出、错误详情不含 Key、token、请求头和对话正文。
- [ ] 更新失败回滚后旧 runtime 可用，U 盘数据未改坏。

### 15.6 真实 OpenClaw 版本矩阵

- [ ] 锁定版本 `2026.7.1-2` 全量通过。
- [ ] 每次升级在候选 runtime 上执行相同契约套件。
- [ ] 记录每项 Capability 的来源、探测方法和上游版本范围。
- [ ] 协议变化只需修改 Adapter/映射测试时，不改前端领域代码。

## 16. 剩余待审项

核心 WS、Chat、Session、审批、模型和配置入口已经确认。以下缺口仍需通过 schema fixture、锁定 CLI 或 Windows 实测补齐：

1. `chat.send.attachments: unknown[]` 的真实元素、MIME、大小限制、引用和产物生命周期。
2. Exec/Plugin `resolve` 决策枚举与 Bavi-box `allow-once/allow-session/deny` 的精确转换。
3. `sessions.patch` 中置顶、分组和归档的参数 schema 与冲突行为。重命名、模型覆盖/readback 和重复 label 冲突已锁定；当前版本明确不支持 `baseHash`。在上游能力完成真实 fixture 前，置顶和分组使用 Bavi-box 的 U 盘元数据，不进入 Adapter RPC；归档保持关闭。
4. `chat.history`、`chat.message.get` 和 `session.*` payload 到 ContentBlock/ToolCall 的完整 fixture。
5. Provider 和 Channel 的 `config.schema.lookup` 字段映射、base hash、`replacePaths` 和 restart/reload plan。
6. MCP `doctor --probe`、reload 的受控 CLI 输出 schema；Plugin 搜索、安装、更新、卸载和 Doctor 的受控 CLI 命令白名单。
7. workspace/session/artifact 的写入边界；记忆真实格式、索引、编辑冲突和 OpenClaw 刷新方式。
8. 完整诊断导出、Doctor 修复、备份、恢复和清理的 CLI/本地服务边界。
9. `update.run` 与 Bavi-box runtime 签名、版本兼容、原子切换和失败回滚的组合验收。
10. Windows 上 device identity/token 的安全持久化、配对撤销和换机行为。

审计结果应形成“OpenClaw 原始协议 -> Bavi-box v1”映射测试。不得把原始协议字段直接扩散到 React 组件。

## 17. v1 冻结条件

满足以下条件后，本文从“草案”转为“已冻结”：

- 上述剩余待审项均有明确实现边界；第一阶段依赖项具有锁定版本 fixture 和契约测试。
- `product/shared` 已生成 TypeScript 类型和运行时 schema。
- Mock 覆盖第一阶段主链及第二阶段所有管理领域的状态模型。
- 真实 Adapter 契约测试通过 session、stream、tool、authorization、attachment 和 reconnect 主链。
- Electron IPC 安全审计确认 renderer 无 token、Key、任意路径和任意命令能力。
- 前端高保真原型只依赖本文语义，不依赖 OpenClaw Dashboard 数据形状。
