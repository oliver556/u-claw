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
2. 用户输入手机号并通过阿里云短信验证码登录。
3. 用户输入随 U 盘附带的激活码。
4. 阿里云 U-Claw Cloud API 绑定手机号与激活码。
5. U-Claw Cloud API 使用同手机号自动创建或恢复 New API 用户。
6. U-Claw Cloud API 创建 New API token，返回给客户端写入本地 OpenClaw 配置。
7. 客户端模型页进入时主动查询 U-Claw Cloud API，用于展示 New API 余额、今日用量、近 7 天、累计流水。
8. 用户点击充值后创建订单；支付回调成功后，U-Claw Cloud API 调 New API `add_quota`。

## 当前开发切片

已实现：

- `POST /v1/auth/sms/send`
- `POST /v1/auth/sms/login`
- 短信发送 provider seam：本地 development no-op；生产 `aliyun` adapter 预留且未实现时失败关闭
- `POST /v1/activation/redeem`
- 激活时自动创建同手机号 New API 账号和 token
- `GET /v1/newapi/usage/summary`
- `GET /v1/recharge/plans`
- `POST /v1/recharge/orders`
- `POST /v1/payments/virtual/notify`
- `GET /v1/recharge/orders/{orderNo}`

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

目标机器：阿里云 1 核 1G ECS。

推荐形态：

```text
Go static binary + systemd + Nginx + PostgreSQL
```

原因：

- Go 单文件部署内存占用低，适合 1 核 1G。
- U-Claw Cloud API 不承载模型推理流量，请求量和 CPU 压力远低于 New API。
- PostgreSQL 保存激活、订单和回调，方便恢复 U 盘本地数据丢失的用户。
- systemd 负责进程守护，Nginx 负责 TLS、限流和反代。

MVP 暂不引入 Redis/asynq。真实支付上线后，`add_quota` 失败可先通过 PostgreSQL 状态 `credit_failed` 与后台补偿命令处理；订单量上升后再接 outbox worker。

## 配置项

生产必需：

```text
APP_ENV=production
DATABASE_URL=postgres://...
JWT_SECRET=...
SMS_CODE_PEPPER=...
ACTIVATION_CODE_PEPPER=...
NEWAPI_ADMIN_BASE_URL=https://...
NEWAPI_ADMIN_TOKEN=...
NEWAPI_CLIENT_BASE_URL=https://...
NEWAPI_USER_PASSWORD_SECRET=...
SMS_PROVIDER=aliyun
ALIYUN_SMS_ACCESS_KEY_ID=...
ALIYUN_SMS_ACCESS_KEY_SECRET=...
ALIYUN_SMS_SIGN_NAME=...
ALIYUN_SMS_TEMPLATE_CODE=...
```

开发环境可使用：

```text
APP_ENV=development
DEV_SMS_CODE=123456
NEWAPI_ACTIVATION_QUOTA=100000
```

`virtual` 支付回调只允许非 production。

当前不接真实 New API 线上信息，也不保存任何真实短信密钥。真实 New API 与阿里云短信参数到位后，替换对应环境变量和 Aliyun SMS adapter，再做 staging 写入型验收。

## 验收标准

- 本地 `go test ./...` 通过。
- `deploy/scripts/newapi-local-up.sh` 可启动本地 New API lab。
- `deploy/scripts/activation-local-e2e.sh` 可完成：短信登录、激活、创建 New API token、查询余额、创建虚拟充值订单、虚拟回调、余额增加。
- U-Claw 客户端模型页进入时能看到 New API 余额、今日用量、近 7 天和流水。

## 后续待办

- 接入真实 Aliyun SMS `SMSProvider` adapter，完成短信签名、模板变量、限流与错误码映射。
- 等待真实 New API admin/client endpoint 与管理 token 后，做 staging 写入型开户、token、充值验证。
- 接入官方 Alipay/WeChat 支付创建订单与签名回调。
- 增加订单列表 UI 和充值记录 UI。
- 增加失败订单补偿 worker 或 admin 命令。
- 对香港 Nginx 管理路径加 IP allowlist，仅允许阿里云 U-Claw Cloud API 调 New API admin。
