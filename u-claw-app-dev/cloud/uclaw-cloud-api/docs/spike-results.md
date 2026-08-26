# U-Claw Cloud API Phase 0 Spike Results

更新时间：未执行

## 目标

用计划部署的 New API Docker tag 实测 U-Claw 后端需要的管理动作。

## 待验证动作

- [ ] `POST /api/user/` 创建同手机号 New API 用户。
- [ ] 用 username 查询或登录拿到 New API user id。
- [ ] `POST /api/token/` 通过 `create-token` 创建用户 API token，并确认响应字段。
- [ ] `POST /api/user/manage` 通过 `--user-id` 给用户 add quota。
- [ ] 用普通用户 token 查询余额、用量、流水。
- [ ] 香港 Nginx 管理路径只允许阿里云服务器 IP。

## 环境

```text
New API Docker tag:
New API admin base URL:
本地 New API URL:
香港 Nginx endpoint:
测试手机号:
测试时间:
```

## 结果记录

```text
创建用户:
查询 user id:
创建 token:
add quota:
查余额/流水:
```

## 建议命令

```bash
./deploy/scripts/newapi-local-up.sh

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
待填写。
```
