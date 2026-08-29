# U-Claw 激活与 New API 充值 PRD

## 目标

在 U-Claw 官方云端体系中，阿里云 1 核 1G 服务器只承载轻量激活、账号映射、订单记录与回调编排；模型推理、余额、用量和充值额度最终以 OVH New API 为准，并展示到 U-Claw 客户端模型界面。

## 项目位置

后端项目放在：

```text
u-claw-app-dev/cloud/uclaw-cloud-api
```

禁止放入或修改：

```text
u-claw-app
product
product/activation-server
```

原因：`u-claw-app` 与 `product` 是归档目录；当前活跃开发目录是 `u-claw-app-dev`。云端后端独立放在 `cloud/uclaw-cloud-api`，避免和 Electron/OpenClaw runtime 混在一起。

## 架构边界

- 阿里云 U-Claw Cloud API：手机号登录、短信验证码、U 盘激活码绑定、本地与云端授权数据保存、订单创建、支付回调接收、调用 New API 管理接口。
- OVH New API：模型账号、API token、余额 quota、充值加额度、用量流水。
- 香港直连 Nginx：作为 New API 前置反代，不承载 U-Claw 激活业务。
- U-Claw 客户端：首启激活；模型页主动查询余额/用量；本地也保存一份激活结果和 New API client endpoint。

## 当前服务器拓扑

以下信息用于开发、部署和联调定位。SSH 密码、New API admin token、短信密钥、签名私钥不得写入 Git 文档；只允许放在服务器受限 env 文件、CI/部署密钥库或一次性安全交付记录中。

| 节点 | 角色 | SSH | 运行职责 |
| --- | --- | --- | --- |
| `121.41.89.103` | 阿里云 U-Claw Cloud API VPS | `root@121.41.89.103:22` | 激活、手机号登录、订单、支付回调、调用 New API admin |
| `64.90.19.251` | New API 前置 VPS | `root@64.90.19.251:24851` | New API / sub2apii 前置反代、访问控制、TLS/路由 |
| `158.51.110.49` | New API / sub2apii 本体 VPS | `root@158.51.110.49:14851` | New API 服务本体、sub2apii、模型账号和 quota 数据 |

安全要求：

- 禁止把 SSH 密码写入 repo、PRD、README、`.env.example`、脚本、测试日志或验收截图。
- 首次部署可用临时密码登录，但上线前应迁移到 SSH key + 最小权限 deploy 用户，并关闭或限制 root 密码登录。
- 阿里云 Cloud API 访问 New API admin 路径时，New API 前置层必须做来源 IP allowlist；公网客户端不得直连 admin 管理接口。
- 文档中的 IP/端口可提交；任何 token/password/secret 只能以占位符呈现。

## 用户流程

1. 用户首次打开 U-Claw，进入首启激活页。
2. 用户输入真实手机号。
3. 用户输入随 U 盘附带的激活码。
4. 当前验收版本验证码固定为 `123456`；阿里云短信审核完成后切回真实短信发送。
5. 阿里云 U-Claw Cloud API 绑定手机号、激活码与当前 U 盘摘要。
6. U-Claw Cloud API 使用手机号自动创建或恢复 New API 用户。
7. U-Claw Cloud API 创建 New API token，返回给客户端写入本地 OpenClaw 配置；客户端写盘并验证后调用 commit。
8. 客户端模型页进入时主动查询 U-Claw Cloud API，用于展示 New API 余额、今日用量、近 7 天、累计流水。
9. 用户点击充值后创建订单；支付回调成功后，U-Claw Cloud API 调 New API `add_quota`。

手机号短信登录保留为后续账号恢复、授权找回和 New API token 恢复入口；阿里云短信审核未完成时，本版本用 `SMS_PROVIDER=fixed` 和固定验证码 `123456` 验收。

## 当前开发切片

已实现：

- `POST /v1/auth/sms/send`
- `POST /v1/auth/sms/login`
- 短信发送 provider seam：本地 development no-op；当前验收版 `fixed` provider 使用固定验证码 `123456`；生产 `aliyun` adapter 使用阿里云官方 Go SDK 调用 `SendSms`；已补 `QuerySendDetails` smoke 用于查送达回执
- `POST /v1/activation/redeem`
- 激活时自动创建同手机号 New API 账号和 token
- `GET /v1/newapi/usage/summary`
- `GET /v1/recharge/plans`
- `POST /v1/recharge/orders`
- `POST /v1/payments/virtual/notify`
- `GET /v1/recharge/orders/{orderNo}`
- Electron activation-only 首启客户端已切到 `POST /v1/activations`；当前提交手机号、固定验证码和激活码，客户端会写入本地授权材料与 OpenClaw New API 配置，读回验证成功后调用 `/v1/activations/{activationId}/commit`，随后在同一 Electron 进程内启动正常 U-Claw 工作台，避免用户看到窗口关闭。

