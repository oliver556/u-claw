# P2-T10 文件与记忆管理缺口闭合设计

## 目标

完成 production `workspace.open` / `workspace.reveal`，并把工作区和记忆写入的一致性边界从进程内排队提升为可检测外部冲突的 optimistic CAS。保持 DATA-002 现有读写能力，不实现 P2-T11/P2-T13 coordinator。

## 受控系统打开

`data-service` 只接受 shared schema 校验后的相对 ID，并继续隔离 memory、控制文件和隐藏域。目标先经 `@openclaw/fs-safe` 打开，拒绝 path traversal、symlink/junction 和 hardlink；服务将受控绝对路径与文件身份交给注入的 `WorkspaceShell`。

production adapter 位于 Electron 主进程，调用前再次验证 workspace root、目标 realpath、链接类型、link count 和文件身份，再调用 `shell.openPath` 或 `shell.showItemInFolder`。renderer 只保留 `DataBridge.invoke`，不暴露路径、Node API、shell API 或任意命令能力。

Electron shell 是 path-based API，不提供 Windows handle-bound shell invocation。实现保证已知替换在 shell 调用前失败；不能宣称消除校验与系统调用之间所有本机攻击者 TOCTOU。此限制保留为真实 Windows 验收边界。

## 一致性边界

冻结最小注入点 `DataMutationCoordinator`：

```ts
interface DataMutationCoordinator {
  runVersioned<T>(
    context: { method: VersionedDataMutationMethod; id: string; expectedVersion: string },
    operation: () => Promise<T>,
  ): Promise<T>;
}
```

所有 `workspace.rename/move/delete` 与 `memory.write/delete` 经该接口执行。默认实现使用 U 盘数据根上的 `O_CREAT | O_EXCL` advisory sidecar lock，在协作进程之间串行化版本检查与 mutation；后续 P2-T11/P2-T13 可注入 production coordinator，在不改变 renderer/shared IPC 契约下接管跨域写入协调。

对象版本仍为 filesystem optimistic CAS：进入锁定操作后比较 content/stat version，提交后验证结果。旧 version、锁等待期间外部修改和可观测对象替换返回 `CONFLICT`。sidecar lock 是 advisory；不遵守该锁的 OpenClaw writer 可在任意时刻写入。因此该协议检测已观测冲突，但不是严格跨进程线性化 CAS。

## 测试

- open/reveal production adapter 成功调用受控 Electron shell。
- traversal、symlink、hardlink、根逃逸和调用前替换失败。
- 旧 version、版本验证后的外部写入、对象替换失败且不报告成功。
- DATA-002 read/write/delete 回归测试保持通过。
- desktop unit、shared contract、typecheck、build、integration 全部通过。

## 范围

不修改 New API、服务器或 OpenClaw；不实现全局 snapshot/restore coordinator；不修改主工作区未提交的 `docs/第二阶段验收边界.md`。
