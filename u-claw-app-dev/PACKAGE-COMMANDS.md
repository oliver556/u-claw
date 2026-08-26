# U-Claw `package.json` 命令说明

> 适用目录：`u-claw-app-dev`  
> 正式开发、构建和打包只能在该目录执行。  
> `u-claw-app` 和 `product` 是归档目录，禁止在其中开发或打包。

## 1. 最常用的 4 条命令

```bash
cd /Users/jamison/Document/300_学习/320_code/390_ai_agent/u-claw/u-claw-app-dev

# 日常开发
npm run dev

# 视频链路调试（与 npm run dev 相同，保留专用入口）
npm run dev:video

# 正式客户便携版 + 部署 U 盘
npm run package:portable:customer -- --usb /Volumes/UCLAW-01

# 正式主播/内部便携版 + 部署 U 盘
npm run package:portable:streamer -- --usb /Volumes/UCLAW-01
```

如果不确定该用哪条，只看这一节。

## 2. 命令速查

| 命令 | 用途 | 会不会交付 U 盘 |
|---|---|---|
| `npm run dev` | 启动开发桌面端 | 不会 |
| `npm run dev:video` | 启动开发桌面端，用于视频链路调试 | 不会 |
| `npm run start` | 不带 `--dev` 标记启动本地 Electron | 不会 |
| `npm run sync:config` | 同步桌面/便携配置 | 只有指定 `--usb` 才会 |
| `npm run package:portable:customer` | 生成客户便携版 | 指定 `--usb` 才会 |
| `npm run package:portable:streamer` | 生成主播/内部便携版 | 指定 `--usb` 才会 |
| `npm run build:mac-arm64` | 只做 Mac Apple Silicon 构建排查 | 不会 |
| `npm run build:mac-x64` | 只做 Mac Intel 构建排查 | 不会 |
| `npm run build:win` | 只做 Windows 构建排查 | 不会 |
| `npm run build:all` | 同时做 Mac/Windows 构建排查，很慢 | 不会 |
| `npm run patch-openclaw` | 重新应用 OpenClaw 本地补丁 | 不会 |
| `npm run sync-lib` | 同步共享 UI/资源到桌面开发目录 | 不会 |
| `npm run prepare-build` | 旧 `build:*` 的构建前准备 | 不会 |
| `npm run postinstall` | npm 安装依赖后的自动步骤 | 不会 |

## 3. 开发启动命令

### `npm run dev`

执行顺序：

```txt
patch-openclaw
-> sync-lib
-> electron . --dev
```

用于日常开发。会启动本机 video adapter，默认从 `127.0.0.1:18808` 开始选端口。

### `npm run dev:video`

```txt
dev:video -> npm run dev
```

这是为了保留明确的视频调试入口。它不会注入公网 adapter，不会设置 `UCLAW_VIDEO_PROVIDER=volcengine`。

正确视频链路：

```txt
OpenClaw -> 本机 adapter -> New API -> 服务器 adapter -> 即梦
```

### `npm run start`

与 `dev` 的准备流程相同，但最后执行 `electron .`，不带 `--dev`。主要用于检查本地非 dev 启动行为，不是 U 盘交付命令。

## 4. 配置同步命令

### 默认同步

```bash
npm run sync:config
```

作用：

```txt
从当前桌面配置读取 New API key
写入大小写两套桌面配置
写入大小写两套本机便携缓存配置
```

注意：默认命令会继承真实 key，不能用它生成客户空配置。

### 只同步桌面配置

```bash
npm run sync:config -- --desktop
```

### 只同步本机便携缓存

```bash
npm run sync:config -- --portable-cache
```

### 生成客户空配置

```bash
npm run sync:config -- --customer --dest /absolute/path/openclaw.json
```

强制要求：

```txt
custom.apiKey = 空
litellm.apiKey = 空
xai.baseUrl = https://video-adapter.gmnlee.com/xai/v1
xai.apiKey = uclaw-video-adapter
```

`--customer` 必须指定 `--dest` 或 `--usb`，防止误清空桌面 key。

### 生成主播/内部配置

```bash
npm run sync:config -- --streamer --dest /absolute/path/openclaw.json
npm run sync:config -- --streamer --usb /Volumes/UCLAW-01
```

强制要求：

```txt
custom.apiKey = 自动继承桌面 New API key
litellm.apiKey = 自动继承桌面 New API key
xai.baseUrl = https://video-adapter.gmnlee.com/xai/v1
xai.apiKey = uclaw-video-adapter
```

读不到真实 New API key 时，`--streamer` 会直接失败，不生成假主播版。

### 高级参数

```txt
--source <path>          指定额外的 openclaw.json key 来源
--new-api-key <key>      手工覆盖 New API key
--new-api-base-url <url> 手工覆盖 New API 地址
--video-base-url <url>   手工覆盖视频 adapter 地址
--video-api-key <key>    手工覆盖视频 adapter token
--dest <path>            写入指定配置文件
--usb <mount>            写入 <mount>/U-Claw/data/.openclaw/openclaw.json
```

正常打包不要手工使用 `--new-api-*` 或 `--video-*`。正式版本由 `package:portable:*` 固定地址和 key 职责。

## 5. 正式便携版命令

### 客户版

```bash
npm run package:portable:customer -- --usb /Volumes/UCLAW-01
```

完成：

