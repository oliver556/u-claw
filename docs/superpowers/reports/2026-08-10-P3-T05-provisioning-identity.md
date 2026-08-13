# P3-T05 制盘身份与 New API 自动开户完成报告

> **版本说明（2026-08-13）：** 本报告证明旧版完整制盘 saga 的本地实现，不表示第一版仍要求按该流程上线。第一版改按[《第一版启动、激活与授权总方案》](../../第一版启动激活授权方案.md)实施：首次使用绑定 USB，New API 余额人工设置。本文保留为幂等、补偿和安全写盘代码证据。

## 状态

`completed`

- Branch：`codex/p3-t05-provisioning-identity`
- Base / target branch：`codex/integration-p2-t10-local`
- Base commit：`9bc66f5a62e87253fac35486b1fc3c1d75c892d3`
- Verified implementation head：`09e0516682f52966ff3732cf49cd981cad97d754`
- PR URL/state：无；未 push，未建 PR

## 完成内容与需求映射

- 幂等开户：domain-separated SHA-256 step key；同盘跨 device、跨 coordinator 进程内队列加跨进程 lockfile；localhost server 同 key+fingerprint 共享 in-flight operation。重复与并发请求只产生一个 user/token/mapping。
- 一设备一身份：严格校验 device、USB fingerprint、license、user、token、channel、policy digest、generation、previous token、license 时段和 startup-secret proof。New API status mutation使用 expected status/generation/license/token CAS。
- 凭据边界：token 先为 `provisioning`；mapping CAS active 后再 activate token。credential 只在私有 artifact 中保存；结果、错误、journal、audit、普通配置和报告不含 startup secret、token secret、management credential、Authorization 或上游 provider Key。
- 原子与恢复：`@openclaw/fs-safe` Root-relative 操作；拒绝 symlink/hardlink；POSIX 强制 Python helper `require`，不可用时 fail-closed。持久 generation backup、journal intent/phase、文件 fsync、父目录 fsync、commit/rollback 和 restart recovery 已覆盖。
- 部分失败补偿：mapping intent 先落 journal；ambiguous POST 先 authoritative reconcile。owned mapping CAS failed，随后 revoke token/license并恢复 artifact；补偿 pending 可重试。pre-create、post-commit timeout、非法响应和 crash 均有测试。
- 生命周期：disable 先禁 policy/mapping再清本地；revoke CAS mapping、撤销 token/license、清本地；reissue 保留 immutable source binding/license source、target generation和 phase，相同 old binding/action可跨 crash 续跑，旧 token永久 revoked。
- Endpoint：New API/lifecycle client默认只允许 HTTPS；localhost HTTP 必须显式 test-only opt-in；未配置 client fail-closed。
- Windows：Launcher production/licensefixture 与 test binaries仅完成 amd64交叉编译。P3-T05 provisioning 在 Windows 默认 fail-closed，等待 P3-T08 native pinned-handle helper；不冒充真机或物理盘通过。

## 关键安全边界

企业 provider Key始终留在 New API 服务端。下发的是 device-scoped token，绑定 user/device/channel/policy/generation；只有 mapping active、user active、policy匹配后才能激活。

远端/Zod/transport错误在 typed client/coordinator边界转换为固定错误，不保留 raw cause。journal只记录公开资源 ID、哈希、phase、CAS和补偿状态。持久 backup可能包含旧私有 credential snapshot，因此 mode 0600、Root-bound、commit后删除，不进入日志或报告。

POSIX 制盘依赖 fs-safe Python fd-relative helper并强制 `require`。Windows Node fallback不足以抵抗 ancestor swap，因此 production provisioning明确拒绝，原生 pinned-handle支持属于 P3-T08真实环境工作。

## Changed Files

设计与报告：

- `docs/superpowers/specs/2026-08-10-P3-T05-provisioning-identity-design.md`
- `docs/superpowers/plans/2026-08-10-P3-T05-provisioning-identity.md`
- `docs/superpowers/reports/2026-08-10-P3-T05-provisioning-identity.md`

