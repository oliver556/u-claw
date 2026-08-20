# U-Claw 启动、打包与 Gateway 链路第三版重构需求

- 日期：2026-08-20
- 文档版本：V3
- 文档类型：重构需求、候选架构与实施前门禁；不是逐文件实施计划
- 状态：待 Claude 终审；已确认商业决策不得被本重构隐式改变
- 代码基线：当前 `main`，HEAD `57dda616`
- 目标平台：首版 Windows x64 物理 U 盘商业客户端

## 1. 文档目的

本文合并并收口以下材料：

- `docs/superpowers/reports/2026-08-20-启动打包Gateway链路重构评估.md`
- `docs/superpowers/reports/2026-08-20-启动打包Gateway链路重构评估-评审结果.md`
- `docs/superpowers/reports/2026-08-20-启动打包Gateway链路重构评估-V2.md`
- `docs/superpowers/reports/2026-08-20-启动打包Gateway链路重构评估-V2-评审结果.md`
- `docs/重构需求/2026-08-20-启动强制更新与服务端单次回滚需求.md`
- `docs/重构需求/2026-08-20-模型目录与商业API凭据链路简化重构需求.md`

本文回答：

1. 哪些商业能力必须保留。
2. 为什么不能直接退回原版 OpenClaw 或旧 `portable/`。
3. 当前 `product/` 哪些机制属于过度工程化。
4. Bootstrap、正式 Shell、Gateway、runtime 和更新如何重新分层。
5. 哪些结论已确认，哪些必须实测后拍板。
6. 实施前必须补齐哪些证据。

## 2. 文档优先级

以下商业决策已确认，优先级高于早期评估建议：

### 2.1 每次启动在线强制版本门禁

正式客户端每次启动必须在线读取服务端唯一正式版本策略。

```text
无法确认 requiredReleaseSequence
→ 正式 Shell 不启动
```

不提供离线版本检查降级。

### 2.2 客户端不启动旧版业务

最新版安装或启动失败后：

- 不自动启动上一版业务。
- 不允许用户选择旧版。
- 不允许跳过更新。
- 不允许降低 `releaseSequence`。
- Bootstrap 保持可用，继续获取服务端后续修复版本。

### 2.3 服务端使用向前发布回滚

服务端只保留当前正式内容和上一稳定内容。

故障回滚不是要求客户端运行旧 sequence，而是：

```text
上一稳定内容
→ 生成更高 releaseSequence 的新 release
→ 重新签名
→ 切换为服务端唯一正式版本
```

### 2.4 正式 UI 不拥有更新功能

正式产品页面删除：

- 检查更新。
- 稍后更新。
- 跳过版本。
- 更新渠道。
- 页面内下载安装。
- 自动更新开关。

版本查询、下载、验证、安装和重启只属于独立 Bootstrap。

### 2.5 商业模型统一经过 OpenClaw

目标链路：

```text
U-Claw UI
→ OpenClaw session/chat/tool/history
→ U-Claw 商业中转 Provider
→ 服务端模型中转
```

Gateway 失败不得触发客户端降级到另一条自建聊天链。

## 3. V3 核心结论

不继续修补当前重型启动模型，也不直接退回旧脚本版。

采用以下方向：

> 保留商业授权、强制更新、凭据隔离、U 盘业务数据和品牌 UI；让 runtime 回归“安装验证一次、日常直接运行”的简单模型；Bootstrap 与正式业务 runtime 分离；正式 Shell 与 Gateway 能力状态分离。

首选候选架构：

```text
小型可信 Bootstrap / Go Launcher
→ 本地安全和激活材料分类
→ 每次在线强制版本检查
→ 必要时下载、完整验签、安装指定 release
→ 在线 License 门禁
→ 启动已验证的本机内容寻址 runtime
→ 精简 Electron Shell 立即显示
→ Electron 后台启动 OpenClaw Gateway
→ Gateway 和各业务能力独立 ready / degraded
```

暂定技术选择：

- Bootstrap：保留小型 Go Launcher。
- 正式 Shell：D3，精简 Electron 薄壳。
- runtime：已确认 R2 本机内容寻址 runtime；业务数据和授权身份继续留 U 盘；物理实测作为实施验收门。
- `runtime.pkg`：只作制盘、下载和更新运输格式；不参与 warm startup。
- Gateway：由 Electron Main 单一拥有和监督。
- 旧 `portable/`：不得继续与商业版共用同一正式发布身份。

## 4. 为什么原版 OpenClaw 没有这些问题

原版模型较简单：

```text
npm install openclaw
→ 直接运行已安装 OpenClaw
→ 浏览器访问 localhost
```

原版不负责：