```txt
重新构建 Mac arm64 app
重新构建 Mac x64 app
重新构建 Windows x64 app
生成 Mac arm64 tar.gz + SHA-256 manifest
生成 Mac x64 tar.gz + SHA-256 manifest
生成 Windows zip + SHA-256 manifest
生成 New API key 为空的客户 openclaw.json
生成 release/portable-customer/U-Claw
备份 U 盘旧官方文件
写入 U 盘并校验 SHA-256
```

打包时会按平台裁剪 Node runtime：

```txt
Mac arm64 包只保留 node-darwin-arm64
Mac x64 包只保留 node-darwin-x64
Windows 包只保留 node-win32-x64
旧 runtime 备份和其他平台 runtime 不进入交付包
```

Mac 启动脚本必须按宿主机架构选择归档：

```txt
arm64  -> u-claw-app-mac-arm64.tar.gz
x86_64 -> u-claw-app-mac-x64.tar.gz
```

两套 Mac App 缓存必须分开：

```txt
~/Library/Caches/U-Claw/u-claw-app-mac-arm64
~/Library/Caches/U-Claw/u-claw-app-mac-x64
```

Windows 首次启动：

```txt
校验 Windows zip SHA-256
优先用系统 tar.exe 解压到 %LOCALAPPDATA%\U-Claw\usb-portable\app-win-x64
每 5 秒输出一次已用时间
仅首次或包版本变化时解压；后续直接复用电脑缓存
```

因此首次启动仍比后续慢，但不会长期停在 PowerShell `Expand-Archive` 的 0% 界面。若压缩包损坏，会明确报 SHA-256 不匹配。

### 主播/内部版

```bash
npm run package:portable:streamer -- --usb /Volumes/UCLAW-01
```

流程与客户版相同，但 `custom/litellm` 自动继承当前桌面 New API key。

主播/内部版同样必须同时携带 Mac arm64、Mac x64 和 Windows x64 三套 App 归档。

### 只生成 stage，不写 U 盘

```bash
npm run package:portable:customer
npm run package:portable:streamer
```

输出：

```txt
release/portable-customer/U-Claw
release/portable-streamer/U-Claw
```

### `--skip-build`

```bash
npm run package:portable:streamer -- --skip-build --usb /Volumes/UCLAW-01
```

仅在“刚刚已经构建成功，只调试组装/部署脚本”时使用。

正式交付禁止使用 `--skip-build`，否则可能重用旧产物。

## 6. `build:*` 命令

```bash
npm run build:mac
npm run build:mac-arm64
npm run build:mac-x64
npm run build:win
npm run build:all
```

这些命令用于单平台构建排查、DMG/NSIS 调试。它们不生成完整的便携 U 盘目录，不区分客户/主播版，也不会自动部署 U 盘。

因此：

```txt
能构建 != 已完成便携版交付
有 DMG/EXE != U 盘版已正确
```

正式 U 盘只用 `package:portable:customer` 或 `package:portable:streamer`。

## 7. 内部命令

### `npm run patch-openclaw`

重新将 `scripts/patch-openclaw.js` 中的补丁应用到 `node_modules/openclaw`。包括 xAI 视频 provider 仅允许访问 `127.0.0.1:<port>` 的 SSRF 精准放行。

日常不需要单独运行；`dev`、`start`、`package:portable:*` 都会自动运行。

### `npm run sync-lib`

将共享资源同步到当前桌面开发目录。日常不需要单独运行。

### `npm run prepare-build`

旧 `build:*` 的构建前步骤：

```txt
patch-openclaw -> sync-lib -> sync:config
```

`sync:config` 默认会继承真实 key，所以 `prepare-build` 不用于区分客户/主播交付。

### `npm run postinstall`

`npm install` 后自动执行：

```txt
electron-builder install-app-deps
-> patch-openclaw
```

一般不需要手工执行。

## 8. 第一次准备环境

```bash
cd <repo>/u-claw-app-dev
bash setup.sh
```

`setup.sh` 检查 Node.js、安装 npm 依赖、准备打包 runtime。同一台开发机通常只在初次环境准备或依赖损坏时运行。

## 9. 选择命令的最短决策

```txt
我要开发界面/功能
  -> npm run dev

我要测试视频
  -> npm run dev:video

我要交付给客户
  -> npm run package:portable:customer -- --usb <U盘根目录>

我要交付主播/内部版
  -> npm run package:portable:streamer -- --usb <U盘根目录>

我只想看 Mac/Windows 能不能构建
  -> build:mac-* / build:win

我只想修正某个 openclaw.json
  -> sync:config + 明确的 --customer/--streamer + --dest/--usb
```

## 10. 禁止事项

```txt
禁止用 build:* 代替正式便携版总命令。
禁止看到 DMG/EXE 就手工复制到 U 盘并宣布交付完成。
禁止用默认 sync:config 生成客户空配置。
禁止正式交付使用 --skip-build。
禁止手工把真实 key 写进模板、文档或源码。
禁止将 providers.xai.baseUrl 改成 New API。
禁止在桌面/便携版设置 UCLAW_VIDEO_PROVIDER=volcengine。
```

## 11. 相关文档

```txt
../docs/多人开发/开发硬性要求.md
../docs/多人开发/视频请求链路与模型扩展冻结说明.md
../docs/多人开发/便携版固定打包命令与版本矩阵.md
```
