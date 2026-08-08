# Task 9 便携启动器说明

> 日期：2026-08-09
>
> 范围：Task 9A 技术选型与 Task 9B Windows x64 正式 Launcher

## 1. 结论

- 正式 Launcher 使用 Go，不维护 .NET 第二套实现。
- 客户端仍是 Electron；Launcher 只负责校验、解压、启动和进程监督，不承载业务 UI。
- runtime 存入本机可重建缓存，用户数据唯一副本固定在 U 盘 `.uclaw/data`。
- `runtime.pkg` 固定为 gzip tar，`version.json` 使用严格 manifest 契约。
- 正式 Windows 构建使用 `-H windowsgui`，不会显示终端窗口。
- 启动阶段显示 Win32 原生小窗口；Electron 就绪后自动隐藏。

## 2. 选型证据

| 项目 | Go | .NET 8 NativeAOT |
|---|---:|---:|
| Mandatory gate | 通过 | 通过 |
| P95 | `21.7459ms` | `29.9361ms` |
| EXE | `2591744` bytes | `3173888` bytes |

- Actions run：`31260704973`
- Artifact：`launcher-benchmark-results`
- Artifact ID：`9022738910`
- Digest：`sha256:66c6261d35827d488357f5f84eb73022e44777c6cbc3831b76d80411cb1ce42b`
- Decision：`selected=go`、`reason=p95-margin`

Go P95 比 NativeAOT 低约 27%，达到选型规则的 20% 门槛。该数据只证明 Hosted Runner 上的技术预选，不是物理 U 盘冷启动数据。

## 3. 发行结构

```text
U-Claw.exe
.uclaw/
  runtime.pkg
  version.json
  data/
```

约束：

- 发行根目录只允许 `U-Claw.exe` 和 `.uclaw`。
- Windows 上 `.uclaw` 标记为 hidden。
- `.uclaw/data` 是用户数据目录，不能复制到本机缓存。
- `runtime.pkg` 和 `version.json` 是只读发行输入，可重新下载和重建。

## 4. 启动流程

```text
STARTING
  -> VALIDATING_USB
  -> CHECKING_RUNTIME
  -> EXTRACTING_RUNTIME（仅首启或缓存损坏）
  -> STARTING_APP
  -> READY
```

具体行为：

1. 从 `U-Claw.exe` 所在目录推导 U 盘根目录。
2. 探测 `.uclaw/data` 可写性，并立即删除随机探针文件。
3. 对同一数据目录获取单实例锁。
4. 严格读取 `.uclaw/version.json`。
5. 流式检查 `runtime.pkg` 大小和 SHA-256。
6. 解压到 `%LOCALAPPDATA%\U-Claw\runtime\<runtime-id>` 的临时目录。
7. 校验文件数、解包字节和入口点后写 marker，再原子 rename。
8. 通过参数数组启动 Electron，不经过 shell。
9. 注入 `UCLAW_DATA_DIR=<USB>\.uclaw\data`。
10. Windows Job Object 监督完整子进程树；U 盘断开时停止进程树。

## 5. Manifest 契约

`version.json` 只允许以下字段：

- `schemaVersion`
- `productVersion`
- `runtimeVersion`
- `runtimeId`
- `runtimeArchive`
- `runtimeSha256`
- `runtimeBytes`
- `unpackedBytes`
- `fileCount`
- `entrypoint`
- `entryArgs`

未知字段、尾随 JSON、NUL、绝对路径、`..`、Windows 保留名、链接、重复条目和越界计数全部拒绝。

## 6. 缓存边界

本机缓存：

```text
%LOCALAPPDATA%\U-Claw\runtime\<runtime-id>
```

Launcher 只能处理：

- 当前 manifest 对应的 `<runtime-id>` 缓存目录。
- 同一 `<runtime-id>.partial-*` 临时目录。
- 当前 runtime 内的 `.uclaw-runtime.json` marker。

Launcher 不得删除：

