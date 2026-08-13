# P3-T05 制盘身份与 New API 自动开户设计

> **版本说明（2026-08-13）：** 本文是旧版“制盘时完成设备绑定、许可证签发和 New API 自动开户”方案。第一版不再以该完整 saga 作为销售前置条件，改按[《第一版启动、激活与授权总方案》](../../第一版启动激活授权方案.md)实施：发货前准备用户名、激活码和独立 New API 设备账户，人工设置余额；首次使用时才绑定 USB 并签发许可证。本文保留为可复用补偿、原子写盘和未来自动化运营参考。

## 范围与验收映射

本任务在 `9bc66f5a62e87253fac35486b1fc3c1d75c892d3` 的 P3-T01~P3-T04 基础上，完成可接真实 New API、可由 localhost mock 自动验证的制盘闭环。来源是阶段委派中的 P3-T05 验收项，以及 P3-T04 报告“制盘事务负责 New API 用户/Token 创建、设备映射、授权文件落盘和失败补偿”的起点约束。

| 验收项 | 设计映射 |
|---|---|
| 幂等开户、并发不重复 | 每设备串行锁；由业务输入派生稳定、分步骤幂等 key；服务端 replay 校验 |
| 一设备一身份、严格绑定 | `deviceId`、USB fingerprint、license、user、token、channel 在每一步和恢复时交叉校验 |
| 不泄露 Token/上游 Key | 上游 Key 不进入输入或产物；Token 仅进入 mode 0600 私有 credential；错误/journal/result 不含 secret |
| 原子、可恢复写盘 | 同目录 `wx` 临时文件、`sync`、`rename`；非敏感 journal 记录阶段；最终 active 仅在全部文件落盘后提交 |
| 失败补偿 | mapping 标记 failed；撤销 token 与 license；补偿状态可重试、可审计 |
| lifecycle 对齐 | `active` 才可完成；revoke/disabled/reissue 明确传播到 New API binding |
| endpoint fail-closed | 复用 P3-T01/P3-T04 typed client；生产 HTTPS；loopback HTTP 仅显式 test 注入；缺配置使用 unavailable client |
| localhost mock 覆盖 | 成功、重复、并发、认证、网络、非法响应、写盘失败、补偿恢复、敏感扫描 |
| 真实环境边界 | 只做 sandbox、localhost、Windows amd64 交叉编译；真实服务/Win/U 盘留 P3-T08 |

不做 Stripe、支付、P3-T06 运营 UI/批量控制、真实远端写入、真实 Windows 或物理 U 盘验收。

## 方案选择

选择“协调器 saga + 本地恢复 journal”。不修改已冻结 P3-T04 lifecycle contract，也不要求 New API 与 license server 支持跨服务两阶段提交。

备选一是先写盘再开户。失败会留下可验证 license 文件但无账号，违反 fail-closed。备选二是扩展两个服务做分布式 prepare/commit，真实服务尚未联调，超出 P3-T05。saga 利用现有幂等 API 和撤销接口，改动最小，恢复语义可测试。

## 身份与凭据

`deviceId` 和 `usbFingerprint` 由冻结的 Windows native fingerprint gate 提供。协调器不自行降级生成设备身份；缺任一值直接拒绝。P3-T05 扩展 New API typed contract，mapping 增加 `channelId`、`model`、`policyDigest`、`generation`；device token 增加同一 binding scope 与 `provisioning | active | revoked` 状态。服务端下游鉴权必须同时检查 token active、mapping active、user enabled、channel/model/policy digest 一致。一次成功绑定严格满足：

```text
deviceId == license.deviceId == startupCredential.deviceId == NewApi user.deviceId == mapping.deviceId
licenseId == license.licenseId == startupCredential.licenseId == mapping.licenseId
usbFingerprint == license.usbFingerprint.sha256 == mapping.usbFingerprint
user.id == token.userId == mapping.newApiUserId
token.id == mapping.newApiTokenId
channelId/model/policyDigest/generation == token scope == mapping == credential binding
startup secret proof == mapping startupSecretSalt/startupSecretHash
```

每次远端响应均由协调器重新校验请求 identity、预期状态、资源关系、token name、license 有效期和 generation。final commit 前重新读取本地产物并查询权威 mapping/license 状态。schema-valid 但 binding 不一致的响应按非法响应处理。

Launcher 文件：

```text
.uclaw/license/.startup-credential.json
.uclaw/license/license.json
.uclaw/builtin-model-credential.v1.json
.uclaw/provisioning-transaction.v1.json
```

前三者 mode 0600。journal mode 0600，但只记录 schema、transaction ID、binding 摘要、阶段、公开资源 ID、补偿状态和时间，不记录 startup secret、New API token secret、管理 credential、Authorization、上游 provider Key、完整请求或响应。

