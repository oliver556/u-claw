# Bavi-box 支付宝真实充值开发文档

更新时间：2026-08-31

## 1. 目标

把模型页“充值”从当前 `virtual` provider 升级为支付宝真实收款流程。用户支付成功后，Bavi-box Cloud API 必须把对应额度幂等充值到绑定的 New API 用户，并让客户端能看到订单状态、余额刷新和使用流水变化。

本开发只处理支付宝优先链路：

- 客户端创建支付宝充值订单。
- 阿里云 Bavi-box Cloud API 调支付宝 `alipay.trade.precreate` 生成二维码。
- 支付宝异步通知阿里云 `/v1/payments/alipay/notify`。
- 阿里云验签、校验金额、记录回调、订单入账。
- 阿里云调用 OVH New API admin `/api/user/manage` 给同手机号 New API 用户加 quota。
- 客户端轮询订单状态，`credited` 后刷新 `/v1/newapi/usage/summary`。

不在本切片实现微信支付、退款、对账文件下载、分账、订阅扣款。

## 2. 当前状态

已完成：

- `payment_orders`、`payment_callbacks`、`outbox_jobs` 基础表已存在。
- `internal/recharge` 已有订单状态机：`created -> paid -> crediting -> credited`，失败可到 `credit_failed`。
- `newapi.Client.AddQuota` 已验证，真实调用形态为 `{id, action:"add_quota", mode:"add", value}`。
- `POST /v1/recharge/orders` 已有 provider seam；`alipay` 未配置 adapter 时会拒绝创建订单。
- 支付宝 SPI onboarding 已接入并上线：`/isv/spi/service`，仅用于支付宝控制台接入校验，不是客户端真实充值。

必须修正：

- 计费口径按用户确认：`1 CNY = 600w 算力`。
- 当前 `internal/billing/conversion.go` 中 `ComputeUnitsPerCNY` 是 `60000000`，上线真实支付前应改为 `6000000`，并更新 Go/JS 验收断言。
- 客户端账户余额展示金额，不展示大额算力数字；金额换算继续用 `NewAPIQuotaPerCNY` 作为 New API raw quota 和 CNY 的折算比。

## 3. 真实支付架构

```text
Bavi-box 客户端
  -> POST /v1/recharge/orders provider=alipay
  <- orderNo + qrCode
  -> GET /v1/recharge/orders/{orderNo} 轮询

支付宝用户扫码支付
  -> 支付宝网关
  -> POST https://license.yiyong.me/v1/payments/alipay/notify

阿里云 Bavi-box Cloud API
  -> 验签 + 校验 app_id/order/amount/trade_status
  -> payment_callbacks 去重
  -> payment_orders 标记 paid
  -> New API admin add_quota
  -> payment_orders 标记 credited 或 credit_failed

OVH New API
  -> 用户 quota 增加
  -> /api/user/self 与 /api/log/self 成为余额/流水 source of truth
```

阿里云服务器只做订单、回调和管理编排，不承载模型推理。模型调用仍由客户端 OpenClaw 直连香港前置后的 New API endpoint。

## 4. 支付宝接口选择

优先使用当面付扫码充值：

- 下单：`alipay.trade.precreate`
- 补查：`alipay.trade.query`
- 通知：支付接口 `notify_url` 指向 `/v1/payments/alipay/notify`

依据支付宝官方文档：

- `alipay.trade.precreate` 用于线下交易预创建，返回二维码支付信息。
- 支付成功应优先依赖异步通知；未收到通知时，用 `alipay.trade.query` 根据 `out_trade_no` 或 `trade_no` 补查。
- 异步通知中只有 `TRADE_SUCCESS` 或 `TRADE_FINISHED` 才认定付款成功。

## 5. 需要新增/修改的后端事项

### 5.1 配置

修改 `internal/config/config.go` 与 `deploy/env/uclaw-cloud-api.env.example`，新增：

```text
ALIPAY_GATEWAY_URL=https://openapi.alipay.com/gateway.do
ALIPAY_APP_ID=<支付宝应用 app_id>
ALIPAY_PRIVATE_KEY_PATH=/etc/uclaw-cloud-api/alipay_private_key.txt
ALIPAY_PUBLIC_KEY_PATH=/etc/uclaw-cloud-api/alipay_public_key.txt
ALIPAY_NOTIFY_URL=https://license.yiyong.me/v1/payments/alipay/notify
ALIPAY_SIGN_TYPE=RSA2
ALIPAY_SELLER_ID=<可选，签约收款方 seller_id>
ALIPAY_ONE_CENT_TEST_ENABLED=false
```

