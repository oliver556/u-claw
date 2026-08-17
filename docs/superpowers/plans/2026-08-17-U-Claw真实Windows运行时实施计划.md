# U-Claw 真实 Windows 运行时实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建可复现的完整 Windows x64 U-Claw runtime，使用户只需双击 U 盘根目录的 `U-Claw.exe`，即可在普通用户、Defender 开启、首次断网环境中启动真实 Electron 界面和本地 OpenClaw。

**Architecture:** 新增确定性 Windows runtime 组装器，验证并展开锁定的 Electron、Node 和 OpenClaw 输入，将已构建的 U-Claw workspaces 与生产依赖放入 Electron `resources/app`。Launcher 向 Desktop 注入 runtime 内 Node/OpenClaw 的绝对路径，现有 `build-runtime`、签名、在线 feed、离线 EXE 和更新事务保持不变。

**Tech Stack:** Node.js 24.15.0、npm 11.12.1、Electron 40.10.6、OpenClaw 2026.7.1-2、ES modules、JSZip、Go Launcher、PowerShell 5.1/7、GitHub Actions Windows 2022。

---

## 文件结构

- `product/runtime-versions.json`：固定 Windows Electron、Node、OpenClaw 来源和完整性。
- `product/packaging/fetch-runtime-artifact.mjs`：受控下载、大小限制、SHA-256/SRI 验证，无重定向。
- `product/packaging/build-windows-runtime.mjs`：组装真实 Electron app、Node、OpenClaw 和生产依赖。
- `product/packaging/windows-runtime-app/package.json`：Electron app 的固定主入口和生产依赖声明。
- `product/packaging/windows-runtime-app/package-lock.json`：完整生产依赖闭包，包含 OpenClaw 固定版本。
- `product/tests/packaging/windows-runtime.test.mjs`：下载器和组装器的单元/契约测试。
- `product/launcher/process.go`：向正常 Desktop 进程注入 runtime 内 Node/OpenClaw 路径。
- `product/launcher/process_test.go`：验证固定路径、环境覆盖和 activation-only 隔离。
- `product/scripts/build-windows-validation-kit.mjs`：串联真实 runtime、签名、初始 U 盘目录、feed 和离线 EXE。
- `product/scripts/build-windows-validation-kit.test.mjs`：禁止 fixture runtime、私钥泄漏和不完整套件。
- `product/tests/windows/real-runtime-smoke.ps1`：断网启动真实 runtime 并验证窗口、Gateway、版本和脱敏诊断。
- `.github/workflows/portable-launcher.yml`：增加真实 runtime 构建与 Windows 启动门禁。
- `product/package.json`：增加正式 runtime 和验收包脚本。
- `deploy/updates/README.md`：记录真实 runtime 发布顺序和验收命令。

### Task 1: 固定 Windows runtime 外部输入

**Files:**
- Modify: `product/runtime-versions.json`
- Modify: `product/scripts/verify-reproducibility.mjs`
- Modify: `product/scripts/verify-reproducibility.test.mjs`

- [ ] **Step 1: 写失败的固定输入测试**

在 `verify-reproducibility.test.mjs` 添加：

```js
test("pins immutable Windows runtime artifacts", async () => {
  const versions = JSON.parse(await readFile(new URL("../runtime-versions.json", import.meta.url)));
  assert.deepEqual(versions.windowsArtifacts, {
    electron: {
      url: "https://github.com/electron/electron/releases/download/v40.10.6/electron-v40.10.6-win32-x64.zip",
      sha256: "072480360a5d5e3ec0d4173b1f9d7d0bca435098567d7e6bb5829638072febfd",
    },
    node: {
      url: "https://nodejs.org/dist/v24.15.0/node-v24.15.0-win-x64.zip",
      sha256: "cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62",
    },
    openclaw: {
      url: "https://registry.npmjs.org/openclaw/-/openclaw-2026.7.1-2.tgz",
      integrity: "sha512-ycF3yPcbjN6bUPeaUx6Mh6vze1hQWoD3CT/wWcmD7a8xaHHHRUaAlaq+lFxMHf1ssEgODVAwjlzYqp2twkYZ7g==",
    },
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd product && node --test scripts/verify-reproducibility.test.mjs`

