# 2026-08-29 activation update credential closure

## 结论

- 当前 U 盘已补入硬更新凭据文件：`/Volumes/U-claw-1/Bavi-box/data/.openclaw/update-credential.v1.json`。
- 该凭据文件可驱动公网 `https://updates.yiyong.me/uclaw/update/check` 真实查库成功。
- Cloud API 已发布 `0.1.10`，支持 activation 响应可选返回 `updateCredential`。
- 未在本文档写入任何密码、DATABASE_URL、New API key、R2 secret 或 device token。

## 本次改动

- Cloud API `/v1/activations` 响应新增可选 `updateCredential`。
- 新增文件型 issuer：`UPDATE_CREDENTIAL_FILE` 指向 root-only JSON 文件。
- 文件型 issuer 必须命中 `allowedActivationIds`、`allowedPrincipals` 或 `allowedUsbFingerprintSummaries` 绑定条件，避免全局下发同一 token。
- Electron main 收到 `updateCredential` 后写入 `.openclaw/update-credential.v1.json`。
- `uclaw-activation.json` 只记录 `updateCredentialStatus`、`updateDeviceId` 和 token fingerprint，不记录 raw token。

## 现场动作

- 阿里云 `uclaw-cloud-api-staging` 已切到 `0.1.10`。
- 本次 U 盘采用安全单独下发方式补凭据。
- 旧 prod 测试 token 已视为暴露并轮换；新 token 仅保留在远端 root-only 文件和当前 U 盘凭据文件。
- 未启用 Cloud API 静态 issuer，因为当前 U 盘没有可用于精确绑定的 `uclaw-activation.json` / `activationId`。

## 脱敏验收

公网 update check 从 U 盘凭据文件发起，结果：

```text
HTTP=200
allowed=true
forceUpdate=true
requiredVersion=1.0.1
releaseId=v1.0.1
manifestUrl=prod R2 / releases/packages/[version]/...
packageUrl=prod R2 / releases/packages/[version]/...
```

本地验证：

```text
go test ./...
go vet ./...
node scripts/verify-activation-only-mode.js
node scripts/verify-activation-real-write.js
./deploy/scripts/activation-artifact-local-e2e.sh
git diff --check
```

## 回滚

- 若 U 盘硬更新测试异常，删除当前 U 盘的 `.openclaw/update-credential.v1.json` 即可回到“已激活但不自动 update check”的状态。
- 若 Cloud API 0.1.10 异常，将 `/opt/uclaw-cloud-api-staging/current` symlink 切回上一 release，并重启 `uclaw-cloud-api-staging`。
