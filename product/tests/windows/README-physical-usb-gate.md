# Windows 10/11 物理 U 盘最终发布门禁

本门禁只采集和汇总真实环境证据。脚本不会把 CI、虚拟盘、macOS、fixture 或人工未确认项写成 PASS。

## 1. 制品和机器

每台机器复制同一份候选制品到物理 U 盘。制品至少包含：

```text
<USB>\U-Claw\U-Claw.exe
<USB>\U-Claw\.uclaw\runtime.pkg
<USB>\U-Claw\.uclaw\version.json
```

另复制以下两个门禁文件到测试机。门禁脚本不依赖 Node.js：

```text
physical-usb-gate.ps1
physical-usb-gate.matrix.json
```

最低环境矩阵为四次独立完整执行：

```text
Windows 10 + 推荐 U 盘
Windows 10 + 低速 U 盘
Windows 11 + 推荐 U 盘
Windows 11 + 低速 U 盘
```

每次必须使用：

- 非 `Builtin Administrators` 成员的普通用户；UAC 未提升。
- Microsoft Defender Antivirus 和实时防护开启。
- x64 Windows。
- 本机 PATH 中没有 `node.exe`。
- `ReleaseRoot` 位于系统识别为 `Removable + USB` 的真实盘。

`UsbClass` 是人工分类。必须给 `bootstrap-visible` 或 `first-install` 附上 U 盘型号、购买规格或基准证据，禁止只改参数冒充低速盘。

## 2. 准备一次主机执行

Windows PowerShell 5.1 或 PowerShell 7：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
Set-Location C:\UClawGateTools

$run = & .\physical-usb-gate.ps1 `
  -Action Prepare `
  -ReleaseRoot 'E:\U-Claw' `
  -EvidenceRoot 'C:\UClawGateEvidence' `
  -UsbClass recommended

$run
```

`Prepare` 自动记录并校验：OS、x64、普通用户/UAC、Defender、无本机 Node.js、物理 USB、U 盘匿名身份、机器匿名身份、release ID/sequence、三个制品的大小和 SHA-256。原始机器 GUID、U 盘序列号、License、Token、Key 不写入证据。

查看待执行项：

```powershell
$state = Get-Content (Join-Path $run 'run.json') -Raw | ConvertFrom-Json
$state.cases | Where-Object status -ne 'passed' | Select-Object id, category, title, passCriterion
```

## 3. 记录每个门禁项

每项必须提供至少一个脱敏附件。附件可以是截图、录屏、时间线、事件日志、Bootstrap 结构化日志或服务端审计记录。文本附件和备注如果疑似包含 `Authorization`、Bearer、deviceToken、startup secret、API Key、激活码或私钥，脚本直接拒绝。

```powershell
.\physical-usb-gate.ps1 `
  -Action Record `
  -RunPath $run `
  -CaseId 'first-install' `
  -Outcome passed `
  -Note '全新用户配置；首次完整安装后 Shell、Gateway 和真实聊天成功。' `
  -AttachmentPath 'C:\EvidenceInput\first-install.mp4','C:\EvidenceInput\first-install-timeline.json'
```

失败或暂时不能执行时，仍记录真实状态：

```powershell
.\physical-usb-gate.ps1 `
  -Action Record `
  -RunPath $run `
  -CaseId 'cdn-failure' `
  -Outcome blocked `
  -Note '无测试 CDN 故障注入权限。' `
  -AttachmentPath 'C:\EvidenceInput\cdn-blocker.txt'
