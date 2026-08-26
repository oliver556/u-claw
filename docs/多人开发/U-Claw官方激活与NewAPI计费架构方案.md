# U-Claw 官方激活与 New API 计费架构方案

更新时间：2026-08-26

## 1. 背景

U-Claw 桌面客户端当前已具备模型页，可展示余额、用量、模型能力、运行状态、趋势和流水。下一步需要把这些数据接入真实的商业化后端体系。

本方案目标是定义：

- U-Claw 官方激活服务如何管理手机号账号、短信登录、激活码和 U 盘权益。
- U-Claw 激活服务如何自动创建 New API 用户、生成/轮换 token、发放初始额度。
- U-Claw 充值按钮如何接微信/支付宝官方支付，并在支付成功后自动给 New API 用户加 quota。
- U-Claw 客户端如何保存 New API token，并直接请求 New API endpoint。
- 模型页余额、充值记录、使用流水如何以 New API 为准展示。

本文为方案评审与后续开发分期文档，不直接修改现有 OpenClaw runtime。

## 2. 已确认决策

| 领域 | 决策 |
| --- | --- |
| U-Claw 官方服务 | 阿里云服务器，只承载账号、激活、订单、支付回调、New API 管理编排 |
| New API 服务 | OVH 高配服务器，部署 New API + sub2api，承载模型调用、quota、余额、消费流水 |
| 网络入口 | 香港直连服务器部署 1Panel + Nginx，作为 New API 前置反代 |
| 客户端模型调用 | U-Claw 本地 OpenClaw 直接请求香港 New API endpoint |
| 用户身份 | 手机号 + 阿里云短信验证码 |
| 激活码 | 阿里云后端批量生成，随 U 盘发放，一次性绑定首个手机号 |
| New API username | 使用手机号，与 U-Claw 账号同名 |
| New API password | 强随机生成，用户不可见 |
| New API token | 阿里云不长期保存；客户端 U 盘本地加密保存 |
| token 恢复 | 手机号验证码登录后，阿里云调用 New API 重新生成 token，旧 token 作废 |
| token 数量 | 一个手机号账号共用一个 New API token |
| 初始额度 | 激活码开通后赠送小额 New API quota |
| 充值 | U-Claw 阿里云后端创建微信/支付宝订单，支付回调后异步调用 New API 加 quota |
| 使用流水 | 不在阿里云保存完整副本，以 New API 为准；阿里云最多保存短期缓存/快照 |
| 充值记录 | 阿里云保存支付订单和回调审计；New API 保存 quota 变动与消费口径 |
| 退款 | MVP 不做自动退款，只支持人工后台标记与人工处理 |
| 技术栈 | Go + Gin/Echo + pgx/sqlc + PostgreSQL + Redis + asynq worker |
| 管理后台 | 先做最小管理后台/API |

## 3. 总体架构

```text
U-Claw Client
  ├─ 本地 OpenClaw 模型请求
  │    └─ HTTPS -> 香港 Nginx -> OVH New API -> sub2api / 上游渠道
  │
  ├─ 激活 / 登录 / 恢复 / 充值下单 / 订单状态
  │    └─ HTTPS -> 阿里云 U-Claw Cloud API
  │
  └─ 余额 / 用量 / 流水展示
       └─ HTTPS -> 香港 Nginx -> OVH New API

阿里云 U-Claw Cloud API
  ├─ PostgreSQL：用户、激活码、New API 映射、支付订单、回调、审计
  ├─ Redis：短信验证码、限流、异步任务队列
  ├─ Worker：New API 创建用户、生成 token、加 quota、轮换 token、补偿重试
  ├─ 阿里云短信：手机号验证码
  ├─ 微信/支付宝官方支付：下单与回调
  └─ 管理调用：HTTPS -> 香港 Nginx 管理专用路径 -> OVH New API Admin API

香港 Nginx
  ├─ 客户端 OpenAI-compatible API 路径
  ├─ 客户端 New API 余额/流水查询路径
  └─ 管理专用路径：仅允许阿里云服务器 IP，带强 admin token / mTLS

OVH New API
  ├─ New API 用户、token、quota
  ├─ 模型调用与消费流水
  └─ sub2api 号池/上游渠道适配
```

## 4. 服务边界

