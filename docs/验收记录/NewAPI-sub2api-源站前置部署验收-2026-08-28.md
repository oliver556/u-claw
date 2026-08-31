# New API / sub2api 源站与前置部署验收

时间：2026-08-28

## 范围

- 源站：`158.51.110.49:14851`
- 前置：`64.90.19.251:24851`
- 调用方：`121.41.89.103`
- 域名：`newapi.yiyong.me`、`sub2api.yiyong.me`

## 结果

- 源站已安装 1Panel v2.2.5、Docker 与 Docker Compose。
- 源站 Docker stack 已启动：PostgreSQL、Redis、New API、sub2api。
- New API 本机健康检查返回 `200`。
- sub2api 本机健康检查返回 `200`，容器 health 状态为 `healthy`。
- 前置已安装 Nginx/Certbot，并签发 `newapi.yiyong.me` 与 `sub2api.yiyong.me` HTTPS 证书。
- 公网 `https://newapi.yiyong.me/v1/models` 返回 `401`，说明客户端 API 路由可达，等待真实 token。
- 公网 `https://newapi.yiyong.me/` 返回 `403`，管理根路径未对公网开放。
- 公网 `https://sub2api.yiyong.me/` 返回 `403`，sub2api 管理面未对公网开放。
- 从 `121.41.89.103` 请求 `https://newapi.yiyong.me/` 返回 `200`。
- 从 `121.41.89.103` 请求 `https://sub2api.yiyong.me/` 返回 `200`。
- 源站 `3000/8080` 已通过 `DOCKER-USER` allowlist 限制；非前置来源直连超时。

## 已知待办

- 初始化 New API 管理员，生成 `NEWAPI_ADMIN_TOKEN`。
- 将 `NEWAPI_ADMIN_BASE_URL=https://newapi.yiyong.me` 与 `NEWAPI_CLIENT_BASE_URL=https://newapi.yiyong.me/v1` 写入阿里云 Cloud API 受限 env。
- 等阿里云短信签名/端口实名报备完成后，重跑真实短信送达验收。
- 支付 SDK、订单列表 UI、充值记录 UI 仍未开始。

## 安全说明

- 本记录不包含 SSH 密码、1Panel 密码、New API token、短信密钥或数据库密码。
- 上线前仍需轮换测试 root 密码，并改用 SSH key 与非 root deploy 用户。