```

`failed` 或 `blocked` 都使主机门禁失败。不能用说明文字替代真实执行。

## 4. 关键场景执行方法

首次安装：使用从未安装该 release 的测试用户/机器。确认 `%LOCALAPPDATA%\U-Claw\runtimes\<sequence>-<digest>` 新建，记录完整验证、Shell、Gateway `/ready`、hello、首次真实聊天时间。

warm startup：完成首次安装并正常退出后再次双击。同一时间线中记录未解压、未重写 runtime marker、Shell、Gateway 和真实聊天时间。

`runtime.pkg` 不可访问：只在可恢复的验收 U 盘副本操作。先完成 warm startup，再临时改名：

```powershell
$pkg = 'E:\U-Claw\.uclaw\runtime.pkg'
Rename-Item -LiteralPath $pkg -NewName 'runtime.pkg.unavailable'
try {
  Start-Process -FilePath 'E:\U-Claw\U-Claw.exe' -WorkingDirectory 'E:\U-Claw' -Wait
} finally {
  Rename-Item -LiteralPath 'E:\U-Claw\.uclaw\runtime.pkg.unavailable' -NewName 'runtime.pkg'
}
```

必须证明 warm 启动成功且未读取完整包。若当前线上策略要求不同 sequence，正确结果是进入强制更新门禁，不是绕过更新。

网络故障：分别执行物理断网、错误代理、测试防火墙阻断、版本策略服务停机、CDN 404/超时/错误内容。普通用户不得为测试长期提权；路由器、防火墙、策略服务和 CDN 故障由授权测试操作者在外部控制。每项证明正式 Shell fail-closed、无旧版入口，恢复后可重试。

License：由授权测试服务签发过期、撤销、设备绑定失败、U 盘绑定失败四类测试状态。证据只保留匿名 License ID/状态码/时间，不保留激活码、签名材料或长期 Token。

Gateway/崩溃：用任务管理器或授权诊断入口分别制造 Gateway 不存在、超时、崩溃，Renderer 崩溃，Electron Main 崩溃。Gateway 重试连续十次。记录进程树、能力状态和清理结果；不得修改产品实现来制造 PASS。

磁盘不足：在可回收测试卷或空间受控测试机执行。证明 `installed-current` 未切换、有效安装未删、U 盘 `data/` 和身份材料哈希未变。

第二支 U 盘：第一支保持运行，再插入并启动第二支。证明宿主机全局单实例锁阻断第二支，第一支继续运行。

换盘符/拔盘/更新中断：由磁盘管理或重插改变盘符；运行中安全拔盘；下载、解压、切换前分别中断更新。证明数据身份连续、进程退出、staging 可恢复或清理、current 未错误切换。

向前回滚：在验收服务先发布故障 sequence N，再用上一稳定内容生成 N+1。必须附发布审计、CDN 回读、指针切换顺序、客户端从 N 更新到 N+1、故障 release withdrawn 的证据。任何 sequence 降低都失败。

业务矩阵：对文本真流式、多轮上下文、切会话后台继续、首轮图片、图片编辑、Tool Calling、DeepSeek/通义千问/豆包动态目录、BYOK/商业 Provider 隔离逐项录屏并保存脱敏协议摘要。所有商业请求必须经过 OpenClaw。

数据和秘密：更新前后分别生成 U 盘 `data/`、License/绑定/长期 deviceToken 文件的脱敏清单和哈希；运行宿主残留审计及 `npm run test:secrets` 的发布侧结果。证据只记录哈希和判据，不复制秘密原文。

## 5. 完成主机和总矩阵

完成一台机器全部项：

```powershell
.\physical-usb-gate.ps1 -Action FinalizeHost -RunPath $run
```

返回码：

- `0`：该主机全部环境检查、全部 case、全部附件通过。
- `2`：至少一个环境条件、case 或附件未通过。`host-final.json` 状态为 `blocked`。
- 其他非零：脚本或证据输入错误。

四次主机执行结束后汇总：

```powershell
.\physical-usb-gate.ps1 `
  -Action Aggregate `
  -HostEvidencePath `
    'C:\Gate\win10-recommended\host-final.json', `
    'C:\Gate\win10-low-speed\host-final.json', `
    'C:\Gate\win11-recommended\host-final.json', `
    'C:\Gate\win11-low-speed\host-final.json' `
  -OutputPath 'C:\Gate\physical-usb-gate-final.json'
```

汇总只在以下条件全部成立时 PASS：四个 OS/U 盘组合均存在；每个主机报告 PASS；release ID/sequence 一致；`U-Claw.exe`、`runtime.pkg`、`version.json` 大小和 SHA-256 跨主机一致。

## 6. 证据路径和放行

单次执行：

```text
<EvidenceRoot>\<run-id>\run.json
<EvidenceRoot>\<run-id>\attachments\<case-id>\*
<EvidenceRoot>\<run-id>\host-final.json
```

总矩阵：

```text
<OutputPath>\physical-usb-gate-final.json
```

另保留发布流水线的脱敏证据：build、最终 runtime smoke、候选/验收/正式 promotion digest、upload、CDN readback、secret scan、pointer-switch authorization。只有物理门禁汇总 PASS 且这些发布证据全部 PASS，才允许切换 `requiredReleaseSequence`。

macOS、Windows CI、fixture launcher、模拟盘只能证明脚本/合同，不满足本门禁。
