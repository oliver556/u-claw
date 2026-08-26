# U-Claw Cloud API Phase 0 Spike Results

更新时间：2026-08-26 22:25

## 目标

用计划部署的 New API Docker tag 实测 U-Claw 后端需要的管理动作。

## 待验证动作

- [x] `POST /api/user/` 创建同手机号 New API 用户。
- [x] 用 username 查询或登录拿到 New API user id。
- [x] `POST /api/token/` 通过 `create-token` 创建用户 API token，并确认响应字段。
- [x] `POST /api/user/manage` 通过 `{id, action:"add_quota", mode:"add", value}` 给用户 add quota。
- [ ] 用普通用户 token 查询余额、用量、流水。
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
查余额/流水: 未测试，待补普通用户 token 查询接口
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
重要发现：POST /api/token/ 成功响应不返回明文 token；token key 已落库，生产链路需要确认是否可通过 API 响应拿 key，或改用 New API 支持的可返回 key 的接口/流程。
未完成：普通用户 token 查询余额/流水接口、OVH New API + 香港 Nginx 路径验收。
```