### 4.1 阿里云 U-Claw Cloud API

负责：

- 手机号短信验证码发送与登录。
- 激活码校验、绑定、作废、批次管理。
- 自动创建 New API 用户。
- 自动创建 / 轮换 New API token。
- 保存 U-Claw 用户与 New API 用户映射。
- 生成微信/支付宝支付订单。
- 验证支付回调，保存回调审计。
- 异步调用 New API 给用户加 quota。
- 支持客户端查询充值订单状态。
- 支持客户端恢复 token。
- 支持最小管理后台查询用户、激活码、订单、补偿任务。

不负责：

- 不承载模型推理流量。
- 不作为模型请求代理。
- 不保存完整 New API 消费流水副本。
- 不作为余额扣费 source of truth。
- 不长期保存 New API token 明文或可解密密文。

### 4.2 OVH New API + sub2api

负责：

- New API 用户、token、quota。
- OpenAI-compatible API 调用。
- 模型用量、余额、消费流水。
- sub2api 上游渠道号池与自有渠道承载。
- 充值后的 quota 实际入账。

### 4.3 香港 Nginx

负责：

- 给客户端提供稳定 New API endpoint。
- 隐藏 OVH 源站。
- TLS、限流、日志、健康检查。
- 为阿里云后端提供 New API 管理接口专用入口。

要求：

- 客户端路径与管理路径分离。
- 管理路径只允许阿里云服务器 IP。
- Nginx 日志不得记录 `Authorization`。
- 管理路径建议额外启用 mTLS 或二级 admin secret。

## 5. 核心流程

### 5.1 首次激活

```text
1. 用户打开 U-Claw 客户端。
2. 输入手机号，请求短信验证码。
3. 阿里云发送验证码，并做频率限制。
4. 用户输入验证码 + 激活码。
5. 阿里云校验：
   - 手机号验证码有效。
   - 激活码存在。
   - 激活码未绑定。
   - 激活码未作废。
6. 阿里云生成 New API password。
7. 阿里云调用 New API：POST /api/user/ 创建用户。
   - username = 手机号。
   - password = 强随机。
8. 因 New API 创建接口只返回 success，不返回 user id：
   - 通过 username 搜索/查询拿 user id；或
   - 用该账号登录后获取用户信息。
9. 阿里云用 New API 用户身份创建 API token：POST /api/token/。
10. 阿里云保存映射：
    - user_id
    - phone
    - activation_code_id
    - newapi_user_id
    - newapi_username
    - newapi_base_url
    - token_version
    - 不保存明文 API key
11. 阿里云调用 New API 管理接口给初始 quota。
12. 客户端收到 baseUrl + token + 默认模型配置。
13. 客户端本地加密保存 token，并写入 OpenClaw 配置。
14. 激活完成。
```

失败处理：

- New API 创建用户成功但查询 user id 失败：写入 `newapi_admin_jobs`，进入补偿重试。
- token 创建失败：用户状态为 `pending_token`，客户端显示“账号准备中”。
- 初始 quota 发放失败：激活可先完成，但显示“赠送额度发放中”，worker 重试。

### 5.2 充值

```text
1. 用户在模型页点击“充值”。
2. 客户端请求阿里云创建充值订单。
3. 阿里云按套餐表生成订单：
   - amount
   - quota
   - channel = wechat / alipay
   - status = pending
4. 阿里云返回支付二维码或支付页面 URL。
5. 用户完成支付。
6. 微信/支付宝回调阿里云。
7. 阿里云验签、幂等检查、保存 raw callback。
8. 订单状态从 pending -> paid。
9. worker 异步领取加 quota 任务。
10. worker 调 New API /api/user/manage 给 newapi_user_id 加 quota。
11. 成功后订单状态 paid -> credited。
12. 客户端轮询订单状态，看到 credited 后刷新 New API 余额。
```

状态原则：

- 支付回调必须快进快出。
- New API 加 quota 不在支付回调同步阻塞完成。
- 所有加 quota 请求必须有幂等键。
- 重复支付回调不得重复加 quota。

### 5.3 token 恢复 / U 盘丢失恢复

