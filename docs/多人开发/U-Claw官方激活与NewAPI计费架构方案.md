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

### 3.1 项目结构与代码位置

当前仓库已有三个容易混淆的位置：

```text
<repo>/u-claw-app
<repo>/product
<repo>/u-claw-app-dev
```

根据 `docs/多人开发/开发硬性要求.md`：

- `u-claw-app` 是归档原版 OpenClaw Electron 桌面壳，禁止修改。
- `product` 是旧版本产品工程，当前不作为本轮开发对象，禁止继续在里面开发。
- `u-claw-app-dev` 是本轮正式开发目录。

因此，U-Claw 官方激活与 New API 计费后端的新代码应放在：

```text
<repo>/u-claw-app-dev/cloud/uclaw-cloud-api
```

不要放在：

```text
<repo>/product/activation-server
<repo>/product/*
<repo>/u-claw-app/*
```

原因：

- 遵守当前多人开发硬性边界。
- 避免把新阿里云后端写进已归档或旧产品目录。
- 让 U-Claw 客户端、Control UI patch、云端后端都收口在 `u-claw-app-dev` 这一本轮工作目录下。
- 后续打包或部署时，可明确区分客户端工程与云端服务工程。

建议新建目录结构：

```text
u-claw-app-dev/
  cloud/
    uclaw-cloud-api/
      cmd/
        api/
          main.go
        worker/
          main.go
        adminctl/
          main.go
      internal/
        auth/
        activation/
        newapi/
        recharge/
        payment/
        sms/
        config/
        db/
        jobs/
      migrations/
      api/
        openapi.yaml
      deploy/
        Dockerfile
        docker-compose.dev.yml
        nginx-admin-route.example.conf
      docs/
        spike-results.md
      go.mod
      README.md
```

目录职责：

| 路径 | 职责 |
| --- | --- |
| `cmd/api` | 阿里云 U-Claw Cloud API HTTP 服务 |
| `cmd/worker` | 异步任务：创建 New API 用户、创建/轮换 token、加 quota、补偿重试 |
| `cmd/adminctl` | 激活码批量生成、导出、P0 Spike 命令行工具 |
| `internal/auth` | 手机号、短信验证码、JWT 登录态 |
| `internal/activation` | 激活码、批次、绑定、作废 |
| `internal/newapi` | New API Admin/User API client |
| `internal/recharge` | 充值套餐、订单、订单状态机 |
| `internal/payment` | 微信/支付宝官方支付下单、验签、回调 |
| `internal/sms` | 阿里云短信适配 |
| `internal/db` | PostgreSQL 查询、事务、migration 集成 |
| `internal/jobs` | Redis/asynq 任务定义与处理器 |
| `migrations` | PostgreSQL schema migration |
| `api/openapi.yaml` | 客户端与后台 API 契约 |
| `deploy` | Docker、开发 compose、Nginx 示例配置 |
| `docs/spike-results.md` | Phase 0 Spike 实测记录 |

客户端侧改造仍保留在现有路径：

```text
u-claw-app-dev/scripts/patch-openclaw.js
u-claw-app-dev/resources/*
u-claw-app-dev/src/*
```

边界要求：

- 云端后端代码只写入 `u-claw-app-dev/cloud/uclaw-cloud-api`。
- 客户端 UI 与 OpenClaw Control UI patch 仍走 `u-claw-app-dev/scripts/patch-openclaw.js`。
- `product/activation-server` 只允许作为历史参考，不允许继续开发。
- 不在客户端保存支付密钥、New API admin token、阿里云短信密钥。
- New API admin endpoint、支付密钥、短信密钥只通过云端服务环境变量或 secret manager 注入。

### 3.2 阿里云 1 核 1G 打包与部署策略

阿里云 U-Claw Cloud API 会单独部署到一台 1 核 1G ECS。该机器只承载激活、账号、订单、支付回调、New API 管理编排，不承载模型请求、不部署 New API、不部署 sub2api。

#### 3.2.1 代码位置与部署位置

开发态代码位置：

```text
<repo>/u-claw-app-dev/cloud/uclaw-cloud-api
```

生产态部署位置：

```text
/opt/uclaw-cloud-api
/etc/uclaw-cloud-api/uclaw-cloud-api.env
/var/log/uclaw-cloud-api
```

二者关系：

- 仓库保存源码、migration、Dockerfile、systemd 模板、部署脚本。
- CI 或本地 release 脚本产出 Linux 二进制和 migration。
- 阿里云 ECS 只接收 release 包，不直接作为开发目录。

建议 release 包结构：

```text
uclaw-cloud-api-linux-amd64.tar.gz
  bin/
    uclaw-cloud-api
    uclaw-adminctl
  migrations/
    000001_init.sql
  deploy/
    systemd/
      uclaw-cloud-api.service
    nginx/
      uclaw-cloud-api.conf
    env/
      uclaw-cloud-api.env.example
  README.md
```

