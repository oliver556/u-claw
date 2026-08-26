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
Go static binary + systemd + Nginx + PostgreSQL
```

MVP 不强制部署 Redis/asynq。支付成功后的 New API add quota 先通过 PostgreSQL `outbox_jobs` 低并发补偿。

## 本地命令

```bash
go test ./...
go vet ./...
go run ./cmd/api serve
go run ./cmd/adminctl activation generate 5
DATABASE_URL=postgres://uclaw:change-me@127.0.0.1:5432/uclaw_cloud?sslmode=disable \
  go run ./cmd/adminctl activation seed --code ABCD-EFGH-IJKL-MNOP
./deploy/scripts/smoke-local.sh
./deploy/scripts/newapi-local-spike.sh
./deploy/scripts/activation-local-e2e.sh
cd ../.. && node scripts/verify-cloud-model-usage-ui.js
```

## PostgreSQL 激活存储

配置 `DATABASE_URL` 后，`cmd/api serve` 会使用 PostgreSQL 保存短信验证码、手机号用户与激活码绑定；未配置时只使用内存 store，供本地 smoke 和 Electron 首启验证。

```bash
export DATABASE_URL=postgres://uclaw:change-me@127.0.0.1:5432/uclaw_cloud?sslmode=disable
export ACTIVATION_CODE_PEPPER=change-me-at-least-32-bytes
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

curl -sS -X POST http://127.0.0.1:8080/v1/recharge/orders \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"planCode":"dev_10","provider":"virtual"}'

curl -sS -X POST http://127.0.0.1:8080/v1/payments/virtual/notify \
  -H 'Content-Type: application/json' \
  -d '{"orderNo":"<orderNo>","providerEventId":"virtual-<orderNo>"}'
```

`virtual` 回调只在非 production 环境启用。正式 Alipay/WeChat 接入时复用 `payment_orders`、`payment_callbacks` 与订单幂等状态机，替换签名校验和 provider 回调解析。

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