- U 盘商业发行。
- 激活码和设备绑定。
- 在线撤销和 License 生命周期。
- 强制版本门禁。
- Provider Key 服务端隔离。
- 独立 Bootstrap。
- 品牌业务 UI。
- 非技术用户的双击、诊断和恢复。

原版值得学习的不是“删除所有商业能力”，而是：

- runtime 已安装、已展开、直接运行。
- 启动不重新处理运输包。
- Gateway 是业务后台，不是窗口出现的前置条件。
- 更新和日常启动职责分开。
- 本地 UI 可以在模型能力失败时继续存在。

## 5. 必须保留的产品能力

### 5.1 U 盘业务数据连续性

以下数据继续以 U 盘为权威位置：

- 会话。
- 记忆。
- 工作区。
- 附件索引和受控附件数据。
- Skill 用户数据。
- 渠道和业务设置。
- License 和设备绑定材料。
- 长期设备访问令牌。
- 诊断记录。

runtime 和可重建 cache 是否位于 U 盘，不等同于业务数据是否便携。

### 5.2 非技术用户体验

- 双击单一入口。
- 不要求本机安装 Node.js。
- 不要求执行 npm、PowerShell 或命令行。
- 启动全程有中文可见反馈。
- 失败时显示稳定错误码、诊断和明确恢复状态。
- 用户不需要理解端口、OpenClaw 配置文件和 Gateway 命令。

### 5.3 商业授权

- 激活码。
- U 盘/设备绑定。
- 本地签名许可证。
- 在线状态、撤销和有效期。
- 受控离线 License 宽限不能绕过在线强制版本门禁。
- 未激活设备只能进入最新版 activation-only。

### 5.4 模型凭据隔离

- Provider/New API 上游 Key 只存在服务器。
- 客户端只持有可撤销 `deviceToken`。
- Renderer、普通配置、日志和诊断不得包含上游 Key。
- 商业模型目录由服务端授权结果动态提供。

### 5.5 受控更新

- 每次在线确认唯一正式版本。
- 更新包签名、大小、SHA-256、manifest 和 tree digest 全部验证。
- 下载或安装中断不能覆盖业务数据。
- 不允许旧版业务回退。
- 服务端通过更高 sequence 发布修复或向前回滚内容。

### 5.6 品牌业务 UI

当前 `product/frontend` 不只是 OpenClaw Dashboard 皮肤，已包含：

- 会话管理和活动中心。
- 附件导入和任务状态。
- 模型、Provider 和用量。
- Skill、Plugin、MCP。
- 渠道和个人微信。
- 数据、记忆和诊断。
- 自动化、语音和系统能力。

是否能重构为 OpenClaw Plugin 可以长期评估，但不作为本次重构前置替代方案。

## 6. 必须删除的机制

### 6.1 删除 `runtime.pkg` 热启动

不再允许：

```text
每次启动
→ 完整读取 U 盘 runtime.pkg
→ 用包确认 runtime cache
```

`runtime.pkg` 只用于：

- 制盘。
- 首次安装到目标 runtime 位置。
- 强制在线更新。
- 离线更新器。
- 发布归档和审计。

### 6.2 删除热启动三次整树内容哈希

当前三次校验：

1. U 盘 `runtime.pkg` 完整哈希。
2. 已解压 runtime 整树哈希。
3. runtime lease 再次整树哈希。

目标：

- 安装/更新时完整校验一次。
- warm startup 不读取运输包。
- warm startup 只执行签名身份、关键入口和快速完整性检查。
- 显式诊断可以执行完整树审计。

### 6.3 删除 Gateway-before-window

正式版本和 License 门禁通过后：

```text
启动 Electron
→ 立即创建 Shell 窗口
→ 恢复本地历史和诊断
→ 后台启动 Gateway
```

不能：

```text
等待 Gateway business ready
→ 再创建窗口
```

### 6.4 删除 2 秒假稳定点

不能以“Electron 存活 2 秒”判断 release 启动成功。

### 6.5 删除客户端业务 rollback

本 V3 不设计：

- `rollback.json` 启动指针。
- 启动上一 release 的用户入口。
- 自动启动旧 sequence。
- 本地多版本选择。

安装事务可暂时保留旧文件保证写入安全，但旧文件不能用于正式业务启动。

## 7. 目标职责分层

### 7.1 Bootstrap / Go Launcher

只负责：

- 显示最小启动、更新和阻断 UI。
- 定位产品盘和业务数据。
- 恢复未完成安装事务。
- 分类激活状态。
- 验证本地 License 材料最低安全边界。
- 每次在线读取并验证强制版本策略。
- 下载、验签、安装服务端指定 release。
- 选择且只选择 `requiredReleaseSequence` 对应 runtime。
- 在线 License 状态门禁。
- 启动 activation-only 或 normal Shell。
- 监控正式 Shell 进程和 U 盘存在性。
- 最新版 runtime 无法启动时保持 Bootstrap 可用并继续检查更高 sequence。

