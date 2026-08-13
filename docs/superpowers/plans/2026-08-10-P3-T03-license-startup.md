# P3-T03 License Startup Implementation Plan

> **历史计划说明（2026-08-13）：** 本计划对应已完成的旧版授权底座，不再直接代表第一版完整产品流程。后续实现以[《第一版启动、激活与授权总方案》](../../第一版启动激活授权方案.md)为准；复用 USB 指纹、本地验签和 gate，并补充未激活受限窗口与在线激活路径。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Go Launcher 启动 Electron/OpenClaw 前完成 LIC-001 独立启动凭据、Ed25519 授权和 Windows USB 指纹的 fail-closed 本地验证。

**Architecture:** 平台无关 `license.go` 负责 strict 文件/schema/签名/secret/time/identity 验证；`usb_fingerprint_windows.go` 只负责 native DeviceIoControl 采集；`state.go` 在 runtime 前调用注入式 gate。生产 trust root 由链接期常量提供，测试动态生成私钥。

**Tech Stack:** Go standard library, Windows kernel32 DeviceIoControl, Ed25519, SHA-256, existing Launcher state/reporter tests, Node 24.15.0 workspace gates.

---

### Task 1: 授权 schema、签名和 secret proof

**Files:**
- Create: `product/launcher/license.go`
- Create: `product/launcher/license_test.go`

- [ ] **Step 1: 写失败测试**：动态生成 Ed25519 keypair 和内存 fixture，覆盖有效授权、strict JSON、所有篡改、wrong device/license/fingerprint、缺 secret、未生效、过期、未知 key。
- [ ] **Step 2: 验证 RED**：运行 `go test ./... -run 'TestVerifyStartupLicense|TestLicense'`，预期缺少授权 API 而失败。
- [ ] **Step 3: 最小实现**：定义 strict v1 structs、domain-separated signing payload、constant-time secret proof、固定 sentinel errors 和有界文件读取。
- [ ] **Step 4: 验证 GREEN**：重跑定向测试，预期 PASS。

### Task 2: 版本化 USB 指纹与 Windows native 采集

**Files:**
- Create: `product/launcher/usb_fingerprint.go`
- Create: `product/launcher/usb_fingerprint_windows.go`
- Create: `product/launcher/usb_fingerprint_other.go`
- Create: `product/launcher/usb_fingerprint_test.go`

- [ ] **Step 1: 写失败测试**：覆盖 primary descriptor、fallback `vendor/product/revision/serial/capacity` canonical golden、非 USB、缺 unique/serial/capacity。
- [ ] **Step 2: 验证 RED**：运行 `go test ./... -run 'TestUSBFingerprint'`，预期缺少函数而失败。
- [ ] **Step 3: 最小实现**：公共 canonical/hash helper；Windows 用 `CreateFile` + `DeviceIoControl` 查询 storage property 和 length；非 Windows production fail-closed。
- [ ] **Step 4: 验证 GREEN 与交叉编译**：运行定向测试及 `GOOS=windows GOARCH=amd64 go test -c`。

### Task 3: 启动 gate、状态和诊断

**Files:**
- Modify: `product/launcher/main.go`
- Modify: `product/launcher/state.go`
- Modify: `product/launcher/state_test.go`
- Modify: `product/launcher/main_test.go`

- [ ] **Step 1: 写失败测试**：断言 `VALIDATING_LICENSE` 位于 USB probe 后、lock/runtime 前；每类授权失败不调用 runtime/`StartProcess`；错误码固定且脱敏。
- [ ] **Step 2: 验证 RED**：运行 `go test ./... -run 'TestRun.*License|TestDiagnostic.*License|TestStateText'`，预期缺 gate/state/code。
- [ ] **Step 3: 最小实现**：向 `Dependencies` 加 `VerifyLicense`；production wiring 使用内置 trust root和 native fingerprint；补状态与诊断映射。
- [ ] **Step 4: 验证 GREEN**：运行 Launcher 全测试。

### Task 4: 文件边界、秘密边界与回归

**Files:**
- Modify: `product/launcher/license_test.go`
- Modify: `product/scripts/secret-scan.test.mjs`（仅在现有扫描无法证明边界时）

- [ ] **Step 1: 写失败测试**：覆盖缺文件、symlink/hardlink、Unicode/空格路径、超大文件、尾随 JSON、错误不含 secret/ID/path；扫描 production 不含 private key 或 test key。
- [ ] **Step 2: 验证 RED**：运行定向 Go/secret scan 测试，确认每个新增测试因目标缺口失败。
- [ ] **Step 3: 最小实现**：只收紧授权文件 reader/固定诊断；不扩大公共 redaction 或 shared schema。
- [ ] **Step 4: 验证 GREEN**：定向测试全绿。

### Task 5: 完整验收、review 和提交

**Files:**
- Modify: `docs/superpowers/reports/2026-08-10-P3-T03-license-startup.md`

- [ ] **Step 1: 全量验证**：锁定 Node 24.15.0 后运行 build/typecheck/test/contract/integration/static/secret scan；运行 Go test/race/vet 和 Windows amd64 test/build cross compile。
- [ ] **Step 2: diff/秘密审计**：运行 `git diff --check`、tracked secret scan、私钥标记扫描，核对 shared contract 未改。
- [ ] **Step 3: 独立 review**：对 base `fb932e9` 到 HEAD/diff 审查，修复全部 Critical/Important 后重新验证。
- [ ] **Step 4: 原子提交**：提交代码、测试、设计/计划/报告；保持工作树干净，不 push、不建 PR。