- U 盘 `.uclaw/data`。
- 其他 runtime-id 缓存。
- `%LOCALAPPDATA%\U-Claw` 之外的路径。
- 链接指向的外部目录。

## 7. 固定诊断码

| 诊断码 | 用户提示 |
|---|---|
| `E_INSTANCE_RUNNING` | U-Claw 已在使用这个 U 盘数据目录。 |
| `E_USB_DISCONNECTED` | U 盘已断开，请重新插入后再启动。 |
| `E_USB_UNAVAILABLE` | 无法使用 U 盘数据目录，请检查连接和写入权限。 |
| `E_MANIFEST_INVALID` | 运行时清单无效，请重新下载 U-Claw。 |
| `E_PACKAGE_INVALID` | 运行时文件校验失败，请重新下载 U-Claw。 |
| `E_CACHE_FAILED` | 无法准备本机运行缓存，请检查磁盘空间。 |
| `E_APP_START_FAILED` | 无法启动 U-Claw，请重新启动。 |
| `E_APP_EXITED` | U-Claw 意外退出，请重新启动。 |
| `E_INTERNAL` | U-Claw 启动失败，请重新启动。 |

原始错误、绝对路径、用户名、token 和消息正文不得进入原生状态窗口或 Actions diagnostics artifact。

## 8. 构建与验证

环境：

- Go 1.25+
- Node.js 24.15.0
- Windows x64

基础验证：

```powershell
npm ci --ignore-scripts --prefix product
npm test --prefix product
npm run typecheck --prefix product
npm run build --prefix product

Push-Location product\launcher
go test -race ./...
go run github.com/akavel/rsrc@v0.10.2 -manifest app.manifest -arch amd64 -o rsrc_windows_amd64.syso
go build -trimpath -ldflags '-s -w -H windowsgui' -o U-Claw.exe .
Pop-Location
```

构建 runtime：

```powershell
node product\packaging\build-runtime.mjs `
  --input <runtime目录> `
  --output <构建目录>\runtime.pkg `
  --product-version <产品版本> `
  --runtime-version <运行时版本> `
  --runtime-id <安全ID> `
  --entrypoint electron/electron.exe `
  --entry-arg resources/app.asar
```

将上一命令输出的 JSON 保存为 `version.json`，再组装发行目录：

```powershell
node product\packaging\build-release.mjs `
  --launcher <构建目录>\U-Claw.exe `
  --runtime-package <构建目录>\runtime.pkg `
  --manifest <构建目录>\version.json `
  --output <发行目录>
```

## 9. 自动化门禁

`.github/workflows/portable-launcher.yml` 在 Windows Server 2022 上执行：

- 精确 Node/Go 工具链。
- Node manifest、packaging 和 workflow 合约测试。
- Go race 测试与 `windowsgui` 构建。
- Windows PowerShell 5.1 与 PowerShell 7 双 E2E。
- 首启、二启复用、错误哈希、截断包、partial 残留、中文空格路径、重复启动和数据边界。
- 只上传不含路径、runtime 和用户数据的布尔 diagnostics JSON。

Task 9B 自动化证据：

- Actions run：`31267696191`
- 结果：`success`
- Commit：`a27303968f1457645dbda3fd4fdeb0baf23dad97`
- Artifact：`portable-launcher-diagnostics`
- Artifact ID：`9024668636`
- Digest：`sha256:bf7f712a1d3d99f33c754f37433b6bb27a9cdf7c45b61ff3489226078e77b641`

该结果证明 Windows Server 2022 Hosted Runner 上的自动化门禁通过，不替代 Task 10 的真实 Windows 与物理 U 盘验收。

## 10. 未验收边界

以下内容属于 Task 10，不得标记为已完成：

- 真实 Windows 10 与 Windows 11。
- 普通用户账户和企业策略环境。
- Defender/SmartScreen 对正式签名包的行为。
- 物理 U 盘拔出、盘符变化、休眠恢复和长期插盘运行。
- 完整 Electron + OpenClaw runtime 的真实发行包。
- 第三阶段许可证和防复制能力。