#### 3.2.2 推荐部署方式

推荐优先使用：

```text
Go static binary + systemd + Nginx + PostgreSQL
```

不推荐在 1 核 1G MVP 阶段使用：

```text
Docker Compose 同机部署 Go API + PostgreSQL + Redis + Admin UI
```

原因：

- 1G 内存下，Docker daemon、PostgreSQL、Redis、Nginx、Go API 同机运行余量很小。
- 支付回调与激活链路要求稳定，不能因内存抖动导致进程被 OOM kill。
- U-Claw Cloud API 的主要负载是短请求和少量补偿任务，Go binary + systemd 足够。

#### 3.2.3 数据库与队列取舍

首选方案：

```text
阿里云 ECS：Go API + worker + Nginx
阿里云 RDS PostgreSQL 或独立 PostgreSQL：业务数据
```

如果预算要求全部放在 1 核 1G ECS：

```text
阿里云 ECS：Go API + worker + Nginx + 本机 PostgreSQL
```

此时 MVP 不引入 Redis/asynq，先使用 PostgreSQL job/outbox 表做异步任务与补偿重试：

- 支付回调只落库订单和回调审计。
- `payment_orders` 从 `paid` 进入待入账状态。
- worker 低并发扫描 job/outbox 表。
- worker 幂等调用 New API add quota。
- 成功后订单进入 `credited`。

Redis 可作为 Phase 3+ 增强项，不作为 1 核 1G MVP 必需项。

#### 3.2.4 进程模型

MVP 使用单个 Go binary，多模式启动：

```text
uclaw-cloud-api serve
uclaw-cloud-api worker
uclaw-adminctl activation generate
uclaw-adminctl spike newapi
```

1 核 1G 生产建议：

- `serve` 与 `worker` 可以先合并为同一 systemd service 内的单进程模式。
- worker 并发固定为 1。
- HTTP server 连接池和 PostgreSQL 连接池收紧。
- 后续订单量上升后，再拆成独立 `uclaw-cloud-worker.service`。

#### 3.2.5 systemd 服务建议

服务文件放在仓库：

```text
u-claw-app-dev/cloud/uclaw-cloud-api/deploy/systemd/uclaw-cloud-api.service
```

生产安装到：

```text
/etc/systemd/system/uclaw-cloud-api.service
```

运行约束：

- `Restart=always`
- `RestartSec=3`
- `EnvironmentFile=/etc/uclaw-cloud-api/uclaw-cloud-api.env`
- `WorkingDirectory=/opt/uclaw-cloud-api`
- `User=uclaw`
- `NoNewPrivileges=true`

#### 3.2.6 Nginx 与 HTTPS

阿里云 ECS 上只需要轻量 Nginx：

- 公开路径：登录、短信、激活、恢复、充值下单、支付回调、订单状态。
- 管理后台路径：只允许管理员 IP 或额外管理鉴权。
- 健康检查：`/healthz`、`/readyz`。

不建议在该 1 核 1G 机器上安装 1Panel。1Panel 继续留给香港反代机器或更高配置运维机。

#### 3.2.7 配置与密钥

所有生产密钥只放服务器环境文件或云厂商 secret manager：

```text
/etc/uclaw-cloud-api/uclaw-cloud-api.env
```

至少包含：

- `DATABASE_URL`
- `JWT_SECRET`
- `ALIYUN_SMS_ACCESS_KEY_ID`
- `ALIYUN_SMS_ACCESS_KEY_SECRET`
- `WECHAT_PAY_*`
- `ALIPAY_*`
- `NEWAPI_ADMIN_BASE_URL`
- `NEWAPI_ADMIN_TOKEN`

文件权限：

```text
chown root:uclaw /etc/uclaw-cloud-api/uclaw-cloud-api.env
chmod 0640 /etc/uclaw-cloud-api/uclaw-cloud-api.env
```

#### 3.2.8 发布流程

MVP 发布流程：

1. 本地或 CI 构建 Linux amd64 binary。
2. 打包 `bin/`、`migrations/`、`deploy/`。
3. 上传到阿里云 `/opt/uclaw-cloud-api/releases/<version>`。
4. 执行 migration。
5. 切换 `/opt/uclaw-cloud-api/current` 软链接。
6. `systemctl restart uclaw-cloud-api`。
7. 检查 `/healthz`、短信发送、激活码兑换、支付回调模拟、New API add quota spike。

#### 3.2.9 最小资源配置

1 核 1G 下建议：

