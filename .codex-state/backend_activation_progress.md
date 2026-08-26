### Goal
实现 U-Claw 官方激活服务与 New API 计费体系的 PRD 分期开发。

### Plan
- [x] Clarify architecture decisions through Q&A
- [x] Write PRD + technical plan markdown
- [x] Verify document exists
- [x] Create Phase 0 Go backend skeleton
- [x] Harden Phase 0 spike commands
- [x] Add local New API lab for Phase 0
- [x] Run local New API spike end-to-end
- [x] Implement Phase 1 phone SMS login API slice
- [x] Add local browser verification page for auth
- [x] Move first-login verification into Electron activation page
- [x] Add startup activation gate with local activation marker
- [x] Add cloud activation redeem contract and client config write path
- [x] Add PostgreSQL store for SMS login and activation-code redeem
- [x] Add New API provisioning for same-phone user, token key, quota, and account mapping
- [x] Add New API balance/usage/ledger summary API and model page cloud display

### Current status
- Current step: New API usage summary + model page cloud display complete
- Last completed: `/v1/newapi/usage/summary` 可用 U-Claw access token 实时登录同手机号 New API 用户，读取余额、今日用量、近 7 天、累计流水和最近记录；Electron 模型页已通过 IPC 展示云端摘要。
- Next action: 实现微信/支付宝官方支付订单、回调验签、outbox 加 quota，以及充值按钮对接。

### Notes
- 阿里云 U-Claw 服务负责账号、激活、订单、支付回调、New API 管理编排。
- OVH New API 是 quota、余额、消费流水 source of truth。
- 客户端本地 OpenClaw 直接请求香港 Nginx 反代后的 New API endpoint。
- 新 U-Claw 云端后端只放在 `u-claw-app-dev/cloud/uclaw-cloud-api`；禁止放入 `product/activation-server`、`product`、`u-claw-app`。
- 1 核 1G ECS 生产建议不跑同机全量 Docker Compose；优先单 Go binary + systemd，Redis/asynq 延后，MVP 可用 PostgreSQL job/outbox。
- PRD 第 383 行已固化 MVP 打包结论与 Phase 0 必交付项。
- 验证通过：`go test ./...`、`go vet ./...`、`VERSION=0.1.0-test ./deploy/scripts/release-linux-amd64.sh`。
- 最新验证通过：`go test ./...`、`go vet ./...`、`./deploy/scripts/smoke-local.sh`、`VERSION=0.1.1-test ./deploy/scripts/release-linux-amd64.sh`。
- 本地 New API lab 使用 `calciumion/new-api:latest` + SQLite 单容器；本机已跑通 `./deploy/scripts/newapi-local-spike.sh`。
- 实测 New API `add quota` payload 为 `{id, action:"add_quota", mode:"add", value}`，代码已修正。
- 实测 `POST /api/token/` 成功响应不返回明文 token，但 New API DB 已创建 key；生产前必须确认可返回 token 的接口或可接受流程。
- 最新验证通过：`go test ./...`、`go vet ./...`、`./deploy/scripts/smoke-local.sh`、`./deploy/scripts/newapi-local-spike.sh`、`VERSION=0.1.4-test ./deploy/scripts/release-linux-amd64.sh`。
- Phase 1 第一刀使用 `internal/auth.Store` seam；当前默认 `MemoryStore` 只用于 dev/smoke，下一步替换为 PostgreSQL store。
- 本轮验证通过：`go test ./...`、`go vet ./...`、`./deploy/scripts/smoke-local.sh`、`VERSION=0.1.5-test ./deploy/scripts/release-linux-amd64.sh`。
- `/dev/auth` 已按用户反馈移除；首启登录界面现在归属 `u-claw-app-dev/src/activation.html`，在 `UCLAW_ACTIVATION_ONLY=1` 软件受限模式内验收。
- 最新验证通过：`node scripts/verify-activation-only-mode.js`、`go test ./...`、`go vet ./...`、`./deploy/scripts/smoke-local.sh`、Electron Playwright 首启交互（发码、自动填 `123456`、提交、显示 `138****8000`）。
- 普通启动 gate 验证通过：使用空 `UCLAW_DEV_DATA_DIR` 时自动进入激活页；提交后写入 `.openclaw/uclaw-activation.json`；预置 marker 时跳过激活页进入正常 loading。
- 云端激活路径验证通过：本地 Go API + Electron Playwright 走 `UCLAW_ACTIVATION_ENDPOINT=http://127.0.0.1:8080`，完成 SMS/login/redeem，并写入 New API baseUrl/apiKey/default models。
- 本轮 PG 切片验证通过：`go test ./...`、`go vet ./...`、`./deploy/scripts/smoke-local.sh`、`VERSION=0.1.7-test ./deploy/scripts/release-linux-amd64.sh`、`git diff --check`。
- 当前生产 PG store 覆盖 `sms_codes`、`uclaw_users`、`activation_codes`；未配置 `DATABASE_URL` 时仍走本地 memory store，保持 smoke/Electron dev 可验收。
- New API token 明文回收路径已确认：创建 token 后搜索 token id，再用 token 所属用户 access token 调 `POST /api/token/{id}/key`，返回 key 后补 `sk-` 前缀给客户端。
- New API provisioning 使用 `NEWAPI_USER_PASSWORD_SECRET` 派生确定性 dashboard password，支持失败后同用户重试，不长期保存明文 password。
- 最新完整验证通过：`go test ./...`、`go vet ./...`、`./deploy/scripts/smoke-local.sh`、`./deploy/scripts/newapi-local-spike.sh`、`./deploy/scripts/activation-local-e2e.sh`、`VERSION=0.1.8-test ./deploy/scripts/release-linux-amd64.sh`、`git diff --check`。
- New API usage summary 已接 `/api/user/self` 与 `/api/log/self`；模型页通过 `window.uclaw.getModelUsageSummary()` 走 Electron main 代理，不直接暴露本地文件路径。
- 最新完整验证通过：`node scripts/verify-activation-only-mode.js`、`node scripts/verify-model-usage-dashboard.js`、`node scripts/verify-cloud-model-usage-ui.js`、`go test ./...`、`go vet ./...`、`./deploy/scripts/smoke-local.sh`、`./deploy/scripts/newapi-local-spike.sh`、`./deploy/scripts/activation-local-e2e.sh`、`VERSION=0.1.9-test ./deploy/scripts/release-linux-amd64.sh`、`git diff --check`。
