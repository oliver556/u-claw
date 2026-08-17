# U-Claw 静态更新源

`updates.yiyong.me` 只托管签名后的静态发布文件。它不需要 New API 服务器、许可证服务或数据库。

## 目录与权限

Nginx 的 `root` 固定为 `/srv/uclaw-updates`，发布目录如下：

```text
/srv/uclaw-updates/releases/stable.json
/srv/uclaw-updates/releases/packages/<release-id>/runtime.pkg
```

Nginx 运行账户只授予目录遍历和文件读取权限，不授予写权限。发布账户独立管理，只允许写 `/srv/uclaw-updates/releases`。目录和文件不得由 Nginx 进程拥有。

TLS 证书与私钥由主机证书管理系统维护，放在仓库之外。不要把证书私钥、runtime 发布私钥或发布写入凭据复制到静态目录。应用 `nginx.conf.example` 后先运行 `nginx -t`，再平滑 reload。

## 发布顺序

1. 在受控发布环境生成并验证 feed、`runtime.pkg` 和离线更新器。
2. 先上传 `releases/packages/<release-id>/runtime.pkg` 到临时文件，校验 SHA-256 后在同一文件系统原子改名。
3. 确认包 URL 返回 `200`、字节数和摘要正确。
4. 后发布 `releases/stable.json`，同样使用临时文件和原子改名。

必须先上传 `runtime.pkg`，后更新 `stable.json`。否则客户端可能看到尚不存在或不完整的包。不要覆盖已发布的 package 路径；新版本使用新的 `release-id`。

## 真实 Windows runtime 与验收包

生产验收包必须注入真实激活与许可证状态 HTTPS endpoint，以及各自的 Ed25519 公钥 map。它验证生产授权链、真实 Electron/Node/OpenClaw runtime、在线 feed 和离线更新器：

```bash
cd product
npm run build:windows-validation-kit -- \
  --cache .runtime-cache \
  --output ../outputs/windows-validation-$(date +%Y%m%d-%H%M%S) \
  --feed-base-url https://updates.yiyong.me/releases/ \
  --activation-endpoint https://license.yiyong.me/ \
  --activation-public-keys /secure/activation-public-keys.json \
  --license-status-endpoint https://license.yiyong.me/v1/licenses/ \
  --license-status-public-keys /secure/license-status-public-keys.json
```

没有生产 endpoint/公钥时，可生成即时断网 smoke kit：

```bash
node product/tests/windows/build-real-runtime-smoke-kit.mjs \
  --cache /tmp/uclaw-real-runtime-cache \
  --output ../outputs/windows-real-runtime-smoke
```

smoke kit 使用真实 runtime，但授权为 CI-only fixture。它只验证 Launcher、Electron、Gateway 和更新链，不是生产硬件绑定或生产激活的验收证据。fixture 私钥不得进入 Git、输出目录、U 盘或日志。

生产验收顺序：联网完成真实激活，确认授权文件生成，完全退出 U-Claw；随后断网执行首次正常完整启动，再分别验证在线和离线更新。即时 smoke 顺序：保持断网，直接双击 U 盘根目录 `U-Claw.exe`，关闭后运行 `U-Claw-Update-test.exe`，再启动确认升级。

## 只读验证

验证端只执行两个 HTTPS `GET`：读取 `stable.json`，再按签名清单读取对应 `runtime.pkg`。它拒绝重定向、压缩变换、超限内容、长度不符、签名错误和 SHA-256 错误，不上传或修改服务器文件。

```bash
node product/scripts/verify-update-deployment.mjs --base-url https://updates.yiyong.me/releases/ --public-key-file /secure/release-public-key.pem
```

验证成功后输出发布 ID、版本和包字节数。发布私钥只存在受控发布环境；静态服务器和验证机只需要发布公钥。
