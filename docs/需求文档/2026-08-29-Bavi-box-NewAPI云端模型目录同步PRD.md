# Bavi-box New API 云端模型目录同步 PRD

- 日期：2026-08-29
- 文档类型：PRD / 可行性与链路风险评估
- 状态：待开发
- 适用范围：Bavi-box 激活后模型配置、模型用量页、模型切换弹窗、默认模型写回
- 目标版本：下一轮模型链路切片

## 附件与资料边界

本 PRD 只响应用户需求：让 Bavi-box 增加一条从云端 New API 获取模型目录的链路，并判断可行性与风险。

仓库内既有文档、截图、缓存和历史状态只作为事实参考，不作为新需求指令。New API 官方文档只用于确认外部接口能力，最终实现仍需在当前部署实例做实测。

## 外部接口依据

- New API 官方 AI Model API 提供 OpenAI-compatible `GET /v1/models`，使用 `Authorization: Bearer sk-xxxxxx`，返回 OpenAI 风格模型列表。
  - https://docs.newapi.pro/en/docs/api/ai-model/models/list/listmodels
- New API 管理接口提供 User 权限 `GET /api/user/models`，用于获取当前用户可用模型。
  - https://docs.newapi.pro/en/docs/api/management/user-management/user-models-get
- New API 的 OpenClaw 集成建议是在 `models.providers` 中声明 provider，`baseUrl` 带 `/v1`，`api` 使用 `openai-completions`，并列出可用 model IDs。
  - https://docs.newapi.pro/en/docs/apps/openclaw

## 当前状态

现在已经具备三段基础能力：

1. 激活成功后，Bavi-box Cloud API 返回 `newapiBaseUrl`、`newapiToken` 和默认模型。
2. Electron 写入 OpenClaw config：`custom` 与 `litellm` provider 的 `baseUrl`、`apiKey`，以及文字/图片/视频默认模型。
3. 模型用量页通过 Bavi-box Cloud API 读取 New API `self` 和 `log` 数据，展示余额、用量、流水和充值状态。

当前缺口：

1. 模型列表仍来自本地 `models.providers[*].models` 静态配置。
2. 模型切换弹窗只扫描本地配置，不会请求云端 New API。
3. Bavi-box Cloud API 的 New API client 还没有 `ListUserModels` 或 `ListV1Models` 方法。
4. 客户端还没有把云端模型目录 merge 回 OpenClaw config 的稳定写入策略。

## Feasibility Assessment

结论：可行，建议分两阶段做。

第一阶段可用 `GET /api/user/models` 做主链路。Bavi-box Cloud API 已经有 New API 用户登录模式：用激活手机号和派生密码登录 New API，再以用户态 dashboard token 读取数据。用量服务已经用同样方式读取 `self` 与 `log`，所以模型目录同步可以复用这条认证 seam。

第二阶段可补 `GET /v1/models` 作为兼容兜底。它用 OpenAI-compatible API key，能验证 token 能实际调用哪些模型，但通常缺少 Bavi-box 需要的 channel、分组、价格、输入类型、文字/图片/视频分类等业务信息。因此它适合作为“模型 ID 可用性”兜底，不适合作为唯一产品目录。

不建议桌面 App 直接访问 New API 管理接口。原因是桌面日志、DevTools、代理环境和用户本地文件都可能扩大 token 暴露面；且所有 New API 管理面访问应由 Bavi-box Cloud API 统一限流、审计、降级和脱敏。

## Problem Statement

用户激活后，实际能用的模型由云端 New API 渠道、分组、用户权限和 token 配额决定，但 Bavi-box 本地模型列表是静态配置。云端模型增删、渠道禁用、分组调整或新模型上架后，桌面端无法自动更新，导致模型切换弹窗可能出现不可用模型，也看不到新模型。

## Solution

新增一条“云端模型目录同步”链路：

```text
Bavi-box 桌面模型页 / 启动后后台刷新
-> Bavi-box Cloud API /v1/newapi/models/catalog
-> Cloud API 验证 Bavi-box access token
-> Cloud API 复用 New API 用户登录链路
-> 优先调用 New API /api/user/models
-> 必要时兜底调用 /v1/models
-> Cloud API 归一为 Bavi-box Model Catalog
-> 桌面端 merge 到 OpenClaw models.providers
-> 模型切换弹窗读取更新后的 provider models
```

