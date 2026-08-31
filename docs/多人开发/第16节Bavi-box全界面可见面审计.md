# 第16节 Bavi-box 全界面可见面审计

更新时间：2026-08-23

来源 PRD：`docs/多人开发/第16节Bavi-box全界面改造PRD.md`

## 审计结论

当前第 16 节 UI 改造可分为 8 个任务，且适合长任务推进。可并发部分是审计、验证脚本、文档验收与页面分区文案；集成写入仍应由主 agent 统一改 `scripts/patch-openclaw.js`，避免多个代理同时写同一 patch seam。

2026-08-23 截图反馈修正：当前整体完成度按 70%-75% 记录。前序完成主要是文案、入口、SkillHub 可见性和部分静态验证；视觉品牌层未验收，必须先补 Brand Visual System / Logo 切片，再继续扩大深层 Agents/Chat 文案。

## Task 1 发现

1. Service Worker 默认通知标题仍为 `OpenClaw`。
   - 证据：`u-claw-app-dev/node_modules/openclaw/dist/control-ui/sw.js` 中 push fallback title。
   - 归属：Task 2 / Task 8。

2. Config form 分类仍大量英文。
   - 证据：`config-form-*.js` 中 `Environment Variables`、`Agents`、`Channels`、`Skills`、`Tools`、`Gateway` 等。
   - 归属：Task 6。

3. Config page quick settings 仍有英文长句。
   - 证据：`config-page-*.js` 中 `Choose how much workspace context OpenClaw injects into each run.`、`Save & Publish`、`No MCP servers configured.`。
   - 归属：Task 6。

4. Overview 注意项仍有英文错误/警告标题。
   - 证据：`overview-page-*.js` 中 `Gateway Error`、`Skills with missing dependencies`、`skill(s) blocked`、`cron job(s) failed`、`overdue job`。
   - 归属：Task 2 / Task 8。

5. Skills 页残留安全报告/Skill Card 英文。
   - 证据：`skills-page-*.js` 中 `Refreshing…`、`Full security report`、`Loading Skill Card...`、`Skill Card not loaded.`。
   - 归属：Task 4。

6. Skills 页 `确认风险并安装` 需避免越界解读。
   - 证据：能力矩阵 #13 `High-risk permission confirmation = Blocked`。
   - 归属：Task 4 / Task 8。
   - 处置：后续文案应说明是 OpenClaw 原安装风险确认，不宣称 Bavi-box 事务级权限系统完成。

7. Agents / Tools tab 英文残留明显。
   - 证据：`agents-page-*.js` 中 `Load the gateway config...`、`Tool`、`Enabled Tool`、`Disable`、`Enable`。
   - 归属：Task 5。

8. Agents Skills tab allowlist 文案仍英文。
   - 证据：`agents-page-*.js` 中 `This agent uses a custom skill allowlist.`、`All skills are enabled...`、`Filter`、`shown`。
   - 归属：Task 5。

9. Channels 默认展示多个渠道入口，需另补能力矩阵。
   - 证据：`channels-page-*.js` 默认含 `whatsapp/telegram/discord/googlechat/slack/signal/imessage/nostr`。
   - 归属：Task 5。
   - 风险：当前 SkillHub 能力矩阵未覆盖 Channels；不得把未验证渠道宣称为 Bavi-box 已完成能力。

10. 独立 `tools-page-*.js` 不存在。
    - 证据：active assets 无 `tools-page` bundle；Tools 入口在 Agents page 内。
    - 归属：Task 5 / Task 8。

11. 当前 verifier 只验证应出现的 Bavi-box 文案，不足以覆盖残留扫描。
    - 证据：`verify-skillhub-branding.js` 的 `requiredUiPolishTexts` 为正向断言。
    - 归属：Task 8。

12. 截图显示 Brand Visual System 不成立。
    - 证据：logo 仍像临时红色图标，聊天头像复用该图标；Bavi-box 主色应为 `#1677ff`，但背景、侧栏、选中态、按钮、链接、麦克风、SkillHub 下拉缺少统一的 `#1677ff` 品牌系统。
    - 归属：Task 7。
    - 处置：优先修 logo/头像 asset 与 CSS token，再继续深层 i18n。
    - 2026-08-23 续审：Overview 右侧 workspace 原 light theme 暖灰 `--bg-content:#f4f1ec` 会造成肤色感；处置为冷灰 `--bg-content:#f7f9fc`，卡片保持白色。

13. 截图仍有可见英文残留。
    - 证据：`Assistant`、`The agent run failed before producing a reply.`。
    - 归属：Task 3 / Task 7 / Task 8。
    - 处置：补入 `patch-openclaw.js` 与 `verify-skillhub-branding.js`，避免回流。

## 首个实现切片

本轮先修复最小、高信号、低风险项：

- `sw.js` 默认通知标题改为 Bavi-box，并 bump cache marker。
- Config form 分类标签与描述改为中文/Bavi-box 语义。
- Config page quick settings/MCP 空态改为中文。
- Overview 注意项英文标题改为中文。
- Agents/Tools/Skills 中已定位的高频英文按钮与提示改为中文。
- verifier 增加 Config/Overview/Service Worker 断言。

此切片不新增能力、不改 runtime、不碰模型链路、不改底座文件。
