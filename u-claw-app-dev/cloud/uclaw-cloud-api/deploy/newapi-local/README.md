# Local New API Lab

本目录用于在本机启动一个 New API 实例，服务 U-Claw Cloud API Phase 0 联调。

## 启动

```bash
./deploy/scripts/newapi-local-up.sh
```

默认访问：

```text
http://127.0.0.1:3000
```

如 3000 被占用：

```bash
NEWAPI_LOCAL_PORT=33000 ./deploy/scripts/newapi-local-up.sh
```

## 停止

```bash
./deploy/scripts/newapi-local-down.sh
```

## 联调步骤

1. 打开 New API 页面并完成初始化。
2. 在 New API 后台拿到管理用 token 或可调用管理接口的 token。
3. 导出环境变量：

```bash
export NEWAPI_ADMIN_BASE_URL=http://127.0.0.1:3000
export NEWAPI_ADMIN_TOKEN=<new-api-admin-token>
```

4. 执行 U-Claw spike：

```bash
go run ./cmd/adminctl spike newapi create-user \
  --username 13800138000 \
  --password random-password

go run ./cmd/adminctl spike newapi create-token \
  --token-name uclaw-main

go run ./cmd/adminctl spike newapi add-quota \
  --user-id <newapi-user-id> \
  --quota 100000
```

## 数据位置

本地 New API 数据写入：

```text
deploy/newapi-local/data
deploy/newapi-local/logs
```

这些目录只用于本机联调，不应提交到 Git。
