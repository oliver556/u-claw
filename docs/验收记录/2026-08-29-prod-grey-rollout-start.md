# Prod Hard Update 灰度启动记录

时间：2026-08-29 18:35

## 结论

prod hard update 已进入灰度发布状态，不是全量发布。

当前灰度门禁为 device allowlist，仅放行 1 台 prod 测试设备。后续扩灰时，将待扩灰设备的 `device_id` 追加到远端 allowlist 文件即可。

## 配置状态

```txt
服务：uclaw-update.service
状态：active
authMode：postgres
DB：uclaw_activation
DB 用户：uclaw_update_readonly
DATABASE_URL：root-only file，0600
R2 base：prod R2 public URL
灰度策略：device allowlist
灰度设备数：1
```

## Release 状态

prod R2 `production.json` 验收：

```txt
HTTP=200
requiredVersion=1.0.1
releaseId=v1.0.1
platforms=darwin-arm64,darwin-x64,win32-x64
```

三平台 manifest 表面验收：

```txt
darwin-arm64 manifest -> 200
darwin-x64 manifest -> 200
win32-x64 manifest -> 200
```

## Update Check 回归

灰度测试设备公网 update check：

```txt
HTTP=200
allowed=true
forceUpdate=true
requiredVersion=1.0.1
releaseId=v1.0.1
manifestUrl=https://pub-4f24fbbe718b4c75955440700c70bdeb.r2.dev/releases/packages/v1.0.1/win32-x64/manifest.json
packageUrl=https://pub-4f24fbbe718b4c75955440700c70bdeb.r2.dev/releases/packages/v1.0.1/win32-x64/runtime.pkg
```

无 token 请求：

```txt
HTTP=200
allowed=false
reason=missing-device-token
requiredVersion=1.0.1
releaseId=v1.0.1
```

服务日志证据：

```txt
[hard-update-control-plane] postgres auth allowed deviceId=51f85535-c3fe-4608-bcdd-402a2e58f097
```

## 观察

启动后 1 分钟观察：

```txt
uclaw-update.service=active
recent warnings=0
```

## 安全

- 未记录 DATABASE_URL 明文。
- 未记录密码。
- 未记录 device token。
- 未记录 R2/Cloudflare secret。

## 回滚

若需停止灰度：

1. 清空远端 device allowlist 文件。
2. 重启 `uclaw-update.service`。
3. 复验目标设备不再返回 `allowed=true`。

若需回滚配置：

1. 使用远端 `/root/uclaw-update.env.before-rollout-*` 还原 env。
2. 使用远端 `/root/hard-update-control-plane-server.js.before-rollout-*` 还原服务脚本。
3. 重启 `uclaw-update.service`。