Expected: FAIL，`windowsArtifacts` 为 `undefined`。

- [ ] **Step 3: 添加固定输入并扩展校验器**

向 `runtime-versions.json` 加入上述 `windowsArtifacts`。在 `verifyWorkspacePins()` 中校验 URL 主机、版本字符串、64 位小写 SHA-256 和 OpenClaw SRI 与 `openclawNpmIntegrity` 完全相等：

```js
const sha256 = /^[a-f0-9]{64}$/u;
for (const name of ["electron", "node"]) {
  if (!sha256.test(versions.windowsArtifacts?.[name]?.sha256 ?? "")) {
    throw new Error(`${name} Windows artifact SHA-256 is invalid`);
  }
}
assertEqual(
  versions.windowsArtifacts.openclaw.integrity,
  versions.openclawNpmIntegrity,
  "OpenClaw Windows artifact integrity",
);
```

- [ ] **Step 4: 运行测试并提交**

Run: `cd product && node --test scripts/verify-reproducibility.test.mjs && npm run verify:reproducible`

Expected: PASS。

```bash
git add product/runtime-versions.json product/scripts/verify-reproducibility.mjs product/scripts/verify-reproducibility.test.mjs
git commit -m "build: pin Windows runtime inputs"
```

### Task 2: 实现受控 runtime 归档获取器

**Files:**
- Create: `product/packaging/fetch-runtime-artifact.mjs`
- Create: `product/tests/packaging/fetch-runtime-artifact.test.mjs`

- [ ] **Step 1: 写本地 HTTPS 失败测试**

测试用本地 HTTPS fixture 覆盖成功下载、重定向、超限、SHA-256 错误和已存在输出：

```js
test("downloads one bounded artifact with exact SHA-256", async () => {
  const bytes = Buffer.from("pinned-windows-runtime");
  const output = join(await mkdtemp(join(tmpdir(), "uclaw-fetch-")), "artifact.zip");
  await fetchRuntimeArtifact({
    url: fixture.url("/artifact.zip"),
    output,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    maxBytes: 1024,
    trustedCa: fixture.ca,
  });
  assert.deepEqual(await readFile(output), bytes);
});

test("rejects redirect, overflow, digest mismatch and overwrite", async () => {
  await assert.rejects(fetchRuntimeArtifact(redirectOptions), /redirect/i);
  await assert.rejects(fetchRuntimeArtifact(overflowOptions), /size/i);
  await assert.rejects(fetchRuntimeArtifact(digestOptions), /SHA-256/i);
  await assert.rejects(fetchRuntimeArtifact(existingOptions), /already exists/i);
});
```

- [ ] **Step 2: 运行测试，确认模块缺失**

Run: `cd product && node --test tests/packaging/fetch-runtime-artifact.test.mjs`

Expected: FAIL，无法导入 `fetch-runtime-artifact.mjs`。

- [ ] **Step 3: 实现最小安全下载器**

实现导出：

