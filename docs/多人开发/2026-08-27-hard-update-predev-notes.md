# hard-update + package-policy 预开发说明

- 日期：2026-08-27
- 分支：`codex/hard-update-prep`
- 范围：`u-claw-app-dev`、`docs`
- 状态：mock 开发；R2 账号已创建；真实阿里云 update check / 私钥后续替换

## 已冻结输入

```text
生产控制入口固定：https://yiyong.me/uclaw/releases/production.json 或阿里云 update check API
视频入口保留：https://video-adapter.gmnlee.com/xai/v1
硬更新采用方案 C：阿里云 update check 返回 R2 下载地址。
R2 staging/prod 已创建；Phase 1 先接 staging。
远程更新包不包含 data/。
远程更新不改 openclaw.json、auth_profile_store、license、memory、logs。
旧盘 key 不修复。
新盘 key 后续由激活链路写入。
```

## 新增 mock 能力

```text
scripts/hard-update-package.js
  从 portable stage 生成 packages/v<version>/<platform>/runtime.pkg。
  平台：win32-x64、darwin-arm64、darwin-x64。
  产物：runtime.pkg、runtime.pkg.sha256、manifest.json、sbom.json、production.json。
  使用 Ed25519 mock key 签名 production.json / manifest.json。
  release 目录只放公钥，不放私钥。

scripts/hard-update-client.js
  Launcher 侧 skeleton。
  读取 production.json mock。
  按平台选择 manifest。
  验签、sha256、size、treeDigest。
  解包拒绝 data/、..、绝对路径、symlink、openclaw.json、*.env、*.key。
  写 update-transaction.json、update-shutdown-request.json、shutdown-complete.json、run-state.json。
  mock 安装后写 app/version.json。
  mock 删除 cache stamp。

scripts/updater/
  Go updater skeleton。
  CLI：--root、--transaction、--dry-run。
  只替换 app/、bootstrap/、launcher、启动脚本、说明。
  禁止 data/、openclaw.json、auth_profile_store。
  kill 只读取 run-state pid；不按进程名全局杀。

scripts/verify-hard-update-mock.js
  package-policy + hard-update mock 验收。
```

## 真实阶段需要填写

```text
R2_ACCOUNT_ID
R2_ENDPOINT
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_STAGING_BUCKET
R2_STAGING_PUBLIC_URL
R2_PROD_BUCKET
R2_PROD_PUBLIC_URL
CLOUDFLARE_ACCOUNT_API_TOKEN
CLOUDFLARE_ZONE_ID
UCLAW_WORKER_NAME
UCLAW_RELEASES_ROUTE
ALIYUN_LICENSE_API_BASE
ALIYUN_DEPLOY_HOST
HK_VIDEO_ADAPTER_HOST
UCLAW_RELEASE_KEY_ID
UCLAW_RELEASE_PRIVATE_KEY_PATH
UCLAW_RELEASE_PUBLIC_KEYS_PATH
```

当前本机私密配置：

```text
u-claw-app-dev/.env
```

规则：

```text
.env 不进 git。
不要打印 R2_SECRET_ACCESS_KEY。
不要把 R2 Access Key / Secret Key / Cloudflare API Token 写入代码、manifest、客户端包或 U 盘包。
上传脚本可兼容旧 UCLAW_R2_* 变量，但首选读取 R2_*。
```

当前 R2：

```text
R2_ACCOUNT_ID=370da95abc067c1a2decfbb41fe21f86
R2_ENDPOINT=https://370da95abc067c1a2decfbb41fe21f86.r2.cloudflarestorage.com
R2_STAGING_BUCKET=u-claw-updates-staging
R2_STAGING_PUBLIC_URL=https://pub-8289f643846848528b61bfd5dbf17e43.r2.dev
R2_PROD_BUCKET=u-claw-updates-prod
R2_PROD_PUBLIC_URL=https://pub-4f24fbbe718b4c75955440700c70bdeb.r2.dev
```

## 不并入 launcher-startup-hotfix 的内容

```text
hard-update-package.js
hard-update-client.js
scripts/lib/release-signing.js
scripts/lib/hard-update-utils.js
scripts/updater/
deploy/hard-update.deploy.template.env
远程发布/R2/签名/事务/更新安装逻辑
```

launcher-startup-hotfix 可只消费协议文件名和 run-state 约定，不应合并发布包生成、R2、签名私钥、updater 替换层。

## 2026-08-28 Phase 1 staging 补充

新增：

