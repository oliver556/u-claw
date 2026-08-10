# P3-T05 制盘身份与 New API 自动开户设计

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

`deviceId` 和 `usbFingerprint` 由冻结的 Windows native fingerprint gate 提供。协调器不自行降级生成设备身份；缺任一值直接拒绝。一次成功绑定严格满足：

```text
deviceId == license.deviceId == startupCredential.deviceId == NewApi user.deviceId == mapping.deviceId
licenseId == license.licenseId == startupCredential.licenseId == mapping.licenseId
usbFingerprint == license.usbFingerprint.sha256 == mapping.usbFingerprint
user.id == token.userId == mapping.newApiUserId
token.id == mapping.newApiTokenId
channelId == credential channel binding
startup secret proof == mapping startupSecretSalt/startupSecretHash
```

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

每步幂等 key 从调用方 `idempotencyKey` 加固定 step suffix 派生，满足现有 8~128 字符 contract。相同 key 与相同身份返回同一绑定；相同 key 不同身份拒绝。进程内按 `deviceId` 串行；服务端唯一约束处理跨进程竞争。

写盘使用同目录唯一临时文件、`wx`、mode 0600、完整写入、`sync`、关闭、`rename`。journal 在每个远端副作用之后先持久化。三份制盘文件逐一提交；任一失败删除本事务已经提交的文件，保留 journal，随后补偿。只有三份文件均完成且逐项重读校验后，mapping 才可变为 `active`。因此不会静默留下“服务端 active、账号或文件不可用”的成功结果。

补偿顺序：mapping=`failed`（包含 token ID 与补偿状态）→ revoke token → revoke license → 更新 mapping compensation。既有 contract 只能用 `failed` 表达补偿记录；license 撤销结果写入本地 journal。网络失败不伪装完成，返回固定可重试错误，journal 保持 `compensation-pending`。

## 生命周期语义

- `active`：license、mapping、token、user、文件全部一致才返回成功。
- `revoked`：mapping=`revoked`，token 撤销，license 撤销；本地 credential 删除。重复调用幂等。
- `disabled`：mapping=`disabled`，user policy disabled；token 可保留但不能使用；本地 active load 因 mapping 非 active 失败。
- `reissued`：P3-T04 生成新 license；旧 mapping=`revoked`、旧 token 撤销、旧 credential 删除；新 license 走新的完整开户事务。旧绑定永不复活。
- `expired`：P3-T04 gate 拒绝。P3-T05 不新增 New API `expired` 状态；运维同步由后续控制面触发 disabled/revoked，记录为 P3-T06 边界。
- `provisioning`：任何 runtime 普通请求不得使用；只允许制盘 connectivity check。

## 错误与审计

协调器公开错误只含稳定 code、阶段、retryable，不透传远端 body、路径、请求、headers 或 cause message。内部 cause 可保留对象供测试，但不得序列化到报告。审计使用 P3-T01/P3-T04 的 typed events 加非敏感 journal；普通返回只给 binding IDs 与状态。

生产 endpoint 配置缺失时注入 unavailable client 并 fail-closed。P3-T01/P3-T04 client 的 HTTP loopback 能力仅测试构造函数可用；生产装配不提供放宽开关。模型 endpoint 同样复用 `BuiltinCredentialStore` 的 `allowLoopbackHttp=false` 默认值。

## 测试与真实环境声明

Node integration 使用真实 localhost HTTP server 与临时沙箱目录，覆盖成功、重复、并发、认证失败、网络失败、非法响应、写盘失败、补偿失败后恢复、binding 篡改拒绝和全对象敏感字符串扫描。单元测试对每个新行为保留 RED→GREEN 证据。

fresh 门禁：Node build/typecheck/unit/contract/integration/secret scan；Go test/race/vet；Windows amd64 production/fixture 交叉编译。交叉编译只证明可编译，不宣称真实 Windows、DeviceIoControl、物理 U 盘、真实 New API 或真实撤销传播通过。

