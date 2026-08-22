# SkillHub 聊天页下拉验收清单

更新时间：2026-08-23

## 1. 验收目标

确认聊天页 `SkillHub` 下拉在已连接 Gateway 的桌面窗口中可见、可用、可保存，并严格遵守 `docs/多人开发/开发硬性要求.md` 第 17 点：

1. 不自造 skill runtime。
2. 不绕过 OpenClaw 原版 skill runtime。
3. 不展示 OpenClaw bundled skills。
4. 不承诺当前 session 立即生效。
5. Skill 选择只作为 Agent skills 配置快捷入口。

## 2. 前置条件

1. 当前验收目录为仓库根目录：

```bash
cd /Users/biancheng/Documents/ChatGPT/U-CLAW
```

2. Gateway 已连接且桌面窗口可进入聊天页。若需确认 Gateway 存活：

```bash
curl -sS -o /tmp/uclaw_skillhub_acceptance_gateway.out -w '%{http_code}\n' http://127.0.0.1:18789/
```

预期输出：

```txt
200
```

3. 已执行并通过本地静态验证：

```bash
cd /Users/biancheng/Documents/ChatGPT/U-CLAW/u-claw-app-dev
npm run patch-openclaw
node scripts/verify-skillhub-branding.js
node scripts/verify-skillhub-chat-dropdown.js
node scripts/verify-skillhub-release-readiness.js
NODE_PATH=/Users/biancheng/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules /Users/biancheng/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/verify-skillhub-connected-ui.js
```

预期 `verify-skillhub-release-readiness.js` 输出：

```txt
OK SkillHub release readiness verified
```

预期 connected UI 验收输出：

```txt
OK SkillHub connected UI acceptance verified
```

4. 当前桌面窗口不是连接页、错误页或未授权状态；必须能看到正常聊天输入框。

## 3. 验证步骤

### 3.1 入口可见

1. 打开 U-Claw 桌面窗口。
2. 进入任一可用聊天会话。
3. 观察聊天输入框工具栏，重点查看模型选择控件附近。

预期结果：

1. 模型选择附近出现 `SkillHub` 下拉。
2. 下拉属于输入框工具区，不是独立页面入口。
3. 页面无白屏、无明显布局错位。

### 3.2 数据加载

1. 点击 `SkillHub` 下拉。
2. 等待列表加载完成。

预期结果：

1. 下拉从 Gateway / OpenClaw 本地状态加载数据。
2. 加载失败时显示不可用或错误状态，不显示假数据。
3. 列表项使用用户可读名称、分类或来源、用途说明。

### 3.3 bundled 过滤

1. 检查下拉列表内容。
2. 重点确认是否出现 OpenClaw 原版 bundled skills。
3. 对照原版 `Skills` 页或底层 skills 目录，仅确认用户侧下拉过滤结果，不删除或移动任何 bundled 文件。

预期结果：

1. 不出现 `source === "openclaw-bundled"` 的 skill。
2. 不出现 `bundled === true` 的 skill。
3. 不出现 OpenClaw 原版 bundled skills 的英文名、文件名或仅供底层运行时使用的 skill。
4. 不因隐藏 bundled skills 而删除底层 bundled 文件或破坏运行时依赖。

### 3.4 选择、保存与 allowlist 保留

1. 先记录当前 Agent 已有 skills allowlist。
2. 在 `SkillHub` 下拉中选择一个新增 skill。
3. 观察保存过程与提示文案。
4. 刷新或新建聊天会话后，再确认所选 Agent 的 skill 配置是否保留。

预期结果：

1. 选择后保存到当前 Agent 的 `skills` allowlist。
2. 保存路径复用 OpenClaw Agent skills 配置链路。
3. 新增 skill 只追加或合并到 allowlist，不覆盖、清空或丢弃旧 skills。
4. 保存后旧 skills 仍保留，新 skill 在新建聊天会话后生效。
5. 成功提示必须表达“新会话生效”或同等语义。
6. 不提示“当前 session 立即生效”“本条消息立即生效”等未经验证语义。

### 3.5 保存失败与可恢复