本切片的充值先用 `virtual` provider。虚拟回调成功后立即触发 New API `POST /api/user/manage` 加 quota，并通过订单状态机保证同一订单不会重复加额度。

## 数据模型

PostgreSQL 表：

- `uclaw_users`：手机号用户。
- `activation_codes`：U 盘激活码哈希与绑定关系。
- `newapi_accounts`：U-Claw 用户到 New API user id/username/baseUrl/token fingerprint 的映射。
- `payment_orders`：订单、金额、quota、状态、provider trade no。
- `payment_callbacks`：支付回调事件与去重。
- `outbox_jobs`：后续真实支付和补偿任务预留。

状态机：

```text
created -> paid -> crediting -> credited
created -> paid -> crediting -> credit_failed -> crediting -> credited
```

`crediting` 是短锁状态，用于防止重复回调导致 New API 重复加额度。

## 打包与部署

U-Claw Cloud API 目标机器：阿里云 1 核 1G ECS。New API / sub2api 不放在这台小机，放在独立本体 VPS。

当前选型：

```text
U-Claw Cloud API: Go static binary + systemd + Nginx/Caddy + PostgreSQL
New API / sub2api: 1Panel + Docker Compose + PostgreSQL + Redis
```

原因：

- Go 单文件部署内存占用低，适合 1 核 1G。
- U-Claw Cloud API 不承载模型推理流量，请求量和 CPU 压力远低于 New API。
- PostgreSQL 保存激活、订单和回调，方便恢复 U 盘本地数据丢失的用户。
- systemd 负责进程守护，Nginx 负责 TLS、限流和反代。
- New API / sub2api 独立运行在本体 VPS，通过 1Panel 统一管理 Docker stack；stack 内含 PostgreSQL 和 Redis，Redis DB 0 给 New API，Redis DB 1 给 sub2api。
- 前置 VPS 只做反代、TLS 与路径 allowlist；New API 管理路径只允许阿里云 U-Claw Cloud API 源 IP。

MVP 暂不引入 Redis/asynq。真实支付上线后，`add_quota` 失败可先通过 PostgreSQL 状态 `credit_failed` 与后台补偿命令处理；订单量上升后再接 outbox worker。

部署样板：

```text
deploy/1panel/newapi-sub2api.compose.yml
deploy/1panel/newapi-sub2api.env.example
deploy/1panel/newapi-front-nginx.conf
```

sub2api 注意事项：auto-setup 使用官方拆分环境变量 `DATABASE_HOST/DATABASE_USER/DATABASE_DBNAME` 与 `REDIS_HOST/REDIS_DB`，不可只配置 `DATABASE_URL`/`REDIS_URL`。

## 配置项

生产必需：

```text
APP_ENV=production
DATABASE_URL=postgres://...
JWT_SECRET=...
ADMIN_TOKEN=...
ADMIN_ENCRYPTION_KEY=...
SMS_CODE_PEPPER=...
ACTIVATION_CODE_PEPPER=...
NEWAPI_ADMIN_BASE_URL=https://...
NEWAPI_ADMIN_TOKEN=...
NEWAPI_ADMIN_USERNAME=...
NEWAPI_ADMIN_PASSWORD=...
NEWAPI_CLIENT_BASE_URL=https://...
NEWAPI_USER_PASSWORD_SECRET=...
SMS_PROVIDER=aliyun
ALIYUN_SMS_ACCESS_KEY_ID=...
ALIYUN_SMS_ACCESS_KEY_SECRET=...
ALIYUN_SMS_SIGN_NAME=...
ALIYUN_SMS_TEMPLATE_CODE=...
ALIYUN_SMS_ENDPOINT=dysmsapi.aliyuncs.com
ALIYUN_SMS_TEMPLATE_PARAM_NAME=code
ALIYUN_SMS_HTTP_TIMEOUT=3s
```

开发环境可使用：

```text
APP_ENV=development
DEV_SMS_CODE=123456
NEWAPI_ACTIVATION_QUOTA=100000
```

