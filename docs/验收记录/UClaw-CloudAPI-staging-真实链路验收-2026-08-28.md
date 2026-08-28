# U-Claw Cloud API staging 真实链路验收

时间：2026-08-28

## 范围

- 服务器：`121.41.89.103`
- 服务：`uclaw-cloud-api-staging.service`
- 监听：`127.0.0.1:18180`
- New API：`https://newapi.yiyong.me`
- 客户端 API：`https://newapi.yiyong.me/v1`

## 结果

- `uclaw-cloud-api-staging.service` 状态为 `active`。
- `/healthz` 返回 `status=ok`、`env=production`。
- `/readyz` 返回 DB 与 New API 已配置；Alipay/WeChat 尚未配置。
- New API Root 管理员已创建，管理员 token 已写入阿里云 staging env。
- 首启激活 `POST /v1/activations` 通过：
  - `ok=true`
  - `status=server_bound`
  - `artifactStatus=pending_client_write`
  - `newapiToken` 存在
  - `newapiBaseUrl=https://newapi.yiyong.me/v1`
- 写盘确认 `POST /v1/activations/{activationId}/commit` 通过：
  - `ok=true`
  - `status=committed`
- U-Claw DB 中存在 committed activation attempt。
- New API 中可查到本次 staging 用户。

## 修复项

真实 staging 验收暴露两个后端缺口，已修复：

- PostgreSQL `BindFirstStart` 现在返回真实 U-Claw user id，避免 New API account mapping 使用 synthetic id 触发外键问题。
- New API 用户已存在时，provisioning 会搜索并复用已存在用户，避免重试时因唯一键冲突中断。

## 暂放项

- 阿里云短信 `SendSms` 已被平台受理，但运营商回执仍为 `PORT_NOT_REGISTERED`；此问题待短信签名/端口实名报备审核完成后复验，不阻塞当前 New API / 激活主线。
- 支付 SDK 与真实支付回调仍未接入。

## 安全说明

- 本记录不包含 New API token、管理员密码、短信密钥、数据库密码或激活码明文。
- New API 管理员凭据仅存源站 `/root/uclaw-newapi-admin.env`。
- 阿里云 Cloud API staging env 仅存 `/etc/uclaw-cloud-api/uclaw-cloud-api-staging.env`，权限为 `600`。
