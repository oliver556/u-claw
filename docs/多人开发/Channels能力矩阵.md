# Channels 能力矩阵

更新时间：2026-08-23

## 1. 状态口径

本矩阵遵守 `docs/多人开发/开发硬性要求.md`：没有 OpenClaw 原版 `method/event/CLI/config` 支撑的能力，不进入正式 Bavi-box 能力承诺。Channels 页当前只包裹 OpenClaw 已有渠道状态、配置与登录入口，不自造微信/第三方渠道 runtime。

状态含义：

- `OK`：OpenClaw 已有方法、CLI 或配置 schema，Bavi-box 可展示为原能力入口。
- `Blocked`：有明确卡点，不作为完成能力宣传。
- `Unknown`：未确认权威调用方式，不开发。
- `Do Not Build`：不投入。

## 2. 矩阵

| # | OpenClaw 原能力 | Bavi-box UI 入口 | 权威调用方式 | 配置来源 | 当前状态 | 验证命令/证据 | 风险 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Channels status snapshot | Channels 页健康快照 | Gateway `channels.status`; CLI `openclaw channels status --probe` | `openclaw.json` channels 配置与插件状态 | OK | `server-methods-NpEcZnvp.js` 注册 `channels.status`; `status-C6B9x3W8.js` 使用该 method | probe 失败只代表账号/网络未配置，不代表 UI 假能力 | 可展示状态，不宣称账号已接通 |
| 2 | Channels start/stop/logout | Channels 页刷新、登录、退出类操作 | Gateway `channels.start` / `channels.stop` / `channels.logout` | OpenClaw channel runtime | OK | `server-methods-NpEcZnvp.js` 注册 `channels.start/stop/logout` | 第三方平台凭证缺失会失败 | UI 文案需说明配置态 |
| 3 | Channel config edit | Channels 页配置表单 | `runtimeConfig.save()` + config schema | OpenClaw runtime config schema | OK | `channels-page-*.js` 调用 `runtimeConfig.ensureSchemaLoaded()` 与 `runtimeConfig.save()` | schema 为空时只能用 Raw mode | 仅编辑 OpenClaw config，不改底座 |
| 4 | WhatsApp QR login | WhatsApp 卡片 QR / relink / logout | Gateway `web.login.start`, `web.login.wait`, `channels.logout` | OpenClaw WhatsApp channel runtime | OK | `channels-page-*.js` 调用 `web.login.start` / `web.login.wait` | 依赖本地浏览器会话与第三方 Web 登录 | 可展示入口，但不承诺一定登录成功 |
| 5 | Nostr profile import/publish | Nostr 资料编辑 | HTTP `/api/channels/nostr/:account/profile` 与 `/import` | Nostr channel config/accounts | OK | `channels-page-*.js` fetch `/api/channels/nostr/.../profile` | 依赖 relays、private key、账号配置 | 仅保留原能力 |
| 6 | Telegram / Discord / Slack / Google Chat / Signal / iMessage status cards | Channels 页各渠道卡片 | `channels.status` 返回 `channelMeta` / `channelOrder` / status payload | 对应 channel config 与插件 | OK | `channels-page-*.js` 从 `channelMeta` / `channelOrder` 渲染；fallback 包含这些 channel id | 未配置时只应显示未配置/未连接，不可宣传已接入 | 下一步可继续补 UI 文案 |
| 7 | 微信渠道 | 无正式入口 | 未确认 OpenClaw method/event/CLI/config | 无 | Unknown | 当前未发现微信 channel authority | 若自造入口会违反硬性要求 | 不开发，待原能力确认 |

## 3. 结论

Channels 页可继续 Bavi-box 化 UI 文案，但只能作为 OpenClaw 原 channel runtime 的状态/配置入口。微信或其他未确认渠道不进入正式 UI。