不负责：

- Gateway business ready。
- 模型列表。
- 聊天、生图和 Skill。
- 正式业务 IPC。
- 正式设置页。
- 用户可选更新。

### 7.2 正式 Electron Shell

负责：

- 立即显示品牌 UI。
- 加载 U 盘本地历史和设置。
- 暴露本地诊断、Gateway 重试和安全退出。
- 注册稳定的业务 bridge。
- 管理 Gateway 进程。
- 展示能力级状态。
- Gateway 恢复后恢复业务能力。

### 7.3 OpenClaw Gateway

- 是唯一聊天、工具、历史和模型运行链。
- 启动失败不等于 Shell 失败。
- 由 Electron Main 单一拥有。
- 同一 attempt 不得重复 spawn。
- 崩溃后按受控策略重试。
- 不绑定非 loopback。
- 不要求修改 Defender、防火墙或系统代理。

### 7.4 在线服务

分别负责：

- 强制版本策略。
- runtime/CDN 分发。
- 激活和 License 状态。
- 模型目录和模型代理。
- 服务端向前回滚发布。

一个业务服务失败不能被错误分类为另一个服务失败。但强制版本服务不可达按已确认商业策略阻断正式 Shell。

## 8. 目标启动状态机

### 8.1 所有启动的共同前段

```text
START
→ Bootstrap 窗口立即可见
→ 恢复未完成安装事务
→ 验证产品盘、目录和 Bootstrap 本地安全边界
→ 分类激活材料
→ 已有 License 时先做本地签名、设备和 U 盘绑定检查
→ 在线获取 signed requiredReleaseSequence
```

### 8.2 本地不是服务端指定版本

```text
下载指定 runtime.pkg
→ 校验 HTTPS、策略签名、manifest、大小和 SHA-256
→ 解压到随机 staging
→ 完整 tree digest
→ 验证入口、平台和架构
→ 原子安装到内容寻址 runtime 目录
→ 原子切换本地 installed-current 记录
→ 重启 Bootstrap
→ 再次在线确认 requiredReleaseSequence
```

`installed-current` 只记录本机已安装目标，不授予启动旧版能力。它必须与本次在线策略精确一致才可启动。

### 8.3 未激活设备

```text
先更新到 requiredReleaseSequence
→ 启动该 release 的 activation-only Shell
→ 激活成功 exit code 20
→ 返回 Bootstrap START
→ 重新执行版本和 License 门禁
```

### 8.4 已激活设备

```text
本地 release == requiredReleaseSequence
→ 在线 License 状态门禁
→ 启动 normal Electron Shell
→ Shell 立即显示
→ 后台启动 Gateway
→ 能力逐项 ready / degraded
```

### 8.5 强制版本服务不可用

```text
Bootstrap 保持可见
→ 正式 Shell 不启动
→ 显示稳定错误码和重试
```

### 8.6 最新版 Shell 无法启动

最新版 Shell 无法创建进程、加载本地控制面或完成必要 migration 时：

```text
记录 releaseId、sequence、attemptId、阶段和错误码
→ 正式 Shell 关闭或不显示
→ Gateway 停止或不启动
→ Bootstrap 保持/恢复可见
→ 不启动旧版
→ 继续查询服务端更高 sequence
```

### 8.7 Gateway 失败

Gateway 失败属于能力故障，不自动定义为 release 启动失败：

```text
Shell 保持可见
→ local-only / partial 状态
→ 展示 Gateway 错误、日志和重试
→ 不清空会话、设置、任务和当前模型
```

只有本地 Gateway 二进制/入口完整性错误或本地核心协议与 release 声明不兼容，才升级为 release 级故障并返回 Bootstrap。

## 9. 启动信号和状态语义

### 9.1 `bootstrapVisible`

- Bootstrap 窗口已出现。
- 用户不再面对无反馈启动。

### 9.2 `windowShown`

- Electron Shell 窗口已显示。
- 只控制 Bootstrap 与 Shell 的视觉交接。
- 不证明业务能力可用。

### 9.3 `shellStable`

必须满足：

- Renderer 已加载。
- 启动控制通道可用。
- 本地诊断入口可用。
- 可以显示当前 release ID、sequence 和 Gateway 状态。
- 可以重试 Gateway。
- 可以查看脱敏启动日志。
- 可以安全退出并停止所属进程。

### 9.4 `gatewayServiceReady`

必须满足：

- Gateway 属于当前 attempt。
- `/ready` 成功。
- 本地协议 `hello` 成功。
- 返回的 runtime/build identity 与当前 release 匹配。
- 最小本地核心方法集合兼容。

禁止使用以下条件作为核心门禁：