说明：

- `ALIPAY_PRIVATE_KEY_PATH` 使用应用私钥，只放服务器文件系统，权限建议 `root:uclaw 0640`。
- `ALIPAY_PUBLIC_KEY_PATH` 使用支付宝公钥，用于验签同步响应和异步通知。
- 不把应用私钥、AES key、New API admin token、服务器密码写入 Git、README 或测试输出。
- 当前 `ALIPAY_PUBLIC_CERT_PATH` 名称容易和证书模式混淆；真实支付建议新增 `ALIPAY_PUBLIC_KEY_PATH`，不要复用证书字段。

### 5.2 支付宝 client

新增 `internal/payment/alipay` 或 `internal/alipaypay`：

- `Client.Precreate(ctx, req) (CheckoutResult, error)`
- `Client.Query(ctx, orderNo) (TradeQueryResult, error)`
- `VerifyNotify(form url.Values) (Notify, error)`
- `Sign(params map[string]string) (string, error)`
- `Verify(params map[string]string, sign string) error`

签名规则：

- 公共参数包含 `app_id`、`method`、`format=JSON`、`charset=utf-8`、`sign_type=RSA2`、`timestamp`、`version=1.0`、`notify_url`。
- `biz_content` 至少包含 `out_trade_no`、`total_amount`、`subject`。
- 待签名字符串按支付宝规则排序并排除 `sign`、`sign_type`。
- 同步响应要校验 `sign`，再读取 `alipay_trade_precreate_response.code` 和 `qr_code`。

### 5.3 充值 service 接入 alipay checkout

修改 `internal/httpapi/server.go` 的 `buildRechargeService`：

- 当 `cfg.AlipayConfigured()` 为 true 时，创建 `alipay` checkout client。
- 注入到 `recharge.Config.CheckoutClients[recharge.ProviderAlipay]`。
- `/v1/recharge/providers` 中 `alipay.enabled=true`。

修改 `internal/recharge/service.go`：

- 保留 `ProviderVirtual` 仅非 production。
- `ProviderAlipay` 下单成功后返回：

```json
{
  "order": {
    "orderNo": "UC...",
    "provider": "alipay",
    "amountCents": 1000,
    "quota": 5000000,
    "status": "created"
  },
  "qrCode": "https://qr.alipay.com/...",
  "expiresAt": "2026-08-31T15:30:00Z"
}
```

字段兼容：

- 现有 `QRCodeURL` 可复用，但支付宝返回的是可扫码 URL，不一定是图片 URL。
- 客户端应把它当 QR 内容生成二维码，而不是当图片地址直接加载。

### 5.4 DB migration

新增 `migrations/000003_alipay_checkout.sql`：

```sql
ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS provider_checkout JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_payment_orders_provider_trade_no
  ON payment_orders(provider, provider_trade_no)
  WHERE provider_trade_no IS NOT NULL;
```

用途：

- `provider_checkout` 保存脱敏后的下单响应，如 `qr_code` hash、支付宝返回 code/msg。
- `expires_at` 给客户端展示二维码有效期。
- `provider_trade_no` 唯一索引用于回调幂等辅助。

### 5.5 支付宝异步通知

新增 route：

```text
POST /v1/payments/alipay/notify
```

处理流程：

1. 只接受 `application/x-www-form-urlencoded`。
2. 解析 form，保存最小脱敏原文。
3. 用支付宝公钥验签，验签失败返回 `failure`，不改订单。
4. 校验 `app_id` 等于 `ALIPAY_APP_ID`。
5. 用 `out_trade_no` 查询 `payment_orders`。
6. 校验订单 provider 是 `alipay`。
7. 校验 `total_amount` 精确等于 `amount_cents / 100`。
8. 可选校验 `seller_id` 等于 `ALIPAY_SELLER_ID`。
9. 只有 `TRADE_SUCCESS` / `TRADE_FINISHED` 标记 paid。
10. `payment_callbacks` 用 `trade_no` 或 `notify_id` 去重。
11. 幂等调用 New API add quota。
12. 入账成功返回 `success`；验签或金额异常返回 `failure`。

金额必须用整数分做主存储，不用 float 参与比较。支付宝 `total_amount` 字符串转成分后再比对。

### 5.6 New API 入账

复用现有逻辑：

