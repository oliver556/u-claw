# 电商主图/详情图工作流 PRD

更新时间：2026-08-31

## Problem Statement

Bavi-box 需要把“电商主图/详情图”从一次普通聊天请求升级为用户可理解、可复用、可验收的工作流。用户真正需要的不是直接生成几张看起来漂亮的图片，而是先判断商品资料是否足够、卖点能否合规表达、整套视觉如何保持一致，再进入主图、详情页、Prompt、可选出图和 QA。

当前已有研究文档证明，`ecommerce-visual-copywriting` 适合做上游视觉策划、合规边界、Campaign Style Lock 和 Storyboard；`ecom-details-image` 适合做下游模板匹配、Prompt Pack 和可选图片生成。但两个项目不是现成的一键产品，直接塞进 UI 会形成“看起来可用、实际缺状态机和验收”的残缺能力。

本功能必须遵守 Bavi-box 当前架构边界：复用 OpenClaw Skill、Agent、Session、图片模型和 Gateway 能力，不自造 workflow runtime，不绕过现有模型/API 配置，不把外部脚本里的 API key 配置方式带入产品。

## Solution

在左侧“工作流”入口中新增“电商主图/详情图”工作流卡片。用户点击后进入一个受控工作流会话：系统检查所需 Skill 是否可用，创建或进入专用 Agent/session，按阶段引导用户完成商品资料、合规边界、视觉策划、Storyboard、Prompt Pack、可选出图和 QA。

首版定位为“工作流启动器 + 专用会话 + 阶段确认门”，不是可视化拖拽编排器。UI 只展示已验证真实能力；未验证的直接出图、批量队列、素材库、平台上传包等能力必须标记为不可用或放入后续版本。

推荐版本拆分：

1. V0：Prompt-only 工作流。安装/内置专用 Skill 后，通过专用会话完成资料审查、视觉策划、Storyboard、Prompt Pack 和 QA 文档，不直接调用外部生图脚本。
2. V1：受控出图。确认 OpenClaw/Bavi-box 图片生成工具和当前图片模型配置可用后，由工作流调用现有图片生成链路生成图片，并保留人工 QA。
3. V2：产品化工作台。增加 SKU 资产、版本管理、批量队列、平台规格库、图片对比标注和导出包。

## User Stories

