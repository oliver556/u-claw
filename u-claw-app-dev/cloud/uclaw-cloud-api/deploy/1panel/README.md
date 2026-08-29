# 1Panel New API / sub2api 部署说明

## 目标拓扑

- `158.51.110.49:14851`：New API / sub2api 源站，安装 1Panel、Docker、PostgreSQL、Redis 和业务容器。
- `64.90.19.251:24851`：前置反代，只开放 `api.yiyong.me`、`sub2api.yiyong.me`，并限制管理路径来源。
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

源站 stack 会通过 Docker Compose 创建 PostgreSQL 与 Redis：

- PostgreSQL：启动时执行 `postgres-init/001-create-databases.sql`，创建 `oneapi` 与 `sub2api` 两个 database。
- Redis：启用密码；`NEWAPI_REDIS_DB=0` 给 New API；`SUB2API_REDIS_DB=1` 给 sub2api。

默认 `POSTGRES_HOST=postgres`、`REDIS_HOST=redis`，同一 compose network 内互通。若改用 1Panel 应用商店单独创建的数据库，把这两个值替换为对应容器服务名或内网地址。

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
postgres-init/001-create-databases.sql
apply-origin-firewall.sh
```

`.env` 由 `newapi-sub2api.env.example` 复制后填写真实值，禁止提交。启动：

```bash
docker compose --env-file .env -f newapi-sub2api.compose.yml up -d
docker compose --env-file .env -f newapi-sub2api.compose.yml ps
```

sub2api 官方镜像的 auto-setup 使用 `DATABASE_HOST/DATABASE_USER/DATABASE_DBNAME` 与 `REDIS_HOST/REDIS_DB` 等拆分变量，不使用 `DATABASE_URL`。`SUB2API_ADMIN_PASSWORD` 只在首次初始化空库时生效，后续改 `.env` 不会覆盖已有管理员密码。

源站安全组或防火墙只允许 `64.90.19.251` 访问 `3000/8080`，禁止公网任意访问源站业务端口。Docker 映射端口建议使用 `DOCKER-USER` 链收口：

```bash
FRONT_IP=64.90.19.251 ./apply-origin-firewall.sh
```

脚本会写入 `uclaw-origin-firewall.service`，重启后自动恢复端口 allowlist。

## 前置反代

在前置 `64.90.19.251` 安装 Nginx/OpenResty 或使用 1Panel 网站反代，参考 `newapi-front-nginx.conf`：

- `api.yiyong.me/v1/`：公网模型 API。
- `api.yiyong.me/api/user/*`、`/api/token/*`、`/api/log/*`：仅允许 `121.41.89.103`。
- `sub2api.yiyong.me/`：默认仅允许 `121.41.89.103`，需要浏览器管理时临时加办公室/VPN IP。

TLS 证书由 1Panel/OpenResty 或 Caddy 自动签发；不要把证书私钥放入 repo。

当前验收状态：

- `https://api.yiyong.me/v1/models`：公网可达，代表 New API 客户端 API 已经走通，等待真实 token。
- `https://api.yiyong.me/`：非授权来源返回 `403`；从 `121.41.89.103` 返回 `200`。
- `https://sub2api.yiyong.me/`：非授权来源返回 `403`；从 `121.41.89.103` 返回 `200`。
- `http://158.51.110.49:3000/` 与 `http://158.51.110.49:8080/`：非前置来源超时，代表源站直连已收口。

## U-Claw Cloud API 对接值

`121.41.89.103` 的 `uclaw-cloud-api.env` 中应使用：

```text
NEWAPI_ADMIN_BASE_URL=https://api.yiyong.me
NEWAPI_CLIENT_BASE_URL=https://api.yiyong.me/v1
```

`NEWAPI_ADMIN_TOKEN` 只放服务器受限 env。短信当前代码链路已受理，但阿里云回执 `PORT_NOT_REGISTERED`，需等签名/端口实名报备生效后再做送达验收。