```text
1. 用户重新安装或更换 U 盘后打开客户端。
2. 手机号 + 短信验证码登录。
3. 客户端请求恢复 New API 配置。
4. 阿里云查询手机号绑定的 newapi_user_id。
5. 阿里云调用 New API 管理接口轮换 token。
6. 旧 token 作废。
7. 阿里云下发新 token + baseUrl + 默认模型配置。
8. 客户端本地加密保存，并写入 OpenClaw 配置。
9. 其他旧设备需要重新登录同步。
```

### 5.4 模型页数据展示

```text
1. 客户端进入模型页。
2. 客户端使用本地 New API token 请求香港 New API endpoint。
3. 查询：
   - 余额 / quota。
   - 使用流水。
   - 充值或 quota 变动记录，如 New API 支持。
4. U-Claw 页面按 New API 原生 quota 展示。
5. 可辅助显示约人民币 / 约 token，但不作为对账口径。
```

说明：

- 阿里云不保存完整消费流水。
- 若 New API 查询接口不可用，页面显示“New API 数据暂不可用”。
- 可在客户端做短期缓存，但 source of truth 仍是 New API。

## 6. 数据模型草案

### 6.1 users

```sql
id UUID PRIMARY KEY
phone VARCHAR(32) UNIQUE NOT NULL
status VARCHAR(32) NOT NULL
created_at TIMESTAMPTZ NOT NULL
updated_at TIMESTAMPTZ NOT NULL
last_login_at TIMESTAMPTZ
```

### 6.2 sms_codes

```sql
id UUID PRIMARY KEY
phone VARCHAR(32) NOT NULL
purpose VARCHAR(32) NOT NULL
code_hash TEXT NOT NULL
expires_at TIMESTAMPTZ NOT NULL
consumed_at TIMESTAMPTZ
ip INET
created_at TIMESTAMPTZ NOT NULL
```

### 6.3 activation_batches

```sql
id UUID PRIMARY KEY
name TEXT NOT NULL
channel TEXT
initial_quota BIGINT NOT NULL DEFAULT 0
total_count INT NOT NULL
created_by UUID
created_at TIMESTAMPTZ NOT NULL
```

### 6.4 activation_codes

```sql
id UUID PRIMARY KEY
batch_id UUID NOT NULL
code_hash TEXT UNIQUE NOT NULL
status VARCHAR(32) NOT NULL
bound_user_id UUID
activated_at TIMESTAMPTZ
revoked_at TIMESTAMPTZ
created_at TIMESTAMPTZ NOT NULL
```

状态：

- `unused`
- `activated`
- `revoked`

### 6.5 newapi_accounts

```sql
id UUID PRIMARY KEY
user_id UUID UNIQUE NOT NULL
newapi_user_id TEXT UNIQUE NOT NULL
newapi_username VARCHAR(32) UNIQUE NOT NULL
newapi_base_url TEXT NOT NULL
status VARCHAR(32) NOT NULL
token_version INT NOT NULL DEFAULT 1
last_token_rotated_at TIMESTAMPTZ
created_at TIMESTAMPTZ NOT NULL
updated_at TIMESTAMPTZ NOT NULL
```

注意：

- `newapi_username` 当前决策为手机号。
- 不保存 New API token 明文。
- 不保存可解密 token。

### 6.6 recharge_plans

```sql
id UUID PRIMARY KEY
name TEXT NOT NULL
amount_cents BIGINT NOT NULL
quota BIGINT NOT NULL
status VARCHAR(32) NOT NULL
sort_order INT NOT NULL DEFAULT 0
created_at TIMESTAMPTZ NOT NULL
updated_at TIMESTAMPTZ NOT NULL
```

### 6.7 recharge_orders

```sql
id UUID PRIMARY KEY
order_no TEXT UNIQUE NOT NULL
user_id UUID NOT NULL
plan_id UUID NOT NULL
amount_cents BIGINT NOT NULL
quota BIGINT NOT NULL
channel VARCHAR(32) NOT NULL
status VARCHAR(32) NOT NULL
payment_trade_no TEXT
paid_at TIMESTAMPTZ
credited_at TIMESTAMPTZ
failed_reason TEXT
created_at TIMESTAMPTZ NOT NULL
updated_at TIMESTAMPTZ NOT NULL
```

状态：