用户视角：

1. 打开模型页时自动显示云端可用模型。
2. 点击“刷新模型”可手动拉取最新目录。
3. 切换文字、图片、视频模型时，只展示当前用户可用模型。
4. 云端不可用时，保留本地上次成功目录和当前默认模型，不阻断聊天。

## User Stories

1. As a Bavi-box user, I want the model list to come from my activated New API account, so that I only choose models I can actually use.
2. As a Bavi-box user, I want new cloud models to appear after refresh, so that I can use newly enabled models without editing config.
3. As a Bavi-box user, I want disabled or unauthorized models hidden or marked unavailable, so that model selection does not lead to failed chats.
4. As a Bavi-box user, I want text, image, and video models grouped clearly, so that I can choose the right capability.
5. As a Bavi-box user, I want the current default model preserved when refresh fails, so that existing conversations are not broken by network issues.
6. As a Bavi-box user, I want clear stale/offline state, so that I know whether the list is current or cached.
7. As a Bavi-box user, I want the model switch to save and apply to OpenClaw config, so that the next request uses the selected model.
8. As a Bavi-box support operator, I want model catalog refresh errors logged without secrets, so that I can diagnose channel or permission issues safely.
9. As a Bavi-box backend operator, I want New API model calls rate-limited and cached, so that many clients opening the model page do not overload New API.
10. As a Bavi-box developer, I want deterministic tests around catalog normalization, so that upstream response changes do not silently break the UI.
11. As a Bavi-box developer, I want `/api/user/models` and `/v1/models` treated as separate adapters, so that fallback behavior is explicit.
12. As a Bavi-box product owner, I want the PRD to forbid fake model lists, so that UI does not promise unsupported capability.

## Capability Matrix Row

| OpenClaw / New API 原能力 | Bavi-box UI 入口 | 权威调用方式 | 配置来源 | 当前状态 | 验证命令/证据 | 风险 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OpenClaw `models.providers` 配置读写；New API 用户可用模型接口 | 模型页、模型切换弹窗 | Bavi-box Cloud API 代理 `GET /api/user/models`；兜底 `GET /v1/models` | New API 用户权限、Bavi-box 激活态、OpenClaw config | OK to PRD, 待开发 | 本地代码已有激活写 config 与用量 read-side；New API 官方文档确认模型接口存在 | 分类/价格/分组/缓存/权限漂移 | 第一版只同步目录，不改 OpenClaw runtime |

## Proposed API Contract

### Bavi-box Cloud API

```text
GET /v1/newapi/models/catalog
Authorization: Bearer <bavi-box-access-token>
```

Response:

```json
{
  "status": "ok",
  "source": "newapi-user-models",
  "refreshedAt": "2026-08-29T12:00:00Z",
  "ttlSeconds": 300,
  "provider": {
    "id": "newapi",
    "baseUrl": "https://api.example.com/v1",
    "api": "openai-completions"
  },
  "models": [
    {
      "id": "gpt-5.5",
      "name": "gpt-5.5",
      "providerModelId": "gpt-5.5",
      "capabilities": ["text"],
      "groups": [],
      "channelIds": ["1"],
      "available": true,
      "reasoning": false
    }
  ],
  "warnings": []
}
```

降级 response：

```json
{
  "status": "stale",
  "source": "local-cache",
  "refreshedAt": "2026-08-29T11:55:00Z",
  "ttlSeconds": 300,
  "models": [],
  "warnings": ["New API 模型目录暂不可用，继续使用本地缓存。"]
}
```

错误语义：

- `401`：Bavi-box access token 无效，客户端应提示重新激活或重新登录。
- `403`：用户未绑定 New API 账号，不展示云端目录。
- `503`：New API 暂不可用，客户端使用本地缓存。
- `502`：New API 响应结构不符合预期，客户端使用本地缓存并提示稍后再试。

## Normalization Rules

1. `/api/user/models` 返回按 channel id 分组的模型数组时，Cloud API 展平成唯一 model id 列表，并保留 `channelIds`。
2. `/v1/models` 返回 OpenAI list 时，只取 `data[*].id`、`owned_by` 等安全字段。
3. 模型能力分类第一版用规则表，不依赖 New API 单一字段：
   - 包含 `image`、`gpt-image`、`dall`、`flux`、`midjourney`：归入 `image`。
   - 包含 `video`、`jimeng`、`kling`、`runway`：归入 `video`。
   - 其余默认归入 `text`。