- `/models` 在线成功。
- 真实聊天成功。
- 图片服务成功。
- SkillHub 成功。
- 所有可选 plugin/method 完整。
- 任意拍脑袋的单一存活秒数。

### 9.5 能力状态

```text
full
  当前公开能力完整可用

partial
  Gateway 可用，但部分模型、图片、Skill、Plugin 或渠道不可用

local-only
  Shell、本地历史、设置和诊断可用；Gateway 不可用

blocked
  强制版本、License、Shell 本地控制面或 release 完整性失败
```

## 10. runtime 运输与运行位置

### 10.1 运输格式

```text
runtime.pkg
+ signed release manifest
+ SBOM
+ release metadata
```

### 10.2 对比运行模式

阶段 -1 使用同一最终 runtime 实测两种模式。R1 作为对比基线，R2 作为首版正式方案验收对象：

#### R1：U 盘已展开 runtime

```text
U 盘 app/releases/<release-id>/
→ 直接运行
```

优势：完全自包含，不在宿主机安装 runtime。

风险：Electron、OpenClaw 和 Node 读取数万小文件，U 盘随机 IO 可能极慢。

#### R2：宿主机内容寻址 runtime

```text
U 盘 runtime.pkg + data/
→ 首次在该电脑完整验证并安装到：
%LOCALAPPDATA%/U-Claw/runtimes/<sequence>-<tree-digest>/
→ 后续直接从本机运行
```

优势：

- U 盘只进行首次顺序读。
- warm startup 从本机 SSD 运行。
- 避免 U 盘数万小文件随机读。
- runtime 属于可重建宿主 cache，不含业务数据。

风险：

- 首次在新电脑需要准备 runtime。
- 宿主机留下可重建 runtime 文件。
- 需要安全清理和归属 marker。

### 10.3 已确认首版运行方案

首版正式方案冻结为 R2：宿主机内容寻址 runtime。

```text
U 盘保留 runtime.pkg、业务数据和授权身份
→ Bootstrap 在新电脑首次使用时完整验签
→ 安装到 %LOCALAPPDATA%/U-Claw/runtimes/<sequence>-<tree-digest>/
→ 后续 warm startup 从本机 SSD 直接运行
```

宿主机只允许残留可重建 runtime 和明确归属的 cache；会话、记忆、工作区、License、`deviceToken` 和其他业务数据仍以 U 盘为权威位置。没有对应 U 盘和有效 License，本机 runtime 不得独立进入业务。

阶段 -1 物理实测是 R2 的验收门，不再用于在 R1/R2 之间自由选择。若 R2 未达到安全、兼容或性能门禁，必须退回重新评审；不得自动同时实现 R1、R2 或三种用户可选模式。

### 10.4 内容寻址

runtime 目录身份至少绑定：

```text
releaseSequence
releaseId
runtimeTreeSha256
targetPlatform
targetArch
```

目录名建议包含 sequence 和 digest 前缀，但真实信任仍来自已签名 manifest，不来自目录名。

## 11. 完整性和威胁模型

### 11.1 必须防御

- 发布和 CDN 制品替换。
- runtime.pkg 篡改。
- manifest 篡改。
- 非法降级和旧版本重放。
- staging 路径穿越、symlink/reparse 和硬链接攻击。
- 更新中断。
- installed-current 指针替换。
- 关键执行入口意外损坏或普通恶意软件修改。
- 客户端秘密进入包、日志或 Renderer。

### 11.2 不承诺防御

- 本机管理员或内核级攻击。
- 机器所有者重写整个客户端协议。
- 运行时 DLL 注入和内存篡改。
- 发布私钥已经泄露后的完整生态恢复。

商业授权的最终权威仍在服务端 License、deviceToken、额度和模型代理。

### 11.3 安装/更新时完整验证

必须执行：

- 策略签名和新鲜度。
- release manifest Ed25519。
- runtime.pkg 大小和 SHA-256。
- 解压条目路径、类型、数量和大小上限。
- 解压后完整 tree digest。
- 平台、架构、release ID 和 sequence。
- 关键入口存在性。
- 原子 staging 和切换。

### 11.4 warm startup 快速校验

可以执行：

- 已签名 manifest 身份。
- 宿主 runtime ownership marker。
- release identity 和 installed-current 一致性。
- Electron、Node、sidecar、OpenClaw 入口哈希。
- `app.asar` 等单一大容器哈希。
- 关键 native 模块哈希。
- 路径、reparse、链接数和文件 identity。
- 发现异常时触发完整树审计并阻断。

重要边界：

> 预先保存的 tree digest 或 marker 不能证明目录当前未被修改。只有重新读取内容计算完整 tree digest 才能证明当前整树完整性。

### 11.5 完整审计

