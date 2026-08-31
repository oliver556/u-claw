# U-Claw R2 staging hard update runbook

- 日期：2026-08-28
- 范围：方案 C / Phase 1 staging
- 状态：历史归档；2026-08-31 起不再作为正式发布入口

> 2026-08-31 更新：R2 发布链路已废弃。正式发布改用 64 前置机静态目录：
> `64.90.19.251:24851`、`/srv/uclaw-updates/releases`、
> `https://download.yiyong.me/uclaw/releases/production.json`。
> 当前正式脚本为 `scripts/hard-update-upload-front64.js` 和
> `scripts/publish-hard-update-release.js`。
> 本文只保留历史验收记录，不再用于发版。

## 1. 职责

```text
阿里云 update check API:
- license/device/version/gray/forceUpdate 判断
- 返回 requiredVersion / forceUpdate / manifestUrl / packageUrl / shortConfig
- 只做控制面
- 不转发 runtime.pkg 大文件

Cloudflare R2:
- 只放静态发布物
- production.json / release-public-keys.json / manifest.json / runtime.pkg / runtime.pkg.sha256 / sbom.json
- 不做 license/device 鉴权
- 不保存 New API key、R2 secret、Cloudflare token

香港网络优化机:
- 只用于 New API / video adapter
- 不参与硬更新主链路
```

## 1.1 2026-08-28 当前决策

```text
1. 域名：
   updates.yiyong.me -> 阿里云 121.41.89.103。
   update check 控制面入口为 https://updates.yiyong.me/uclaw/update/check。
   双端启动入口默认直连 R2 staging production.json，不依赖激活鉴权。

2. update 后端：
   U-Claw 自研控制面。
   部署在阿里云 121.41.89.103。

3. R2 下载：
   update check 返回 R2 manifestUrl/packageUrl。
   staging 实际下载入口：
   https://pub-8289f643846848528b61bfd5dbf17e43.r2.dev/releases/production.json

4. 灰度：
   Phase 1 全量强制。
   allowed license/device 且 installedVersion != requiredVersion 时 forceUpdate=true。

5. prod 发布：
   staging 先验收。
   人工确认后发 prod。
   production.json 最后发布。
   版本不可覆盖；发错包只能发新版本。

6. 短期 token：
   Phase 2 协议已预留，但当前未启用。
   规则定为不设置到期时间；响应使用 tokenExpiresAt: null。
   只给运行期 New API / video adapter 用。
   硬更新包永远不带 token。

7. release signing key：
   Ed25519 私钥保留两份。
   本机副本：
   u-claw-app-dev/release/.release-signing/release-signing-key.json
   发布管理员 U 盘副本：
   /Volumes/发布管理员U盘/U-Claw-Release-Secrets/release-signing-key.json
   私钥当前放在发布管理员 U 盘：
   /Volumes/发布管理员U盘/U-Claw-Release-Secrets/release-signing-key.json
   私钥路径写入 u-claw-app-dev/.env。
   私钥不进 git、不进包、不进 manifest、不进文档。
   公钥发布到 releases/bootstrap/release-public-keys.json。
```

## 2. R2 bucket

```text
staging bucket: u-claw-updates-staging
staging public URL: https://pub-8289f643846848528b61bfd5dbf17e43.r2.dev

prod bucket: u-claw-updates-prod
prod public URL: https://pub-4f24fbbe718b4c75955440700c70bdeb.r2.dev

endpoint: https://370da95abc067c1a2decfbb41fe21f86.r2.cloudflarestorage.com
account id: 370da95abc067c1a2decfbb41fe21f86
```

对象路径固定在 bucket 根：

```text
releases/production.json
releases/bootstrap/release-public-keys.json
releases/packages/<releaseId>/<platformKey>/manifest.json
releases/packages/<releaseId>/<platformKey>/runtime.pkg
releases/packages/<releaseId>/<platformKey>/runtime.pkg.sha256
releases/packages/<releaseId>/<platformKey>/sbom.json
```

不要额外加 `uclaw/` 前缀，除非未来阿里云/yiyong.me 路由显式要求。

## 3. .env

本机私密文件：

```text
u-claw-app-dev/.env
```

首选变量：

```text
R2_ACCOUNT_ID=
R2_ENDPOINT=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_STAGING_BUCKET=
R2_STAGING_PUBLIC_URL=
R2_PROD_BUCKET=
R2_PROD_PUBLIC_URL=
```

