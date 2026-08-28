# U-Claw Cloud API

U-Claw Cloud API 是阿里云 1 核 1G ECS 上运行的激活与商业化后端。它只负责账号、激活码、订单、支付回调、New API 管理编排，不承载模型推理流量。

## 位置

```text
u-claw-app-dev/cloud/uclaw-cloud-api
```

禁止把新后端写入：

```text
product/activation-server
product/*
u-claw-app/*
```

## 本轮 MVP 形态

```text
U-Claw Cloud API: Go static binary + systemd + Nginx/Caddy + PostgreSQL
New API / sub2api: 1Panel + Docker Compose + PostgreSQL + Redis
```

U-Claw Cloud API 仍保持低内存 systemd 形态，适合阿里云 1 核 1G。New API / sub2api 按用户要求用 1Panel 管理 Docker、PostgreSQL 与 Redis；Redis DB 0 给 New API，DB 1 给 sub2api。

## 生产服务器拓扑

| 角色 | 公网 IP | SSH 端口 | 初始用户 | 说明 |
| --- | --- | --- | --- | --- |
| U-Claw 阿里云激活服务器 | `121.41.89.103` | `22` | `root` | 本服务部署目标，只承载激活、保存、订单与支付回调 |
| New API 前置香港 VPS | `64.90.19.251` | `24851` | `root` | 1Panel + Nginx，反代客户端与管理路径 |
| New API / sub2api 本体 OVH VPS | `158.51.110.49` | `14851` | `root` | New API + sub2api 源站 |

密码、私钥、支付证书、New API admin token 不写入仓库。正式上线前必须轮换已共享的 root 密码，并优先改成 SSH key + `uclaw-deploy` 用户。

## 本地命令

```bash
go test ./...
go vet ./...
go run ./cmd/api serve
go run ./cmd/adminctl activation generate 5
DATABASE_URL=postgres://uclaw:change-me@127.0.0.1:5432/uclaw_cloud?sslmode=disable \
  go run ./cmd/adminctl activation seed --code ABCD-EFGH-IJKL-MNOP
./deploy/scripts/smoke-local.sh
./deploy/scripts/activation-artifact-local-e2e.sh
./deploy/scripts/newapi-local-spike.sh
./deploy/scripts/activation-local-e2e.sh
cd ../.. && node scripts/verify-cloud-model-usage-ui.js
```

## PostgreSQL 激活存储

配置 `DATABASE_URL` 后，`cmd/api serve` 会使用 PostgreSQL 保存短信验证码、手机号用户与激活码绑定；未配置时只使用内存 store，供本地 smoke 和 Electron 首启验证。

```bash
export DATABASE_URL=postgres://uclaw:change-me@127.0.0.1:5432/uclaw_cloud?sslmode=disable
export ACTIVATION_CODE_PEPPER=change-me-at-least-32-bytes
export LICENSE_SIGNING_KEY_ID=prod-ed25519-2026-08
export LICENSE_SIGNING_SEED_HEX=<32-byte-ed25519-seed-hex>
go run ./cmd/adminctl activation seed --code ABCD-EFGH-IJKL-MNOP
```

`activation generate` 输出的码形如 `ABCD-EFGH-IJKL-MNOP`，与客户端激活页输入格式一致。

## 本地手机号登录

开发环境默认短信码为 `123456`，响应会返回 `devCode`，生产环境不会暴露。

```bash
curl -sS -X POST http://127.0.0.1:8080/v1/auth/sms/send \
  -H 'Content-Type: application/json' \
  -d '{"phone":"13800138000","purpose":"login"}'

curl -sS -X POST http://127.0.0.1:8080/v1/auth/sms/login \
  -H 'Content-Type: application/json' \
  -d '{"phone":"13800138000","purpose":"login","code":"123456"}'
```

登录后用返回的 `accessToken` 兑换 U 盘激活码：

```bash
curl -sS -X POST http://127.0.0.1:8080/v1/activation/redeem \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"activationCode":"ABCD-EFGH-IJKL-MNOP","deviceSummary":"PREVIEW-ONLY"}'
```

## 短信验证接口预留

短信发送已经通过 `auth.SMSProvider` 抽象隔离。当前状态：