```js
export async function fetchRuntimeArtifact({ url, output, sha256, maxBytes, trustedCa }) {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash) {
    throw new Error("runtime artifact URL must be credential-free HTTPS");
  }
  await requireMissing(output);
  const response = await requestWithoutRedirect(target, trustedCa);
  const temporary = `${output}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const actual = await writeBoundedAndHash(response, temporary, maxBytes);
    if (actual !== sha256) throw new Error("runtime artifact SHA-256 mismatch");
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
}
```

`requestWithoutRedirect` 只接受 `200`，拒绝所有 `3xx`；`writeBoundedAndHash` 流式计数，超过 `maxBytes` 立即销毁响应并删除临时文件。

- [ ] **Step 4: 验证并提交**

Run: `cd product && node --test tests/packaging/fetch-runtime-artifact.test.mjs`

Expected: PASS。

```bash
git add product/packaging/fetch-runtime-artifact.mjs product/tests/packaging/fetch-runtime-artifact.test.mjs
git commit -m "build: fetch verified runtime artifacts"
```

### Task 3: 锁定真实 Electron app 的生产依赖

**Files:**
- Create: `product/packaging/windows-runtime-app/package.json`
- Create: `product/packaging/windows-runtime-app/package-lock.json`
- Create: `product/tests/packaging/windows-runtime-dependencies.test.mjs`

- [ ] **Step 1: 写依赖闭包失败测试**

```js
test("locks the offline Windows app dependency closure", async () => {
  const manifest = JSON.parse(await readFile(manifestPath));
  const lock = JSON.parse(await readFile(lockPath));
  assert.equal(manifest.main, "desktop/dist/entry.js");
  assert.equal(manifest.dependencies.openclaw, "2026.7.1-2");
  assert.equal(lock.packages["node_modules/openclaw"].version, "2026.7.1-2");
  assert.equal(lock.packages["node_modules/openclaw"].integrity,
    "sha512-ycF3yPcbjN6bUPeaUx6Mh6vze1hQWoD3CT/wWcmD7a8xaHHHRUaAlaq+lFxMHf1ssEgODVAwjlzYqp2twkYZ7g==");
  for (const entry of Object.values(lock.packages)) {
    assert.equal(entry?.link, undefined);
  }
});
```

- [ ] **Step 2: 运行测试，确认文件缺失**

Run: `cd product && node --test tests/packaging/windows-runtime-dependencies.test.mjs`

Expected: FAIL，manifest 不存在。

- [ ] **Step 3: 创建固定 app manifest 和 lockfile**

`package.json` 使用：

```json
{
  "name": "@uclaw/windows-runtime-app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "desktop/dist/entry.js",
  "dependencies": {
    "@openclaw/fs-safe": "0.4.1",
    "jszip": "3.10.1",
    "openclaw": "2026.7.1-2",
    "semver": "7.8.5",
    "undici": "7.29.0",
    "zod": "4.4.3"
  }
}
```

Run: `cd product/packaging/windows-runtime-app && PATH=/tmp/uclaw-node-24.15.0/bin:$PATH npm install --package-lock-only --ignore-scripts`

Expected: 生成 lockfile；`openclaw` 版本和 SRI 与固定输入一致。

- [ ] **Step 4: 验证纯生产安装并提交**

Run: `cd product/packaging/windows-runtime-app && npm ci --omit=dev --ignore-scripts --os=win32 --cpu=x64 && npm ls --omit=dev`

Expected: exit 0，无 missing/invalid dependency。

```bash
git add product/packaging/windows-runtime-app product/tests/packaging/windows-runtime-dependencies.test.mjs
git commit -m "build: lock Windows app dependencies"
```

### Task 4: 组装真实 Windows runtime 目录

**Files:**
- Create: `product/packaging/build-windows-runtime.mjs`
- Create: `product/tests/packaging/windows-runtime.test.mjs`
- Modify: `product/package.json`

- [ ] **Step 1: 写组装器失败测试**

fixture 使用小型 ZIP 和生产目录骨架，不访问公网：

```js
test("assembles one complete offline Windows runtime", async () => {
  const result = await buildWindowsRuntime(fixture.options);
  for (const relative of [
    "electron/electron.exe",
    "electron/resources/app/package.json",
    "electron/resources/app/desktop/dist/entry.js",
    "electron/resources/app/frontend/dist/index.html",
    "electron/resources/app/node_modules/openclaw/openclaw.mjs",
    "node/node.exe",
  ]) assert.equal((await lstat(join(result.outputDir, relative))).isFile(), true);
  assert.equal(await hasSymlink(result.outputDir), false);
});

