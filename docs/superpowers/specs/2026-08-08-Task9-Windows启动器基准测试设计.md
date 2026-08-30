# Task 9 Windows 启动器基准测试设计

> 日期：2026-08-08
>
> 状态：待用户复核
>
> 范围：Task 9 Step 1，仅用于 Go 与 .NET 8 NativeAOT 启动器选型

## 1. 目标

在不依赖当前 macOS 会话直接操作 Windows 实机的前提下，用 GitHub Hosted Windows Runner 构建和执行两个等价的一次性启动器小样，生成可审计 JSON 报告，为 Task 9 正式实现选定唯一技术。

本步骤不生成正式 `Bavi-box.exe`，不验收 U 盘拔出、Defender 真实拦截、Win10/Win11 实机兼容性，也不并行维护两套正式 Launcher。

## 2. 方案选择

### 方案 A：GitHub Hosted Windows + 本地复用脚本（采用）

- GitHub Actions 负责安装固定版本 Go/.NET SDK、构建小样、运行统一 PowerShell 基准脚本。
- 脚本同时可在用户 Windows 机器上手动执行，输出同格式报告。
- CI 结果用于初步选型；真实 U 盘和 Windows 验收仍属 Task 9 后续与 Task 10。

### 方案 B：只在用户 Windows 机器上运行

数据更接近真实硬件，但每次需要人工协调，不利于重复、审查和回归。不作为首选。

### 方案 C：自建 Windows Runner

可绑定真实 U 盘和固定硬件，但需额外运维、权限和安全管理。保留为后续发行验收能力，不阻塞当前选型。

## 3. 产物

```text
.github/workflows/launcher-benchmark.yml
product/benchmarks/launcher/
  go/
  dotnet/
  README.md
product/tests/windows/launcher-benchmark.ps1
product/tests/windows/launcher-benchmark.schema.json
product/tests/packaging/launcher-benchmark.test.mjs
```

- Go 与 .NET 小样实现相同行为：读取 manifest，验证 runtime-id/SHA-256/相对路径，拒绝路径穿越，输出 ready JSON 后退出。
- PowerShell 脚本不编译业务逻辑；只负责运行、计时、检查和生成报告。
- JSON Schema 固定报告字段，Node 测试在 macOS/CI 上检查脚本结构、决策规则和示例报告。

## 4. 基准口径

每个候选项必须通过：

1. Release 单文件 x64 构建成功。
2. 在移除 Go/.NET SDK 路径后仍可启动。
3. EXE 使用 `asInvoker`，不触发 UAC，不读写受保护目录或调用提权命令。Hosted Runner 账户可能已具备管理员权限，不将此项记为“普通用户实测”。
4. 在含中文和空格的路径下工作。
5. 合法 manifest 成功；非法 SHA-256、绝对路径、`..` 路径穿越必须失败。
6. 输出不包含用户名、token、绝对工作目录或 CI 秘密。

采集指标：

- EXE 字节数。
- 20 次新进程启动的 p50/p95 毫秒数。
- 构建耗时。
- 各功能/安全用例通过状态。
- Runner OS、CPU、架构、Go/.NET 精确版本、commit SHA。

Hosted Runner 无法提供可信的物理冷启数据，因此报告标记为 `hosted-runner-process-start`，不冒充实机冷启。

## 5. 决策规则

1. 任一必过项失败，该候选项淘汰。
2. 两者均通过时，比较三次独立 workflow 报告的中位数。
3. p95 启动时间差距达 20% 时，选更快者。
4. 时间差距不足 20% 时，EXE 体积差距达 25% 则选更小者。
5. 仍无明显差距时，选 Go：单 EXE 工具链更直接，与当前便携式启动器需求更匹配。
6. 选型后记录 ADR，删除落选小样，只保留报告、统一测试器和唯一正式实现。

GitHub Hosted Runner 可产生“预选结论”。正式 Launcher 可按该结论开始，但 Task 9/10 完成状态必须等真实 Windows + U 盘验收后更新。

## 6. CI 与安全边界

- Workflow 支持 `workflow_dispatch`，也在相关路径的 PR 上运行结构和功能校验。
- 不读取 repository/environment secrets，不下载未固定版本的二进制附件。
- Action 使用 commit SHA 或明确主版本；SDK 版本在 workflow 中锁定。
- JSON 报告作为 Actions artifact 上传，不自动提交或修改 ADR。
- 任一安全用例失败时 workflow 失败，不生成“已选型”标记。

## 7. 验证边界

本阶段可验证：

- 两种技术的 Windows x64 单文件构建。
- 进程启动耗时、体积、无 SDK PATH 执行。
- 中文/空格路径、manifest/SHA-256/路径穿越逻辑。
- 报告 Schema、可复现命令和 CI artifact。

本阶段不可验收：

- 物理 U 盘拔出和盘符变化。
- Defender 对正式包的行为。
- Windows 普通用户账户下的实际运行与权限拒绝行为。
- Win10/Win11 真实用户环境和长时间运行。
- Electron + OpenClaw 完整 runtime 管理。
- 正式 Launcher 的原子解压、版本缓存、单实例和中断恢复。