4. 可配置 allowlist/denylist 必须在 Cloud API 侧执行，防止不该面向用户的模型进入 UI。
5. 默认模型若不在最新目录中，应保留但标记 `available=false`，要求用户切换，不自动改默认模型。
6. 不从模型名推导价格。价格仍以后续 New API 价格接口或 Bavi-box 定价表为准。

## Implementation Decisions

- 只新增模型目录同步链路，不重写 OpenClaw runtime。
- 后端新增 `newapi.Client.ListUserModels`，优先调用 `/api/user/models`。
- 后端可新增 `newapi.Client.ListV1Models` 作为兜底，但调用前必须明确 token 来源，禁止把明文 token 写入日志。
- 后端新增 `models` 或 `catalog` service，复用 usage service 的用户登录方式：手机号 + 派生密码登录 New API。
- 后端新增 `GET /v1/newapi/models/catalog`，只接受 Bavi-box access token。
- 后端缓存同用户模型目录，建议 TTL 5 分钟；New API 故障时返回最后一次成功缓存与 `status=stale`。
- 桌面端新增 `getCloudModelCatalog()`，走 Bavi-box Cloud API，不直接访问 New API 管理面。
- 桌面端新增 merge 函数，把云端模型写入 OpenClaw config 的 `models.providers.newapi` 或当前 `custom` provider。
- 第一版建议新增 `newapi` provider，减少复用 `custom` / `litellm` 的语义混乱；旧 provider 保留兼容。
- 模型切换弹窗继续从 OpenClaw `runtimeConfig` 读取，避免绕过 OpenClaw 配置系统。
- `patch-openclaw.js` 只补 UI 入口和刷新按钮，不承载复杂业务逻辑；复杂归一逻辑放后端和 Electron helper。
- 不在 PRD 中要求修改 package name、appId、数据库表名前缀或内部环境变量。

## Data Flow

### 首启激活后

```text
激活成功
-> 写入 New API baseUrl/token/defaultModels
-> 异步请求 /v1/newapi/models/catalog
-> 成功：merge models.providers.newapi.models
-> 失败：保留 bundled default models，并在模型页显示云端目录未刷新
```

### 模型页打开

```text
打开模型页
-> 并行读取 OpenClaw usage/config
-> 读取 Bavi-box Cloud API usage summary
-> 读取 Bavi-box Cloud API model catalog
-> 渲染余额、用量、模型能力卡、可用模型弹窗
```

### 手动刷新

```text
点击刷新模型
-> 请求 Cloud API catalog
-> 写入/更新 provider models
-> runtimeConfig.save()
-> runtimeConfig.apply()
-> readback 验证默认模型仍合法
```

## Testing Decisions

- Go 单元测试：
  - `newapi.Client.ListUserModels` 能解析 channel-model map。
  - `newapi.Client.ListV1Models` 能解析 OpenAI list。
  - catalog service 能去重、分类、保留 channel ids、生成 stale fallback。
  - New API 401/403/5xx/invalid JSON 不泄露 token。
- Go HTTP 测试：
  - 未登录访问 `/v1/newapi/models/catalog` 返回 401。
  - 已激活用户返回归一模型目录。
  - New API 故障且有缓存时返回 `status=stale`。
  - New API 故障且无缓存时返回 503。
- Electron/helper 测试：
  - 云端目录 merge 到 `models.providers.newapi.models`。
  - 默认模型不存在时保留但标记不可用，不自动改写。
  - baseUrl 必须保留 `/v1`。
  - 不把 API key 写到导出、日志或错误 toast。
- Control UI patch 验证：
  - 模型页出现“刷新模型”。
  - 模型切换弹窗展示云端同步模型。
  - stale 状态、空目录状态、刷新失败状态可见。
  - `npm run patch-openclaw` 二次执行无 diff。
- 集成验收：
  - 本地 New API 起一个含两类模型的测试实例。
  - 激活后打开模型页，能看到云端模型。
  - 新增/禁用 New API 模型后刷新，桌面列表变化。
  - 选择新模型后发起一次文本请求成功。

## Risk Matrix