- Bootstrap/诊断提供“完整性检查”。
- 完整审计失败必须阻断正式 Shell。
- 是否每 N 次启动自动审计，不在没有性能数据时写死。
- 启动日志必须记录本次使用快速校验还是完整审计。

## 12. installed-current 与防降级

### 12.1 本地选择不是发布授权

`installed-current` 只能表达本机已安装哪个 release。

真正允许启动的条件：

```text
installed release identity
== 本次在线 signed requiredReleaseSequence
```

### 12.2 指针认证

客户端不能使用发布私钥签本地指针。

建议：

- `installed-current` 引用一个已签名 release manifest。
- 本地指针使用受控原子文件和本地主机 anchor 认证。
- 启动时重新验证目标 release manifest。
- 目标 sequence 必须等于在线策略。

### 12.3 禁止普通 sequence 降低

任何本地旧 release 均不得因“回滚”直接启动。

服务端向前回滚仍使用更高 sequence。

## 13. Electron D3 薄壳

### 13.1 选择理由

当前 frontend 深度依赖 Electron preload bridge：

- `window.uclaw.client`
- attachments
- chatQueue
- providers
- skills
- plugins
- channels
- MCP
- data
- diagnostics
- release
- taskArtifacts
- systemNode
- systemVoice
- image operations

同时存在事件订阅、流式聊天、取消、文件选择和窗口控制。

所以 D1 浏览器/PWA 不是简单“把 IPC 改成 HTTP”，而是需要重新设计完整 loopback RPC、WebSocket/SSE、身份认证、CSRF/DNS rebinding、多标签页和文件权限。

D3 是首版最低迁移风险选择。

### 13.2 D1 长期研究

D1 可做小型技术 spike，但不作为当前重构并行正式实现。

只有同时满足以下条件才重新评估：

- Frontend bridge 可由统一 transport adapter 隔离。
- loopback 安全模型完成。
- 流式、取消、订阅和文件能力可覆盖。
- 浏览器/PWA 用户体验通过真实测试。
- 总维护成本低于 Electron。

### 13.3 D2 暂不采用

不引入 Rust/Tauri 工具链，除非 D1 和 D3 都无法满足明确需求。

## 14. Gateway 生命周期

### 14.1 单一所有者

Electron Main 是 Gateway 唯一进程所有者。

必须记录：

- pid。
- instanceId。
- attemptId。
- port。
- releaseId。
- spawn 时间。
- readiness 阶段。
- stop reason。

### 14.2 端口

- 只绑定 loopback。
- 使用受控动态端口范围。
- 冲突时选择新端口。
- 不添加全局防火墙规则。
- 应用自身请求强制绕过系统代理。

### 14.3 重试

- 同一 attempt 只能存在一个 Gateway。
- startup failure 先完成旧进程清理，再开始新 attempt。
- 旧 attempt 事件不能覆盖新状态。
- watchdog 采用状态和失败分类，不立即无上限重启。

### 14.4 business capability

Gateway `/ready` 和 hello 成功后，模型、聊天、图片、Skill、Plugin、渠道分别初始化。

任一能力失败只降低对应能力，不能重置整个 Shell。

## 15. 正式发布流水线

### 15.1 唯一商业发布入口

当前 `.github/workflows/release.yml` 发布旧 `portable/`，不能继续作为商业 `product/` 正式发布入口。

必须建立唯一商业 Windows 流水线。

产品源码和发布边界已确认：

```text
product/
→ 唯一商业产品源码
→ 唯一 runtime 组装输入
→ 唯一 Bootstrap/Launcher 输入
→ 唯一正式 U-Claw Windows 发布来源
```

根目录旧 `portable/`：

- 退出正式商业发行。
- 不作为新 `runtime.pkg`、Bootstrap、制盘包或在线更新输入。
- 不再由 `.github/workflows/release.yml` 以“正式 U-Claw”身份发布。
- 新商业流水线验收完成前只作历史对照；验收完成后归档或删除。

归档 `u-claw-app/`：

- 继续保持 2026-06-19 归档状态。
- 不构建、不发布、不继续开发。
- 不作为 Electron Shell、Gateway、runtime 或版本号来源。
- `track-upstream.yml`、活动测试和发布流程必须删除对其 `package.json`、`src/main.js` 等文件的依赖。
- 如需参考旧 Electron/Gateway 失败经验，只读 Git 历史或归档代码，不得复制其发布身份。

目录暂时保留不等于仍属于正式产品。任何正式商业制品必须能够证明构建输入中不含根 `portable/` 和 `u-claw-app/`。

### 15.2 构建顺序