兼容旧变量：

```text
UCLAW_R2_ENDPOINT=
UCLAW_R2_ACCESS_KEY_ID=
UCLAW_R2_SECRET_ACCESS_KEY=
UCLAW_R2_BUCKET=
UCLAW_R2_PUBLIC_URL=
```

规则：

```text
.env 不进 git。
脚本不能打印 R2_SECRET_ACCESS_KEY。
secret 不进代码。
secret 不进 production.json / manifest.json / sbom.json。
secret 不进 U 盘包。
secret 不进文档。
```

## 4. staging 发布命令

首次生成真实 release signing key：

```bash
cd u-claw-app-dev
node scripts/hard-update-release-key.js create \
  --env .env \
  --key-file release/.release-signing/release-signing-key.json \
  --out release/bootstrap/release-public-keys.json
```

约定：

```text
本机副本放 u-claw-app-dev/release/.release-signing/release-signing-key.json。
发布管理员 U 盘副本放 /Volumes/发布管理员U盘/U-Claw-Release-Secrets/release-signing-key.json。
release/ 已被 git ignore。
.env 写入 UCLAW_RELEASE_KEY_ID / UCLAW_RELEASE_PRIVATE_KEY_PATH / UCLAW_RELEASE_PUBLIC_KEYS_PATH。
脚本不打印私钥内容。
公钥随每次 hard-update-package 输出到 releases/bootstrap/release-public-keys.json。
```

当前本机副本和 U 盘副本都已存在，keyId：

```text
uclaw-release-2026-08-28
```

先生成 release，base URL 必须用 staging R2 public URL：

```bash
cd u-claw-app-dev
node scripts/hard-update-package.js create \
  --stage release/portable-customer/U-Claw \
  --out release/mock-hard-update \
  --version <未发布过的新版本> \
  --base-url https://pub-8289f643846848528b61bfd5dbf17e43.r2.dev/releases \
  --env .env
```

再本地校验：

```bash
node scripts/hard-update-package.js verify --release release/mock-hard-update
node scripts/verify-hard-update-mock.js
```

先上传不可变发布物：

```bash
node scripts/hard-update-upload-r2.js \
  --release release/mock-hard-update \
  --env .env \
  --channel staging \
  --skip-production
```

控制面已部署为同一 release 后，最后切换 production 指针：

```bash
node scripts/hard-update-upload-r2.js \
  --release release/mock-hard-update \
  --env .env \
  --channel staging \
  --only-production
```

本次完整构建使用 `v1.0.1`。R2 原有 `v1.0.0` 与本次构建内容不同，因此按版本不可变规则保留，不覆盖。

手动 staging 发布示例：

```bash
cd /Users/jamison/Document/300_学习/320_code/390_ai_agent/u-claw-worktrees/hard-update-prep/u-claw-app-dev

node scripts/hard-update-package.js create \
  --stage release/portable-customer/U-Claw \
  --out release/staging-v1.0.1 \
  --version 1.0.1 \
  --base-url https://pub-8289f643846848528b61bfd5dbf17e43.r2.dev/releases \
  --env .env

node scripts/hard-update-package.js verify --release release/staging-v1.0.1

node scripts/hard-update-upload-r2.js \
  --release release/staging-v1.0.1 \
  --env .env \
  --channel staging \
  --skip-production
```

待控制面部署到 `release/staging-v1.0.1` 后：

```bash
node scripts/hard-update-upload-r2.js \
  --release release/staging-v1.0.1 \
  --env .env \
  --channel staging \
  --only-production
```

一键发布 staging（仅用于有阿里云部署权限的发布管理员）：

```bash
cd /Users/jamison/Document/300_学习/320_code/390_ai_agent/u-claw-worktrees/hard-update-prep/u-claw-app-dev

node scripts/publish-hard-update-release.js \
  --stage release/portable-customer/U-Claw \
  --version <未发布过的新版本> \
  --channel staging \
  --deploy-control
```

prod 发布必须显式确认：

```bash
cd /Users/jamison/Document/300_学习/320_code/390_ai_agent/u-claw-worktrees/hard-update-prep/u-claw-app-dev

node scripts/publish-hard-update-release.js \
  --stage release/portable-customer/U-Claw \
  --version <未发布过的新版本> \
  --channel prod \
  --confirm-prod
```

