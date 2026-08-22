# ⚠️ 已归档：Electron 桌面版不再发布（2026-06-19 起）

`u-claw-app/`（Electron 打包的桌面版，产出 `U-Claw Setup *.exe` 安装版、`U-Claw *.exe` 绿色版、`U-Claw-*.dmg`）**已停止发布**。代码保留在仓库中仅作存档，CI 不再构建它。

## 为什么停发

1. **是商业版 ClawX 已做得更好的事的劣化版**——桌面体验打磨不过专门做这件事的 ClawX。
2. **与产品定位相悖**——U-Claw 的本质是「插上 U 盘就能用」（`portable/` 的 `.bat`/`.command`），Electron 桌面版是跑偏的妥协。
3. **启动坑多**。实测（2026-06-19）：
   - OpenClaw 首次冷启动要建 V8 编译缓存，可达 30–60s+；旧版 `main.js` 写死 `GATEWAY_STARTUP_TIMEOUT=30000`（30s 硬超时）→ **冷启动必弹「Gateway startup timeout」错误框**。
   - **绿色版**（electron-builder portable target）每次双击都自解压 837MB 到随机临时目录 → **永远冷启动**，且热重启易因解压目录冲突卡死。
   - 已把超时调到 180s + 给 spawn 加固定 `NODE_COMPILE_CACHE`（见本目录 `src/main.js` 的改动）——安装版可用（冷启 50s→热启 9s），但绿色版仍是「每次解压重型 app」的先天硬伤。

## 现在的产品形态

唯一主推 **`portable/`**（便携 U 盘版，`.bat`/`.command` 解压即用，已有 U 盘启动加速）。发布只产出 `u-claw-portable-windows-*.zip`，见 `.github/workflows/release.yml`。

## 想捡回来怎么办

代码原封不动还在这个目录。构建命令仍是 `cd u-claw-app && bash setup.sh && npm run build:win`。若要重新发布，把 `release.yml` 里删掉的 `desktop-windows`/`desktop-mac` 两个 job 恢复即可（翻 git 历史 commit 即可找回）。重新发布前务必先解决「绿色版每次冷启动」的体验问题，否则会复现上述坑。