```text
固定 commit、工具链、依赖和 releaseSequence
→ npm ci
→ build/typecheck/test/secret scan
→ 组装 Windows Electron runtime
→ 目录级真实 smoke
→ inventory、SBOM、tree digest
→ 生成 runtime.pkg
→ 签名 release manifest
→ 构建 Authenticode Bootstrap/Launcher
→ 生成制盘和在线更新制品
→ 最终制品真实启动
→ 物理 U 盘验收
→ 保存 SHA-256、日志和审计
→ 上传制品
→ CDN 回读验证
→ 最后原子切换 requiredReleaseSequence
```

### 15.3 发布禁止项

- 灰度后重新构建。
- 签名后手工修改文件。
- 使用 `@latest` 生成正式 runtime。
- 可选插件失败后 `|| true` 静默发布。
- fixture runtime 代替最终 runtime smoke。
- 先切服务端强制版本，再上传制品。
- 自动修改 Defender、防火墙或系统代理。

### 15.4 Bootstrap 自身更新

Bootstrap 自更新尚未定案，但必须满足：

- 业务 runtime 不能随意替换 Bootstrap。
- 新版本策略可声明最低 Bootstrap 版本。
- Bootstrap 更新包独立签名。
- Windows 运行中 EXE 替换使用独立 helper 或重启事务。
- 更新失败后 Bootstrap 仍能继续获取修复版本。
- Bootstrap 更新频率必须远低于业务 runtime。

该问题需单独设计，不能用普通 runtime current 机制顺带实现。

## 16. 进程、并发和宿主残留

### 16.1 单实例

- 同一产品盘重复双击：聚焦已有 Bootstrap/Shell。
- 正式 Shell 启动后，第二次启动不重复执行 Gateway。

### 16.2 两支 U 盘

已确认：同一台电脑不允许同时运行两支 U-Claw 商业 U 盘。

- Bootstrap 使用宿主机级全局单实例锁，不以盘符或 U 盘身份拆分锁。
- 第一支 U 盘已运行时，第二支 U 盘只显示稳定提示，不进入版本、License、Shell 或 Gateway 流程。
- 第二次启动同一支 U 盘时，聚焦已有 Bootstrap/Shell。
- 锁记录必须能识别进程已退出后的陈旧状态，不能永久阻塞后续启动。
- 第一支 U 盘退出并完成所属进程清理后，另一支 U 盘才能启动。
- 两支 U 盘的业务数据、License 和 `deviceToken` 永不共享。

### 16.3 宿主机允许残留

R2 模式允许宿主机保留：

- 已验证 runtime。
- compile cache。
- browser cache。
- temp。
- authorization anchor。

禁止残留：

- 会话正文。
- 记忆和工作区。
- 附件业务数据。
- 明文 deviceToken。
- Provider/New API Key。
- 完整 prompt、回复和工具输出日志。

### 16.4 安全清理

可重建 runtime 清理必须：

- 使用 ownership marker。
- 拒绝 symlink/reparse 越界。
- 不清理正在运行的 release。
- 不触碰业务数据和未知目录。

## 17. 磁盘空间

安装前计算：

```text
下载包
+ staging 解压后大小
+ 当前安装事务临时文件
+ 安全余量
```

由于客户端不保留可启动旧业务版，不需要为业务 rollback 长期预留第二份 runtime；但安装切换完成前仍需保证事务安全。

空间不足：

- 不切换 installed-current。
- 不删除当前服务端指定版本的有效安装。
- Bootstrap 显示稳定错误和清理建议。
- 不自动删除 U 盘业务数据。

## 18. 日志和诊断

### 18.1 统一字段

```text
launchAttemptId
releaseId
releaseSequence
policyEpoch
runtimeTreeSha256 prefix
stage
capability
pid
instanceId
port
durationMs
result
errorCode
```

### 18.2 阶段

```text
bootstrap.visible
bootstrap.recoverInstall
bootstrap.localLicense
bootstrap.versionPolicy
bootstrap.download
bootstrap.verifyPackage
bootstrap.installRuntime
bootstrap.onlineLicense
bootstrap.spawnShell
shell.windowShown
shell.shellStable
gateway.spawn
gateway.httpReady
gateway.hello
gateway.capabilities
workspace.readyOrDegraded
```

### 18.3 禁止记录

- 激活码。
- startup secret。
- deviceToken。
- Authorization。
- Provider/New API Key。
- 完整 prompt 和回复。
- 完整工具参数和工具输出。
- 图片 base64。
- 未脱敏客户路径。

## 19. 阶段 -1：实施前证据门

### 19.1 物理 U 盘 runtime 位置对比

同一最终 runtime、同一测试机、Defender 开启，比较：

```text
R1：U 盘已展开目录直接运行
R2：U 盘 runtime.pkg 首次安装到本机，后续本机运行
当前模型：runtime.pkg + 当前 cache/三次校验
```

记录：

