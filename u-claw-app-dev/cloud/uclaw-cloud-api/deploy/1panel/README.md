# 1Panel New API / sub2api 部署说明

## 目标拓扑

- `158.51.110.49:14851`：New API / sub2api 源站，安装 1Panel、Docker、PostgreSQL、Redis 和业务容器。
- `64.90.19.251:24851`：前置反代，只开放 `newapi.yiyong.me`、`sub2api.yiyong.me`，并限制管理路径来源。
- `121.41.89.103:22`：U-Claw Cloud API，只允许它访问 New API 管理接口。

## 1Panel 基础安装

官方安装入口：

```bash
bash -c "$(curl -sSL https://resource.1panel.pro/v2/quick_start.sh)"
```

安装完成后用：

```bash
1pctl user-info
```

取回面板地址和初始账号。初始密码不得写入 Git；上线前必须改为长随机密码，并限制面板访问来源。

## 1Panel 数据服务

在源站 `158.51.110.49` 的 1Panel 中创建：

- PostgreSQL：创建 `oneapi` 与 `sub2api` 两个 database，可共用一个最小权限用户。
- Redis：启用密码；`NEWAPI_REDIS_DB=0` 给 New API；`SUB2API_REDIS_DB=1` 给 sub2api。

若 1Panel 创建的 PostgreSQL/Redis 只在 Docker 网络内可访问，需把 `POSTGRES_HOST`、`REDIS_HOST` 填成 1Panel 应用网络里的服务名；若监听本机端口，则可用 `127.0.0.1`。

## 源站业务容器

在源站创建目录：

```bash
mkdir -p /opt/uclaw-newapi-stack
cd /opt/uclaw-newapi-stack
```

放入：

```text
newapi-sub2api.compose.yml
.env
```

`.env` 由 `newapi-sub2api.env.example` 复制后填写真实值，禁止提交。启动：

```bash
docker compose --env-file .env -f newapi-sub2api.compose.yml up -d
docker compose --env-file .env -f newapi-sub2api.compose.yml ps
```

源站安全组或防火墙只允许 `64.90.19.251` 访问 `3000/8080`，禁止公网任意访问源站业务端口。

## 前置反代

在前置 `64.90.19.251` 安装 Nginx/OpenResty 或使用 1Panel 网站反代，参考 `newapi-front-nginx.conf`：

- `newapi.yiyong.me/v1/`：公网模型 API。
- `newapi.yiyong.me/api/user/*`、`/api/token/*`、`/api/log/*`：仅允许 `121.41.89.103`。
- `sub2api.yiyong.me/`：默认仅允许 `121.41.89.103`，需要浏览器管理时临时加办公室/VPN IP。

TLS 证书由 1Panel/OpenResty 或 Caddy 自动签发；不要把证书私钥放入 repo。

## U-Claw Cloud API 对接值

`121.41.89.103` 的 `uclaw-cloud-api.env` 中应使用：

```text
NEWAPI_ADMIN_BASE_URL=https://newapi.yiyong.me
NEWAPI_CLIENT_BASE_URL=https://newapi.yiyong.me/v1
```

`NEWAPI_ADMIN_TOKEN` 只放服务器受限 env。短信当前代码链路已受理，但阿里云回执 `PORT_NOT_REGISTERED`，需等签名/端口实名报备生效后再做送达验收。
