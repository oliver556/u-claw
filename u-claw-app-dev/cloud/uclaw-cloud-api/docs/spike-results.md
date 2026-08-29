# Bavi-box Cloud API Phase 0 Spike Results

更新时间：2026-08-27 05:09

## 目标

用计划部署的 New API Docker tag 实测 Bavi-box 后端需要的管理动作。

## 待验证动作

- [x] `POST /api/user/` 创建同手机号 New API 用户。
- [x] 用 username 查询或登录拿到 New API user id。
- [x] `POST /api/token/` 通过 `create-token` 创建用户 API token，并确认响应字段。
- [x] `POST /api/user/manage` 通过 `{id, action:"add_quota", mode:"add", value}` 给用户 add quota。
- [x] 用普通用户 token 查询余额、用量、流水。
- [ ] 香港 Nginx 管理路径只允许阿里云服务器 IP。

## 环境

```text
New API Docker tag: calciumion/new-api:latest
New API version: v1.0.0-rc.26
New API admin base URL: http://127.0.0.1:3000
本地 New API URL: http://127.0.0.1:3000
香港 Nginx endpoint: 未测试
测试手机号: 13987754323
测试时间: 2026-08-26 22:25
```

## 结果记录

```text
创建用户: OK，POST /api/user/ 成功，username=13987754323
查询 user id: OK，GET /api/user/search?keyword=13987754323 返回 user_id=6
创建 token: OK，POST /api/token/ 成功；响应不返回明文 token，但 tokens 表已创建 user_id=6 的 key
add quota: OK，POST /api/user/manage 使用 {id, action:"add_quota", mode:"add", value} 成功，users.quota=100000
查余额/流水: OK，`activation-local-e2e.sh` 通过 Bavi-box Cloud API 以普通用户身份读取 New API `/api/user/self` 和 `/api/log/self`，accountBalance=100000，records=2
虚拟充值后余额: OK，虚拟回调 credited 后再次查询，accountBalance=150000
```

## 建议命令

```bash
./deploy/scripts/newapi-local-up.sh
./deploy/scripts/newapi-local-spike.sh

export NEWAPI_ADMIN_BASE_URL=
export NEWAPI_ADMIN_TOKEN=

go run ./cmd/adminctl spike newapi create-user \
  --username <phone> \
  --password <random-password>

go run ./cmd/adminctl spike newapi create-token \
  --token-name uclaw-main

go run ./cmd/adminctl spike newapi add-quota \
  --user-id <newapi-user-id> \
  --quota <quota-tokens>
```

## 结论

```text
本地 New API SQLite 单容器可用于 Phase 0 管理 API 联调。
已验证：admin 创建用户、按 username 查询 user id、用户登录后创建 API token、admin add quota。
重要修正：add quota 不能使用 {id, quota}，必须使用 {id, action:"add_quota", mode:"add", value}。
重要发现：POST /api/token/ 成功响应不返回明文 token；需用 token 所属用户 access token 调 `POST /api/token/{id}/key` 获取真实 key。
2026-08-27 补验：`spike newapi provision` 已跑通创建同名用户、用户登录、创建 token、搜索 token id、fetch real key、admin add quota；脚本只输出 `token_present=true`，不打印明文 key。
2026-08-27 补验：`activation-local-e2e.sh` 已跑通短信登录、激活兑换、真实 New API token 返回、普通用户 usage summary、虚拟充值和充值后余额增加。
未完成：OVH New API + 香港 Nginx 路径验收。
```
