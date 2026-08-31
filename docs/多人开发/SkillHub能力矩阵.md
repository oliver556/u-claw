# SkillHub 能力矩阵

更新时间：2026-08-23

## 1. 状态口径

本矩阵遵守 `docs/多人开发/开发硬性要求.md` 第 5、17 点：

- `OK`：已有 OpenClaw 原能力或权威调用方式，且已可验证，可进入 Bavi-box UI。
- `Blocked`：有明确卡点，不进入正式 UI；只允许做标注清楚的占位或文档设计。
- `Unknown`：未确认权威调用方式，不开发。
- `Do Not Build`：不投入开发时间，不作为后续实现方向。

SkillHub 用户侧以 Bavi-box 筛选后的 SkillHub skill 为准；OpenClaw bundled skills 可保留在底层，但不作为用户侧选择项展示。不得自造 skill executor、不得绕过 OpenClaw skill runtime、不得删除底层 bundled skills 来达成隐藏效果。

## 2. 矩阵

| # | OpenClaw 原能力 | Bavi-box UI 入口 | 权威调用方式 | 配置来源 | 当前状态 | 验证命令/截图 | 风险 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | ClawHub/skills marketplace search | Skills 页“SkillHub/技能商城”搜索框 | Gateway `skills.search`；CLI `openclaw skills search <query> --json --limit <n>` | OpenClaw Gateway；ClawHub/SkillHub upstream；Electron 启动注入的 OpenClaw env | OK | `node u-claw-app-dev/node_modules/openclaw/openclaw.mjs skills search weather --json --limit 2`；`npm run patch-openclaw` 后 Gateway UI 文案验证 | 上游字段仍以 OpenClaw 返回为准，不能套旧 `product` API shape | 用户侧文案叫 SkillHub，技术侧保留 OpenClaw ClawHub 调用链 |
| 2 | Skill detail lookup | Skills 页搜索结果详情/安装面板 | Gateway `skills.detail`；原版 `skills-page-*.js` 已接 Gateway 方法 | OpenClaw Gateway detail response；远端 canonical URL / install reference | OK | 在 Gateway UI 打开搜索结果详情；代码侧查 `skills.detail` 调用；`rg -n "skills.detail" u-claw-app-dev/node_modules/openclaw/dist/control-ui/assets/skills-page-*.js` | 展示可宽容，安装前仍需重新校验 bundle identity / permission fingerprint | 旧迁移经验可复用错误分类思想，不复用旧 API 字段 |
| 3 | Skill install from marketplace | Skills 页“安装”动作 | Gateway `skills.install`；CLI `openclaw skills install <reference>` | OpenClaw workspace skills 目录；安装 reference 来自 search/detail | OK | UI 安装链路沿用原版；`rg -n "skills.install" u-claw-app-dev/node_modules/openclaw/dist/control-ui/assets/skills-page-*.js` | 当前只确认 OpenClaw 原安装能力；Bavi-box 级事务、权限确认、重启恢复另列为 `Blocked` | 第一阶段可进入 UI，但不得声称已完成完整安全事务体系 |
| 4 | Installed skills inventory | Skills 页“已安装/本地技能”列表 | Gateway `skills.status`；CLI `openclaw skills list --json` | `OPENCLAW_HOME` / `OPENCLAW_STATE_DIR` 指向的 `.openclaw`；workspace / managed / bundled skill roots | OK | `OPENCLAW_HOME="/Users/biancheng/Library/Application Support/u-claw" OPENCLAW_STATE_DIR="/Users/biancheng/Library/Application Support/u-claw/.openclaw" OPENCLAW_CONFIG_PATH="/Users/biancheng/Library/Application Support/u-claw/.openclaw/openclaw.json" node u-claw-app-dev/node_modules/openclaw/openclaw.mjs skills list --json` | 未设置 env 会误读 `~/.openclaw`，造成错误结论 | 用户侧列表已过滤 bundled；底层 inventory 不改 |
| 5 | Enable/disable skill entry | Skills 页启用/禁用；Agents 页 skills toggle | Gateway `skills.update`；Agents 页 `runtimeConfig.patchForm(["agents","list",i,"skills"], ...)` + `runtimeConfig.save()` | `openclaw.json` 中 skills entries 与 agents 配置 | OK | `rg -n "skills.update|patchForm\\(\\[.*skills" u-claw-app-dev/node_modules/openclaw/dist/control-ui/assets/*.js` | `skills.status` 可能短暂 stale；高风险重新启用确认另列 `Blocked` | 可承接原版操作，后续需补 loading、防重复与 bounded polling |
| 6 | Update installed skill | Skills 页更新动作 | Gateway `skills.update`；OpenClaw 原 Skills 页调用 | `skills.entries.<skillKey>`；OpenClaw install metadata | OK | `rg -n "skills.update" u-claw-app-dev/node_modules/openclaw/dist/control-ui/assets/skills-page-*.js` | 更新需保留 enabled 状态；失败时需 domain error 与 readback | 当前为原版可用能力，Bavi-box 操作事务增强另列切片 |
| 7 | Workspace skill uninstall/delete | “我的技能”卸载 workspace skill | 尚无已确认 OpenClaw Gateway `skills.uninstall`；可行方向是 workspace-only delete adapter + runtime readback | workspace `skills/` 目录；OpenClaw runtime readback | Blocked | 待验证：是否存在官方 uninstall method/CLI；当前不得进入正式 UI | 误删 bundled/managed namesake 会破坏 runtime；路径删除需防 traversal/symlink | 不进正式 UI；只允许文档设计。实现前须确认权威删除方式与回滚 |
| 8 | Bundled skills retained under runtime | 无直接用户入口；底层依赖保留 | OpenClaw 原 bundled skills root；不删除目录 | `node_modules/openclaw` bundled skills；OpenClaw loader priority | OK | `node .../openclaw.mjs skills list --json` 可见 `source:"openclaw-bundled"` / `bundled:true` | 若为隐藏而删除目录，可能破坏内置依赖或 runtime 假设 | 必须保留底层 bundled，符合第 17 点 |
| 9 | Bundled skills hidden/weak in user UI | Skills 页用户侧列表；聊天页未来下拉 | `patch-openclaw.js` 对 Skills 页渲染层过滤 `source === "openclaw-bundled"` 或 `bundled === true` | UI patch；OpenClaw inventory 原数据不变 | OK | `cd u-claw-app-dev && npm run patch-openclaw && node scripts/verify-skillhub-branding.js` | 仅 UI 过滤；若 OpenClaw asset 结构升级，patch 需 fail fast | 已完成首切片：用户侧不展示 bundled，底层不删 |
| 10 | Chat page SkillHub dropdown | 聊天输入框工具栏，模型选择附近 | 复用 Agent skills 配置：`runtimeConfig.patchForm(["agents","list",i,"skills"], ...)` + `runtimeConfig.save()`；第一版明确“新会话生效” | `openclaw.json` agents list/defaults；当前会话绑定 agent | OK | `cd u-claw-app-dev && node scripts/verify-skillhub-chat-dropdown.js`；`NODE_PATH=/Users/biancheng/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules /Users/biancheng/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/verify-skillhub-connected-ui.js`；Gateway HTTP `200` | 当前 session 即时生效未承诺；自动验收会临时写入本机 `openclaw.json` 后原样还原 | 已连接 UI 验收通过：下拉可见、过滤 bundled、选择后合并保留旧 allowlist、配置可还原 |
| 11 | Agent skills allowlist binding | Agents 页 Skills 面板；聊天下拉未来复用 | 原版 Agents 页 `runtimeConfig.patchForm(["agents","list",i,"skills"], ...)` + `runtimeConfig.save()` | `openclaw.json` `agents.defaults.skills` / `agents.list[].skills` | OK | `rg -n "runtimeConfig\\.patchForm|agents.*skills" u-claw-app-dev/node_modules/openclaw/dist/control-ui/assets/agents-page-*.js` | allowlist 是可见性/加载过滤，不是 shell 安全边界 | 聊天下拉必须走此链路或等价 OpenClaw config 链路 |
| 12 | SkillHub/OpenClaw package format audit | 文档与开发准入，不是用户入口 | `SKILL.md` frontmatter `name`；OpenClaw skill roots；`metadata.openclaw` requires/install；runtime readback | workspace skills、managed skills、bundled skills、`skills.load.extraDirs` | OK | 已有 `docs/多人开发/SkillHub格式审计与首切片.md`；CLI `skills list --json` / `skills search --json` | SkillHub ZIP/远端 manifest 仍需逐包校验；旧 `api.skillhub.cn` shape 不能当权威 | 作为后续实现准入；具体安装安全校验另列切片 |
| 13 | High-risk permission confirmation | 安装确认弹窗；重新启用确认弹窗 | 旧迁移经验要求 `permissionFingerprint` + `acceptedRisk`；当前 OpenClaw Gateway 是否内建确认契约未确认 | Skill package metadata / requires / local risk policy | Blocked | 待验证：OpenClaw `metadata.openclaw.requires` 与 SkillHub trust 字段如何映射到 Bavi-box 权限确认 | 漏确认会放大本地文件/命令/env 风险；仅 checkbox 不够 | 不进正式 UI。完成 shared contract 与本地 service 前不得开放高风险安装/重新启用 |
| 14 | Install transaction / restart recovery | 安装、更新、卸载、启停 operation 状态 | 旧方案为 `SkillOperation` + transaction journal + staging/backup/replace/verify；当前 OpenClaw 原 Skills 页未提供 Bavi-box 级恢复层 | 本地 transaction journal；workspace skills；OpenClaw readback | Blocked | 待实现后验证：中断安装、重启恢复、readback rollback | 半写入 skill 会造成 runtime 状态漂移；重复提交会产生并发事务 | 不进正式 UI 的“强承诺”；当前只可使用原版安装能力，不宣称可恢复 |
| 15 | Local ZIP import | “我的技能”导入 ZIP | 尚无已确认 OpenClaw Gateway ZIP import；需本地 validator + install adapter，再写入 OpenClaw skill 目录 | 用户选择的 ZIP；trusted host/path/hash rules；workspace skills | Blocked | 待验证：ZIP path traversal、Windows reserved names、symlink、file count/size、sha256、`SKILL.md name` readback | 本地 ZIP 是高风险入口；未经校验会写坏 workspace 或越权写文件 | 不进正式 UI。必须先做 bundle validator、权限确认、runtime readback |
| 16 | Old `product` SkillHub API direct client | 不设 Bavi-box 正式入口 | 禁止直接复用旧 `product/desktop/src/skills/skillhub-client.ts` 的远端 API shape；优先 OpenClaw Gateway `skills.search/detail/install` | 旧 `api.skillhub.cn/api/v1/skills` 曾返回 HTTP 405；字段与当前 OpenClaw search 结果不一致 | Do Not Build | `docs/多人开发/SkillHub格式审计与首切片.md` 已记录旧 API 失配；禁止以旧 URL 作为权威 | 硬搬旧 client 会导致 API shape 失配、身份证明漂移、安装错 skill | 不投入。只复用旧安全思想与测试经验，不迁旧直连实现 |

## 3. 数量汇总

- `OK`：11
- `Blocked`：4
- `Unknown`：0
- `Do Not Build`：1

`Blocked` 项不得进入正式 UI；`Unknown` 项如后续出现，默认不开发。下一步建议先串行推进 `Blocked` 中的权限确认、事务恢复、ZIP import 三项，且每项必须先补验证记录。
