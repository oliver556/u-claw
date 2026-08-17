# U-Claw 真实 Windows 运行时设计

**状态：** 已确认

**日期：** 2026-08-17

## 目标

为 U-Claw 生成可复现的 Windows x64 便携运行时。用户只需双击 U 盘根目录的 `U-Claw.exe`，即可在普通用户、Defender 开启、首次断网的环境中启动完整 U-Claw Electron 界面和本地 OpenClaw。

该运行时继续使用现有 Launcher、签名清单、`runtime.pkg`、在线 feed 和离线更新器，不引入传统安装程序，也不要求 New API 服务器参与客户端启动或更新。

## 已发现的缺口

现有 Windows CI 使用 `product/tests/windows/fixtures/portable-runtime.go` 验证 Launcher 和更新事务。该 fixture 默认只运行 100 毫秒，并不包含 Electron、Node、OpenClaw 或 U-Claw 前端。它只能用于自动生命周期测试，不能作为人工验收包。

仓库当前也没有把真实 Desktop、Frontend、Adapter、Shared、Electron、Node 和 OpenClaw 组装为 Windows runtime 的正式构建器。因此，现有 CI 通过只证明更新链路对 fixture 有效，不证明完整 U-Claw 能从 U 盘启动。

## 用户可见结构

U 盘根目录保持单一启动入口：

```text
U-Claw.exe
.uclaw/
  runtime.pkg
  version.json
  data/
  license/
```

用户不直接操作 Electron、Node 或 OpenClaw。Launcher 验证授权和签名，将 `runtime.pkg` 解压到受控本机缓存，再启动真实客户端。

## 运行时内部结构

正式组装器生成的输入目录至少包含：

```text
runtime-source/
  electron/
    electron.exe
    resources/
      app/
  node/
    node.exe
  openclaw/
    openclaw.mjs
  app/
    desktop/
    frontend/
    adapter/
    shared/
    node_modules/
```

具体 Electron app 入口由组装器生成的应用清单固定。Desktop 必须使用 runtime 内的 `node.exe` 和 OpenClaw 入口，禁止依赖 Windows 全局 Node、npm、OpenClaw 或联网安装。

## 固定输入

组装器只接受仓库锁定版本：

- Electron Windows x64 `40.10.6`
- Node Windows x64 `24.15.0`
- OpenClaw `2026.7.1-2`
- 当前提交构建后的 Desktop、Frontend、Adapter、Shared
- lockfile 中对应的生产依赖

外部归档必须具有仓库固定的来源、文件名、大小边界和 SHA-256 或上游强完整性值。版本、平台、架构或完整性不匹配时构建失败。

## 构建流程

```text
校验 Node/npm 和 lockfile
-> 构建 Desktop、Frontend、Adapter、Shared
-> 获取并验证固定 Electron、Node、OpenClaw
-> 复制生产依赖并消除 workspace 软链接
-> 组装真实 runtime-source
-> 验证所有真实入口和依赖闭包
-> build-runtime 生成 runtime.pkg
-> Ed25519 签名 version.json
-> build-release 生成初始 U 盘目录
-> build-update-feed 生成在线 feed
-> build-offline-updater 生成离线 EXE
```

正式人工验收包必须由该流程产生。CI fixture 流程继续保留，但产物名称和诊断必须明确包含 `fixture`，不得作为人工验收包交付。

## 启动流程

```text
用户双击 U-Claw.exe
-> Launcher 验证 U 盘目录和测试授权
-> Launcher 验证 version.json 签名
-> Launcher 验证 runtime.pkg 大小和 SHA-256
-> Launcher 解压并验证本机缓存
-> Electron 加载真实 Desktop 入口和 Frontend
-> Desktop 使用 runtime 内 Node 启动本地 OpenClaw
-> 完成协议和能力探测
-> 显示完整 U-Claw 主窗口
```

首次断网启动不得请求下载 Electron、Node、OpenClaw、npm 包或前端资源。许可 fixture 可用于验收，但测试私钥不得进入 U 盘、ZIP、日志或 Git。

## 错误处理

- 缺少 Electron、Node、OpenClaw、Desktop 入口或前端入口时，组装阶段失败。
- 外部归档版本、平台、架构或完整性不匹配时，下载或组装阶段失败。
- runtime 内存在软链接、非普通文件、额外 Electron EXE 或不安全 Windows 路径时，组装阶段失败。
- Windows runtime 在启动宽限期内退出时，Launcher 保留 `E_APP_EXITED`，同时生成不含用户名、绝对路径、令牌和授权材料的诊断。
- 断网启动不得回退到在线安装或系统级依赖。
- 更新前后必须保留授权、启动凭据和用户数据；失败更新按现有事务机制回滚。

## 自动验证

新增测试覆盖：

1. 组装器拒绝缺失文件、版本漂移、错误完整性、软链接和额外 Electron EXE。
2. 组装器验证 `electron.exe`、`node.exe`、OpenClaw 入口、Desktop 入口和 Frontend `index.html`。
3. 生产依赖闭包不包含 workspace 软链接，不依赖仓库外路径。
4. 生成的 runtime 清单与实际归档大小、SHA-256 和树哈希一致。
5. 人工验收构建命令不得引用 `portable-runtime.go`。
6. Windows CI 在断网约束下启动真实 Electron runtime，使进程越过 Launcher 启动宽限期并产生可验证的就绪证据。
7. 现有 PowerShell 5.1/7、Launcher race、在线 feed、离线 EXE、篡改、降级、运行中更新和回滚测试继续通过。

## 人工验收

在 Win10/11 x64、普通用户、Defender 开启、物理 U 盘环境中：

1. 断网首次启动 U 盘根目录的 `U-Claw.exe`。
2. 确认完整 U-Claw 界面打开，本地 OpenClaw 运行，不出现 `E_APP_EXITED`。
3. 关闭客户端，执行同版本链路生成的离线更新 EXE。
4. 再次启动，确认版本升级。
5. 比较授权、启动凭据和用户数据哈希，必须不变。
6. 确认无管理员提权提示，无需关闭 Defender。
7. 更换 USB 接口和另一台 Windows 主机重复。
8. staging HTTPS 就绪后，再使用同一 `runtime.pkg` 和签名 feed 验证在线更新。

## 完成条件

- 正式运行时组装器、测试和 Windows CI 全部通过。
- 真实 U 盘人工验收通过。
- 在线和离线链路使用字节一致的 `runtime.pkg`。
- 测试私钥未进入交付物或仓库。
- 设计和实施计划中的真实环境验收状态更新为已完成。
- 满足以上条件后，功能分支才可合并 `main`。