test("rejects missing builds, unsafe ZIP paths and a second Electron executable", async () => {
  await assert.rejects(buildWindowsRuntime(missingBuild), /Desktop build/i);
  await assert.rejects(buildWindowsRuntime(zipSlip), /unsafe archive path/i);
  await assert.rejects(buildWindowsRuntime(secondExe), /exactly one Electron executable/i);
});
```

- [ ] **Step 2: 运行测试，确认模块缺失**

Run: `cd product && node --test tests/packaging/windows-runtime.test.mjs`

Expected: FAIL，无法导入组装器。

- [ ] **Step 3: 实现确定性组装器**

导出固定接口：

```js
export async function buildWindowsRuntime({
  electronArchive, nodeArchive, appDependencyRoot,
  desktopRoot, frontendRoot, adapterRoot, sharedRoot, outputDir,
}) {
  await requireMissing(outputDir);
  const temporary = await mkdtemp(join(dirname(outputDir), ".windows-runtime-"));
  try {
    await extractZipStrict(electronArchive, join(temporary, "electron"));
    await extractNodeExe(nodeArchive, join(temporary, "node", "node.exe"));
    const appRoot = join(temporary, "electron", "resources", "app");
    await copyAppManifestAndDependencies(appDependencyRoot, appRoot);
    await copyWorkspaceBuild("desktop", desktopRoot, appRoot);
    await copyWorkspaceBuild("frontend", frontendRoot, appRoot);
    await copyWorkspaceBuild("adapter", adapterRoot, appRoot);
    await copyWorkspaceBuild("shared", sharedRoot, appRoot);
    await verifyWindowsRuntimeTree(temporary);
    await rename(temporary, outputDir);
    return { outputDir };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
```

所有复制使用 `lstat`，拒绝软链接、junction、设备文件和大小超过签名上限的树。ZIP 路径通过现有 `isSafeWindowsRelativePath()` 校验，拒绝绝对路径和 `..`。

- [ ] **Step 4: 添加 CLI 和 package script**

CLI 参数固定为 `--cache`、`--output`。脚本先执行 `npm run build`，再执行生产依赖 `npm ci --omit=dev --ignore-scripts --os=win32 --cpu=x64`，最后组装。

`package.json` 添加：

```json
"build:windows-runtime": "node packaging/build-windows-runtime.mjs"
```

- [ ] **Step 5: 验证并提交**

Run: `cd product && node --test tests/packaging/windows-runtime.test.mjs && npm run typecheck`

Expected: PASS。

```bash
git add product/packaging/build-windows-runtime.mjs product/tests/packaging/windows-runtime.test.mjs product/package.json
git commit -m "build: assemble real Windows runtime"
```

### Task 5: 让 Launcher 使用 runtime 内 Node 和 OpenClaw

**Files:**
- Modify: `product/launcher/process.go`
- Modify: `product/launcher/process_test.go`

- [ ] **Step 1: 写失败的路径注入测试**

```go
func TestNormalProcessSpecPinsRuntimeOwnedNodeAndOpenClaw(t *testing.T) {
	spec := NormalProcessSpec(paths, manifest, fixtureLease{root: runtimeRoot})
	want := map[string]string{
		"UCLAW_NODE_BIN": filepath.Join(runtimeRoot, "node", "node.exe"),
		"UCLAW_OPENCLAW_ENTRY": filepath.Join(runtimeRoot, "electron", "resources", "app", "node_modules", "openclaw", "openclaw.mjs"),
	}
	for key, value := range want {
		if !slices.Contains(spec.Env, key+"="+value) { t.Fatalf("missing %s", key) }
	}
}
```

另加测试确认 `ActivationProcessSpec` 不包含 `UCLAW_NODE_BIN` 和 `UCLAW_OPENCLAW_ENTRY`。

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd product/launcher && go test ./... -count=1`

Expected: FAIL，缺少两个环境变量。

- [ ] **Step 3: 最小实现固定布局注入**

在 `NormalProcessSpec` 使用 lease root 追加：

```go
runtimeRoot := lease.RootPath()
environment := append(portableProcessEnvironment(paths),
	"UCLAW_NODE_BIN="+filepath.Join(runtimeRoot, "node", "node.exe"),
	"UCLAW_OPENCLAW_ENTRY="+filepath.Join(runtimeRoot, "electron", "resources", "app", "node_modules", "openclaw", "openclaw.mjs"),
)
return processSpec(paths, manifest, lease, arguments, environment)
```

- [ ] **Step 4: 验证并提交**

Run: `cd product/launcher && go test ./... -count=1 && go test -race ./... -count=1 && go vet ./...`

Expected: 全部 exit 0。

```bash
git add product/launcher/process.go product/launcher/process_test.go
git commit -m "feat: launch bundled Node and OpenClaw"
```

### Task 6: 生成完整 runtime.pkg 和人工验收套件

**Files:**
- Create: `product/scripts/build-windows-validation-kit.mjs`
- Create: `product/scripts/build-windows-validation-kit.test.mjs`
- Modify: `product/package.json`

- [ ] **Step 1: 写失败的验收套件契约测试**

```js
test("validation kit requires the real Windows runtime", async () => {
  const source = await readFile(scriptUrl, "utf8");
  assert.match(source, /build-windows-runtime\.mjs/u);
  assert.doesNotMatch(source, /portable-runtime\.go/u);
  assert.match(source, /build-runtime\.mjs/u);
  assert.match(source, /build-update-feed\.mjs/u);
  assert.match(source, /build-offline-updater\.mjs/u);
});

test("handoff excludes every private key", async () => {
  const kit = await buildWindowsValidationKit(fixture);
  assert.deepEqual(await readdir(kit.handoffDir), [
    "README.txt", "U-Claw-Update-test.exe", "U-Claw-test-USB", "online-feed", "test-public.pem",
  ]);
  assert.equal((await scanPrivateKeyBlocks(kit.handoffDir)).length, 0);
});
```

- [ ] **Step 2: 运行测试，确认模块缺失**

Run: `cd product && node --test scripts/build-windows-validation-kit.test.mjs`

Expected: FAIL，脚本不存在。

- [ ] **Step 3: 实现套件编排器**

编排器必须：

1. 调用真实 `build:windows-runtime`。
2. 为 v1/v2 生成不同的完整 runtime.pkg。
3. 使用临时 Ed25519 密钥签名 runtime 和 feed。
4. 编译带测试公钥的 Launcher 与正式 UI 离线更新器。
5. 使用 `const token = randomBytes(32).toString("base64url")` 生成 Gateway token，并在初始 `.uclaw/data/.openclaw/openclaw.json` 写入：

```js
const workspace = path.join(dataDirectory, "workspace");
const config = {
  gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token } },
  agents: {
    defaults: { workspace, skipBootstrap: true },
    list: [{ id: "main", default: true, workspace }],
  },
};
await writeFile(configPath, `${JSON.stringify(config)}\n`, { flag: "wx", mode: 0o600 });
```

实际写入前将 workspace 转为 U 盘数据目录内绝对路径；token 只保存在 U 盘测试配置，不进入日志。交付目录不含任何私钥。

- [ ] **Step 4: 添加正式脚本入口并提交**

`package.json` 添加：

```json
"build:windows-validation-kit": "node scripts/build-windows-validation-kit.mjs"
```

Run: `cd product && node --test scripts/build-windows-validation-kit.test.mjs && npm run test:secrets`

Expected: PASS。

```bash
git add product/scripts/build-windows-validation-kit.mjs product/scripts/build-windows-validation-kit.test.mjs product/package.json
git commit -m "build: produce real Windows validation kit"
```

### Task 7: 写入真实 runtime 就绪证据

**Files:**
- Create: `product/desktop/src/runtime/readiness-signal.ts`
- Create: `product/desktop/tests/readiness-signal.test.ts`
- Modify: `product/desktop/src/main.ts`
- Modify: `product/desktop/tests/main.test.ts`

- [ ] **Step 1: 写失败的原子就绪证据测试**

```ts
it("atomically writes a path-free real runtime readiness record", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "uclaw-ready-"));
  await writeRuntimeReadiness(dataDir, {
    productVersion: "0.1.0",
    runtimeVersion: "2026.7.1-2",
    gatewayReady: true,
  });
  const value = JSON.parse(await readFile(join(dataDir, "diagnostics", "runtime-ready.json"), "utf8"));
  expect(value).toEqual({
    schemaVersion: 1,
    productVersion: "0.1.0",
    runtimeVersion: "2026.7.1-2",
    gatewayReady: true,
  });
  expect(JSON.stringify(value)).not.toContain(dataDir);
});
```

- [ ] **Step 2: 运行测试，确认模块缺失**

Run: `cd product && npm test -w @uclaw/desktop -- readiness-signal.test.ts`

Expected: FAIL，无法导入 `readiness-signal`。

- [ ] **Step 3: 实现原子写入并接入真实启动完成点**

```ts
export async function writeRuntimeReadiness(
  dataDir: string,
  value: { productVersion: string; runtimeVersion: string; gatewayReady: true },
): Promise<void> {
  const directory = join(dataDir, "diagnostics");
  await mkdir(directory, { recursive: true });
  const target = join(directory, "runtime-ready.json");
  const temporary = join(directory, `.runtime-ready-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, ...value })}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, target);
}
```

在 `startElectronMain()` 中保存 `runDesktopMain()` 返回的 window；只有 Gateway 能力探测、窗口创建和 IPC 注册全部完成且 window 非空时，才写入 `runtime-ready.json`。启动失败或 activation-only 路径不得写入。

- [ ] **Step 4: 验证并提交**

Run: `cd product && npm test -w @uclaw/desktop -- readiness-signal.test.ts main.test.ts && npm run typecheck -w @uclaw/desktop`

Expected: PASS。

```bash
git add product/desktop/src/runtime/readiness-signal.ts product/desktop/tests/readiness-signal.test.ts product/desktop/src/main.ts product/desktop/tests/main.test.ts
git commit -m "feat: record real runtime readiness"
```

### Task 8: 增加 Windows 真实 runtime 断网门禁

**Files:**
- Create: `product/tests/windows/real-runtime-smoke.ps1`
- Modify: `.github/workflows/portable-launcher.yml`
- Modify: `product/scripts/portable-launcher-workflow.test.mjs`

- [ ] **Step 1: 写失败的工作流契约测试**

```js
test("Windows CI launches the real runtime offline", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.match(workflow, /build:windows-runtime/u);
  assert.match(workflow, /real-runtime-smoke\.ps1/u);
  assert.match(workflow, /UCLAW_REAL_RUNTIME_READY/u);
  assert.match(workflow, /New-NetFirewallRule|network-disabled/u);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd product && npm run test:portable-launcher`

Expected: FAIL，工作流缺少真实 runtime 门禁。

- [ ] **Step 3: 实现 PowerShell smoke**

`real-runtime-smoke.ps1` 执行：

```powershell
$process = Start-Process -FilePath $LauncherExe -WorkingDirectory $UsbRoot -PassThru
try {
    $ready = Join-Path $UsbRoot '.uclaw\data\diagnostics\runtime-ready.json'
    for ($attempt = 0; $attempt -lt 120 -and -not (Test-Path -LiteralPath $ready); $attempt++) {
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-Path -LiteralPath $ready)) { throw 'UCLAW_REAL_RUNTIME_READY_TIMEOUT' }
    $diagnostic = Get-Content -LiteralPath $ready -Raw | ConvertFrom-Json
    if ($diagnostic.runtimeVersion -ne '2026.7.1-2' -or -not $diagnostic.gatewayReady) {
        throw 'UCLAW_REAL_RUNTIME_NOT_READY'
    }
}
finally {
    if (-not $process.HasExited) { $process.CloseMainWindow(); $process.WaitForExit(15000) }
    if (-not $process.HasExited) { $process.Kill() }
    $process.Dispose()
}
```

CI 在启动前阻断测试进程的外网访问或使用 runner 防火墙规则，结束时在 `finally` 删除规则。诊断只含版本、布尔状态和固定错误码。

- [ ] **Step 4: 更新工作流并验证**

工作流先构建真实 validation kit，再运行 PowerShell 5.1 和 7 smoke；原 fixture 生命周期仍单独运行。

Run: `cd product && npm run test:portable-launcher && npm run test:update-packaging`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add .github/workflows/portable-launcher.yml product/tests/windows/real-runtime-smoke.ps1 product/scripts/portable-launcher-workflow.test.mjs
git commit -m "ci: gate real Windows runtime startup"
```