prod 不会默认发布。缺 `--confirm-prod` 时脚本必须失败。

部署 update check 控制面：

```bash
cd /Users/jamison/Document/300_学习/320_code/390_ai_agent/u-claw-worktrees/hard-update-prep/u-claw-app-dev
bash scripts/deploy-hard-update-control-plane.sh
```

验收命令：

```bash
curl -sS https://updates.yiyong.me/healthz

UCLAW_UPDATE_DEVICE_TOKEN='<通过安全通道取得的 device token>' \
node scripts/hard-update-client.js check \
  --usb <tmp-or-usb>/U-Claw \
  --update-check-url https://updates.yiyong.me/uclaw/update/check \
  --device <devices.device_id> \
  --platform darwin-arm64
```

上传顺序：

```text
release-public-keys.json
runtime.pkg
runtime.pkg.sha256
sbom.json
manifest.json
部署同版本控制面
production.json 最后；它是唯一激活 release 的可变指针
```

## 5. HTTP 下载 mock

默认 staging 直连 R2：

```bash
node scripts/hard-update-client.js check \
  --usb <tmp-or-usb>/U-Claw \
  --platform win32-x64
```

不传 `--release`、`--production-url`、`--update-check-url` 时，客户端默认走：

```text
https://pub-8289f643846848528b61bfd5dbf17e43.r2.dev/releases/production.json
```

启动入口 `startup-update` 使用该路径做无条件硬更新：

```text
盘内 app/version.json != R2 production.json requiredVersion
-> 下载、验签、校验、staging、后台 apply、重启 launcher
```

显式 update check 回归模式才走控制面，且必须提供：

```text
https://updates.yiyong.me/uclaw/update/check
Authorization: Bearer <device token>
deviceId: <devices.device_id>
```

显式 URL：

```bash
node scripts/hard-update-client.js mock-update \
  --usb <tmp-or-usb>/U-Claw \
  --production-url https://pub-8289f643846848528b61bfd5dbf17e43.r2.dev/releases/production.json \
  --platform win32-x64
```

客户端继续验证：

```text
production.json Ed25519 signature
manifest.json Ed25519 signature
manifestSha256
runtime.pkg sha256
runtime.pkg size
treeDigest
zip 路径安全
禁止 data/、.openclaw/、openclaw.json、auth_profile_store、license、memory、logs、*.env、*.key
```

## 6. 阿里云 update check mock

离线契约工具：

```bash
node scripts/hard-update-check-mock.js \
  --release release/mock-hard-update \
  --platform win32-x64 \
  --device DEV-MOCK \
  --installed-version 0.0.1
```

当前已补最小真实控制面服务：

```bash
node scripts/hard-update-control-plane-server.js \
  --env .env \
  --release release/mock-hard-update
```

部署目标：

```text
/opt/uclaw-update
systemd service: uclaw-update.service
listen: 127.0.0.1:18080
Caddy route: https://updates.yiyong.me/uclaw/update/check -> 127.0.0.1:18080
current staging requiredVersion: 1.0.0
```

响应字段：

```text
requiredVersion
forceUpdate
productionUrl
manifestUrl
packageUrl
shortConfig
```

缺真实信息：

```text
prod 发布审批执行记录
prod 数据库切换窗口
```

真实数据库状态：

```text
阿里云 Postgres 存在 uclaw_activation / uclaw_activation_staging32。
uclaw_activation_staging32 已有测试链：
  activation_inventory/devices/licenses/device_access_tokens 各 1 行。
update check 已接入真实 staging 查库规则。
客户端输入使用 Authorization: Bearer <device_token> + deviceId。
不使用 activation_code 做 update check。
licenses.status 只认 active。
token/device/inventory status 只认 active。
license.not_before <= now() 且 license.expires_at > now()。
当前 /srv/uclaw-staging32/config/activation.env 的 app 用户 DATABASE_URL 认证失败。
本轮阿里云控制面服务使用本机 postgres socket 读取 staging32：
  UCLAW_UPDATE_PSQL_DATABASE=uclaw_activation_staging32
  UCLAW_UPDATE_PSQL_SYSTEM_USER=postgres
正式上线前建议修复 app 用户 DB 凭证并切回非 superuser 只读查询。
```

2026-08-29 已确认 schema：

