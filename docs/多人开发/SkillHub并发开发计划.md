# SkillHub 并发开发计划

更新时间：2026-08-23

## 1. 当前依据

本计划基于：

- `docs/多人开发/开发硬性要求.md` 第 17 点：Skill / SkillHub 原则。
- `docs/多人开发/SkillHub技能库PRD.md`：产品范围、用户故事、验收标准。
- `docs/多人开发/SkillHub格式审计与首切片.md`：OpenClaw 事实、已验证调用链、首切片结果。

当前结论：

1. SkillHub 是 Bavi-box 用户侧 skill 来源。
2. OpenClaw bundled skills 可保留在底层，但不作为用户侧 SkillHub 选项展示。
3. 不自造 skill executor，不绕过 OpenClaw skill runtime。
4. SkillHub skill 必须进入 OpenClaw 可识别的安装/绑定链路。
5. 现阶段优先复用 OpenClaw Gateway `skills.search/detail/install/status/update` 与 Agents 页 skills 配置链路。

## 2. 并发开发原则

1. 主 agent 负责需求解释、切片分派、集成顺序、最终验收与风险收口。
2. 子 agent 只能修改自己切片列出的文件；不同子 agent 的写入文件集合必须互斥。
3. 读 `u-claw-app`、`product` 可作参考；禁止修改二者。
4. 所有正式开发写入限定在 `u-claw-app-dev`、`docs/多人开发`、`.codex-state` 中对应任务文件。
5. 每个切片完成后必须报告：变更文件、验证命令、结果、阻塞、回滚方式。
6. 若两个切片都需要改同一文件，必须串行，由主 agent 合并后再放行下一个切片。
7. 不允许为了演示做假 UI、假状态、假安装或独立 runtime。

## 3. 默认禁止修改的底座文件

以下文件默认禁止修改，除非边城明确授权且先写清原因、影响、验证和回滚：

```txt
u-claw-app-dev/src/main.js
u-claw-app-dev/package.json
u-claw-app-dev/setup.sh
u-claw-app-dev/setup.bat
```

以下底座能力也默认禁止改：

```txt
Gateway 启动逻辑
portable data 目录逻辑
Mac/Win 打包配置
U 盘数据同步脚本
OpenClaw 包版本
Node runtime 打包逻辑
```

## 4. 可领取切片

### Slice 1：能力矩阵与状态口径补齐

目标：

- 把 SkillHub 功能逐项落入能力矩阵，明确 `OK / Blocked / Unknown / Do Not Build`。
- 明确哪些能力已可复用 OpenClaw Gateway，哪些必须等审计或 adapter。

允许修改文件：

```txt
docs/多人开发/SkillHub能力矩阵.md
.codex-state/skillhub_matrix_progress.md
.codex-state/skillhub_matrix_journal.md
```

禁止修改文件：

```txt
u-claw-app
product
u-claw-app-dev/**
docs/多人开发/SkillHub技能库PRD.md
docs/多人开发/SkillHub格式审计与首切片.md
```

验证命令：

```bash
test -f docs/多人开发/SkillHub能力矩阵.md
rg -n "Unknown|Blocked|OK|Do Not Build" docs/多人开发/SkillHub能力矩阵.md
git diff -- docs/多人开发/SkillHub能力矩阵.md .codex-state/skillhub_matrix_progress.md .codex-state/skillhub_matrix_journal.md
```

回滚方式：

```bash
git restore -- docs/多人开发/SkillHub能力矩阵.md .codex-state/skillhub_matrix_progress.md .codex-state/skillhub_matrix_journal.md
```

风险：

- 若矩阵把 `Unknown` 能力误标为 `OK`，后续会出现假 UI 或不可用入口。

### Slice 2：Skills 页面用户侧展示与 bundled skills 弱化

目标：

- 在已完成 `ClawHub -> SkillHub` 首切片基础上，继续弱化用户侧 bundled skills。
- 保留底层 bundled skills，不删除目录，不破坏 OpenClaw runtime。
- 记录所有 control-ui patch 的定位、替换和回滚说明。

允许修改文件：

```txt
u-claw-app-dev/scripts/patch-openclaw.js
docs/多人开发/SkillHub格式审计与首切片.md
.codex-state/skill_marketplace_ui_progress.md
.codex-state/skill_marketplace_ui_journal.md
```

禁止修改文件：

```txt
u-claw-app
product
u-claw-app-dev/src/main.js
u-claw-app-dev/package.json
u-claw-app-dev/setup.sh
u-claw-app-dev/setup.bat
u-claw-app-dev/node_modules/openclaw/dist/control-ui/assets/*.js
```

说明：

- `assets/*.js` 只能由 `npm run patch-openclaw` 生成修改，禁止手改。

验证命令：

```bash
cd u-claw-app-dev
npm run patch-openclaw
node --check scripts/patch-openclaw.js
curl -I http://127.0.0.1:18789/
rg -n "SkillHub|ClawHub|bundled" node_modules/openclaw/dist/control-ui/assets/skills-page-*.js
```