| 风险 | 影响 | 概率 | 等级 | 缓解 |
| --- | --- | --- | --- | --- |
| New API `/api/user/models` 返回结构在版本间变化 | 模型目录解析失败 | 中 | 高 | adapter 单测覆盖 map/list/empty；invalid JSON 返回 stale/503 |
| `/v1/models` 只给模型 id，不给能力/价格/分组 | UI 分类错误或价格误导 | 高 | 高 | 第一版不展示价格；能力分类用规则表并允许 Cloud API allowlist 覆盖 |
| 用户 token 或 dashboard token 泄露 | 账号额度风险 | 低到中 | 高 | 桌面不直连管理面；后端日志脱敏；错误不带 header/body；禁止持久化明文 token |
| New API 管理面被大量客户端刷新压垮 | 模型页变慢，New API 负载升高 | 中 | 中 | Cloud API per-user cache + rate limit + background refresh |
| 云端模型目录与 OpenClaw 当前 provider 不一致 | 选择后请求失败 | 中 | 高 | merge 后 readback；可选探活；失败保留旧默认并提示 |
| 图片/视频模型经 adapter 才能用 | 云端列表不能直接执行 | 高 | 高 | text/image/video 分 provider 管理；视频继续走 adapter provider，不直接等同 New API 原生模型 |
| 上游渠道临时禁用但缓存仍显示 | 用户选择 stale 模型失败 | 中 | 中 | TTL 短；stale UI 明示；失败时回到模型页提示刷新 |
| 自动刷新改写用户手动配置 | 用户默认模型被意外覆盖 | 中 | 高 | 目录同步只改 catalog，不自动改 defaults；用户确认后才改默认 |
| New API baseUrl 与 client baseUrl 不一致 | `/v1/models` 或调用失败 | 中 | 中 | config 校验要求 client baseUrl 以 `/v1` 结尾；admin base 与 client base 分离 |
| AGPL/上游合规理解错误 | 商业发布风险 | 低到中 | 中 | 只调用 API 不复制 New API 代码；保留部署和合规说明 |

## Out of Scope

- 不实现代码。
- 不改 OpenClaw provider runtime。
- 不做 New API channel 管理 UI。
- 不做价格同步和套餐定价改造。
- 不做模型测速、排行榜或自动择优路由。
- 不把 New API admin token 下发到桌面端。
- 不删除现有本地静态默认模型。

## Acceptance Criteria

1. 激活用户打开模型页后，可看到来自云端 New API 的可用模型目录。
2. New API 不可用时，模型页不崩溃，展示本地缓存或清晰失败态。
3. 模型切换弹窗只把云端可用模型作为优先候选。
4. 选择模型后写入 OpenClaw config，并 readback 验证。
5. 不泄露 New API admin token、用户 API key、dashboard access token。
6. 不改变充值、余额、用量、文本聊天既有链路。
7. Mac/Windows 便携包启动链路不受影响。
8. 所有新增接口和同步行为有单元测试、HTTP 测试和 patch verifier。

## Rollout Plan

1. Phase 0：本地 New API 实例验证 `/api/user/models` 和 `/v1/models` 实际响应。
2. Phase 1：后端 `newapi.Client` 和 catalog service。
3. Phase 2：Cloud API endpoint + cache/rate limit。
4. Phase 3：Electron helper 拉取并 merge OpenClaw config。
5. Phase 4：模型页 UI 增加刷新、stale、云端来源标识。
6. Phase 5：E2E 验收：激活、刷新目录、切换模型、发起一次文本请求。

## Open Questions

1. New API 生产实例 `/api/user/models` 的真实响应是否与官方文档一致。
2. 是否要把 provider 命名从 `custom` 收口到 `newapi`，还是继续兼容现有 `custom` / `litellm`。
3. 图片模型是否仍固定 `litellm/gpt-image-2`，还是允许云端目录驱动。
4. 视频模型是否只走 Bavi-box video adapter，还是将 New API 原生 video 模型纳入候选。
5. Cloud API 是否需要持久化最近成功目录，还是只做内存 TTL cache。

## Recommended First Slice

第一刀只做“用户可用文字模型目录”：

```text
GET /v1/newapi/models/catalog
-> Cloud API 登录 New API
-> 调 /api/user/models
-> 返回 text models
-> Electron merge 到 models.providers.newapi.models
-> 模型弹窗显示云端候选
```

这刀风险低、可验收、不会碰图片/视频 adapter，也不会改变默认模型自动选择逻辑。