```text
licenses.license_id: uuid NOT NULL, primary key
licenses.status: text NOT NULL
licenses.expires_at: timestamptz NOT NULL
licenses unique index:
  (device_id, revision)
  (license_id, device_id)

devices.device_id: uuid NOT NULL, primary key
devices.inventory_id: uuid NOT NULL, unique, foreign key -> activation_inventory(id)

activation_inventory.activation_code_digest: bytea NOT NULL, unique
```

真实 update check SQL 规则：

```text
FROM device_access_tokens token
JOIN licenses license
  ON license.license_id = token.license_id
 AND license.device_id = token.device_id
JOIN devices device
  ON device.device_id = token.device_id
 AND device.inventory_id = token.inventory_id
JOIN activation_inventory inventory
  ON inventory.id = token.inventory_id
WHERE token.token_digest = sha256(raw_device_token)
  AND token.status = 'active'
  AND license.status = 'active'
  AND device.status = 'active'
  AND inventory.status = 'active'
  AND license.not_before <= now()
  AND license.expires_at > now()
  AND device.device_id = $deviceId
```

验收结果：

```text
2026-08-29：有效 staging device token 返回 allowed=true、requiredVersion=1.0.0、forceUpdate=true。
缺 token: allowed=false, reason=missing-device-token。
错 token: allowed=false, reason=license-device-token-denied。
control plane 返回的 productionUrl/manifestUrl/packageUrl 均为 R2 staging URL。
HTTP 从 R2 拉回 v1.0.0 的 production.json、manifest.json、runtime.pkg，验签、sha256、size、treeDigest 通过。
v1.0.1 的 13 个不可变对象已上传并校验；production.json 仍指向 v1.0.0，等待同版本控制面部署后再切换。
```

## 7. 验收清单

```text
node -c scripts/hard-update-package.js
node -c scripts/hard-update-client.js
node -c scripts/hard-update-upload-r2.js
node -c scripts/hard-update-check-mock.js
node -c scripts/hard-update-release-key.js
node -c scripts/hard-update-control-plane-server.js
node scripts/verify-hard-update-mock.js
生成 mock release
release 不含 data/.openclaw/.env/*.key
R2 staging 真实上传成功
HTTP 从 R2 拉回 production.json / manifest.json / runtime.pkg
HTTP 下载后验签、sha256、size、treeDigest 通过
update 后 data/.openclaw/openclaw.json hash 不变
update check 使用 Bearer device token + deviceId，真实 staging 查库 allowed
控制面只返回 R2 URL，不转发 runtime.pkg
阿里云部署脚本、R2 manifest、客户端包、Git 均不含密码或 secret
双端启动脚本在启动 Electron 前自动执行 hard-update-client.js startup-update
startup-update 有更新时只 staging，后台 apply-startup-update 等 launcher 退出后替换并重启
package.json 已将 hard-update-client.js 和必要 lib 打进 Electron app archive
```

## 8. 用户视角启动硬更新测试

```text
前提：
1. R2 staging production.json 指向比盘内 app/version.json 更高的 requiredVersion。
2. 盘内 app/bootstrap/release-public-keys.json 信任当前 release 公钥。
3. 盘内 bundled Node 和 hard-update-client.js 存在。
4. 不需要激活凭据，不需要 deviceId/deviceToken。
```

用户动作：

```text
Windows 用户双击 U-Claw Launcher.exe。
macOS 用户双击 U-Claw Launcher.app。
```

期望：

```text
启动窗口显示检查/下载/应用强制更新进度。
用户不需要手动运行发布脚本。
更新包验签、sha256、size、treeDigest 均通过后才替换程序层。
data/、.openclaw/、license、memory、logs、*.env、*.key 不被更新包覆盖。
替换完成后自动重新打开 U-Claw Launcher。
第二次启动看到 app/version.json 已是 requiredVersion，直接进入正常启动。
```

排查位置：

```text
Windows:
<USB>/U-Claw/data/logs/Windows-Start-App.log
<USB>/U-Claw/data/logs/U-Claw-Launcher.log
%LOCALAPPDATA%\U-Claw\launcher-logs\Windows-Hard-Update-Apply.log

macOS:
<USB>/U-Claw/data/logs/Mac-Start-App.log
<USB>/U-Claw/data/logs/U-Claw-Launcher.log
~/Library/Caches/U-Claw/launcher-logs/Mac-Hard-Update-Apply.log

事务:
<USB>/U-Claw/app/update-transaction.json
```