- `pending`
- `paid`
- `crediting`
- `credited`
- `credit_failed`
- `closed`
- `manual_refund`

### 6.8 payment_callbacks

```sql
id UUID PRIMARY KEY
order_no TEXT NOT NULL
channel VARCHAR(32) NOT NULL
event_type TEXT
raw_payload JSONB NOT NULL
verify_status VARCHAR(32) NOT NULL
received_at TIMESTAMPTZ NOT NULL
```

### 6.9 newapi_admin_jobs

```sql
id UUID PRIMARY KEY
type VARCHAR(64) NOT NULL
idempotency_key TEXT UNIQUE NOT NULL
payload JSONB NOT NULL
status VARCHAR(32) NOT NULL
retry_count INT NOT NULL DEFAULT 0
last_error TEXT
next_run_at TIMESTAMPTZ
created_at TIMESTAMPTZ NOT NULL
updated_at TIMESTAMPTZ NOT NULL
```

任务类型：

- `create_newapi_user`
- `create_newapi_token`
- `grant_initial_quota`
- `credit_recharge_quota`
- `rotate_newapi_token`

### 6.10 audit_logs

```sql
id UUID PRIMARY KEY
actor_type VARCHAR(32) NOT NULL
actor_id UUID
action TEXT NOT NULL
target_type TEXT
target_id TEXT
metadata JSONB
created_at TIMESTAMPTZ NOT NULL
```

## 7. API 草案

### 7.1 手机号验证码

```http
POST /v1/auth/sms/send
Content-Type: application/json

{
  "phone": "13800138000",
  "purpose": "login"
}
```

```http
POST /v1/auth/sms/login
Content-Type: application/json

{
  "phone": "13800138000",
  "code": "123456"
}
```

返回：

```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "user": {
    "id": "...",
    "phone": "138****8000"
  }
}
```

### 7.2 激活

```http
POST /v1/activation/redeem
Authorization: Bearer <uclaw_access_token>
Content-Type: application/json

{
  "activationCode": "XXXX-XXXX-XXXX"
}
```

返回：

```json
{
  "status": "activated",
  "newApi": {
    "baseUrl": "https://api.u-claw.example.com/v1",
    "apiKey": "sk-...",
    "username": "13800138000",
    "tokenVersion": 1
  },
  "defaults": {
    "textModel": "custom/gpt-5.5",
    "imageModel": "litellm/gpt-image-2",
    "videoModel": "xai/jimeng-video-3-720p"
  }
}
```

### 7.3 恢复 token

```http
POST /v1/newapi/token/rotate
Authorization: Bearer <uclaw_access_token>
Content-Type: application/json

{
  "reason": "restore_device"
}
```

返回：

```json
{
  "baseUrl": "https://api.u-claw.example.com/v1",
  "apiKey": "sk-...",
  "tokenVersion": 2
}
```

### 7.4 充值套餐

```http
GET /v1/recharge/plans
Authorization: Bearer <uclaw_access_token>
```

返回：

```json
{
  "plans": [
    {
      "id": "plan_50",
      "name": "基础充值",
      "amountCents": 5000,
      "quota": 500000
    }
  ]
}
```

### 7.5 创建充值订单

```http
POST /v1/recharge/orders
Authorization: Bearer <uclaw_access_token>
Content-Type: application/json

{
  "planId": "plan_50",
  "channel": "alipay"
}
```

返回：

```json
{
  "orderNo": "UC202608260001",
  "status": "pending",
  "payUrl": "https://pay.u-claw.example.com/orders/UC202608260001",
  "qrCodeUrl": "https://..."
}
```

### 7.6 查询订单状态

```http
GET /v1/recharge/orders/{orderNo}
Authorization: Bearer <uclaw_access_token>
```

返回：

```json
{
  "orderNo": "UC202608260001",
  "status": "credited",
  "amountCents": 5000,
  "quota": 500000,
  "paidAt": "2026-08-26T10:10:00Z",
  "creditedAt": "2026-08-26T10:10:03Z"
}
```

### 7.7 支付回调

```http
POST /v1/payments/wechat/notify
POST /v1/payments/alipay/notify
```

要求：

- 必须验签。
- 必须幂等。
- 必须保存 raw callback。
- 必须先落库为 `paid`，再交给 worker 加 quota。