1. As a Bavi-box user, I want to find “电商主图/详情图” under 工作流, so that I can start ecommerce image production from a task-oriented entry.
2. As a Bavi-box user, I want the workflow to tell me whether required skills are available, so that I do not enter a broken flow.
3. As a Bavi-box user, I want missing product information clearly listed, so that I know what must be supplied before serious visual planning.
4. As a Bavi-box user, I want to provide product category, platform, SKU, specifications, selling points, qualifications and reference images, so that the workflow can plan around real evidence.
5. As a Bavi-box user, I want compliance risk called out before image planning, so that risky claims are removed early.
6. As a Bavi-box user, I want ordinary food, health food, sports/body-management and ordinary goods treated differently, so that output does not cross advertising or platform limits.
7. As a Bavi-box user, I want Feature -> Advantage -> Benefit -> Evidence translation, so that product facts become user-understandable selling points.
8. As a Bavi-box user, I want Campaign Style Lock generated before individual images, so that the whole package keeps consistent color, lighting, typography and product presentation.
9. As a Bavi-box user, I want the workflow to pause after the strategy plan, so that I can confirm direction before detailed work starts.
10. As a Bavi-box user, I want a 5-image main-image storyboard, so that each image has a distinct conversion task.
11. As a Bavi-box user, I want a 7-9 module detail-page storyboard, so that the detail page follows a conversion narrative instead of random image stacking.
12. As a Bavi-box user, I want the workflow to pause after Storyboard, so that I can prevent expensive rework before Prompt generation.
13. As a Bavi-box user, I want each planned image to output scene description, in-image copy, design notes, prompt and negative constraints, so that designers or AI tools can execute it.
14. As a Bavi-box user, I want Prompt-only mode when image API is unavailable, so that planning work still produces useful deliverables.
15. As a Bavi-box user, I want optional direct generation only when Bavi-box image model configuration is available, so that generation uses the existing model chain and billing visibility.
16. As a Bavi-box user, I want reference product images passed into generation when possible, so that product appearance is less likely to drift.
17. As a Bavi-box user, I want generated Chinese text flagged for manual checking, so that wrong characters or unreadable small text are caught before publishing.
18. As a Bavi-box user, I want product-accuracy QA, so that generated images do not invent packaging, logos, functions or physical details.
19. As a Bavi-box user, I want compliance QA after output, so that final materials still avoid unsupported claims.
20. As a Bavi-box user, I want failed or incomplete stages to preserve prior output, so that I can revise only the failing part.
21. As a Bavi-box user, I want every stage to expose assumptions, so that missing facts are not silently invented.
22. As a Bavi-box user, I want the workflow conversation saved as a normal session, so that I can resume the case later.
23. As a Bavi-box user, I want the session label to include the workflow name and product name when available, so that I can find previous SKU work quickly.
24. As a Bavi-box maintainer, I want the workflow to use OpenClaw Skill and Agent/session interfaces, so that Bavi-box does not fork runtime behavior.
25. As a Bavi-box maintainer, I want external skills packaged into OpenClaw-readable `SKILL.md` directories, so that installation and allowlist binding stay compatible.
26. As a Bavi-box maintainer, I want direct image generation to go through existing image model configuration, so that keys, providers and usage are not duplicated.
27. As a Bavi-box maintainer, I want unverified workflow builder features hidden or disabled, so that UI does not imply unavailable runtime support.
28. As a Bavi-box maintainer, I want targeted verifiers for the new workflow entry, so that future OpenClaw Control UI changes fail fast.

## Implementation Decisions

- The feature lives under the existing left-side 工作流 information architecture.
- The first release is a workflow launcher and specialized conversation flow, not a new workflow engine.
- The workflow runtime authority is OpenClaw Skill + Agent/session. Bavi-box must not create a separate skill executor.
- `ecommerce-visual-copywriting` is the upstream strategy skill: intake, compliance boundary, conversion-driver diagnosis, Campaign Style Lock, strategy plan, Storyboard and self-review.
- `ecom-details-image` is the downstream prompt/template skill: template mapping, image brief, Prompt Pack and optional generation rules.
- External skill content must be repackaged or installed in an OpenClaw-readable skill directory before appearing as usable.
- If a required skill is missing, the workflow card can show setup guidance, but must not claim the workflow is ready.
- Prompt-only is the safe first version because it avoids key handling, provider mismatch and direct generation reliability risks.
- Direct generation must use Bavi-box/OpenClaw image generation configuration and current image model selection where possible.
- The external `IMG_BASE_URL`, `IMG_MODEL`, `IMG_API_KEY` style config must not become a second product-level model configuration path.
- The workflow should create or enter a dedicated Agent/session, with a stable system prompt that enforces the staged process and confirmation gates.
- Strategy confirmation and Storyboard confirmation are mandatory gates unless the user explicitly chooses a fast mode.
- Fast mode may skip pauses only by using clear assumptions and still producing compliance and QA sections.
- Output artifacts are initially conversation-native Markdown sections. Separate file export, ZIP, SKU asset storage and version repository are later versions.
- The interface should show stage state such as 未开始, 资料不足, 策划待确认, 分镜待确认, Prompt 已生成, 出图待配置, QA 待处理 and 已完成.
- Workflow card actions should be limited to verified actions: start, continue, view sessions, install/setup skill and open model configuration if needed.
- The workflow must not invent certificates, patents, approvals, sales data, reviews, test reports or medical/health claims.
- For high-risk categories, the workflow must default to conservative neutral expression and mark assumptions.
- Work should remain inside the active development tree and use the existing Control UI patch pipeline if UI changes are later implemented.

## Testing Decisions