### Task 9: 完整验证、生成 U 盘并执行真实验收

**Files:**
- Modify: `deploy/updates/README.md`
- Modify: `docs/superpowers/specs/2026-08-17-U-Claw真实Windows运行时设计.md`
- Modify: `docs/superpowers/specs/2026-08-14-U-Claw在线与离线更新设计.md`

- [ ] **Step 1: 运行完整本地门禁**

```bash
cd product
PATH=/tmp/uclaw-node-24.15.0/bin:$PATH npm run build
PATH=/tmp/uclaw-node-24.15.0/bin:$PATH npm run typecheck
PATH=/tmp/uclaw-node-24.15.0/bin:$PATH npm test
PATH=/tmp/uclaw-node-24.15.0/bin:$PATH npm run test:secrets
PATH=/tmp/uclaw-node-24.15.0/bin:$PATH npm run build:windows-runtime -- --cache .runtime-cache --output .real-runtime
cd launcher && go test -race ./... -count=1 && go vet ./...
cd ../offline-updater && go test -race ./... -count=1 && go vet ./...
```

Expected: 全部 exit 0；`.real-runtime` 通过真实入口和无软链接检查。

- [ ] **Step 2: 推送功能分支并等待 Windows CI**

Run: `git push origin codex/online-offline-updates`

