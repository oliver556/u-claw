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

## 只读验证

验证端只执行两个 HTTPS `GET`：读取 `stable.json`，再按签名清单读取对应 `runtime.pkg`。它拒绝重定向、压缩变换、超限内容、长度不符、签名错误和 SHA-256 错误，不上传或修改服务器文件。

```bash
node product/scripts/verify-update-deployment.mjs --base-url https://updates.yiyong.me/releases/ --public-key-file /secure/release-public-key.pem
```

验证成功后输出发布 ID、版本和包字节数。发布私钥只存在受控发布环境；静态服务器和验证机只需要发布公钥。