- 开 1-2G swap，只作为兜底，不依赖 swap 承载常态压力。
- Go 进程目标常驻内存小于 150MB。
- PostgreSQL 连接池小于 10。
- worker 并发为 1。
- 日志走 journald + logrotate，不落巨大业务日志。
- 支付 raw callback 只存必要字段和脱敏原文，不无限增长。

#### 3.2.10 后续扩容路径

当订单、短信、激活量上升：

1. PostgreSQL 迁到 RDS。
2. worker 拆到独立进程或独立机器。
3. Redis/asynq 引入异步队列。
4. 管理后台从 API 进程拆出静态前端或独立服务。
5. 阿里云 ECS 从 1 核 1G 升级到 2 核 2G。

#### 3.2.11 本轮 MVP 打包结论

本轮先按 1 核 1G ECS 可稳定运行的最小形态落地：

```text
Go static binary + systemd + Nginx + PostgreSQL
```

固定结论：

- 代码位置：`u-claw-app-dev/cloud/uclaw-cloud-api`。
- 生产目录：`/opt/uclaw-cloud-api`。
- 生产配置：`/etc/uclaw-cloud-api/uclaw-cloud-api.env`。
- 阿里云 ECS 不安装 1Panel。
- 阿里云 ECS 不部署 New API。
- 阿里云 ECS 不部署 sub2api。
- MVP 不强制部署 Redis/asynq。
- MVP 使用 PostgreSQL job/outbox 表承接支付后异步补偿任务。
- 支付回调只验签、落库、快速返回。
- New API add quota 由低并发 worker 幂等执行。
- worker 并发先固定为 1。
- 充值与激活之外的模型调用流量不经过阿里云 ECS。

Phase 0 开发时必须同步产出：

- Linux amd64 release 构建脚本。
- `deploy/systemd/uclaw-cloud-api.service`。
- `deploy/nginx/uclaw-cloud-api.conf`。
- `deploy/env/uclaw-cloud-api.env.example`。
- PostgreSQL migration。
- New API spike CLI。

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
2. 客户端携带 U-Claw access token 请求阿里云 U-Claw Cloud API。
3. 阿里云用手机号同名 New API 账号临时登录 New API dashboard。
4. 阿里云实时读取 New API：
   - 余额 / quota。
   - 使用流水。
   - 充值或 quota 变动记录，如 New API 支持。
5. 阿里云聚合今日用量、近 7 天、累计用量和最近记录。
6. U-Claw 页面按 New API 原生 quota 展示。
7. 可辅助显示约人民币 / 约 token，但不作为对账口径。
```

说明：

- 阿里云不保存完整消费流水。
- 余额、用量、流水的 source of truth 仍是 New API。
- 阿里云本接口只在进入模型页或用户手动刷新时读取 New API。
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

### 7.4 模型页余额 / 用量 / 流水摘要

```http
GET /v1/newapi/usage/summary
Authorization: Bearer <uclaw_access_token>
```

返回：

```json
{
  "status": "ok",
  "newapiUserId": 123,
  "newapiUsername": "13800138000",
  "accountBalance": 100000,
  "usedQuota": 24171,
  "requestCount": 3,
  "todayUsage": 0,
  "last7DaysUsage": 24171,
  "cumulativeUsage": 24171,
  "recentRecordText": "1 条最近记录",
  "records": [
    {
      "id": 1,
      "createdAt": 1787762761,
      "modelName": "gpt-5.5",
      "quota": 24171,
      "promptTokens": 0,
      "completionTokens": 0,
      "requestId": "..."
    }
  ],
  "refreshedAt": "2026-08-27T00:00:00Z",
  "unit": "quota"
}
```

实现状态：

- 已接 New API `/api/user/self` 读取余额、已用 quota、请求数。
- 已接 New API `/api/log/self?p=0&page_size=50` 读取当前用户最近流水。
- 已纳入 `activation-local-e2e.sh`，激活后自动验证可读取 `accountBalance=100000`。
- 已纳入 Electron UI 验收脚本 `u-claw-app-dev/scripts/verify-cloud-model-usage-ui.js`，可验证模型页实际展示 `100,000` 余额与 `New API quota`。

### 7.5 充值套餐

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

### 7.6 创建充值订单

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

### 7.7 查询订单状态

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

### 7.8 支付回调

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

### 12.0 本地 New API 联调实验室

可以先在开发机本地启动一个 New API 实例，用于验证 U-Claw Cloud API 的管理调用形态。

本地联调代码位置：

```text
u-claw-app-dev/cloud/uclaw-cloud-api/deploy/newapi-local
```

启动方式：

```bash
cd u-claw-app-dev/cloud/uclaw-cloud-api
./deploy/scripts/newapi-local-up.sh
```

默认访问：

```text
http://127.0.0.1:3000
```

如果端口冲突：

```bash
NEWAPI_LOCAL_PORT=33000 ./deploy/scripts/newapi-local-up.sh
```

本地联调使用 SQLite 单容器 New API：

```text
calciumion/new-api:latest
```

原因：

- 足够验证创建用户、创建 token、add quota、查余额/流水这些接口形态。
- 不需要本机额外安装 PostgreSQL / Redis。
- 不影响阿里云 1 核 1G 的生产部署策略。
- 数据目录可随时删除重建，适合试错。

本地数据目录：

```text
deploy/newapi-local/data
deploy/newapi-local/logs
```

这些目录只用于本地，不提交 Git。

自动联调流程：

```bash
cd u-claw-app-dev/cloud/uclaw-cloud-api
./deploy/scripts/newapi-local-up.sh
./deploy/scripts/newapi-local-spike.sh
```

`newapi-local-spike.sh` 会自动：

1. 检查 `/api/setup`。
2. 如未初始化，则创建本地 root。
3. 登录 root 获取 dashboard access token。
4. 创建手机号格式测试用户。
5. 按 username 查询 New API user id。
6. 调 `POST /api/user/manage` 给用户加 quota。
7. 登录测试用户并创建 `uclaw-main` token。

本地默认 root：

```text
root / UclawLocal@2026
```

如果已有本地 root 密码：

```bash
NEWAPI_LOCAL_ROOT_PASSWORD=<password> ./deploy/scripts/newapi-local-spike.sh
```

手动联调流程：

1. 启动本地 New API。
2. 打开 `http://127.0.0.1:3000` 完成初始化。
3. 在 New API 后台获取管理 token 或可调用管理接口的 token。
4. 设置：