Shared contract：

- `product/shared/src/index.ts`
- `product/shared/src/new-api-management.ts`
- `product/shared/src/provisioning-identity.ts`
- `product/shared/tests/new-api-management.test.ts`
- `product/shared/tests/provisioning-identity.test.ts`
- `product/tests/fixtures/new-api-management-v1.json`

Desktop implementation：

- `product/desktop/src/index.ts`
- `product/desktop/src/license-lifecycle/client.ts`
- `product/desktop/src/new-api-management/client.ts`
- `product/desktop/src/new-api-management/local-server.ts`
- `product/desktop/src/providers/builtin-credential-store.ts`
- `product/desktop/src/provisioning/artifact-writer.ts`
- `product/desktop/src/provisioning/coordinator.ts`
- `product/desktop/src/provisioning/index.ts`

Tests：

- `product/desktop/tests/builtin-credential-store.test.ts`
- `product/desktop/tests/model-source-router.test.ts`
- `product/desktop/tests/provisioning-artifact-writer.test.ts`
- `product/desktop/tests/provisioning-coordinator.test.ts`
- `product/tests/integration/license-lifecycle-local.test.ts`
- `product/tests/integration/model-source-routing.test.ts`
- `product/tests/integration/new-api-management-local.test.ts`
- `product/tests/integration/provisioning-identity-local.test.ts`

## Fresh Verification

Node runtime固定为 `24.15.0`：

- `npm run build`：pass；workspace build与 dist smoke pass。Vite仅报告既有 >500 kB chunk warning。
- `npm run typecheck`：pass。
- `npm test`：pass。Node scripts/packaging `121/121`；contract `18/18`；shared `262/262`；adapter `159/159`；desktop `523/523`；frontend `152/152`。
- `npm run test:integration`：`39/39` pass；P3-T05 localhost provisioning `8/8`。
- `npm run test:secrets`：pass。

Launcher：

- `go test ./...`：pass。
- `go test -race ./...`：pass。
- `go vet ./...`：pass。
- `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build`：production pass。
- 同命令加 `-tags licensefixture`：fixture pass。
- production/licensefixture `go test -c`：两份 Windows amd64 test binary均编译 pass，未运行。
- `git diff --check base..HEAD`：pass after closeout whitespace fix。

独立 reviewer第五轮最终结论：`Critical=0 Important=0`。

## Conflict Risk

中等。主要冲突面：`product/shared/src/new-api-management.ts`、shared/desktop exports、New API client/local server、BuiltinCredentialStore及其既有 P3-T01/P3-T02 tests。集成时必须保留：默认 HTTPS、显式 localhost test开关、token `provisioning -> active -> revoked`、mapping CAS、P3-T03 local gate -> P3-T04 lifecycle gate顺序。新增 `product/desktop/src/provisioning/` 和独立 tests冲突风险低。

## P3-T06 StartingState

P3-T06应从本分支最终 closeout HEAD（基于 `09e0516`实现与本报告提交）开始，并在集成到 `codex/integration-p2-t10-local` 后使用对应集成 commit。可复用 `ProvisioningCoordinator.applyLifecycle`、authoritative New API query/CAS、journal phase和安全 credential store。

P3-T06只扩运营控制/审计入口，不应削弱 P3-T05 fail-closed endpoint、token activation、CAS、补偿或 filesystem pinning。批量控制、控制台 UI、真实服务策略同步不属于 P3-T05。

## 未验证真实环境项

- 真实 New API 服务器、真实 management/data-plane鉴权和企业 provider Key托管。
- Windows native provisioning pinned-handle helper、DACL、制造账户、Defender和真实异常恢复。
- Windows 11真机、DeviceIoControl真实指纹、物理 U 盘、拔盘/断电/坏块/文件系统行为。
- 真实网络超时、代理、TLS证书、服务重启、跨主机并发与数据库唯一事务。
- 真实 lifecycle撤销传播、24h offline grace与 reissue运营流程。

以上留 P3-T08；本报告不宣称通过。