- `SMS_PROVIDER=development`：仅限本地开发和测试，不调用真实短信供应商；非 production 才会返回 `devCode`。
- `SMS_PROVIDER=aliyun`：使用阿里云官方 Go SDK 调用 `SendSms`。必须配置已审核通过的签名和模板。
- production 启动校验要求 `SMS_PROVIDER=aliyun`，并要求 `ALIYUN_SMS_ACCESS_KEY_ID`、`ALIYUN_SMS_ACCESS_KEY_SECRET`、`ALIYUN_SMS_SIGN_NAME`、`ALIYUN_SMS_TEMPLATE_CODE` 全部存在。
- `ALIYUN_SMS_ENDPOINT` 默认 `dysmsapi.aliyuncs.com`；`ALIYUN_SMS_TEMPLATE_PARAM_NAME` 默认 `code`，对应模板变量 `${code}`。
- `ALIYUN_SMS_HTTP_TIMEOUT` 默认 `3s`，SDK 自动重试关闭，避免验证码超时重试导致重复短信。

真实 AccessKey 只放服务器受限 env 或部署密钥库，不写入 Git。当前真实 smoke 显示 `SendSms` 已被阿里云受理；送达回执为 `PORT_NOT_REGISTERED`，需等待短信签名/端口实名报备完成后复验。

## 1Panel New API / sub2api 部署

部署样板位于：

```text
deploy/1panel/
```

核心文件：

- `newapi-sub2api.compose.yml`：源站自包含 stack，包含 PostgreSQL、Redis、New API 与 sub2api。
- `newapi-sub2api.env.example`：生产 `.env` 模板，真实密钥不得提交。
- `newapi-front-nginx.conf`：前置反代参考配置，New API 管理路径仅允许阿里云 Cloud API 源 IP。
- `apply-origin-firewall.sh`：源站 `DOCKER-USER` 端口 allowlist，限制 `3000/8080` 只允许前置机访问。

部署顺序：

```bash
# 158.51.110.49 源站
bash -c "$(curl -sSL https://resource.1panel.pro/v2/quick_start.sh)"
mkdir -p /opt/uclaw-newapi-stack
cd /opt/uclaw-newapi-stack
cp newapi-sub2api.env.example .env
docker compose --env-file .env -f newapi-sub2api.compose.yml config
docker compose --env-file .env -f newapi-sub2api.compose.yml up -d
FRONT_IP=64.90.19.251 ./apply-origin-firewall.sh
```

前置 `64.90.19.251` 只做 `newapi.yiyong.me`、`sub2api.yiyong.me` 的 TLS/反代/allowlist；源站 `3000/8080` 必须用安全组或防火墙限制只允许前置访问。

## 首启 activation-only 激活接口

Electron 受限激活页不要求手机号登录，直接提交交付卡上的用户名和激活码：

```bash
curl -sS -X POST http://127.0.0.1:8080/v1/activations \
  -H 'Content-Type: application/json' \
  -d '{"username":"UCLAW-BIANCHENG","activationCode":"ABCDE-FGHIJ-KLMNO-PQRST-UVWXYZ","usbFingerprintSummary":"PREVIEW-ONLY","idempotencyKey":"local-dev-1"}'
```

当前切片返回 `server_bound`、`pending_client_write` 与 `licenseArtifact`。`licenseArtifact` 是 `license.json` 可持久化授权材料，包含 canonical payload 和 Ed25519 signature；客户端写盘 helper 还没有上报授权材料写入完成。写盘 helper 验证后调用：

```bash
curl -sS -X POST http://127.0.0.1:8080/v1/activations/<activationId>/commit \
  -H 'Content-Type: application/json' \
  -d '{"writeStatus":"verified"}'
```

验收时可检查响应中存在：

```text
licenseArtifact.payload.schemaVersion = uclaw.license.v1
licenseArtifact.payload.activationId = <activationId>
licenseArtifact.signature.algorithm = Ed25519
licenseArtifact.signature.value = <base64 signature>
```

也可以运行一键验收脚本：

```bash
./deploy/scripts/activation-artifact-local-e2e.sh
```

脚本会自动启动本地 API、提交首启激活、校验 `licenseArtifact`、调用 commit，并输出摘要。产物会写入：

