# 1Panel 域名入口验收记录

时间：2026-08-29 19:17

## 目标

- `1panel.yiyong.me` 指向本体 VPS `158.51.110.49`，访问本体 1Panel。
- `2panel.yiyong.me` 指向前置 VPS `64.90.19.251`，访问前置 1Panel。

## 本体 VPS

```txt
IP：158.51.110.49
DNS：1panel.yiyong.me -> 158.51.110.49
1Panel：已存在，1panel-core / 1panel-agent active
入口：Caddy
反代：1panel.yiyong.me -> 127.0.0.1:18088
HTTPS：Caddy 自动证书
公网验收：https://1panel.yiyong.me/ -> 200 text/html
```

## 前置 VPS

```txt
IP：64.90.19.251
DNS：2panel.yiyong.me -> 64.90.19.251
1Panel：本次安装完成，1panel-core / 1panel-agent active
Docker：本次随 1Panel 安装完成
本机端口：28807
入口：NGINX
反代：2panel.yiyong.me -> 127.0.0.1:28807
HTTPS：Certbot + NGINX，自动续签
公网验收：https://2panel.yiyong.me/ -> 200 text/html
```

## 安全

- 未记录 1Panel 密码。
- 未记录 1Panel 安全入口。
- 未记录 SSH 密码。
- 如需查看登录信息，在对应服务器执行 `1pctl user-info`。

## 密码统一

2026-08-29 19:23 已将本体 VPS 与前置 VPS 的 1Panel 用户密码统一为用户指定值。

复验：

```txt
1panel.yiyong.me -> 200 text/html
2panel.yiyong.me -> 200 text/html
本体 1panel-core / 1panel-agent -> active
前置 1panel-core / 1panel-agent -> active
```

未修改 SSH root 密码、数据库密码、R2/Cloudflare secret 或 device token。

## 说明

前置 VPS 原有 `api.yiyong.me` / `newapi.yiyong.me` NGINX 反代未移除；本次只新增 `2panel.yiyong.me` 独立 server block。
