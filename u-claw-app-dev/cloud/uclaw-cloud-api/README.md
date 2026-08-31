# Bavi-box Cloud API

Bavi-box Cloud API 是阿里云 1 核 1G ECS 上运行的激活与商业化后端。它只负责账号、激活码、订单、支付回调、New API 管理编排，不承载模型推理流量。

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
Bavi-box Cloud API: Go static binary + systemd + Nginx/Caddy + PostgreSQL
New API / sub2api: 1Panel + Docker Compose + PostgreSQL + Redis
```

Bavi-box Cloud API 仍保持低内存 systemd 形态，适合阿里云 1 核 1G。New API / sub2api 按用户要求用 1Panel 管理 Docker、PostgreSQL 与 Redis；Redis DB 0 给 New API，DB 1 给 sub2api。

`license.yiyong.me` 当前采用渐进切换：`/v1/activations*`、`/v1/auth/*`、`/v1/recharge/*` 等新 Cloud API 路径转发到 `127.0.0.1:18180`；旧 `/model-api/*` 与未迁移 `/v1/*` 仍保留旧 activation-server 兜底。参考配置见 `deploy/caddy/uclaw-cloud-api.Caddyfile`。

## 生产服务器拓扑

| 角色 | 公网 IP | SSH 端口 | 初始用户 | 说明 |
| --- | --- | --- | --- | --- |
| Bavi-box 阿里云激活服务器 | `121.41.89.103` | `22` | `root` | 本服务部署目标，只承载激活、保存、订单与支付回调 |
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

## 最小运营后台

部署后访问：

```text
https://license.yiyong.me/admin
```

后台使用首次注册 + 登录 session。首次访问时，如果库中还没有管理员账号，页面会显示“首次注册”；生产环境首次注册必须同时填写 `ADMIN_TOKEN` 作为初始化令牌，注册完成后再用账号密码登录。`ADMIN_TOKEN` 仍保留为受限应急 Bearer token，生产环境必须配置，并建议在 Caddy/Nginx 再加办公室或 VPN IP allowlist。

当前最小能力：

- 生成激活码并写入 PostgreSQL 库存；新生成和重发的激活码会用 `ADMIN_ENCRYPTION_KEY` 加密保存展示材料，可在后台列表查看和复制。
- 查询激活码状态、绑定手机号、绑定的 Bavi-box 用户 ID。
- 查询 New API 用户映射、New API user id、base URL、token 轮换时间，以及最近一次首启激活状态。
- 禁用未使用激活码。
- 重发未使用或已禁用激活码：旧码标记为 `reissued`，新码写入同批次库存。

历史手工 seed 的激活码只存 `code_hash`，无法反推明文；后台会显示“旧码不可见”或尾号提示。后续运营应尽量通过后台“生成/重发”创建激活码。

接口：

```bash
curl -sS -X POST https://license.yiyong.me/internal/admin/v1/auth/register \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"username":"uclawroot","password":"change-me-now"}'

curl -sS -X POST https://license.yiyong.me/internal/admin/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"uclawroot","password":"change-me-now"}'

curl -H "Authorization: Bearer $ADMIN_SESSION_TOKEN" \
  https://license.yiyong.me/internal/admin/v1/activation-codes

curl -X POST -H "Authorization: Bearer $ADMIN_SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"count":1,"batchName":"manual","createdBy":"operator"}' \
  https://license.yiyong.me/internal/admin/v1/activation-codes/generate
```

## 本地手机号登录

开发环境默认短信码为 `123456`，响应会返回 `devCode`。当前验收版本也可配置 `SMS_PROVIDER=fixed`，使用真实手机号 + 固定验证码 `123456`，不调用阿里云短信。

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
- `SMS_PROVIDER=fixed`：当前验收版本临时使用；不调用真实短信供应商，固定验证码来自 `DEV_SMS_CODE`，默认 `123456`。
- `SMS_PROVIDER=aliyun`：使用阿里云官方 Go SDK 调用 `SendSms`。必须配置已审核通过的签名和模板。
- production 启动校验允许 `SMS_PROVIDER=fixed` 或 `SMS_PROVIDER=aliyun`；上线正式短信后应切回 `aliyun`，并要求 `ALIYUN_SMS_ACCESS_KEY_ID`、`ALIYUN_SMS_ACCESS_KEY_SECRET`、`ALIYUN_SMS_SIGN_NAME`、`ALIYUN_SMS_TEMPLATE_CODE` 全部存在。
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

前置 `64.90.19.251` 只做 `api.yiyong.me`、`sub2api.yiyong.me` 的 TLS/反代/allowlist；源站 `3000/8080` 必须用安全组或防火墙限制只允许前置访问。

## 首启 activation-only 激活接口

Electron 受限激活页提交手机号、验证码和激活码。当前验收版验证码固定为 `123456`：

```bash
curl -sS -X POST http://127.0.0.1:8080/v1/activations \
  -H 'Content-Type: application/json' \
  -d '{"phone":"13800138000","smsCode":"123456","activationCode":"ABCDE-FGHIJ-KLMNO-PQRST-UVWXYZ","usbFingerprintSummary":"PREVIEW-ONLY","idempotencyKey":"local-dev-1"}'
```

当前切片返回 `server_bound`、`pending_client_write` 与 `licenseArtifact`。`licenseArtifact` 是 `license.json` 可持久化授权材料，包含 canonical payload 和 Ed25519 signature；客户端会写入授权材料、New API credential、OpenClaw config，若响应含 `updateCredential` 还会写入硬更新凭据，读回验证后调用：

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

硬更新凭据只在受控验收或服务端 issuer 命中时返回：

```json
{
  "schemaVersion": "uclaw.update-credential.v1",
  "updateCheckUrl": "https://updates.yiyong.me/uclaw/update/check",
  "deviceId": "<devices.device_id>",
  "deviceToken": "<one-time-device-token>",
  "platformKeys": ["win32-x64", "darwin-arm64", "darwin-x64"],
  "issuedAt": "2026-08-29T10:00:00Z"
}
```

部署可用 `UPDATE_CREDENTIAL_FILE=/path/to/root-only-update-credential.json` 启用文件型 issuer。该 JSON 必须包含 `allowedActivationIds`、`allowedPrincipals` 或 `allowedUsbFingerprintSummaries` 至少一类绑定条件，避免把同一 token 发给不相关激活请求。文件权限应为 `root:root 0600`；`deviceToken` 不写文档、不进 Git、不截图。

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

`activation-response.json` 会自动脱敏 `accessToken`、`newapiToken` 与 `updateCredential.deviceToken`，只保留 token 存在性和短 fingerprint。

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

Electron 验收脚本 `scripts/verify-activation-real-write.js` 会驱动真实 activation-only 页面，确认本地文件写入、commit 顺序、完成页“完成并重启”以及退出码 20 重启交接。

## New API 用量摘要

模型页进入或手动刷新时，请求 Bavi-box Cloud API 聚合 New API 余额、今日用量、近 7 天、累计用量和最近流水：

```bash
curl -sS http://127.0.0.1:8080/v1/newapi/usage/summary \
  -H "Authorization: Bearer <accessToken>"
```

该接口实时登录同手机号 New API 账号读取 `/api/user/self` 与 `/api/log/self`，不在阿里云长期保存完整消费流水。

## New API 模型目录

模型页点击“同步模型”时，请求 Bavi-box Cloud API 读取当前用户在 New API 后台可用的模型权限，并写入本地 OpenClaw `models.providers.newapi.models`：

```bash
curl -sS http://127.0.0.1:8080/v1/newapi/models/catalog \
  -H "Authorization: Bearer <accessToken>"
```

该接口实时登录同手机号 New API 账号读取 `/api/user/models`，只返回模型 id、channel id、能力分类和 provider 元数据；Cloud API 不把 New API API key 下发到该接口响应，也不在前端暴露 admin token。若 New API 临时失败且服务内存中已有上次成功目录，会返回 `status: "stale"` 和 warning，客户端可继续使用本地已保存配置。

## 虚拟充值回调

当前切片先用 `virtual` provider 验证充值闭环：客户端创建订单后，本地或测试工具调用虚拟回调，Bavi-box Cloud API 会把订单置为 paid，并通过 New API admin `/api/user/manage` 给同手机号 New API 账号加 quota。

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

## 支付宝聚合收钱码 SPI 接入

支付宝控制台“聚合收钱码”要求 API 全部接入后才允许申请上线。截图中的 `spi.alipay.pay.*` 是支付宝调用 Bavi-box Cloud API 的 SPI，不是客户端充值下单 API。当前已先接入第一个接口：

```text
spi.alipay.pay.aggpay.merchantinfo.query
```

控制台“服务配置基础”建议填写：

```text
后端服务正式地址: https://license.yiyong.me/isv/spi/service
后端服务测试地址: https://license.yiyong.me/isv/spi/service
响应是否加密: 否
请求编码: UTF-8
```

如果控制台允许每个 API 单独填写地址，第一个接口也可以填专用地址：

```text
https://license.yiyong.me/v1/payments/alipay/spi/merchantinfo/query
```

`/v1/payments/alipay/spi` 仍保留给客户端支付模块内部使用；支付宝 SPI 控制台优先使用 `/isv/spi/service`，该路径与支付宝官方 demo 的 SPI service path 更接近，避免控制台校验误判业务 API path。

生产环境可通过 env 覆盖商户展示信息：

```bash
ALIPAY_SPI_MERCHANT_ID=2088xxxxxxxxxxxx
ALIPAY_SPI_MERCHANT_NAME=Bavi-box
ALIPAY_SPI_MERCHANT_SHORT=Bavi
ALIPAY_SPI_SERVICE_PHONE=0571-00000000
ALIPAY_SPI_SERVICE_ADDRESS=https://license.yiyong.me
```

本地验收：

```bash
curl -sS -X POST http://127.0.0.1:8080/v1/payments/alipay/spi \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'method=spi.alipay.pay.aggpay.merchantinfo.query' \
  --data-urlencode 'biz_content={"out_trade_no":"UC-SPI-SMOKE"}'
```

期望响应：

```json
{
  "response": {
    "code": "10000",
    "msg": "Success",
    "merchant_id": "2088xxxxxxxxxxxx",
    "merchant_name": "Bavi-box"
  }
}
```

当前按“响应是否加密=否”实现；后续若控制台强制响应加签或加密，再基于已挂载的支付宝应用私钥增加 `sign` 字段与 AES 加密。

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
export NEWAPI_ADMIN_USERNAME=change-me
export NEWAPI_ADMIN_PASSWORD=change-me

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

go run ./cmd/adminctl spike newapi user-models \
  --username 13800138000 \
  --password random-password

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

`user-models` 会用用户身份读取 `/api/user/models`，只输出 channel 到模型名的映射和去重模型数，用于上线前确认 New API 实例响应结构。

`provision` 会执行生产同构链路：创建同名 New API 用户、用户登录、创建 API token、调用 `/api/token/{id}/key` 取真实 key、admin add quota，并只输出 `token_present=true`，不打印明文 key。

## Release

```bash
VERSION=0.1.0 ./deploy/scripts/release-linux-amd64.sh
```

产物：

```text
dist/uclaw-cloud-api-linux-amd64.tar.gz
```
