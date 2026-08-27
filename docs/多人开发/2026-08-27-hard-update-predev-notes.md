# hard-update + package-policy 预开发说明

- 日期：2026-08-27
- 分支：`codex/hard-update-prep`
- 范围：`u-claw-app-dev`、`docs`
- 状态：mock 开发；真实 R2 / DNS / 反代 / 私钥后续替换

## 已冻结输入

```text
生产入口固定：https://yiyong.me/uclaw/releases/production.json
视频入口保留：https://video-adapter.gmnlee.com/xai/v1
R2 只做 placeholder/mock。
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
CLOUDFLARE_ACCOUNT_ID
UCLAW_R2_BUCKET
UCLAW_R2_ENDPOINT
UCLAW_R2_ACCESS_KEY_ID
UCLAW_R2_SECRET_ACCESS_KEY
CLOUDFLARE_API_TOKEN
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