短信审核未完成时，当前验收版本可临时配置：

```text
SMS_PROVIDER=fixed
DEV_SMS_CODE=123456
```

该配置不调用阿里云短信，允许输入真实手机号与固定验证码完成登录和首启绑定。阿里云短信审核通过后切回 `SMS_PROVIDER=aliyun`。

`virtual` 支付回调只允许非 production。

运营后台：

- 入口：`https://license.yiyong.me/admin`。
- 鉴权：首次注册管理员账号，生产环境注册必须带 `ADMIN_TOKEN` 初始化令牌；之后登录获取 session；`ADMIN_TOKEN` 只作为受限应急 token 保留。
- 列表：必须展示激活码状态、可见激活码或旧码不可见提示、绑定手机号、U-Claw 用户 ID、New API user id、New API username、New API base URL、最近一次首启激活阶段。
- 激活码展示：历史 seed 码只存 hash，不能反推明文；后台生成/重发的新码使用 `ADMIN_ENCRYPTION_KEY` 加密保存展示材料，列表可查看和复制。

当前已完成 New API / sub2api 源站、前置反代、New API Root 管理员和 U-Claw Cloud API staging 部署；`NEWAPI_ADMIN_TOKEN` 与 `NEWAPI_ADMIN_USERNAME/PASSWORD` 已写入阿里云 staging 受限 env。New API admin token 过期时，Cloud API 使用管理员账号重新登录并在内存中刷新 token，然后重试原请求一次。`license.yiyong.me` 已把新激活相关路径切到 Cloud API staging，并完成公网首启激活验收。
客户端侧已完成首启真实写盘闭环：手机号 + 固定验证码 + 激活码提交、`licenseArtifact` 写入、New API credential 写入、OpenClaw config 写入、读回验证、commit、完成页直接进入主界面。便携启动脚本默认注入 `https://license.yiyong.me`，并允许授权后的 `openclaw.json` 同步回 U 盘。

## 验收标准

- 本地 `go test ./...` 通过。
- `deploy/scripts/newapi-local-up.sh` 可启动本地 New API lab。
- `deploy/scripts/activation-local-e2e.sh` 可完成：短信登录、激活、创建 New API token、查询余额、创建虚拟充值订单、虚拟回调、余额增加。
- U-Claw 客户端模型页进入时能看到 New API 余额、今日用量、近 7 天和流水。
- activation-only 客户端提交手机号、固定验证码和激活码后，本地生成 `.openclaw/license/license.json`、`.openclaw/builtin-model-credential.v1.json`、`.openclaw/uclaw-activation.json`，并写入 `.openclaw/openclaw.json` 的 New API provider 配置。
- 完成页点击“进入 U-Claw”后，Electron 在同一进程内启动 Config server、Video adapter、OpenClaw Gateway，并加载正常工作台；退出码 20 仅保留为旧包兼容路径。

## 当前部署盘点

- `121.41.89.103`：旧 activation-server 仍在；新增 `uclaw-cloud-api-staging.service` 监听 `127.0.0.1:18180`；`license.yiyong.me` 新激活路径已转发到该服务，公网首启激活真实链路验收通过。
- `64.90.19.251`：已安装 Nginx/Certbot；`newapi.yiyong.me`、`sub2api.yiyong.me` HTTPS 证书有效；公网 `/v1` 可达，管理面非授权来源 `403`。
- `158.51.110.49`：已安装 1Panel v2.2.5、Docker 与 Compose；New API、sub2api、PostgreSQL、Redis 均已启动，源站 `3000/8080` 已用 `DOCKER-USER` allowlist 限制只允许前置访问。
- Aliyun SMS：`SendSms` API 已受理；`QuerySendDetails` 回执 `PORT_NOT_REGISTERED`，待短信签名/端口实名报备审核完成后再复验，当前暂不阻塞主线。
- Electron activation-only：已通过本地 stub 驱动的真实页面写盘和同进程进入主界面验收；短信待审核期间按真实手机号 + 固定验证码 `123456` + 激活码完成首启。

## 后续待办

- 制定旧 activation-server 下线窗口，并把 `uclaw-cloud-api-staging.service` 命名整理为正式服务。
- 接入官方 Alipay/WeChat 支付创建订单与签名回调。
- 增加订单列表 UI 和充值记录 UI。
- 增加失败订单补偿 worker 或 admin 命令。