## 8. New API 管理接口依赖

已知限制：

- `POST /api/user/` 创建用户只返回 success，不直接返回 user id。

自动开通流程必须验证：

1. 用 username 创建 New API 用户。
2. 用 username 查询 user id，或用该账号登录后获取 user id。
3. 用该用户身份创建 API token：`POST /api/token/`。
4. 支付成功后调用 `/api/user/manage` 给用户加 quota。
5. 恢复时调用 New API 管理能力重新生成 token，并废弃旧 token。
6. 客户端普通 New API token 可查询余额、使用流水、充值记录或 quota 变动记录。

## 9. 安全要求

### 9.1 手机号与 PII

当前决策接受 New API username = 手机号，因此必须落地最小保护：

- Nginx 日志不得记录 query 中敏感参数。
- Nginx 日志不得记录 `Authorization`。
- New API admin 后台只允许白名单 IP。
- OVH DB 备份必须加密。
- 阿里云后台展示手机号默认脱敏。
- 日志保留期必须有限制。
- 导出文件必须加水印或审计。

### 9.2 New API Admin Token

- 只存阿里云服务器环境变量或 secret manager。
- 不进 Git。
- 不进客户端。
- 不进数据库。
- 管理接口加 IP 白名单。
- 建议香港 Nginx 管理路径加 mTLS。

### 9.3 New API 用户 token

- 阿里云不长期保存 token。
- 客户端 U 盘 portable data 保存本地加密 token。
- 本地加密密钥由手机号登录态 + 服务端下发设备密钥派生。
- U 盘丢失后走 token 轮换，旧 token 作废。

### 9.4 支付

- 微信/支付宝私钥只在阿里云后端。
- 客户端不得持有支付证书或密钥。
- 支付回调必须验签。
- 支付订单与 New API 加 quota 必须幂等。

## 10. 客户端改造点

### 10.1 激活页

需要支持：

- 手机号输入。
- 短信验证码。
- 激活码输入。
- 激活状态展示。
- 账号准备中 / token 创建中 / 初始额度发放中。
- 激活成功后自动写入 OpenClaw 配置。

### 10.2 本地配置写入

激活或恢复成功后写入：

- New API baseUrl。
- New API token。
- 默认文字模型。
- 默认图片模型。
- 默认视频模型。

要求：

- 写入前备份旧配置。
- 若用户已有自定义配置，提示覆盖或合并。
- token 本地加密保存。

### 10.3 模型页

模型页数据源改造：

- 余额：从 New API 查询。
- 今日用量、近 7 天、累计流水：从 New API 查询。
- 使用流水：从 New API 查询。
- 充值按钮：打开阿里云充值订单支付页。
- 充值后：轮询阿里云订单状态，到 `credited` 后刷新 New API 余额。

### 10.4 恢复流程

需要支持：

- 手机号验证码登录。
- 请求阿里云轮换 New API token。
- 本地重写 token。
- 告知用户旧设备需要重新登录。

## 11. 管理后台 MVP

先做最小后台或管理 API：

- 激活码批次生成。
- 激活码导出。
- 激活码查询。
- 激活码作废。
- 用户查询。
- 用户绑定的 New API user id 查询。
- 充值订单查询。
- 支付回调查看。
- New API 加 quota 任务查看。
- 失败任务手动重试。
- 客服人工换绑手机号。
- 退款人工标记。

不做：

- 完整 BI 报表。
- 自动退款。
- 渠道复杂结算。
- 多角色复杂权限。

## 12. P0 Spike

正式开发前必须用计划部署的 New API Docker tag 实测。

### 12.1 New API 管理能力

- 创建用户。
- 创建用户后按 username 查 user id。
- 创建 API token。
- 轮换 / 作废 token。
- add quota。
- 查询用户余额。
- 查询使用流水。
- 查询 quota 变动或充值记录。

### 12.2 香港 Nginx

- 客户端模型调用路径。
- 客户端余额/流水查询路径。
- 阿里云管理专用路径。
- 管理路径 IP 白名单。
- Authorization 日志屏蔽。
- 高并发连接与超时配置。

### 12.3 支付

- 微信官方支付下单。
- 支付宝官方支付下单。
- 回调验签。
- 重复回调幂等。
- 支付成功但 New API 暂时不可用时补偿重试。