Expected: Windows fixture 生命周期和真实 runtime 断网 smoke 全绿。

- [ ] **Step 3: 使用临时测试密钥生成新套件**

Run:

```bash
cd product
npm run build:windows-validation-kit -- \
  --cache .runtime-cache \
  --output ../outputs/windows-validation-$(date +%Y%m%d-%H%M%S)
```

Expected: 输出初始 U 盘目录、在线 feed、离线 EXE、公钥和 README；secret scan 确认无私钥。

- [ ] **Step 4: 清空并复制到唯一外接 U 盘**

先用 `diskutil list external physical` 确认唯一目标。仅在设备号、容量和用户声明一致后执行：

```bash
diskutil eraseDisk ExFAT UCLAW MBRFormat /dev/diskN
cp -R ../outputs/windows-validation-*/U-Claw-test-USB/. /Volumes/UCLAW/
cp ../outputs/windows-validation-*/U-Claw-Update-test.exe /Volumes/UCLAW/
sync
diskutil eject /dev/diskN
```

`/dev/diskN` 必须替换为只读检查得到的精确外接物理盘，禁止使用通配设备号或环境变量。

- [ ] **Step 5: Windows 物理验收**

在 Win10/11 x64 普通用户、Defender 开启、断网状态：

1. 双击 U 盘根目录 `U-Claw.exe`。
2. 确认真实 U-Claw 界面和本地 Gateway 就绪。
3. 关闭客户端，运行 `U-Claw-Update-test.exe`。
4. 再次启动并确认版本升级。
5. 比较 `.uclaw/license`、启动凭据和 `.uclaw/data` 保护文件哈希不变。
6. 确认无提权提示、无 Defender 放行要求。
7. 更换 USB 接口和另一台 Windows 主机重复。

- [ ] **Step 6: 收口文档并提交**

只有本地门禁、Windows CI 和物理验收全部通过后，将两份设计状态更新为 `已确认，实施完成`，并在部署 README 记录真实 runtime 发布命令。

```bash
git add deploy/updates/README.md docs/superpowers/specs/2026-08-17-U-Claw真实Windows运行时设计.md docs/superpowers/specs/2026-08-14-U-Claw在线与离线更新设计.md
git commit -m "docs: complete real Windows runtime acceptance"
```

- [ ] **Step 7: 合并前最终检查**

Run: `git status --short && git log --oneline main..HEAD`

Expected: worktree 干净；真实运行时相关提交完整；无私钥、缓存、runtime 归档或测试授权被 Git 跟踪。只有此时才进入合并 `main` 流程。
