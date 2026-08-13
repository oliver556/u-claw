# P3-T04 许可证生命周期设计

> **版本说明（2026-08-13）：** 本文记录旧版许可证生命周期底座。第一版首次签发入口改为用户名与激活码绑定 USB，权威方案见[《第一版启动、激活与授权总方案》](../../第一版启动激活授权方案.md)。本文的状态查询、签名回执、撤销、reissue、revision 和 24 小时离线容错继续复用。

## 范围

完成 `LIC-002` 的代码与本地/沙箱自动化：许可证签发、状态查询、撤销、重制、在线失败与授权状态区分，以及有界离线容错。复用 `P3-T01` typed HTTP contract 的认证、幂等、错误和 loopback 测试边界；复用 `P3-T03` Ed25519 本地验签和 Launcher 前置 gate。

不包含制盘自动开户、New API Token 生命周期、运营控制、Stripe/支付、真实授权服务、真实 Windows 或物理 U 盘验收。后者留给 `P3-T05`、`P3-T06`、`P3-T08`。

## 选择

采用独立、版本化的 `license-lifecycle-v1` contract，不把启动许可证塞入 New API Token contract：

1. Node localhost server 是 issuer/server test boundary。测试启动时从调用方注入临时 Ed25519 私钥；私钥不进入客户端、Launcher、fixture、环境变量、日志或仓库。
2. 服务端记录许可证状态与单调 revision，签发 Ed25519 `license.json` 和 opaque signed status receipt。客户端只持公钥；contract 不暴露独立 signature 字段。
3. Launcher 先完成 `P3-T03` 本地验签，再在线查询；只有在线 `active` 或满足冻结规则的离线缓存才能继续。
4. 状态回执由服务端签名；U 盘缓存使用 startup secret 独立 domain 派生的 AEAD key 加密回执，并认证时钟元数据。主机侧另存独立 HMAC authorization anchor，锁定最高 revision、状态和最后观察时间，防止旧 U 盘缓存整体回滚。任一认证失败、时钟回拨、anchor/cache 不一致或超窗都 fail-closed。

不采用“只信本地 license 签名”：签名只证明授权曾被签发，不能证明当前仍为 `active`。不采用无限期或客户端配置 grace：会让撤销无法有界传播。

## 状态机

服务端状态固定为：

```text
provisioning -> active -> revoked
                    \-> disabled
                    \-> expired (由 expiresAt 派生)
active/revoked/disabled/expired -> reissued (旧 license)
reissue -> 新 license: active
```

- `provisioning`：签发事务尚未提交，不允许启动。
- `active`：在线确认后允许启动，并可刷新离线回执。
- `revoked`：明确撤销，立即拒绝；不得用旧 active 缓存覆盖。
- `reissued`：旧许可证已被新许可证替代，旧 license 永久拒绝。
- `expired`：`now >= expiresAt`，即使存储状态仍为 active 也返回 expired。
- `disabled`：运营禁用，拒绝启动；不等同撤销。

每次状态变化递增 revision。状态查询只返回脱敏摘要和 opaque receipt，不返回 startup secret、设备 Token、完整 USB 指纹、独立签名字段、`license.json` 签名或 Authorization。

## 签发、撤销与重制

签发输入包含 `deviceId`、完整 USB 指纹、有效期和 `idempotencyKey`。服务端生成新的 `licenseId`、随机 startup secret、独立 salt/proof 和签名授权文件。同步事务由 `provisioning` 提交为 `active`；失败保留审计失败记录，不留下多个有效授权。

相同幂等 key 与相同输入重放同一加密封存结果；同 key 不同输入返回 typed `IDEMPOTENCY_CONFLICT`。同一设备并发签发只允许一个 active license，竞争请求返回 typed `LICENSE_CONFLICT`。

撤销对同一 license 幂等：首次写 `revoked` 并递增 revision；重复请求返回同一终态，不重复产生副作用。不同 payload 复用 key 仍冲突。

重制是单事务：生成全新 `licenseId`、startup secret、salt/proof、授权文件；旧许可证写 `reissued` 并关联 replacement license ID；新许可证成为唯一 active。相同幂等请求重放同一密封结果；并发重制只能提交一次。startup secret 随机独立生成，不复用 New API Token，也不从其派生。

## 在线查询与离线策略

Launcher gate 顺序：

```text
ProbeDataDirectory
-> VALIDATING_LICENSE
-> P3-T03 local signature/device/secret/time/fingerprint checks
-> query lifecycle status
   -> active + valid signed receipt: persist authenticated cache, allow
   -> provisioning/revoked/reissued/expired/disabled: persist terminal receipt, deny
   -> transport/unavailable: evaluate offline cache
-> instance lock/cache/runtime/process
```

在线错误分类固定区分：transport/unavailable、authentication、invalid response、signature invalid、device mismatch、not yet valid、expired、provisioning、revoked、reissued、disabled。

离线只在在线请求发生 retryable transport/unavailable 错误时评估。HTTP 状态错误、响应格式错误、认证错误和签名错误不得降级离线。

冻结 grace：