```bash
export NEWAPI_ADMIN_BASE_URL=http://127.0.0.1:3000
export NEWAPI_ADMIN_TOKEN=<new-api-admin-token>
```

5. 执行：

```bash
go run ./cmd/adminctl spike newapi create-user \
  --username <phone> \
  --password <random-password>

go run ./cmd/adminctl spike newapi create-token \
  --token-name uclaw-main

go run ./cmd/adminctl spike newapi add-quota \
  --user-id <newapi-user-id> \
  --quota <quota-tokens>
```

注意：

- 本地 New API 只用于接口 spike。
- 最终上线前仍必须用 OVH New API + 香港 Nginx 管理路径再跑一次完整验收。
- 本地 SQLite 结果不能作为生产性能或高并发结论。

当前本地实测结论：

- `calciumion/new-api:latest` 当前本地版本为 `v1.0.0-rc.26`。
- `POST /api/user/` 可用 admin dashboard token 创建同手机号用户。
- `GET /api/user/search?keyword=<phone>` 可按 username 查到 user id。
- `POST /api/user/manage` 加额度 payload 必须是 `{id, action:"add_quota", mode:"add", value}`。
- `POST /api/token/` 需要用目标用户身份调用，不能用 admin token 直接给任意用户创建 token。
- `POST /api/token/` 成功响应未返回明文 token，但 SQLite `tokens` 表已创建 key；生产前必须继续确认可返回 token 的接口或可接受流程。

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

- 在 `u-claw-app-dev/cloud/uclaw-cloud-api` 初始化最小 Go module 或 Spike CLI。
- 验证 New API 管理 API。
- 验证香港 Nginx 路径。
- 验证支付回调可跑通。

验收：

- 有脚本或 curl 记录证明创建用户、创建 token、add quota、查余额/流水可行。
- 明确 New API Docker tag。
- 明确所有 endpoint。

### Phase 1: 阿里云账号与激活服务

范围：

- 在 `u-claw-app-dev/cloud/uclaw-cloud-api` 完成 Go 项目骨架。
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

当前实现进度：

- 已完成 Go 项目骨架、健康检查、New API spike CLI、本地 New API lab。
- 已完成手机号短信登录 API 的开发态链路，并接入 Electron 首启激活页。
- 已完成 `/v1/activation/redeem` contract，客户端可写入 `openclaw.json`。
- 已完成 PostgreSQL store 第一刀：`sms_codes`、`uclaw_users`、`activation_codes` 持久化；`DATABASE_URL` 配置后服务使用 PG，否则本地 smoke 使用内存 store。
- 已新增 `adminctl activation seed --code <code>`，可把随 U 盘发放的激活码 seed 到 PostgreSQL。
- 已完成 New API 自动创建同名用户、用户登录、创建 API token、通过 `POST /api/token/{id}/key` 取真实 key、初始 quota 发放、`newapi_accounts` 映射落库。
- 已完成完整本地 E2E：临时 PostgreSQL + 本地 New API + U-Claw Cloud API + 激活码 seed + SMS/login/redeem，返回可用 `sk-` token。
- 尚未完成余额/用量/流水查询 API 与充值支付回调；这是下一开发切片。

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