### 12.4 客户端

- 激活后自动写入 OpenClaw 配置。
- 本地 token 加密保存。
- token 轮换后旧 token 失效。
- 模型页能用普通 New API token 查余额/流水。

## 13. 分期计划

### Phase 0: Spike 与冻结接口

目标：

- 验证 New API 管理 API。
- 验证香港 Nginx 路径。
- 验证支付回调可跑通。

验收：

- 有脚本或 curl 记录证明创建用户、创建 token、add quota、查余额/流水可行。
- 明确 New API Docker tag。
- 明确所有 endpoint。

### Phase 1: 阿里云账号与激活服务

范围：

- Go 项目初始化。
- PostgreSQL schema。
- 阿里云短信。
- 手机号登录。
- 激活码批次生成。
- 激活码兑换。
- New API 自动创建用户。
- New API token 创建。
- 初始 quota 发放。

验收：

- 新手机号 + 激活码可完成激活。
- New API 中能看到同手机号用户。
- 客户端能拿到 baseUrl/token。
- 激活码不可重复使用。

### Phase 2: 客户端激活与配置写入

范围：

- U-Claw 激活 UI。
- 自动写入 OpenClaw 配置。
- 本地 token 加密保存。
- 激活状态处理。

验收：

- 用户无需手工复制 key。
- 激活后可直接发起模型请求。
- 本地配置丢失后可重新登录恢复。

### Phase 3: 充值闭环

范围：

- 充值套餐表。
- 微信/支付宝官方支付下单。
- 支付回调。
- 订单状态机。
- worker 异步加 quota。
- 客户端订单轮询。

验收：

- 支付成功后订单进入 `credited`。
- New API 用户 quota 增加。
- 重复回调不重复加 quota。
- New API 故障时任务进入重试队列。

### Phase 4: 模型页真实数据接入

范围：

- 客户端用 New API token 查余额。
- 客户端用 New API token 查使用流水。
- 充值按钮接阿里云下单。
- 订单 credited 后刷新余额。

验收：

- 模型页不再显示“未接入”。
- 余额、用量、流水与 New API 后台一致。
- New API 查询失败时有明确降级态。

### Phase 5: 管理后台 MVP

范围：

- 激活码管理。
- 用户查询。
- 订单查询。
- 回调审计。
- New API 任务重试。
- 人工换绑。

验收：

- 客服能通过手机号查激活状态、New API user id、订单状态。
- 失败加 quota 可手动重试。
- 激活码可批量导出和作废。

## 14. 风险与对策

### 风险 1: New API 管理 API 与预期不一致

对策：

- Phase 0 必须先实测。
- 若 token 创建或 add quota 只能后台操作，不进入正式开发。

### 风险 2: 手机号进入 New API 与 OVH 日志

对策：

- Nginx 日志脱敏。
- DB 备份加密。
- admin 白名单。
- 后台展示脱敏。

### 风险 3: 支付成功但 New API 加 quota 失败

对策：

- 支付回调只落库为 `paid`。
- worker 异步加 quota。
- 幂等键。
- 重试队列。
- 管理后台手动补偿。

### 风险 4: U 盘丢失导致 token 泄漏

对策：

- token 本地加密。
- 恢复时轮换 token。
- 旧 token 作废。
- 客户端提示其他设备重新登录。

### 风险 5: 香港 Nginx 成为单点

对策：

- 健康检查。
- 连接数与超时优化。
- 后续可加第二台香港入口。
- 客户端配置 baseUrl 可远程更新。

## 15. 评审结论

方案可推进。

Go 后端适合承担阿里云 U-Claw Cloud API：账号、激活码、支付订单、支付回调、New API 管理编排、补偿任务。不要让阿里云服务承载模型推理，也不要复制完整 New API 消费账本。

New API 继续作为余额、quota、消费流水的 source of truth。U-Claw 客户端本地 OpenClaw 直接请求香港反代后的 New API endpoint。充值资金链路由阿里云创建订单和验签，到账动作由 worker 幂等调用 New API add quota。

正式开工前必须先完成 P0 Spike，尤其验证 New API Docker tag 下的创建用户、查询 user id、创建 token、add quota、查余额/流水能力。
