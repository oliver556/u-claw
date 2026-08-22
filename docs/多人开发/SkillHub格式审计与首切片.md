# SkillHub 格式审计与首切片

更新时间：2026-08-23

## 1. 审计结论

可以开始实现，但第一阶段不应直接移植旧 `product` 技能库 UI。

当前 `u-claw-app-dev` 是 Electron 壳 + OpenClaw 打包控制台，不是旧 `product` 的 React/TypeScript 前端工程。OpenClaw 原版控制台已经内置 Skills 页面、ClawHub 搜索、详情、安装、启停和 Agent skill toggle 入口。U-Claw 应优先复用这些 OpenClaw Gateway 方法和控制台能力，再做 U-Claw 筛选、中文化、品牌化和聊天下拉快捷入口。

## 2. 名称映射

产品侧继续叫 `SkillHub`。

技术侧 OpenClaw 当前叫 `ClawHub`，对应 CLI/Gateway/UI 已存在这些能力：

- `openclaw skills search`
- `openclaw skills install`
- `openclaw skills verify`
- `skills.search`
- `skills.detail`
- `skills.install`
- `skills.status`
- `skills.update`

实现中应把 `ClawHub` 视为 OpenClaw upstream 技术名，把 `SkillHub` 作为 U-Claw 用户可见名。

## 3. OpenClaw Skill 包结构

OpenClaw skill 是一个包含 `SKILL.md` 的目录。

最低结构：

```text
<skill-dir>/
  SKILL.md
  references/
  scripts/
  assets/
```

`SKILL.md` 最小 frontmatter：

```markdown
---
name: image-lab
description: Generate or edit images via a provider-backed image workflow
---
```

关键规则：

- skill 名称来自 `SKILL.md` frontmatter `name`，不是目录名。
- 若 `name` 缺失，才回退目录名。
- Agent allowlist 也按 frontmatter `name` 匹配。
- frontmatter 支持 YAML；`metadata.openclaw` 可用 JSON5 对象。
- `metadata.openclaw.requires` 控制 bins/env/config/os gating。
- `metadata.openclaw.install` 提供依赖安装提示。
- 同名 skill 由更高优先级 root 覆盖低优先级 root。

## 4. OpenClaw 安装目录与优先级

OpenClaw skill 加载优先级从高到低：

```text
<workspace>/skills
<workspace>/.agents/skills
~/.agents/skills
~/.openclaw/skills
bundled skills
skills.load.extraDirs
```

在 U-Claw 本地开发启动环境中，使用 `OPENCLAW_HOME` 后，实际工作目录为：

```text
/Users/biancheng/Library/Application Support/u-claw/.openclaw/workspace
/Users/biancheng/Library/Application Support/u-claw/.openclaw/skills
```

注意：

- 不设置 `OPENCLAW_HOME` 直接跑 OpenClaw CLI，会落到 `~/.openclaw/workspace`。
- Electron 启动时已设置 `OPENCLAW_HOME=userDataPath`、`OPENCLAW_STATE_DIR=.openclaw`、`OPENCLAW_CONFIG_PATH=.openclaw/openclaw.json`。
- U 盘/便携模式必须继续沿用启动脚本给定的 data/cache 路径，不得把缓存目录当源码。

## 5. Agent skills 绑定方式

OpenClaw Agent skills 是可见性/加载过滤，不是 shell 安全边界。

配置形态：

```json5
{
  agents: {
    defaults: {
      skills: ["github", "weather"]
    },
    list: [
      { id: "writer" },
      { id: "docs", skills: ["docs-search"] },
      { id: "locked-down", skills: [] }
    ]
  }
}
```

规则：

- `agents.defaults.skills` 是默认 allowlist。
- `agents.list[].skills` 是该 agent 的最终列表，不与 defaults merge。
- omit 表示不限制。
- `[]` 表示不给该 agent 暴露任何 skill。
- OpenClaw 原版 Agents 页面已经用 `runtimeConfig.patchForm(["agents","list",i,"skills"], ...)` 修改该配置。

聊天下拉第一版应复用这条链路：

```text
用户选择 Skill
-> 写入当前 Agent 的 `agents.list[].skills`
-> runtimeConfig.save()
-> 当前 session 若不稳定即时生效，则提示或新建/切换会话
```

## 6. Gateway / CLI 权威调用

优先使用 OpenClaw 已有 Gateway 方法：

- `skills.status`：读取当前 Agent 可见 skill inventory。
- `skills.search`：远端 ClawHub 搜索。
- `skills.detail`：远端详情。
- `skills.install`：安装到默认 Agent workspace `skills/`。
- `skills.update`：更新 ClawHub install 或 patch `skills.entries.<skillKey>`。

CLI 可作为开发验证工具：

```bash
OPENCLAW_HOME="/Users/biancheng/Library/Application Support/u-claw" \
OPENCLAW_STATE_DIR="/Users/biancheng/Library/Application Support/u-claw/.openclaw" \
OPENCLAW_CONFIG_PATH="/Users/biancheng/Library/Application Support/u-claw/.openclaw/openclaw.json" \
node u-claw-app-dev/node_modules/openclaw/openclaw.mjs skills list --json
```

远端搜索验证：

```bash
node u-claw-app-dev/node_modules/openclaw/openclaw.mjs skills search weather --json --limit 2
```