1. 记录保存前 Agent skills allowlist。
2. 通过断开 Gateway、DevTools 阻断保存请求，或使用主开发者提供的失败构建触发一次保存失败。
3. 观察下拉状态、提示文案与 Agent skills 配置。
4. 恢复 Gateway 后重新打开聊天页或原版 `Agents -> Skills` 面板。

预期结果：

1. 保存失败时显示失败状态，不把失败选择展示成已保存。
2. Agent skills allowlist 与保存前一致，不出现半写入、空 allowlist 或重复脏数据。
3. UI 可恢复到保存前选择；恢复连接后可再次保存。
4. 失败不影响普通文本对话、模型选择或进入聊天页。

### 3.6 断连与不可用文案

1. 在 Gateway 未连接或桌面窗口停留在连接状态时进入聊天页。
2. 点击或观察 `SkillHub` 下拉。

预期结果：

1. 下拉不可用时显示明确文案：`SkillHub 暂不可用`。
2. 不显示空白列表、假数据或 bundled skills 作为兜底数据。
3. 恢复 Gateway 连接后，下拉可重新加载 SkillHub skills。

### 3.7 基线回归

1. 保存 skill 后，发送一条普通文本消息。
2. 切换模型选择控件，确认原模型选择交互仍可用。
3. 切换到未选择 skill 的新会话，确认聊天页仍可正常打开。

预期结果：

1. 文本对话 P0 baseline 不破坏。
2. 模型选择不受 SkillHub 下拉影响。
3. Gateway 不崩溃，聊天页无白屏。

## 4. 失败排查

1. 下拉不出现：先运行 `node scripts/verify-skillhub-chat-dropdown.js`，确认 patch 已注入聊天页 bundle。
2. 页面停在连接页：先确认 Gateway `http://127.0.0.1:18789/` 返回 `200`，并检查桌面窗口是否已完成连接。
3. 断连或 Gateway 不可用：下拉必须显示 `SkillHub 暂不可用`；若显示假数据或空白不可通过。
4. 下拉为空：确认本地是否存在非 bundled 的 SkillHub skills；空态可以接受，展示 bundled 不可接受。
5. 旧 skills 丢失：回到原版 `Agents -> Skills` 面板对照保存前 allowlist，视为保存逻辑失败，不通过验收。
6. 新 skill 未在新会话生效：确认是否已新建会话；第一版不要求当前 session 即时生效，但新会话必须可见或可用。
7. 保存失败：检查是否能在原版 `Agents -> Skills` 面板保存同一 Agent skills 配置，并确认失败后配置未变脏。
8. 当前会话未立即获得工具：不视为失败；第一版只承诺新会话生效。

## 5. 不可接受项

1. 下拉展示 OpenClaw bundled skills。
2. 为聊天页新增独立 chat-level skill runtime。
3. 绕过 OpenClaw `skills.status`、Agent skills config 或原版 runtime 链路。
4. 使用旧 `api.skillhub.cn/api/v1/skills` 作为聊天页数据源。
5. UI 文案承诺当前 session 或本条消息立即生效。
6. 为隐藏 bundled skills 删除底层 bundled skills。
7. 修改 `u-claw-app`、`product` 或底座文件以通过验收。
8. 保存新增 skill 时覆盖、清空或丢弃旧 skills allowlist。
9. 保存失败后配置变脏、无法恢复，或 UI 把失败状态伪装成已保存。
10. Gateway 断连时不显示 `SkillHub 暂不可用`。
11. 未完成已连接桌面或 connected UI 自动验收前，将能力矩阵状态改为 `OK`。

## 6. 通过后如何更新能力矩阵

在已连接 Gateway 的桌面窗口或 connected UI 自动验收完成前，能力矩阵必须保持 `Blocked`。验收通过后，修改：

```txt
docs/多人开发/SkillHub能力矩阵.md
```

建议更新方式：

1. 找到“聊天页 SkillHub 下拉”对应行。
2. 将状态从 `Blocked` 改为 `OK`。
3. 在“验证命令/截图”中补充本清单路径、Gateway `200`、静态验证脚本结果、connected UI 验收脚本输出、桌面窗口截图或人工验收记录。
4. 在“风险”中保留“当前 session 即时生效未承诺，第一版为新会话生效”。
5. 保留权限确认、事务恢复、ZIP import 等未验收能力为 `Blocked`。