- Bootstrap 可见时间。
- 首次 Shell 可见时间。
- warm Shell 可见时间。
- Gateway `/ready`。
- Gateway hello。
- 第一次真实聊天。
- 文件读取数量、顺序读和随机读。
- CPU、磁盘和 Defender 影响。

覆盖：

- 推荐 USB 3.0 U 盘。
- 至少一支低速样本。
- Windows 11 普通用户。
- 无本机 Node.js。

### 19.2 Frontend bridge 审计

不能只搜索 `ipcRenderer`。必须结构化统计：

- `window.uclaw.*` 各领域 bridge。
- invoke 请求类型。
- subscribe 事件类型。
- 流式聊天。
- 取消和幂等。
- 文件选择、拖放和附件。
- 窗口控制。
- 本地数据和诊断。

输出：

- D3 可复用比例。
- D1 需要新增的 HTTP/WebSocket/SSE 端点。
- loopback 身份、CSRF、DNS rebinding 和多标签页边界。

### 19.3 当前正式启动基线

记录当前 `main`：

- 三次校验各自耗时。
- U 盘顺序读和小文件随机读。
- Electron 可见时间。
- Gateway ready。
- 当前错误码和日志完整性。

### 19.4 威胁模型确认

确认第 11 节边界。不得在实施中临时扩大到“防御机器所有者和管理员”，也不得静默削弱发布、更新和防降级安全。

### 19.5 阶段 -1 退出条件

只有以下全部完成，才进入代码重构：

- R1/R2 性能数据。
- Frontend bridge 审计。
- 当前启动基线。
- 威胁模型签字确认。
- D3 首版选择确认。
- 旧 `portable/` 定位确认。

## 20. 推荐实施顺序

### 阶段 0：冻结和测试合同

- 暂停人工制作新商业客户包。
- 保留当前已知可用包和 SHA-256。
- 把 Gateway 失败不阻断 Shell 写成失败测试。
- 冻结 Bootstrap 强制版本和 License 门禁合同。

### 阶段 1：UI/Gateway 解耦

- Electron 窗口先显示。
- 建立 `windowShown` 和 `shellStable`。
- Gateway 后台启动。
- full/partial/local-only/blocked 状态。
- 重试不重复进程。
- Gateway 失败保留诊断和本地历史。

此阶段可继续使用现有 runtime 加载方式，避免同时改所有层。

### 阶段 2：runtime 运输与运行分离

- 落地已确认的 R2 宿主机内容寻址 runtime。
- R1 只保留为阶段 -1 对比基线，不进入正式产品实现。
- `runtime.pkg` 退出 warm startup。
- 安装/更新时完整校验。
- warm startup 快速校验。
- 内容寻址 runtime 不互相删除。

### 阶段 3：独立 Bootstrap 和强制更新

- 每次在线版本门禁。
- 未激活先更新再 activation-only。
- 安装事务恢复。
- 只启动 requiredReleaseSequence。
- 最新版失败后保持 Bootstrap，等待更高 sequence。
- 严格执行“本地 License 校验 → 强制版本门禁 → 在线 License 校验 → Shell → Gateway”。

### 阶段 4：唯一生产流水线

- 正式 Windows runtime 组装器。
- release manifest、runtime.pkg、SBOM、Launcher 和制盘结果统一编排。
- 最终 runtime smoke。
- CDN 回读后再切强制版本。

### 阶段 5：物理 U 盘发布门禁

- Windows 10/11。
- 普通用户。
- 无本机 Node.js。
- Defender 开启。
- 推荐盘和低速盘。
- 首次和 warm startup。
- 断网、代理和防火墙。
- 强制版本服务/CDN故障。
- License 故障。
- Gateway 各类失败。
- Renderer/Main 崩溃。
- 空间不足。
- 第一支 U 盘运行时，第二支 U 盘被宿主机全局单实例锁稳定阻断。
- 换盘符、拔盘。
- 更新中断。
- 服务端向前回滚 release。

## 21. 验收标准

### 21.1 Bootstrap 和强制版本

- 双击后立即出现 Bootstrap 可见反馈。
- 每次启动真实在线查询版本策略。
- 本地 release 不等于 required sequence 时正式 Shell 不启动。
- 用户无跳过、稍后、旧版和降级入口。
- 下载、签名、空间或安装失败不切换 installed-current。
- 最新版 Shell 级失败后不启动旧版。
- Bootstrap 能继续获取服务端更高 sequence。

### 21.2 Shell 和 Gateway

- 版本和 License 门禁通过后，Shell 不等待 Gateway business ready。
- Gateway 不存在或超时时，Shell 仍提供本地历史、诊断、重试和退出。
- Gateway ready 后通过同一 Shell 恢复业务能力。
- 模型、图片、Skill 或渠道失败不重启整个 Shell。
- 连续重试十次无重复 Gateway、timer、IPC handler 和孤儿进程。

