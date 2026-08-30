# Bavi-box 第一阶段 Windows 会合验收

> Task：`P1-T23`
> 记录日期：2026-08-09
> 严格状态：阻塞，未通过

## 已建立的自动化

- 首启缓存创建、二启缓存复用、退出后进程清理、拔盘观测、宿主机残留差分审计。
- 汇总证据包含 OS build、管理员组成员身份、token 提升状态、Defender、盘符与设备身份哈希、三件发行物 SHA-256、UTC 时间、各 case 结果和阻塞原因。
- 宿主机 baseline 只保存路径 SHA-256 和文件元数据，不序列化用户名、绝对路径或文件名。
- 默认只接受可移动盘、USB BusType 和 Win32_DiskDrive USB 身份同时成立的物理 U 盘。模拟目录即使显式放行，也只产生 `blocked` 烟测证据。
- Hosted Windows Runner 只检查 PowerShell 5.1/7 解析和阻塞路径，不计入实机验收。

## 当前阻塞

- 未在真实 Windows 10 x64 普通用户、Defender 开启环境执行。
- 未在真实 Windows 11 x64 普通用户、Defender 开启环境执行。
- 未用同一物理 U 盘完成两机换机连续性验证。
- 未完成运行中物理拔盘和停止写入观测。
- 未完成真实业务数据的宿主机残留差分审计。
- 44 项基础及第一阶段功能尚未全部有 Windows 最终证据。
- 当前 macOS 环境无 PowerShell；仅完成 Node.js 合同测试、JSON/YAML 解析和差异检查。PowerShell 5.1/7 语法与阻塞路径尚待 Hosted Windows 工作流执行。

上述阻塞清零、两机 JSON 证据合并且所有 case 为 `passed` 前，`P1-T23` 不得标记完成，第一阶段不得宣称通过或发布。
