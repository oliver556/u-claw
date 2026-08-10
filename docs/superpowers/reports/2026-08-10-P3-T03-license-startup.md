# P3-T03 启动授权与本地验签交付报告

## 状态

`LIC-001` 代码与本地/沙箱自动化完成。生产 Launcher 默认 fail-closed；真实 Windows、物理 U 盘、换机/换盘符和硬件兼容率仍由 `P3-T08` 验收。

## 代码证据

- `product/launcher/license.go`：strict v1 credential/license schema、重复 key/未知字段/尾随 JSON 拒绝、Ed25519 验签、独立 startup secret proof、device/license/fingerprint/time 校验、有界 handle 读取和固定错误。
- `product/launcher/usb_fingerprint_windows.go`：Windows native `CreateFile`/`DeviceIoControl`；USB bus；首选 `StorageDeviceUniqueIdProperty`；strict serial fallback；不调用 PowerShell。
- `product/launcher/state.go`：`VALIDATING_LICENSE` 位于 USB 可写校验后、instance lock/runtime 清单/解压/`StartProcess` 前。失败不触发 Electron/OpenClaw runtime。
- `product/launcher/main.go`：`--release-fs-helper` 入口复用相同 USB 可写校验和生产授权 gate；未授权时不进入 install/cache cleanup helper core。
- `.github/workflows/portable-launcher.yml`：生产构建要求独立 `UCLAW_LICENSE_TRUSTED_PUBLIC_KEYS` 公钥变量；清空外部 `GOFLAGS`，禁止意外编入 test-only fingerprint source。
- `product/tests/windows/sign-license-fixture.mjs`：Windows lifecycle 运行时动态生成 test-only Ed25519 keypair；私钥只在进程内存中，不写仓库、fixture 文件或日志。

## 授权与秘密边界

固定 U 盘路径：

```text
.uclaw/license/.startup-credential.json
.uclaw/license/license.json
```

credential 保存 `deviceId`、`licenseId`、独立 `startupSecret`。license 签名绑定 `deviceId`、`licenseId`、`usbFingerprint`、`startupSecretSalt`、`startupSecretHash`、`notBefore`、`expiresAt` 和 key ID。启动 secret proof 使用 domain-separated salted SHA-256；secret 为随机高熵值，New API Token 不进入授权 schema、哈希、trust root、错误或测试路径。

生产代码只含公钥 trust root 插槽；默认 `{}` 时拒绝启动。签名私钥、企业上游 Key、New API Token 未进入仓库、客户端、U 盘 fixture 或日志。

## 拒绝状态

固定码覆盖：credential 缺失、secret 缺失/错误、license 缺失、文件不安全、格式错误、trust root 缺失、签名错误、device/license mismatch、USB identity 缺失、fingerprint mismatch、未生效、已过期。中文消息固定，不返回路径、ID、secret、signature 或 fingerprint。

## USB 指纹 v1

已批准方案 A：

1. native storage descriptor 必须证明 USB bus。
2. 有实际 identity offset 的 `STORAGE_DEVICE_UNIQUE_IDENTIFIER` 优先；对有界 descriptor 做 domain-separated SHA-256。
3. 缺 unique identifier 时，仅 serial 非空且 `IOCTL_DISK_GET_LENGTH_INFO` capacity 有效才允许 fallback。
4. fallback canonical：规范化 `vendor/product/revision/serial/capacity`，NUL 分隔，SHA-256。
5. unique/serial 都缺失：`E_LICENSE_USB_ID_UNAVAILABLE`。

这是软件层“防君子”绑定，不是硬件级 DRM。

## 自动化证据

- Go：unit、race、vet；Windows amd64 production test/build cross compile；test-only tagged build。
- Node 24.15.0：fresh `npm ci --ignore-scripts`、build/smoke、typecheck、unit、contract、integration、Windows static contracts、portable workflow contract。
- 安全：symlink/hardlink、超大文件、Unicode/空格路径、重复 key、全部签名字段篡改、wrong device/license/fingerprint、缺 secret/file、有效期、启动顺序、固定日志、production signing primitive scan。
- Windows lifecycle 静态契约新增动态 license fixture、缺 credential、缺 license、license 篡改且 runtime cache 未创建。

交叉编译和静态 PowerShell contract 不等同真实 Windows/物理 U 盘执行。

## 分支与冲突

- Branch：`codex/p3-t03-license-startup`
- Base：`fb932e974a157750d125f688b3310411b3e47eb5`
- 设计提交：`8756611`
- Shared contract：未修改 `product/shared/src/index.ts`、公共错误类型或 P3-T01 schema。
- 冲突风险：`product/launcher/state.go`、`product/launcher/main.go` 和 `.github/workflows/portable-launcher.yml` 为中等；P3-T02 不应重叠，主集成窗口需保留 license gate 顺序和独立 trust root。

## P3-T08 延期项

- Win10/11 x64 标准用户下 `DeviceIoControl` 权限与实际返回结构。
- 不同品牌 U 盘、USB-SATA bridge、unique ID/serial 可用率。
- 同一 U 盘换盘符、换机稳定性；容量与 descriptor 稳定性。
- 物理拔盘、真实 release binary、Defender 和签名公钥正式注入。

`P3-T04` 继续实现在线状态、撤销、重制与离线容错；本 Task 不实现服务查询或 Stripe/支付。