- Test at the highest stable seams: workflow entry rendering, Skill availability readback, Agent/session creation, required skill binding, staged prompt behavior and optional image generation readiness.
- Static verifier should assert that the left-side 工作流 page exposes “电商主图/详情图” only through the supported workflow entry and does not add fake builder controls.
- Skill packaging verifier should assert that both upstream and downstream skills have valid `SKILL.md` frontmatter names, descriptions, required references and no real API keys.
- Runtime verifier should read installed skills through OpenClaw skill status and confirm bundled skills are not being used as user-facing substitutes.
- Agent/session verifier should create a test workflow session, read back the label and confirm the dedicated prompt/skill binding is present.
- Prompt-only acceptance should run with no image API key and still produce intake checklist, strategy plan, Storyboard, Prompt Pack and QA checklist.
- Direct-generation acceptance should be separate from Prompt-only and only pass when an actual configured Bavi-box image model can generate and return media through the current visible reply contract.
- Compliance tests should use fixtures for ordinary goods, ordinary food, health food and sports/body-management categories to verify redline behavior.
- QA tests should verify that unsupported evidence, absolute claims and generated-text risks are surfaced rather than hidden.
- UI acceptance should include desktop and narrow viewport screenshots once visible UI is implemented.
- Packaging acceptance must verify the new entry survives `patch-openclaw`, local Gateway startup and portable package preparation.

## Out of Scope

- Visual drag-and-drop workflow builder.
- Independent workflow runtime outside OpenClaw tasks, Skill, Agent or session mechanisms.
- Direct use of an external `.env` image API path as Bavi-box product configuration.
- Legal advice, platform approval guarantee or automatic compliance certification.
- Automatic ecommerce listing upload or ad campaign publishing.
- SKU material library, multi-round version repository, team review permissions and batch queue in V0.
- Generating final marketplace-ready images without human QA.
- Rewriting OpenClaw Gateway, chat runtime, model routing or portable packaging logic.

## Acceptance Criteria

- 工作流入口出现于左侧“工作流”用户视图，名称为“电商主图/详情图”。
- 未验证的 builder、批量队列、素材库、平台上传功能不显示为可用按钮。
- 所需 Skill 缺失时，入口显示 setup/unavailable 状态，不启动假流程。
- Skill 安装或绑定后，可创建/进入专用 workflow session。
- Prompt-only 模式在无图片 API 配置时仍可完整交付策划、分镜、Prompt 和 QA。
- 策划案输出后暂停确认，包含转化驱动力、Campaign Style Lock、利益翻译表、合规边界和缺失信息。
- Storyboard 输出后暂停确认，包含 5 张主图任务分配和 7-9 个详情页模块。
- 最终执行稿逐图包含画面描述、图内文案、设计说明、生图 Prompt 和负面约束。
- QA 至少覆盖合规性、利益翻译度、视觉第一落点、触感/媒介表达、叙事连贯性、中文字核对和产品准确性。
- 普通食品、保健食品、运动器材/体态管理等高风险场景不能输出未经证据支持的功效承诺。
- 直接出图入口只有在 Bavi-box/OpenClaw 图片模型配置可读且生成链路已验证时可用。
- 工作流不会读取、展示、提交或复制真实 API key。
- 新 UI patch 必须有静态 verifier，并更新 Service Worker cache marker。
- 本地验证至少包含 `patch-openclaw`、相关 verifier、Gateway HTTP 200 和一轮手工页面检查。

## Further Notes

本 PRD 基于外部调研文档《电商主图与详情页生成工作流调研》、现有 `SkillHub` 能力矩阵、四分左栏 IA 文档和 Bavi-box 多人开发硬性要求。

优先推荐下一切片：先落 Prompt-only V0，包括 Skill 包审计、能力矩阵更新、工作流入口文案、专用 Agent/session 启动和一个真实 SKU 手工验收。直接出图留到 V1，在确认图片模型工具链、参考图传递和生成媒体回传后再开放。