回滚方式：

```bash
git restore -- u-claw-app-dev/scripts/patch-openclaw.js docs/多人开发/SkillHub格式审计与首切片.md .codex-state/skill_marketplace_ui_progress.md .codex-state/skill_marketplace_ui_journal.md
cd u-claw-app-dev && npm run patch-openclaw
```

风险：

- `skills-page-*.js` 是打包产物，定位字符串易随 OpenClaw 版本变化；必须保持 patch 幂等。

### Slice 3：安装/启停操作状态与防重复提交

目标：

- 让安装、更新、启用、禁用、卸载等用户动作有明确 loading / running / failed 状态。
- 防止重复点击造成并发事务。
- 失败时展示可理解 domain error，不吞错。

允许修改文件：

```txt
u-claw-app-dev/scripts/patch-openclaw-skill-actions.js
docs/多人开发/SkillHub操作状态设计.md
.codex-state/skill_action_loading_progress.md
.codex-state/skill_action_loading_journal.md
```

禁止修改文件：

```txt
u-claw-app
product
u-claw-app-dev/scripts/patch-openclaw.js
u-claw-app-dev/src/main.js
u-claw-app-dev/package.json
u-claw-app-dev/setup.sh
u-claw-app-dev/setup.bat
```

验证命令：

```bash
cd u-claw-app-dev
node --check scripts/patch-openclaw-skill-actions.js
npm run patch-openclaw
curl -I http://127.0.0.1:18789/
rg -n "loading|running|failed|disabled" node_modules/openclaw/dist/control-ui/assets/skills-page-*.js
```

回滚方式：

```bash
git restore -- u-claw-app-dev/scripts/patch-openclaw-skill-actions.js docs/多人开发/SkillHub操作状态设计.md .codex-state/skill_action_loading_progress.md .codex-state/skill_action_loading_journal.md
cd u-claw-app-dev && npm run patch-openclaw
```

风险：

- 若新增独立 patch 脚本未接入现有 `npm run patch-openclaw`，会出现本地验证有效、重装后失效。
- 若无法保持文件互斥，应退回主 agent 串行合并到 `patch-openclaw.js`。

### Slice 4：SkillHub 安装 alias 与 runtime readback

目标：

- 验证 `SKILL.md name`、SkillHub slug、目录名、runtime id 不一致时的读取规则。
- 安装后只接受 workspace 来源 readback，不把 bundled namesake 当成功。
- 明确 `skills.update` 后 bounded polling 策略。

允许修改文件：

```txt
docs/多人开发/SkillHub安装与Readback设计.md
.codex-state/skill_install_alias_progress.md
.codex-state/skill_install_alias_journal.md
```

禁止修改文件：

```txt
u-claw-app
product
u-claw-app-dev/src/main.js
u-claw-app-dev/package.json
u-claw-app-dev/setup.sh
u-claw-app-dev/setup.bat
u-claw-app-dev/node_modules/**
```

验证命令：

```bash
OPENCLAW_HOME="/Users/biancheng/Library/Application Support/u-claw" \
OPENCLAW_STATE_DIR="/Users/biancheng/Library/Application Support/u-claw/.openclaw" \
OPENCLAW_CONFIG_PATH="/Users/biancheng/Library/Application Support/u-claw/.openclaw/openclaw.json" \
node u-claw-app-dev/node_modules/openclaw/openclaw.mjs skills list --json

node u-claw-app-dev/node_modules/openclaw/openclaw.mjs skills search weather --json --limit 2
git diff -- docs/多人开发/SkillHub安装与Readback设计.md .codex-state/skill_install_alias_progress.md .codex-state/skill_install_alias_journal.md
```

回滚方式：

```bash
git restore -- docs/多人开发/SkillHub安装与Readback设计.md .codex-state/skill_install_alias_progress.md .codex-state/skill_install_alias_journal.md
```

风险：

- 未显式设置 `OPENCLAW_HOME` 会把验证跑到 `~/.openclaw`，造成错误结论。

### Slice 5：聊天页 Skill 下拉设计与最小接入点

目标：

- 找到聊天输入框工具栏和模型选择附近的最小 patch 点。
- 下拉只作为 Agent skills 配置快捷入口，不创建 chat-level runtime。
- 若当前 session 不能稳定即时生效，第一版提示“新会话生效”或走新会话策略。

允许修改文件：

```txt
docs/多人开发/Skill下拉接入设计.md
.codex-state/skill_dropdown_design_progress.md
.codex-state/skill_dropdown_design_journal.md
```

禁止修改文件：

```txt
u-claw-app
product
u-claw-app-dev/src/main.js
u-claw-app-dev/package.json
u-claw-app-dev/setup.sh
u-claw-app-dev/setup.bat
u-claw-app-dev/node_modules/**
```

验证命令：