```text
scripts/hard-update-upload-r2.js
  从 u-claw-app-dev/.env 读取 R2 配置。
  首选 R2_*，兼容 UCLAW_R2_*。
  使用 R2 S3 API 上传 release。
  上传 releases/bootstrap/release-public-keys.json。
  上传 releases/packages/<releaseId>/<platformKey>/runtime.pkg / runtime.pkg.sha256 / sbom.json / manifest.json。
  最后上传 releases/production.json。
  不打印 R2_SECRET_ACCESS_KEY。

scripts/hard-update-client.js
  保留 --release 本地 mock。
  支持 --production-url 直连 HTTP/R2 mock。
  未传 --release、--production-url、--update-check-url 时，默认直连 R2 staging production.json：
  https://pub-8289f643846848528b61bfd5dbf17e43.r2.dev/releases/production.json
  HTTP 下载后仍做 production 签名、manifest 签名、manifestSha256、runtime sha256、size、treeDigest、路径安全校验。
  2026-08-29 已新增 startup-update / apply-startup-update：
  - startup-update 供双端启动脚本调用，只下载、验签、校验并 staging。
  - 返回码 20 表示更新已 staging，启动脚本应退出当前 launcher 并交给后台 apply。
  - apply-startup-update 等待 launcher PID 退出后替换 app/bootstrap/launcher/启动脚本/说明。
  - startup-update 默认直连 R2 staging production.json，比对版本后无条件更新程序层。
  - startup-update 不读取激活凭据，不等待激活接口，不依赖 deviceId/deviceToken。
  - update check 鉴权仅保留给显式 --update-check-url 的控制面/回归验证路径。
  - 日志不打印 deviceToken 或 secret。

scripts/hard-update-check-mock.js
  只输出阿里云 update check 契约 mock。
  不连接阿里云。
  不保存 VPS 密码。
  明确阿里云只做控制面，R2 承载 runtime.pkg 下载。

scripts/hard-update-release-key.js
  生成本机离线 Ed25519 release signing key。
  当前本机副本：u-claw-app-dev/release/.release-signing/release-signing-key.json。
  当前发布管理员 U 盘副本：/Volumes/发布管理员U盘/U-Claw-Release-Secrets/release-signing-key.json。
  .env 只保存 UCLAW_RELEASE_PRIVATE_KEY_PATH 等路径变量。
  私钥不进 git、不进包、不进 manifest、不进文档。
  公钥进入 releases/bootstrap/release-public-keys.json。

scripts/publish-hard-update-release.js
  一键执行 create -> verify -> upload R2。
  staging 可直接发布。
  prod 必须显式传 --confirm-prod。
  可选 --deploy-control 部署 update check 控制面。
```

新增 runbook：

```text
docs/多人开发/2026-08-28-R2-staging-hard-update-runbook.md
```

远端验证：

```text
阿里云 121.41.89.103 已安装 Node 18。
/opt/uclaw-update 已部署控制面服务。
systemd: uclaw-update.service active。
Caddy: updates.yiyong.me 增加 /uclaw/update/check 和 /healthz 反代到 127.0.0.1:18080。
公网 https://updates.yiyong.me/healthz 通过。
公网 https://updates.yiyong.me/uclaw/update/check 返回 v1.0.0 R2 staging manifestUrl/packageUrl。
客户端通过 update check 域名拉 R2 包，验签、sha256、size、treeDigest、data hash preserve 均通过。
2026-08-29 更新：真实激活 staging 数据库已接入 update check。
uclaw_activation_staging32 已有 activation_inventory/devices/licenses/device_access_tokens 测试链各 1 行。
update check 输入固定为 Authorization: Bearer <device_token> + deviceId。
服务端按 token sha256 bytea、license/device/inventory active、license 时间窗做真实查库。
有效 staging token 返回 allowed=true；缺 token 和错 token 均拒绝。
当前 /srv/uclaw-staging32/config/activation.env 的 app 用户 DATABASE_URL 认证失败；本轮控制面用本机 postgres socket 查 staging32，正式上线前建议修复 app 用户凭证并切只读账号。
```

## 2026-08-29 双端启动入口补充

```text
package.json electron-builder files 已包含：
- scripts/hard-update-client.js
- scripts/lib/hard-update-utils.js
- scripts/lib/release-signing.js
```

启动链路：

```text
Windows:
U-Claw Launcher.exe
-> Windows-Start-App.bat
-> 安装/复用本机 app cache
-> bundled node.exe 调 hard-update-client.js startup-update
-> 无更新：继续准备 runtime data 并启动 U-Claw.exe
-> 有更新：写 app/update-transaction.json 和 app/.update-staging/
-> 后台 apply-startup-update 等 launcher PID 退出
-> 替换程序层、写 app/version.json、删除本机 cache stamp、重启 U-Claw Launcher.exe

macOS:
U-Claw Launcher.app
-> 内嵌/落地 Mac-Start-App.command
-> 安装/复用本机 app cache
-> bundled node 调 hard-update-client.js startup-update
-> 无更新：继续准备 runtime data 并启动 U-Claw.app/Contents/MacOS/U-Claw
-> 有更新：后台 apply-startup-update 等 launcher PID 退出
-> 替换程序层、写 app/version.json、删除本机 cache stamp、open -n U-Claw Launcher.app
```

当前边界：

```text
本轮接的是启动入口自动执行，不做最终 U 盘打包。
默认启动硬更新仍是 staging R2: https://pub-8289f643846848528b61bfd5dbf17e43.r2.dev/releases/production.json。
update check 控制面只用于显式回归；prod 默认入口仍需上线前切换确认。
Windows 当前在 macOS 上只能做脚本与 mock 验证；真机双击需回 Windows 验收。
```

## 2026-08-30 域名收口待办

```text
用户确认：
- api.gmnlee.com 必须全量清除。
- video-adapter.gmnlee.com 也必须全量清除。
- 视频链路已有独立 worktree 处理，目标部署到 64 前置机 VPS。
- 当前硬更新 worktree 已将文本/图片默认 New API 指向 https://api.yiyong.me/v1。
- 当前仍有旧 gmnlee 域名残留，包含历史文档、mock 测试、视频 adapter 默认值等。

后续冻结/合并前要求：
- 统一替换运行代码、默认配置、mock、打包脚本中的 api.gmnlee.com / video-adapter.gmnlee.com。
- 文档中如保留历史记录，必须明确标注为旧域名，不得作为当前配置。
- 合并视频 worktree 后，以 64 前置机上的新视频 adapter 域名/路径为准。
```