```text
effectiveGraceUntil = min(receipt.graceUntil, receipt.checkedAt + 24h, license.expiresAt)
```

必须同时满足：最近一次成功在线回执状态为 `active`；服务端 Ed25519 回执签名有效；本地 `license.json` 签名和绑定仍有效；缓存 startup secret AEAD 认证有效；主机 authorization anchor 的 HMAC 有效；anchor/cache 的 revision、状态和 `lastObservedAt` 精确一致；`now >= checkedAt`；`now >= lastObservedAt`；`now < effectiveGraceUntil`。首次启动无缓存或无 anchor、缓存状态不是 active、回执重放超窗、缓存/anchor 篡改或时钟回拨全部拒绝。

每次检查在进入 runtime 前先原子更新主机 anchor，再原子更新 U 盘 AEAD cache；任一步失败都拒绝，后续不一致继续 fail-closed。收到 `revoked` 或 `reissued` 后先持久化终态 anchor/cache，再拒绝；离线逻辑从不接受终态。撤销在客户端持续离线且尚未查询到撤销时，最坏传播上限为最后一次 active 在线确认后的 24 小时。

## 文件与信任边界

新增客户端缓存：

```text
.uclaw/license/.lifecycle-cache.json
```

主机 authorization anchor：

```text
HostCacheRoot/license-anchors/<sha256(licenseId,deviceId)>.json
```

U 盘缓存外层只包含 v1 schema、随机 nonce、加密 payload 和认证 tag。加密 payload 内含 opaque signed receipt、`lastObservedAt` 和必要绑定值；key 从 startup secret 经独立 domain 派生，不复用 secret proof。主机 anchor 只包含最高 revision、状态、`lastObservedAt` 和独立 domain HMAC，不含 receipt、签名、secret 或指纹。两者都使用有界、handle-bound、拒绝 symlink/hardlink/未知字段读取，并以同目录临时文件、flush、rename 原子更新。authorization anchor 属于 gate state，不是可复用 runtime cache；错误不暴露路径或底层内容。

生产 lifecycle endpoint 必须为 HTTPS。未配置 endpoint、无状态回执公钥或无本地授权全部 fail-closed。localhost HTTP 仅由显式测试依赖注入允许；生产配置不能放宽。

## Contract 与组件

- `product/shared/src/license-lifecycle.ts`：v1 schemas、状态、输入/输出、typed error、客户端接口。
- `product/desktop/src/license-lifecycle/local-server.ts`：localhost issuer/status test server、内存状态、幂等、并发序列化、审计脱敏。
- `product/desktop/src/license-lifecycle/client.ts`：HTTPS/loopback policy、有界 JSON、typed 错误与凭据脱敏。
- `product/launcher/license.go`：保留本地授权 gate；返回已验证 identity/material 供 lifecycle 检查使用。
- `product/launcher/license_lifecycle.go`：在线查询、状态回执验签、startup secret AEAD 缓存、时钟和 grace 判定。
- `product/launcher/state.go`、`main.go`：在现有 `VerifyLicense` 前置位置组合 local + lifecycle gate，不改变 runtime/cache/process 顺序。

## 错误与脱敏

Launcher 固定错误码至少覆盖：endpoint 未配置、在线不可用且无有效缓存、状态回执签名错误、缓存篡改、时钟回拨、grace 过期、provisioning、revoked、reissued、disabled。`P3-T03` 原有签名、设备、指纹、未生效和过期错误保持不变。

服务端审计仅记录操作、license ID 摘要/内部 ID、状态、revision、结果和错误类别。不记录 request body、Authorization、startup secret、设备 Token、完整 USB 指纹、授权签名或状态回执签名。客户端错误固定文案并再次脱敏远端文本。

## TDD 与验收

- Shared contract：六状态、strict schema、回执/签发输出、错误类别、秘密字段拒绝。
- Node integration：签发/查询/撤销/重制；幂等重放；key 冲突；同设备并发冲突；旧授权拒绝；失败审计；秘密脱敏；HTTPS/loopback/未配置策略。
- Go unit：在线 active；在线失败与 revoked 区分；首次离线；24h 边界；服务端更短 grace；过期；时钟回拨；缓存/AEAD/回执篡改；终态缓存不降级；旧授权拒绝；固定错误脱敏。
- Go state：local + lifecycle gate 仍在 instance lock、host cache、manifest、runtime 和 process 前；失败时后续调用为零。
- 全量：Node 24.15.0 build/typecheck/unit/contract/integration/static/secret scan/diff check；Go unit/race/vet；Windows amd64 production/fixture 交叉编译。

本 Task 自动化只使用 localhost、沙箱与测试替身。真实断网、时钟行为、授权服务器、Windows、物理 U 盘及撤销传播实测留 `P3-T08`，不宣称真机通过。

## P3-T05 起点

`P3-T05` 可调用稳定的 `issue/revoke/reissue/query` typed contract。制盘事务仍需负责 New API 用户/Token 创建、设备映射、授权文件落盘和失败补偿；不能把 lifecycle `active` 当成 New API 自动开户已完成，也不能复用 startup secret。