```bash
rg -n "runtimeConfig\\.patchForm|skills|model|toolbar|chat" u-claw-app-dev/node_modules/openclaw/dist/control-ui/assets/*.js
git diff -- docs/多人开发/Skill下拉接入设计.md .codex-state/skill_dropdown_design_progress.md .codex-state/skill_dropdown_design_journal.md
```

回滚方式：

```bash
git restore -- docs/多人开发/Skill下拉接入设计.md .codex-state/skill_dropdown_design_progress.md .codex-state/skill_dropdown_design_journal.md
```

风险：

- 聊天页为打包产物，贸然改 UI 容易破坏输入框与会话状态；先做设计和定位，再开代码切片。

### Slice 6：聊天页 Skill 下拉实现

目标：

- 基于 Slice 5 的定位结果，实现输入框附近 Skill 下拉。
- 只展示 Bavi-box 筛选后的 SkillHub skills，不展示 bundled skills。
- 选择后复用 `runtimeConfig.patchForm(["agents","list",i,"skills"], ...)` 与 `runtimeConfig.save()` 链路。

允许修改文件：

```txt
u-claw-app-dev/scripts/patch-openclaw-chat-skill-dropdown.js
docs/多人开发/Skill下拉接入设计.md
.codex-state/skill_ui_refresh_progress.md
.codex-state/skill_ui_refresh_journal.md
```

禁止修改文件：

```txt
u-claw-app
product
u-claw-app-dev/scripts/patch-openclaw.js
u-claw-app-dev/src/main.js
u-claw-app-dev/package.json
u-claw-app-dev/setup.sh
u-claw-app-dev/setup.bat
u-claw-app-dev/node_modules/openclaw/dist/control-ui/assets/*.js
```

说明：

- `assets/*.js` 只能由 patch 脚本生成修改。
- 若实现必须改 `patch-openclaw.js`，本切片不得并发领取，必须由主 agent 串行整合。

验证命令：

```bash
cd u-claw-app-dev
node --check scripts/patch-openclaw-chat-skill-dropdown.js
npm run patch-openclaw
curl -I http://127.0.0.1:18789/
rg -n "SkillHub|skills|runtimeConfig\\.patchForm|runtimeConfig\\.save" node_modules/openclaw/dist/control-ui/assets/chat-page-*.js
```

回滚方式：

```bash
git restore -- u-claw-app-dev/scripts/patch-openclaw-chat-skill-dropdown.js docs/多人开发/Skill下拉接入设计.md .codex-state/skill_ui_refresh_progress.md .codex-state/skill_ui_refresh_journal.md
cd u-claw-app-dev && npm run patch-openclaw
```

风险：

- 当前 session 是否即时刷新 tools 未验证；若不稳定，必须提示新会话生效。

### Slice 7：最终集成验收与跨平台清单

目标：

- 主 agent 串行整合各切片，确认无文件所有权冲突。
- 验证 Gateway、Skills 页面、SkillHub 搜索、安装状态、聊天 Skill 下拉与 P0 baseline。
- 输出 Mac/Windows/U 盘便携验收清单。

允许修改文件：

```txt
docs/多人开发/SkillHub验收报告.md
.codex-state/skillhub_integration_progress.md
.codex-state/skillhub_integration_journal.md
```

禁止修改文件：

```txt
u-claw-app
product
u-claw-app-dev/src/main.js
u-claw-app-dev/package.json
u-claw-app-dev/setup.sh
u-claw-app-dev/setup.bat
```

验证命令：

```bash
git status --short
cd u-claw-app-dev
npm run patch-openclaw
node --check scripts/patch-openclaw.js
curl -I http://127.0.0.1:18789/
node node_modules/openclaw/openclaw.mjs skills search weather --json --limit 2
```

回滚方式：

```bash
git restore -- docs/多人开发/SkillHub验收报告.md .codex-state/skillhub_integration_progress.md .codex-state/skillhub_integration_journal.md
```

风险：

- Mac/Windows 打包和 U 盘便携验证需要真实平台环境；若本机不能覆盖，必须在报告中标 `Partial`。

## 5. 推荐下一步

建议先做 Slice 1：能力矩阵与状态口径补齐。

理由：

1. 它不改代码，写入文件与其他切片天然互斥。
2. 它能防止 `Unknown` 能力误入 UI。
3. 它会给 Slice 2、Slice 3、Slice 5 提供统一状态口径。
4. 它最符合 `开发硬性要求.md` 的“原版能力矩阵先行”。

Slice 1 完成后，可并发启动：

- Slice 2：Skills 页面用户侧展示与 bundled skills 弱化。
- Slice 4：SkillHub 安装 alias 与 runtime readback。
- Slice 5：聊天页 Skill 下拉设计与最小接入点。

暂不建议并发启动 Slice 3 和 Slice 6；二者都可能引入新的 patch 脚本接入问题，应等 Slice 2 / Slice 5 明确补丁组织方式后再执行。
