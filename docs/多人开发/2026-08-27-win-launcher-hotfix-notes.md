# win-launcher-hotfix 完成记录

- 日期：2026-08-27
- 分支：`codex/win-launcher-hotfix`
- 范围：启动/关闭生命周期、更新关闭协议占位

## 本分支只做

```text
Launcher/App 协议占位
run-state.json 写入
update-shutdown-request.json 监听
shutdown-complete.json 写入
cache 路径 env 传递
静态验收脚本
```

## 本分支不做

```text
R2
production.json
manifest 签名
runtime.pkg
Go updater 替换层
streamer key 修复
真实 U 盘打包交付
```

## 协议文件

```text
<USB>/U-Claw/app/.runtime/run-state.json
<USB>/U-Claw/app/.runtime/update-shutdown-request.json
<USB>/U-Claw/app/.runtime/shutdown-complete.json
```

## 验证

```bash
cd <repo>/u-claw-app-dev
node -c src/main.js
node -c scripts/verify-launcher-hotfix-protocol.js
npm run launcher-hotfix:verify
bash -n scripts/Mac-Start-App.command
go test ./...
go build .
```

`go test/go build` 在 `scripts/launcher/windows` 内运行。
