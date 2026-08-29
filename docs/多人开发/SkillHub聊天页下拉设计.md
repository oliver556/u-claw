# SkillHub 聊天页下拉设计

更新时间：2026-08-23

## 1. 结论

聊天页可以增加 Skill 下拉，但第一版只作为 Agent skills 配置快捷入口，不创建 chat-level skill runtime。

当前状态仍为 `Blocked`，原因是“修改 Agent skills 后当前 session 是否立即生效”尚未完成端到端验证。因此本设计只允许进入最小接入点确认与受控 patch 设计；正式 UI 上线前必须验证当前会话工具刷新，或采用“新会话生效”的明确语义。

## 2. 依据

- `docs/多人开发/开发硬性要求.md` 第 17 点：SkillHub 用户侧来源、bundled skills 隐藏、复用 OpenClaw runtime。
- `docs/多人开发/SkillHub技能库PRD.md`：聊天页 Skill 下拉必须通过 Agent skills 配置绑定。
- `docs/多人开发/SkillHub格式审计与首切片.md`：Agent allowlist 使用 `SKILL.md` frontmatter `name`。
- `docs/多人开发/SkillHub能力矩阵.md`：聊天页下拉当前为 `Blocked`，不进正式 UI。
- `docs/技能库模块迁移复盘与实现指南.md`：复用安全思想，不复用旧 `product` 远端 API shape。

## 3. 设计原则

1. 用户侧展示 `SkillHub`，技术侧仍复用 OpenClaw `skills.*` 与 Agent config。
2. 下拉只展示 Bavi-box 筛选后的 SkillHub skills，过滤 `source === "openclaw-bundled"` 或 `bundled === true`。
3. 选择项使用用户可读名称、分类/来源和用途描述；底层写入 runtime 识别的 `skill.name`。
4. 下拉必须放在聊天输入框工具栏，靠近模型选择控件，表示“本次对话运行配置”。
5. 不直接请求远端 SkillHub API；数据来自本地 Gateway / OpenClaw 状态。

## 4. 现有锚点

聊天页已确认稳定锚点：

```txt
u-claw-app-dev/node_modules/openclaw/dist/control-ui/assets/chat-page-*.js
class="chat-controls__session chat-controls__inline-select chat-controls__model"
data-chat-model-select="true"
data-chat-thinking-select="true"
class="agent-chat__composer-controls"
```

模型选择已通过 `sessions.patch(..., { model })` 修改当前 session model，并调用 `onModelChanged` / `refreshCurrentSessionTools` 相关链路。Skill 下拉不能照搬 session patch，因为 OpenClaw skill 是 Agent-level configuration。

Agents 页已确认绑定链路：

```txt
u-claw-app-dev/node_modules/openclaw/dist/control-ui/assets/agents-page-*.js
runtimeConfig.patchForm(["agents","list",i,"skills"], [...skills])
runtimeConfig.save()
```

Agents 页当前行为是先修改 runtime config form，再由用户保存。聊天页第一版若自动保存，必须有清晰 loading、失败回滚与新会话生效提示。

## 5. 数据来源

第一版数据源：

```txt
Gateway method: skills.status
Input: 当前 agentId
Output: report.skills[]
```

过滤规则：

```js
skill => !(skill?.source === "openclaw-bundled" || skill?.bundled === true)
```

展示字段优先级：

```txt
label: skill.displayName || skill.title || skill.name
description: skill.description
category/source: skill.category || skill.source
runtime key: skill.name
```

若 `skills.status` 失败或 Gateway 未连接，下拉禁用并显示“SkillHub 暂不可用”。不得显示假数据。

## 6. 交互语义

第一版建议采用“新会话生效”语义：

```txt
用户打开下拉
-> UI 读取当前 Agent 的可见 SkillHub skills
-> 用户选择一个或多个 skill
-> 写入当前 Agent 的 skills allowlist
-> runtimeConfig.save()
-> 提示：Skill 已保存，将从新会话开始生效
```

理由：

- 当前 session tools 是否立即刷新未验证。
- OpenClaw 原版 skill 更接近 Agent-level configuration。
- 新会话生效语义符合硬性要求第 17 点给出的可接受策略。

后续若验证 `refreshCurrentSessionTools` 可稳定刷新当前会话工具，可升级为：

```txt
保存 Agent skills
-> bounded polling skills.status
-> refreshCurrentSessionTools
-> 当前 session 可用
```

## 7. 最小实现方案

推荐新增独立 patch 脚本：

```txt
u-claw-app-dev/scripts/patch-openclaw-chat-skill-dropdown.js
```

再由主 patch 串行调用，或在下一切片由主 agent 合并到 `patch-openclaw.js`。不得手改 `node_modules/openclaw/dist/control-ui/assets/*.js`。

最小代码边界：