```text
dist/activation-acceptance/latest-summary.json
dist/activation-acceptance/license-artifact.json
dist/activation-acceptance/activation-response.json
```

验收通过时摘要中应看到：

```text
ok = true
activationStatus = server_bound
artifactStatus = pending_client_write
commitStatus = committed
licenseSchema = uclaw.license.v1
signatureAlgorithm = Ed25519
signaturePresent = true
```

## New API 用量摘要

模型页进入或手动刷新时，请求 U-Claw Cloud API 聚合 New API 余额、今日用量、近 7 天、累计用量和最近流水：

```bash
curl -sS http://127.0.0.1:8080/v1/newapi/usage/summary \
  -H "Authorization: Bearer <accessToken>"
```

该接口实时登录同手机号 New API 账号读取 `/api/user/self` 与 `/api/log/self`，不在阿里云长期保存完整消费流水。

## 虚拟充值回调

当前切片先用 `virtual` provider 验证充值闭环：客户端创建订单后，本地或测试工具调用虚拟回调，U-Claw Cloud API 会把订单置为 paid，并通过 New API admin `/api/user/manage` 给同手机号 New API 账号加 quota。

```bash
curl -sS http://127.0.0.1:8080/v1/recharge/plans \
  -H "Authorization: Bearer <accessToken>"

curl -sS http://127.0.0.1:8080/v1/recharge/providers \
  -H "Authorization: Bearer <accessToken>"

curl -sS -X POST http://127.0.0.1:8080/v1/recharge/orders \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"planCode":"dev_10","provider":"virtual"}'

curl -sS -X POST http://127.0.0.1:8080/v1/payments/virtual/notify \
  -H 'Content-Type: application/json' \
  -d '{"orderNo":"<orderNo>","providerEventId":"virtual-<orderNo>"}'
```

`virtual` 回调只在非 production 环境启用。正式 Alipay/WeChat 接入时复用 `payment_orders`、`payment_callbacks` 与订单幂等状态机，替换签名校验和 provider 回调解析。

`/v1/recharge/providers` 返回 `virtual`、`alipay`、`wechat` 三类渠道及启用状态。当前后端已预留官方支付 checkout seam：当 `alipay` 或 `wechat` 未配置真实 adapter 时，创建订单会返回 `payment provider <provider> is not configured`，且不会落库生成无效订单。下一切片只需要接入官方 SDK 下单 adapter、支付跳转或二维码、验签回调和补偿 worker。

## New API Spike

可以先本地启动 New API 联调环境：

```bash
./deploy/scripts/newapi-local-up.sh
./deploy/scripts/newapi-local-spike.sh
```

一键脚本会自动初始化本地 root、创建测试用户、查询 user id、加 quota，并用测试用户身份创建 token。

如需手动联调，再打开 `http://127.0.0.1:3000` 完成初始化，并在 New API 后台获取管理 token。

```bash
export NEWAPI_ADMIN_BASE_URL=https://newapi-admin.example.com
export NEWAPI_ADMIN_TOKEN=change-me

go run ./cmd/adminctl spike newapi \
  --username 13800138000 \
  --password random-password

go run ./cmd/adminctl spike newapi create-user \
  --username 13800138000 \
  --password random-password

go run ./cmd/adminctl spike newapi create-token \
  --token-name uclaw-main

go run ./cmd/adminctl spike newapi add-quota \
  --user-id 123 \
  --quota 100000

go run ./cmd/adminctl spike newapi provision \
  --username 13800138000 \
  --quota 100000

go run ./cmd/adminctl spike newapi \
  --username 13800138000 \
  --password random-password \
  --token-name uclaw-main \
  --user-id 123 \
  --quota 100000
```

Spike 结果填写到：

```text
docs/spike-results.md
```

`provision` 会执行生产同构链路：创建同名 New API 用户、用户登录、创建 API token、调用 `/api/token/{id}/key` 取真实 key、admin add quota，并只输出 `token_present=true`，不打印明文 key。

## Release

```bash
VERSION=0.1.0 ./deploy/scripts/release-linux-amd64.sh
```

产物：

```text
dist/uclaw-cloud-api-linux-amd64.tar.gz
```