New API device token 是下发凭据，只能访问绑定的内置模型 channel/policy。企业上游 provider Key 保留在 New API 服务端，不属于任何 schema、写盘产物、日志或返回报告。

## 事务状态机

```text
started
 -> license-issued
 -> user-created
 -> token-created
 -> mapping-created (provisioning)
 -> artifacts-written
 -> active

任意失败 -> compensating -> failed | compensation-pending
重试 failed/pending -> replay/create missing step 或继续 compensation
```

每步幂等 key 为 `p3t05:<step>:<sha256(baseKey)>`，避免合法 128 字符 base key 溢出，并做 domain separation。相同 key 与相同身份返回同一绑定；相同 key 不同身份拒绝。进程内按 `deviceId` 串行；服务端同一 key+fingerprint 共享 in-flight Promise，跨进程由数据库/localhost mock 的唯一约束处理。

写盘使用 handle-bound/同目录唯一临时文件、`wx`、mode 0600、完整写入、`sync`、关闭、`rename`、父目录 `sync`。父目录/目标/备份拒绝 symlink，文件拒绝 hardlink。journal 在每个远端副作用之前记录 intent、之后记录完成。覆盖已有制盘文件前先创建并校验同 generation backup；失败按 journal 完成 commit 或恢复旧 generation，不删除旧有效身份。

credential 使用二阶段 finalization：先写只允许 connectivity check 的 `provisioning` snapshot；远端 mapping/token 变 active 后，重写为 active snapshot并重读验证。若 finalization 失败，journal 明确记录远端 active/local pending，立即禁用或撤销远端 binding并恢复旧 generation；不能返回成功。恢复逻辑可继续 finalization或继续补偿，不把 active 远端状态当作已完成。

补偿 journal 的资源 ID 按 phase 可空：mapping 创建前也能记录失败；user-only orphan 可在下一次相同 identity 重试时复用。存在 token 时，补偿顺序：阻止 token 使用 → mapping=`failed`（包含 token ID 与补偿状态）→ revoke token → revoke license → 更新 mapping compensation。补偿后的同一事务不得把已 revoked token replay 当作成功；协调器查询当前 binding，并创建递增 attempt generation 的新 token/rebind。网络失败不伪装完成，返回固定可重试错误，journal 保持 `compensation-pending`。

## 生命周期语义

- `active`：license、mapping、token、user、文件全部一致才返回成功。
- `revoked`：mapping=`revoked`，token 撤销，license 撤销；本地 credential 删除。重复调用幂等。
- `disabled`：mapping=`disabled`，user policy disabled；token 可保留但不能使用；本地 active load 因 mapping 非 active 失败。
- `reissued`：P3-T04 生成新 license；New API `rebind` 原子检查旧 license/token/generation，复用同一 device user，创建递增 generation token/mapping，旧 token 永久撤销、旧 binding 保留历史终态；本地 credential 走 generation commit。旧绑定永不复活。
- `expired`：P3-T04 gate 拒绝。P3-T05 不新增 New API `expired` 状态；运维同步由后续控制面触发 disabled/revoked，记录为 P3-T06 边界。
- `provisioning`：任何 runtime 普通请求不得使用；只允许制盘 connectivity check。

## 错误与审计

协调器公开错误只含稳定 code、阶段、retryable，不透传远端 body、路径、请求、headers、cause 或 cause message。远端/Zod 错误先转换成固定 typed error，通用 logger 不得接收原始 Error。审计使用 P3-T01/P3-T04 的 typed events 加非敏感 journal；普通返回只给 binding IDs 与状态。

生产 endpoint 配置缺失时注入 unavailable client 并 fail-closed。P3-T01/P3-T04 client 默认只接受 HTTPS；HTTP loopback 需要显式 `allowLoopbackHttp: true`，且生产装配不提供该值。模型 endpoint 同样复用 `BuiltinCredentialStore` 的 `allowLoopbackHttp=false` 默认值。

POSIX sandbox 验证 mode 0600。Windows 生产威胁模型要求制盘目录使用仅当前制造账户和 SYSTEM 可访问的 DACL；P3-T05 只保留 contract/交叉编译证据，真实 DACL、Win 账户和物理盘验证留 P3-T08，不把 POSIX mode 冒充 Windows ACL。

## 测试与真实环境声明

Node integration 使用真实 localhost HTTP server 与临时沙箱目录，覆盖成功、重复、并发、认证失败、网络失败、非法响应、写盘失败、补偿失败后恢复、binding 篡改拒绝和全对象敏感字符串扫描。单元测试对每个新行为保留 RED→GREEN 证据。

fresh 门禁：Node build/typecheck/unit/contract/integration/secret scan；Go test/race/vet；Windows amd64 production/fixture 交叉编译。交叉编译只证明可编译，不宣称真实 Windows、DeviceIoControl、物理 U 盘、真实 New API 或真实撤销传播通过。