1. 在 chat page bundle 中插入 Skill 下拉渲染函数，放在 `agent-chat__composer-controls` 内，模型选择附近。
2. 读取 `skills.status` 的 current agent report，过滤 bundled。
3. 复用 Agents 页 `runtimeConfig.patchForm(["agents","list",i,"skills"], ...)` 与 `runtimeConfig.save()`。
4. 保存前禁用重复提交；失败显示 domain error。
5. 保存成功显示“已保存，新会话生效”。

## 8. 验证计划

代码切片前验证：

```bash
rg -n "data-chat-model-select|agent-chat__composer-controls" u-claw-app-dev/node_modules/openclaw/dist/control-ui/assets/chat-page-*.js
rg -n "runtimeConfig\\.patchForm|agentSkillsReport|onAgentSkillToggle" u-claw-app-dev/node_modules/openclaw/dist/control-ui/assets/agents-page-*.js
```

代码切片后验证：

```bash
cd u-claw-app-dev
node --check scripts/patch-openclaw.js
npm run patch-openclaw
node scripts/verify-skillhub-branding.js
curl -sS -o /tmp/uclaw_skill_dropdown_gateway.out -w '%{http_code}\n' http://127.0.0.1:18789/
rg -n "SkillHub|skills.status|runtimeConfig\\.patchForm|新会话" node_modules/openclaw/dist/control-ui/assets/chat-page-*.js
```

手工验收：

- 打开聊天页，模型选择附近出现 SkillHub 下拉。
- 下拉不展示 bundled OpenClaw skills。
- Gateway 未连接时下拉禁用。
- 选择 Skill 后保存 Agent skills 配置。
- UI 明确提示新会话生效。
- 文本对话 P0 baseline 仍可用。

## 9. 风险与回滚

风险：

- chat bundle 为 minified asset，字符串锚点随 OpenClaw 版本变化。
- 自动保存 Agent config 可能影响当前 Agent 的全局行为，不是仅本条消息。
- 当前 session 即时生效未验证，不能在 UI 中承诺“立即可用”。

回滚：

```bash
git restore -- u-claw-app-dev/scripts/patch-openclaw.js u-claw-app-dev/scripts/patch-openclaw-chat-skill-dropdown.js docs/多人开发/SkillHub聊天页下拉设计.md
cd u-claw-app-dev && npm run patch-openclaw
```

## 10. 下一步

保持 `Blocked`，直到完成其中之一：

1. 验证当前 session 可稳定刷新 tools，并有 bounded polling。
2. 实现并验收“保存后新会话生效”的 UI 语义。

在此之前，不把聊天 Skill 下拉标为 `OK`。

## 11. 最小实现记录

已实现最小 patch：

```txt
u-claw-app-dev/scripts/patch-openclaw.js
u-claw-app-dev/scripts/verify-skillhub-branding.js
u-claw-app-dev/scripts/verify-skillhub-chat-dropdown.js
```

实现语义：

1. 聊天输入框控制区在模型选择旁插入 `SkillHub` 下拉。
2. 下拉打开时懒加载当前 Agent 的 `skills.status`。
3. 列表过滤 bundled skills，不展示 `openclaw-bundled` / `bundled:true`。
4. 选择一个 Skill 后，将该 skill 合并追加到当前 Agent 的 `skills` allowlist，不覆盖旧 skills。
5. 保存成功提示“已保存，新会话生效”。

当前验证：

```bash
cd u-claw-app-dev
npm run patch-openclaw
node --check scripts/patch-openclaw.js
node --check scripts/verify-skillhub-branding.js
node --check scripts/verify-skillhub-chat-dropdown.js
node --check scripts/verify-skillhub-connected-ui.js
node --check node_modules/openclaw/dist/control-ui/assets/chat-page-DrPkxqJK.js
node scripts/verify-skillhub-branding.js
node scripts/verify-skillhub-chat-dropdown.js
NODE_PATH=/Users/biancheng/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules /Users/biancheng/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/verify-skillhub-connected-ui.js
curl -sS -o /tmp/uclaw_skillhub_dropdown.out -w '%{http_code}\n' http://127.0.0.1:18789/
```

浏览器烟测结果：

- 页面可打开，无 console error。
- Gateway 已通过本地 helper 启动并返回 HTTP `200`。
- Connected UI 自动验收已通过：下拉可打开、非 bundled skill 可见、选择 `browser-automation` 后写入 Agent skills allowlist。
- 验收脚本会先备份本机 `openclaw.json`，保存后验证新增 skill 与旧 allowlist 保留，最后原样还原配置。
- 因第一版只承诺“新会话生效”，当前 session 即时 tools refresh 仍不作为通过条件。

启动补充：

- `npm start` 会打开 Electron，但当前环境内 Electron 子进程启动 Gateway 时失败于 `spawn node ENOENT`。
- 因 `u-claw-app-dev/src/main.js` 属硬性要求默认禁改底座，本切片未修改该文件。
- 为恢复本地验证，使用本机 Node 直接启动 Gateway，并沿用 Bavi-box data/config 路径。