- `Store.GetNewAPIAccount(userID)`
- `newapi.Client.AddQuota(AddQuotaRequest{UserID, Quota})`
- `BeginCredit` 防重复。
- `MarkCredited` / `MarkCreditFailed` 记录结果。

新增通用入账方法，避免 virtual/alipay 各写一份：

```go
func (s *Service) CreditPaidOrder(ctx context.Context, orderNo string) (Order, error)
```

`HandleVirtualCallback` 和 `HandleAlipayNotify` 都调用同一个入账方法。

失败策略：

- 支付回调验签和金额正确后，必须先把订单落到 `paid`。
- New API 加 quota 失败时，订单进入 `credit_failed`，保留 `last_error`。
- 增加后台重试入口或 worker，重试只处理 `credit_failed`，再次走 `BeginCredit`。

### 5.7 补查与补偿

新增内部管理接口或 adminctl：

```text
POST /internal/admin/v1/recharge/orders/{orderNo}/alipay-query
POST /internal/admin/v1/recharge/orders/{orderNo}/retry-credit
```

用途：

- 用户扫码成功但支付宝异步通知丢失时，调用 `alipay.trade.query` 查状态。
- 查到 `TRADE_SUCCESS` / `TRADE_FINISHED` 后按同一规则标记 paid 并入账。
- New API 临时不可用时，客服或定时 worker 可重试 `credit_failed`。

后续订单量上升后，再把这两个动作挂到 `outbox_jobs` worker。

### 5.8 套餐和 0.01 测试单

生产套餐建议仍从固定配置或 DB 读取，客户端只提交 `planCode`，不让客户端自由传金额。

建议 SKU：

```text
basic_10  10.00 CNY
plus_50   50.00 CNY
pro_100   100.00 CNY
```

0.01 元测试：

- 增加 `test_001` 计划，`amount_cents=1`。
- 只在 `ALIPAY_ONE_CENT_TEST_ENABLED=true` 时返回给客户端或允许创建。
- staging 可开启，正式上线后关闭。
- 0.01 对应 New API raw quota 应为 `NewAPIQuotaPerCNY / 100`，当前为 `500000 / 100 = 5000`。

### 5.9 客户端 UI

修改 `u-claw-app-dev/scripts/patch-openclaw.js` 中模型页充值流程：

- 点击“充值”调用 `window.uclaw.rechargeModelQuota`。
- 获取 `/v1/recharge/providers`，只展示 enabled provider。
- 创建订单：`POST /v1/recharge/orders {"planCode":"basic_10","provider":"alipay"}`。
- 弹窗展示：
  - 金额
  - 订单号
  - 支付宝二维码
  - 订单状态
  - 手动刷新按钮
- 每 2 秒轮询 `GET /v1/recharge/orders/{orderNo}`，最多 5 分钟。
- 状态到 `credited` 后关闭二维码或显示成功，并立即刷新 `/v1/newapi/usage/summary`。
- 状态到 `credit_failed` 时显示“支付已成功，额度同步中”，保留手动刷新，不提示用户重复支付。

二维码生成：

- 支付宝 `qr_code` 是二维码内容 URL。
- 客户端应本地生成二维码 bitmap/canvas。
- 不建议依赖第三方公网二维码生成服务。

## 6. 回测清单

### 6.1 Unit tests

新增/更新：

- `internal/billing/conversion_test.go`
  - `1 CNY = 600w compute`
  - `1 cent = NewAPIQuotaPerCNY / 100`
- `internal/payment/alipay/client_test.go`
  - `Precreate` 生成正确公共参数和 `biz_content`。
  - RSA2 签名排序稳定。
  - 同步响应验签通过后返回 `qr_code`。
  - 支付宝错误码不创建可支付结果。
- `internal/payment/alipay/notify_test.go`
  - `TRADE_SUCCESS` 验签成功。
  - `TRADE_FINISHED` 验签成功。
  - `WAIT_BUYER_PAY` 不入账。
  - 金额不一致拒绝。
  - `app_id` 不一致拒绝。
  - 重复 `trade_no` 不重复入账。
- `internal/recharge/service_test.go`
  - `ProviderAlipay` 下单调用 checkout client。
  - `HandleAlipayNotify` 标记 paid 并调用 New API add quota。
  - New API 失败进入 `credit_failed`。
  - `RetryCredit` 幂等。
- `internal/httpapi/server_test.go`
  - `/v1/payments/alipay/notify` 无 bearer 但必须验签。
  - `/v1/recharge/providers` 在支付宝配置完整时 enabled。

### 6.2 Local integration