已验证：`skills search --json` 返回 `ownerHandle`、`slug`、`canonicalUrl`、`install.reference`、`trust.installability` 等字段。

## 7. SkillHub 上游形态差异

旧迁移文档基于 `https://api.skillhub.cn/api/v1/skills` 一类接口与 `namespace` 字段。

本轮实测：

- 直接 `GET https://api.skillhub.cn/api/v1/skills?...` 返回 HTTP `405` 且 body 为空。
- OpenClaw CLI `skills search --json` 可成功返回 ClawHub 搜索结果。
- 当前结果形态使用 `ownerHandle` / `sourceIdentity.owner` / `install.reference`，不是旧实现中的 `namespace.publicSlug`。

结论：

- 新实现不能硬搬旧 `product/desktop/src/skills/skillhub-client.ts` 的远端 API shape。
- 若确需本地代理，应优先包裹 OpenClaw Gateway `skills.search/detail/install`，而不是直接依赖远端私有 API。
- 旧实现的安全思想可复用，旧 API 字段不可视为权威。

## 8. 旧 product 实现可复用与不可直接迁移

可复用：

- shared capability schema 思路。
- permission fingerprint / identity fingerprint 思路。
- start loading、防重复提交、operation polling 思路。
- ZIP/path/hash/size/symlink 安全边界。
- runtime readback 只接受 workspace 来源的原则。
- `SKILL.md name` 与目录 slug 不同的 alias 处理经验。

不可直接迁移：

- 旧 `api.skillhub.cn/api/v1/skills` shape。
- 旧 React 页面结构。
- 旧 `window.uclaw.skills.invoke` IPC 形态。
- 旧产品工程目录到 `u-claw-app-dev` 的整体复制。

原因：

- `u-claw-app-dev` 当前通过 OpenClaw packaged control UI 提供功能。
- `src/preload.js` 只暴露 `getGatewayStatus/openDashboard/openConfig`。
- `src/main.js` 只负责启动 Gateway、配置助手、窗口和基础 IPC。
- 原版 `skills-page-*.js` 已内置 ClawHub UI 与 Gateway 调用。

## 9. 风险矩阵

| 风险 | 等级 | 处理 |
| --- | --- | --- |
| 直接迁旧 SkillHub client，API shape 失配 | 高 | 禁止；先走 OpenClaw Gateway/CLI |
| 修改 `node_modules/openclaw/dist/control-ui/assets/*.js` 过多 | 高 | 只做最小 patch，并记录补丁 |
| 自造 chat-level skill runtime | 高 | 禁止；只改 Agent skills 配置 |
| 为隐藏 bundled skills 删除目录 | 高 | 禁止；仅 UI 过滤 |
| CLI 未设置 `OPENCLAW_HOME` 导致验证跑到 `~/.openclaw` | 中 | 所有验证命令显式带 env |
| 当前 session 修改 skills 后不立即生效 | 中 | 第一版提示新会话生效，或自动切换新会话 |
| ClawHub/SkillHub 命名混乱 | 中 | 用户侧统一 SkillHub，技术注释保留 ClawHub |

## 10. 首个可实现切片

首切片目标：U-Claw 化原版 Skills 页面，不改 OpenClaw runtime。

范围：

1. 将用户可见 `ClawHub` 文案改为 `SkillHub` / `技能商城`。已完成。
2. 在 Skills 页面增加 U-Claw 说明和中文空态/错误文案。已完成基础文案。
3. 隐藏或弱化 bundled skills 作为用户侧选择项，但不删除底层目录。已完成用户侧 list 过滤。
4. 保留原版 `skills.search/detail/install/status/update` 调用。
5. 记录所有 control-ui patch 的来源、目标、回滚方式。

非范围：

- 不做独立 React 技能库。
- 不接入旧 `api.skillhub.cn/api/v1/skills`。
- 不做聊天页 Skill 下拉。
- 不改模型链路、Gateway 启动、打包脚本。

验收：

- 本地启动后 Gateway 仍 ready。
- Skills 页面仍可打开。
- SkillHub 搜索仍走原版 Gateway 方法。
- 原版 bundled skills 未被删除。
- `npm run patch-openclaw` 可重复执行且幂等。

## 11. 已实施补丁记录

补丁入口：

```text
u-claw-app-dev/scripts/patch-openclaw.js
```

已实施：

- `patchSkillsPageBranding()`：仅替换用户可见文案，将原版 `ClawHub` 展示为 U-Claw 用户侧 `SkillHub`。
- `patchSkillsPageBundledVisibility()`：仅过滤 Skills 页面 list 渲染中的 `source === "openclaw-bundled"` 或 `bundled === true` 项；Gateway 数据、底层 bundled skill 目录、OpenClaw runtime 均不变。
- service worker `EMBEDDED_CACHE_VERSION` 已追加 `skillhub-branding-1-bundled-filter-1`，避免旧缓存遮盖 UI 补丁。

验证脚本：

```text
u-claw-app-dev/scripts/verify-skillhub-branding.js
```

验证命令：

```bash
cd u-claw-app-dev
npm run patch-openclaw
node --check scripts/patch-openclaw.js
node --check scripts/verify-skillhub-branding.js
node scripts/verify-skillhub-branding.js
curl -sS -o /tmp/uclaw_gateway_check.out -w '%{http_code}\n' http://127.0.0.1:18789/
```
