# P3-T04 许可证生命周期交付报告

## 状态

`LIC-002` 代码与 localhost/沙箱自动化完成：签发、查询、撤销、重制、六类状态、typed 错误、24 小时有界离线容错、回滚防护和 Launcher 前置 gate。未接真实授权服务器、Stripe、Windows 真机或物理 U 盘；这些仍由 `P3-T08` 验收。

## 状态机与在线语义

状态固定为 `provisioning | active | revoked | reissued | expired | disabled`。本地 `license.json` Ed25519 签名只证明授权曾被签发，不代表在线状态仍为 `active`。

- 在线 signed receipt 必须绑定 license、device、revision、状态、有效期、`updatedAt`、`checkedAt`、`graceUntil` 和 key ID。
- receipt 使用 canonical strict base64url；签名、格式、license mismatch、device mismatch、authentication、transport/unavailable 分别返回固定 typed 错误。
- revision 单调；低 revision、同 revision 状态变化、终态回放为 active 全部拒绝。
- `provisioning/revoked/reissued/expired/disabled` 在线持久化后立即拒绝，不进入 runtime。

## 离线策略

仅在线查询发生 retryable unavailable/transport 时允许评估离线缓存。准入条件：最近一次成功在线状态为 `active`、P3-T03 本地签名/secret/device/fingerprint/time 全部有效、服务端 receipt 签名有效、U 盘 AEAD cache 有效、主机 HMAC anchor 有效，并且 anchor/cache 的 revision、状态、`lastObservedAt` 精确一致。

```text
effectiveGraceUntil = min(receipt.graceUntil, receipt.checkedAt + 24h, license.expiresAt)
```

首次离线、anchor 缺失、终态、缓存或 anchor 篡改、旧快照回滚、时钟回拨、回执重放超窗都 fail-closed。更新顺序为 host anchor 后 U 盘 cache；中途失败会留下不一致状态，后续继续拒绝。客户端持续离线且尚未获知服务端撤销时，撤销传播最坏上限为最后一次成功 active 在线确认后的 24 小时。

## 重制语义

重制输入必须提供新 `usbFingerprint/notBefore/expiresAt` 与幂等 key。事务生成全新 `licenseId`、随机 startup secret、salt/proof、签名授权文件；旧 license 递增 revision、标记 `reissued` 并记录 replacement license ID。旧授权永久拒绝。startup secret 不复用 New API Token，也不从其派生。

相同 key/输入重放同一加密封存结果；同 key/不同输入返回 `IDEMPOTENCY_CONFLICT`。同设备并发签发、同 license 并发重制只允许一个成功结果，失败可通过 typed error 与脱敏审计追踪。

## 安全边界

- Ed25519 私钥只由 localhost issuer/test signing boundary 以进程内对象注入；生产客户端、Launcher、U 盘产物、fixture 文件、workflow、日志无私钥。
- 生产 status endpoint 只接受 HTTPS；缺 endpoint 或 receipt 公钥 fail-closed。HTTP 只允许显式 exact-loopback 测试依赖。
- 状态查询、审计、公开错误、host anchor 和 cache 外层不泄露 startup secret、设备 Token、完整 USB 指纹、receipt、签名、Authorization、路径或远端 raw body。
- U 盘 cache 使用 startup-secret 独立 domain 的 AES-GCM；host anchor 使用另一独立 domain 的 HMAC。anchor 属于 gate authorization state，不是 runtime cache。
- Launcher 顺序保持 `ProbeDataDirectory -> P3-T03 local gate -> P3-T04 lifecycle gate -> instance lock/host runtime cache/manifest/runtime/process`。

## 代码证据

- Shared contract：`product/shared/src/license-lifecycle.ts`、shared/contract fixture tests。
- Local issuer/client：`product/desktop/src/license-lifecycle/`、`product/tests/integration/license-lifecycle-local.test.ts`。
- Launcher：`product/launcher/license.go`、`license_lifecycle.go`、`license_status_http.go`、production/fixture query files、`main.go`、`state.go` 及 tests。
- Windows/static：`.github/workflows/portable-launcher.yml`、`product/scripts/portable-launcher-workflow.test.mjs`、Windows signing fixture 与 PowerShell lifecycle harness。

## 自动化结果

- Node `24.15.0`：build/smoke、typecheck、full unit、contract、integration、portable static 全部 exit 0。`npm test` 共 1190 tests；独立 integration 29 tests；portable static 15 tests。
- Go `1.26.0`：`go test -count=1 ./...`、`go test -race -count=1 ./...`、`go vet ./...` 全部 exit 0。
- Windows amd64：production/fixture test binary 与 production/fixture exe 四项 `CGO_ENABLED=0` 交叉编译 exit 0。未执行 Windows 真机或物理 U 盘测试。
- 安全与静态：`git diff --check`、最终暂存后的 `npm run test:secrets` 均 exit 0。
- 独立 review：初轮问题经回归测试修复；最终复审 `Critical=0 Important=0 Minor=0`。

## 分支、提交与冲突

- Branch：`codex/p3-t04-license-lifecycle`
- Base：`b2d76561a1a62671761246d87f66b44cb4b9d75f`
- Commit range：`b2d76561..HEAD`
- 已有设计/计划提交：`0aa09ae`、`0f489c4`
- 实现提交：`feat(license): 完成许可证生命周期`
- 冲突风险：`product/launcher/main.go`、`state.go`、shared export、Windows workflow 为中等；集成时必须保留 P3-T03→P3-T04 gate 顺序、独立 status trust root、host anchor 与 24h 上限。其余新增 lifecycle 文件风险低。

## P3-T08 延期

真实 HTTPS 授权服务器、真实断网与服务恢复、Windows 时钟回拨行为、Win10/11 标准用户权限、物理 U 盘拔插/换盘符/换机、Defender、正式公钥注入和撤销传播实测全部延期到 `P3-T08`。本报告不宣称真机验收。

## P3-T05 startingState

`P3-T05` 从 `b2d76561..HEAD` 启动，可复用稳定的 `LicenseLifecycleClient` typed contract 和 localhost issuer test boundary，调用 `issue/query/revoke/reissue`。制盘事务仍必须单独完成 New API 用户/Token 创建、设备映射、授权文件落盘和失败补偿；不得把 lifecycle `active` 当作自动开户完成，不得复用或派生 startup secret。真实服务与 Windows/U 盘仍不在 `P3-T05` 自动化范围内。