使用本地 New API lab：

```bash
cd u-claw-app-dev/cloud/uclaw-cloud-api
./deploy/scripts/newapi-local-up.sh
go test ./...
go vet ./...
```

新增脚本：

```text
deploy/scripts/alipay-local-e2e.sh
```

脚本用本地生成的 RSA key 模拟支付宝：

1. 启动本地 Cloud API + PostgreSQL + New API lab。
2. 登录手机号测试用户。
3. 激活或确认已有 New API 映射。
4. 创建 `test_001` 支付宝订单。
5. 用测试私钥构造 `TRADE_SUCCESS` notify form。
6. 调 `/v1/payments/alipay/notify`。
7. 查询订单状态必须为 `credited`。
8. 查询 New API `/api/user/self`，余额增加 `5000` raw quota。
9. 再发一次相同 notify，余额不得二次增加。

### 6.3 Staging real pay

阿里云 staging 验收：

1. 部署新版本到 `uclaw-cloud-api-staging.service`。
2. 确认 `ALIPAY_*` env 已配置，不打印密钥。
3. 开启 `ALIPAY_ONE_CENT_TEST_ENABLED=true`。
4. 用真实手机号登录。
5. 创建 `test_001` 支付宝订单。
6. 客户端弹出二维码。
7. 支付宝扫码支付 `0.01`。
8. `journalctl` 确认 notify 验签成功。
9. `GET /v1/recharge/orders/{orderNo}` 返回 `credited`。
10. 模型页余额增加 `¥0.01`，不展示大额算力数字。
11. New API 后台确认同手机号用户 quota 增加。
12. 关闭 `ALIPAY_ONE_CENT_TEST_ENABLED` 或限制测试计划只对管理员可见。

### 6.4 Failure regression

必须回测：

- 支付宝 notify 金额比订单金额少：返回 `failure`，订单保持 `created`，New API 不加额度。
- 支付宝 notify 签名无效：返回 `failure`，不写 paid。
- 重复 notify：只保存/识别一次业务事件，只加一次 quota。
- New API 断开：订单变 `credit_failed`，支付不丢；恢复后 `retry-credit` 可入账。
- 用户未激活或无 `newapi_accounts`：支付成功后 `credit_failed`，后台可定位并补偿。
- 二维码过期：订单保持 `created` 或进入 `closed`，客户端允许重新创建订单。
- `/v1/recharge/orders` 无 bearer：401。
- `provider=virtual` 在 production：拒绝。

### 6.5 Client UI regression

必须回测：

- 模型页充值按钮可打开支付宝充值弹窗。
- 二维码区域比例正常，小屏不溢出。
- 支付中状态轮询不阻塞模型页其他展示。
- 支付成功后余额卡片刷新为金额。
- `credit_failed` 显示“额度同步中”，不让用户误以为没付款。
- 手动刷新按钮可重新查询订单状态和用量摘要。
- 原有模型切换、用量趋势、流水表不回退。

## 7. 部署步骤

1. 本地完成 unit tests 和 local E2E。
2. 打包：

```bash
cd u-claw-app-dev/cloud/uclaw-cloud-api
./deploy/scripts/release-linux-amd64.sh
```

3. 上传到阿里云 release 目录。
4. 确认 env 文件含支付宝配置，所有 secret 不输出到日志。
5. 执行 migration `000003_alipay_checkout.sql`。
6. 重启 `uclaw-cloud-api-staging.service`。
7. `curl /healthz` 和 `/v1/recharge/providers` 检查 `alipay.enabled=true`。
8. 做 0.01 staging real pay。
9. 通过后再部署正式服务名，关闭或限制 `test_001`。

## 8. 交付标准

完成即满足：

- 支付宝真实二维码可生成。
- 支付宝真实异步通知验签通过。
- 支付成功后订单进入 `credited`。
- New API 同手机号用户 quota 增加，且重复通知不重复加。
- 客户端模型页显示金额余额，支付成功后自动刷新。
- `go test ./...`、`go vet ./...`、local E2E、staging 0.01 real pay 全部通过。
- 文档、README、env example 均更新；不包含任何真实密钥。

## 9. 参考

- 支付宝 `alipay.trade.precreate`：https://opendocs.alipay.com/open/8ad49e4a_alipay.trade.precreate
- 支付宝 `alipay.trade.query`：https://opendocs.alipay.com/open/1bce7243_alipay.trade.query
- 支付宝异步通知说明：https://opendocs.alipay.com/open/194/103296
