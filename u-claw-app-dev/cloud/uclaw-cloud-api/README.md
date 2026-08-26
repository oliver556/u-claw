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
./deploy/scripts/smoke-local.sh
```

## 本地手机号登录

开发环境默认短信码为 `123456`，响应会返回 `devCode`，生产环境不会暴露。

浏览器验收页：

```text
http://127.0.0.1:8080/dev/auth
```

```bash
curl -sS -X POST http://127.0.0.1:8080/v1/auth/sms/send \
  -H 'Content-Type: application/json' \
  -d '{"phone":"13800138000","purpose":"login"}'

curl -sS -X POST http://127.0.0.1:8080/v1/auth/sms/login \
  -H 'Content-Type: application/json' \
  -d '{"phone":"13800138000","purpose":"login","code":"123456"}'
```

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

## Release

```bash
VERSION=0.1.0 ./deploy/scripts/release-linux-amd64.sh
```

产物：

```text
dist/uclaw-cloud-api-linux-amd64.tar.gz
```
