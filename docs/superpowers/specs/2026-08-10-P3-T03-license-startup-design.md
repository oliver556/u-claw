# P3-T03 启动授权与本地验签设计

> **版本说明（2026-08-13）：** 本文记录已完成的旧版本地授权底座。第一版产品流程已改为“用户名 + 激活码首次在线绑定当前 U 盘”，权威方案见[《第一版启动、激活与授权总方案》](../../第一版启动激活授权方案.md)。本文的 USB 指纹、Ed25519 验签和启动前 gate 继续复用；“缺授权直接拒绝”需按新方案增加受限激活分支。

## 范围

完成 `LIC-001` 的客户端代码与自动化：Go Launcher 在任何 Electron/OpenClaw runtime 工作前读取独立启动凭据、验证 Ed25519 授权、核对 `deviceId`、`licenseId`、有效期和版本化 USB 指纹。在线状态、撤销、重制和离线容错属于 `P3-T04`；真实 Windows/物理 U 盘兼容率属于 `P3-T08`。

## 选择

采用已批准的方案 A。Windows Launcher 直接调用 `DeviceIoControl`，不调用 PowerShell：

1. 确认存储总线为 USB。
2. 首选 `StorageDeviceUniqueIdProperty`，对有界 descriptor 生成 `uclaw-usb-v1` SHA-256。
3. unique identifier 不可用时，读取 `StorageDeviceProperty`。仅当 serial 非空且 capacity 可用时，规范化 `vendor/product/revision/serial/capacity` 后生成 fallback SHA-256。
4. unique identifier 与 serial 均不可用时 fail-closed：`E_LICENSE_USB_ID_UNAVAILABLE`。

方案 B（仅 serial/model/capacity）兼容更广，但更易复制。方案 C（只接受 unique identifier）更严，但会拒绝更多普通 U 盘。两者不采用。

## 文件与信任边界

固定路径：

```text
.uclaw/license/.startup-credential.json
.uclaw/license/license.json
```

启动凭据 strict JSON：

```json
{"schemaVersion":1,"deviceId":"dev_...","licenseId":"lic_...","startupSecret":"<random secret>"}
```

授权 strict JSON 包含 `deviceId`、`licenseId`、`usbFingerprint`、`startupSecretProof`、`notBefore`、`expiresAt` 和 Ed25519 signature。`startupSecretProof` 保留 P3-T01 冻结字段名 `startupSecretSalt`、`startupSecretHash`。签名 payload 使用固定字段顺序与 domain separator；未知字段、尾随 JSON、非法时间、超界字段全部拒绝。

`startupSecretProof` 使用独立 salt：

```text
SHA-256("uclaw-startup-secret-v1\0" || decodedSalt || "\0" || UTF-8 startupSecret)
```

Launcher 只编入许可证公钥 trust root。生产默认无 key 时 fail-closed；私钥不存在于 production 文件、fixture、日志或环境变量。测试运行时生成 test-only Ed25519 keypair。New API Token 不参与授权 schema、哈希、错误或撤销边界。

## 启动顺序

```text
Resolve paths
-> ProbeDataDirectory
-> VALIDATING_LICENSE
-> verify credential/license/device/fingerprint/time
-> acquire instance lock
-> read/check/extract runtime
-> start Electron/OpenClaw
```

授权失败前不创建 instance lock、不读 runtime manifest、不解压、不调用 `StartProcess`。授权文件通过 `os.OpenRoot` 下的固定相对路径打开；拒绝 symlink、hardlink、非普通文件和超大文件，并从已打开 handle 完成读取与验签，避免检查后换文件。

## 错误与日志

固定诊断码区分：缺 credential、缺 secret、缺 license、格式错误、trust root 不可用、签名错误、wrong device、wrong license、USB identity 不可用、wrong fingerprint、未生效、已过期。所有提示为固定中文文案，不包含路径、ID、secret、signature、fingerprint 或底层错误文本。

## 测试

- Go unit：有效授权；payload/signature/字段篡改；wrong device/license/fingerprint；缺文件/secret；未生效/过期；strict JSON；公私钥隔离；固定错误脱敏。
- Go state：gate 在 runtime 所有操作前；失败时 `StartProcess` 零调用。
- 文件安全：Unicode/空格 Windows 路径；symlink/hardlink；handle-bound read；大小上限。
- USB：primary/fallback canonical golden；缺 unique/serial fail-closed；Windows native 源只交叉编译，不冒充真机。
- 全量：Node 24.15.0 build/typecheck/unit/contract/integration/static/secret scan/diff check；Go test/race/vet；Windows amd64 test/build cross compile。

## 延期与风险

方案 A 是软件层绑定，不宣称硬件级 DRM。不同 U 盘控制器、USB-SATA 桥接、驱动返回结构、标准用户权限、换盘符和换机稳定性必须在 `P3-T08` 真机验证。在线撤销和离线容错状态只保留可扩展 schema/version 边界，不在本 Task 实现。