### 21.3 runtime

- cache hit/warm startup 不读取完整 `runtime.pkg`。
- 安装/更新执行完整包和 tree 校验。
- 快速校验异常触发完整审计并阻断。
- runtime 目录身份绑定 releaseSequence、releaseId 和 tree digest。
- 不同 release 不互相删除正在使用的 runtime。

### 21.4 发布

- 候选、验收和正式制品字节一致。
- 所有版本和工具链固定。
- 最终 runtime 而非 fixture 通过 smoke。
- CDN 制品可回读后才切 requiredReleaseSequence。
- 服务端向前回滚使用更高 sequence。

### 21.5 数据和秘密

- 更新不覆盖 `data/`。
- 不覆盖 License、设备绑定和长期 deviceToken。
- 宿主机不残留业务数据和明文秘密。
- 日志不包含秘密、完整 prompt、完整回复和工具输出。

## 22. 明确不做

- 不整分支 merge `codex/launcher-startup-integration-v2`。
- 不直接 cherry-pick 大幅修改 `main.ts` 或 `state.go` 的旧实现。
- 不在首版同时实现三种 runtime 用户模式。
- 不在当前重构迁移到 Tauri。
- 不把完整 Frontend RPC 立即重写为浏览器 HTTP。
- 不自动修改 Defender、防火墙或系统代理。
- 不允许客户端启动旧版业务。
- 不降低 release sequence。
- 不提供页面内更新。
- 不用延长 Gateway timeout 代替架构修复。
- 不因性能问题删除安装/更新完整验签。
- 不在归档 `u-claw-app/` 中继续实现正式功能。
- 不从根目录旧 `portable/` 复制脚本、配置或 runtime 作为新商业发布输入。
- 不使用 `u-claw-app/package.json` 或旧 `portable/` Tag 规则驱动新商业版本号。

## 23. 尚待确认

1. Bootstrap 自更新协议。
2. `installed-current` 本地 anchor 的具体认证格式。
3. warm startup 关键文件集合。
4. 完整审计触发策略。
5. Shell migration 失败与 Gateway 能力失败的精确分类。
6. Bootstrap 最小 UI 使用 Win32 GDI、其他原生方案还是受控轻壳。

## 24. 请 Claude 终审

请重点检查：

1. 本 V3 是否正确服从“每次在线强制版本、客户端无旧版业务回滚”的已确认需求。
2. `runtime.pkg` 只作运输、warm startup 直接运行已安装 runtime 是否正确。
3. R2 本机内容寻址 runtime 是否破坏 U 盘产品定位或数据边界。
4. 强制版本服务阻断 Shell，与 Gateway 失败只降级 Shell 是否区分清楚。
5. `shellStable` 和 `gatewayServiceReady` 定义是否足够可测试。
6. `/models`、真实聊天和可选能力不进入 release 启动门禁是否正确。
7. 快速校验和完整审计的安全边界是否诚实。
8. `installed-current` 不使用发布私钥、本地只引用已签名 manifest 的设计是否正确。
9. 不保留客户端业务 rollback 后，安装事务恢复是否仍闭环。
10. D3 首版、D1 长期 spike、D2 暂不采用是否合理。
11. UI/Gateway 解耦先于 runtime 重构是否降低实施风险。
12. 独立 Bootstrap 自更新是否还有未识别的信任循环。
13. 当前验收矩阵是否遗漏企业 Windows、U 盘或服务端故障场景。
14. 哪些需求仍然过度工程化，可以继续删除。
15. 哪些安全保证在 V3 中被静默削弱。

建议输出：

```text
总体结论：通过 / 有条件通过 / 退回

已确认需求冲突：
- ...

事实错误：
- ...

过度设计：
- ...

安全缺口：
- ...

建议修改：
- ...

阶段 -1 必须补的证据：
- ...

是否允许进入实施计划：是 / 否
```

## 25. 最终需求摘要

```text
独立小型 Bootstrap
+ 每次在线强制版本门禁
+ 客户端不启动旧版业务
+ 服务端使用更高 sequence 向前回滚
+ runtime.pkg 只作运输和更新格式
+ runtime 安装验证一次、warm startup 直接运行
+ U 盘继续保存业务数据和授权身份
+ 首版保留精简 Electron D3
+ Shell 在正式门禁后立即显示
+ Gateway 后台启动和能力独立降级
+ 商业模型统一经过 OpenClaw
+ product/ 是唯一商业源码和发布输入
+ 根 portable/ 与 u-claw-app/ 退出正式构建和发布链
+ 唯一商业发布流水线
+ 物理 U 盘证据通过后才实施和发布
```
