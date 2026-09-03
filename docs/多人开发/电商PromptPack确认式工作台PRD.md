# 电商 Prompt Pack 确认式工作台 PRD

更新时间：2026-09-03

## Problem Statement

当前“电商主图/详情图”工作台已经能选择平台、上传参考图、选择主图/详情图/模特图并直接生图，但用户在点击生成前看不到系统将如何理解商品、参考图、平台规则和图片任务。结果一旦不符合预期，就会产生额度消耗、等待时间和返工成本。

用户需要的是“少操作直出好图”，但不是完全黑盒直出。更合理的体验是：先基于 Skill 和参考图生成一组可读、可编辑、可确认的 Prompt Pack；用户确认后再调用图片接口生图。这样既保留效率，又让扣费前的方向、文案、构图和合规边界可控。

## Solution

采用设计稿 A“三栏快流”重构当前工作台：

1. 左栏为任务输入：平台、商品资料、输出类型与张数、风格/比例、参考图。
2. 中栏为 Prompt Pack：系统先生成图片策划、Storyboard 和逐图 Prompt，用户可逐张查看、编辑、通过或重生。
3. 右栏为生成结果：展示当前大图、缩略图横向滚动、逐张进度、生成记录、打包下载。

核心链路从“填写资料 -> 直接生图”调整为：

```text
填写资料 -> 生成 Prompt Pack -> 确认 Prompt Pack -> 生成图片 -> 本地保存/扣费/记录
```

参考仓逻辑映射：

- `ecommerce-visual-copywriting-skill` 提供转化驱动力、Campaign Style Lock、Storyboard、合规自审。
- `ecom-details-image` 提供 25 个模板映射、Prompt Pack 结构、参考图传入生图思想。
- Bavi-box 只内化规则与交互，不复制外部独立 API key 路径，不调用外部 `generate_image.py`。

## User Stories

1. As a seller, I want Bavi-box to generate prompts before images, so that I can confirm the direction before spending image quota.
2. As a seller, I want uploaded reference images to influence the prompt plan, so that product shape, color, packaging and SKU facts are preserved.
3. As a seller, I want platform rules applied automatically in the prompt, so that I do not need to know platform dimensions and restrictions.
4. As a seller, I want one Prompt Pack to cover main images, detail images and model images, so that a whole product visual set stays consistent.
5. As a seller, I want each planned image to have a clear role, so that main images do not repeat the same selling point.
6. As a seller, I want detail images to be a sequence, so that buyers see hook, benefit, proof, specs, use cases and CTA in order.
7. As a seller, I want model-image prompts to be separated from product-image prompts, so that try-on, ghost mannequin and lifestyle images follow different rules.
8. As a seller, I want to edit a single prompt, so that I can fix wording or composition without regenerating the whole pack.
9. As a seller, I want to approve or reject each prompt card, so that only confirmed slots enter image generation.
10. As a seller, I want a regenerate-prompt action, so that I can get another plan without consuming image quota.
11. As a seller, I want the primary button to show the correct next action, so that I know whether I am generating prompts, confirming prompts, or generating images.
12. As a seller, I want changing task data after confirmation to create a new task state, so that old prompt/image results do not mix with new product data.
13. As a seller, I want generated images to appear one by one, so that I can inspect early images while later slots are still running.
14. As a seller, I want generated images saved locally immediately, so that upstream URLs or app refreshes do not lose results.
15. As a seller, I want prompt text saved in the manifest, so that I can audit why a result looked a certain way.
16. As a maintainer, I want prompt generation and image generation to be separate IPC contracts, so that image billing only happens after image API success.
17. As a maintainer, I want request-scoped state isolation, so that two products generated in sequence never merge results.
18. As a maintainer, I want deterministic UI tests for the Prompt Pack state machine, so that button states and cache behavior do not regress.

## Product Flow

### Entry

1. 用户打开左侧“工作流”。
2. 点击“电商主图/详情图”。
3. 默认进入三栏工作台，不进入聊天会话，不新建 OpenClaw session。

### Step 1：任务输入

左栏包含：

| 区域 | 控件 | 行为 |
| --- | --- | --- |
| 平台 | Select | 默认读取上次平台；无缓存时默认抖音电商；切换平台会更新尺寸、语言、张数上下限和合规提示 |
| 商品名称 | Input | 建议填写；若卖点为空则必填 |
| 类目 | Input/Select | 可选；影响模板和合规风险 |
| 核心卖点 | Textarea | 建议填写；支持一行一个卖点；若商品名为空则必填 |
| 目标人群 | Input | 可选；为空时使用平台默认购物人群 |
| 输出类型 | Checkbox/Segmented | 主图、详情图、模特图独立选择；至少选择一项 |
| 张数 | Compact stepper | 按平台和类型限制上下限；总量仍受主进程 hard cap |
| 图片语言 | Select | 国内平台默认中文；Amazon/Shopee/Alibaba 默认 English；可手动覆盖 |
| 风格 | Select/Chip | 平台自动、白底主图、信息图、生活方式、UGC、模特展示等 |
| 比例 | Select/Chip | 平台自动、1:1、3:4、4:5、16:9、9:16、详情竖版 |
| 参考图 | Dropzone + thumbnails | 支持点击上传、拖拽、Cmd/Ctrl+V 粘贴；最多 12 张；每张显示删除按钮 |

输入最小门槛：

- 至少 1 张参考图。
- 商品名称或核心卖点至少有一项。
- 至少选择一种输出类型。

### Step 2：生成 Prompt Pack

用户点击“生成 Prompt Pack”后：

1. 前端生成新的 `requestId` 和 task signature。
2. 调用 trusted process 的 Prompt Pack IPC。
3. 主进程基于平台 preset、输出类型、张数、参考图摘要、商品信息和 Skill 规则生成结构化 Prompt Pack。
4. 中栏展示 Prompt Pack，不触发图片接口，不扣图片额度。
5. 生成记录新增一条 `prompt_ready` 或 `prompt_failed` 任务。

Prompt Pack 结构：

```json
{
  "requestId": "string",
  "status": "prompt_ready",
  "strategy": {
    "conversionDriver": "visual|pain|rational|emotional",
    "campaignStyleLock": {
      "palette": ["#FFFFFF", "#2457E6", "#171A1F"],
      "lighting": "string",
      "layout": "string",
      "forbiddenDrift": ["string"]
    },
    "complianceRisk": "low|medium|high",
    "assumptions": ["string"],
    "missingEvidence": ["string"]
  },
  "slots": [
    {
      "id": "KV1",
      "type": "main_image",
      "title": "首图：白底清晰截流",
      "purpose": "click",
      "template": "hero-image",
      "size": "1024x1024",
      "copy": ["清晰打印"],
      "prompt": "string",
      "negativePrompt": "string",
      "reviewStatus": "pending|approved|rejected|edited",
      "qa": ["product_accuracy", "platform_size", "text_readability"]
    }
  ]
}
```

### Step 3：确认与编辑

中栏 Prompt Pack 行为：

- 默认展开第一张 Prompt，其他卡片折叠显示摘要。
- 点击卡片可切换当前 Prompt。
- 点击“编辑”进入 inline textarea，保留原 Prompt，可取消。
- 编辑后卡片状态变为 `edited`，并要求重新确认。
- 点击“通过”将单卡标记为 `approved`。
- 点击“拒绝”将单卡标记为 `rejected`，默认不参与生图。
- 点击“重生此张”只重生当前 slot Prompt，不改变其他 slot。
- 点击“重生整组”生成新 Prompt Pack version，旧 version 进入历史，不覆盖已生成图片。
- 高风险合规项必须显示“需要人工复核”，用户仍可继续，但 manifest 记录 `humanReviewRequired=true`。

确认规则：

- 默认要求所有非 rejected slot 都 `approved` 后，主按钮才显示“确认并生成图片”。
- 若存在 `pending` 或 `edited` slot，主按钮 disabled，并提示“还有 N 张 Prompt 待确认”。
- 若全部 rejected，主按钮 disabled，并提示“至少保留 1 张可生成图片”。

### Step 4：生成图片

用户点击“确认并生成图片”后：

1. 前端将 `approved` slots、参考图和 task signature 发送到现有图片生成 IPC。
2. 主进程逐张调用图片接口。
3. 每张成功后立即 materialize、保存到本地电商图片库、发 progress event。
4. 右栏即时显示第一张图，缩略图横向追加。
5. 图片接口成功后进入用量同步；失败 slot 不走 fallback 扣费。
6. 生成结束后写 manifest，manifest 包含原始输入、平台 preset、Prompt Pack、图片、本地路径、用量结果和 warning。

### Step 5：结果与记录

右栏包含：

- 当前大图预览：点击打开 swiper 放大。
- 缩略图横向滚动：点击只切换大图，不下载。
- 单图下载：在大图操作区提供 icon button。
- 打包下载：导出 ZIP，包含图片、`manifest.json`、`prompts.json` 或 `prompts.md`。
- 打开文件夹：只允许打开可信电商图片库目录。
- 重试同步用量：仅当 billing warning 存在时显示。
- 删除记录：首击显示二次确认；确认后写删除 tombstone，刷新后不复活；不删除本地图片文件。

## State Machine

```text
draft
  -> prompt_generating
  -> prompt_ready
  -> prompt_editing
  -> prompt_confirmed
  -> image_generating
  -> image_partial
  -> image_completed
  -> usage_synced
```

错误状态：

```text
prompt_failed
image_failed
usage_sync_failed
interrupted
deleted
```

状态定义：

| State | 用户可见文案 | 主按钮 | 可编辑输入 | 可编辑 Prompt | 备注 |
| --- | --- | --- | --- | --- | --- |
| draft | 待生成提示词 | 生成 Prompt Pack | Yes | No | 表单变更保持草稿 |
| prompt_generating | 正在生成提示词 | 生成中 | No | No | 禁止重复提交 |
| prompt_ready | 待确认提示词 | 确认并生成图片 | Yes | Yes | 若有 pending，按钮 disabled |
| prompt_editing | 正在编辑提示词 | 保存后确认 | Yes | Yes | 编辑单卡 |
| prompt_confirmed | 提示词已确认 | 生成图片 | No | No | 可返回编辑，会变回 prompt_ready |
| image_generating | 正在生成图片 | 任务已创建 | No | No | 逐张 progress |
| image_partial | 部分生成 | 继续/重试失败项 | No | No | 成功图片保留 |
| image_completed | 已完成 | 基于当前资料新建任务 | Yes | No | 输入变更即新任务 |
| usage_synced | 已扣费 | 创建新任务 | Yes | No | 记录展示已同步 |
| usage_sync_failed | 扣费待同步 | 重试同步用量 | No | No | 不影响图片下载 |

## Primary Button Logic

主按钮以 task signature 决定语义：

| 条件 | 文案 | 状态 |
| --- | --- | --- |
| 缺参考图 | 请先上传参考图 | disabled |
| 缺商品名且缺卖点 | 请补充商品信息 | disabled |
| 无输出类型 | 请选择输出类型 | disabled |
| 当前无 Prompt Pack | 生成 Prompt Pack | enabled |
| Prompt Pack 生成中 | 正在生成提示词 | disabled |
| Prompt Pack 与当前输入不一致 | 生成新的 Prompt Pack | enabled |
| 有 pending/edited Prompt | 还有 N 张待确认 | disabled |
| 有 approved Prompt 且无 pending/edited | 确认并生成图片 | enabled |
| 图片生成中 | 任务已创建 | disabled |
| 生成完成且输入未变 | 基于当前资料新建任务 | enabled |
| 输入已变 | 创建新任务 | enabled |

关键原则：

- 数据变了就不是“重新生成”，而是“新任务”。
- Prompt Pack 已确认后再改输入，必须提示“资料已变化，需要生成新的 Prompt Pack”。
- 旧结果保留在记录中，右栏当前结果只显示当前 request。

## Interaction Details

### 左栏输入

- 平台切换后，若已有 Prompt Pack，标记为 stale，不自动覆盖。
- 张数 stepper 采用 28-30px 高度紧凑控件，不使用大卡片。
- 参考图删除只影响草稿，已生成 manifest 不被改写。
- 粘贴上传时若剪贴板没有图片，不弹错误，只显示轻提示。
- 拖拽进入 dropzone 时显示边框高亮；离开恢复。

### 中栏 Prompt Pack

- 卡片头部一行显示 `slot id + 标题 + 状态 chip + 操作 icon`。
- Prompt 文本默认最多显示 4 行，点击展开。
- 编辑 textarea 最小高度 120px，宽度跟随中栏，不引起横向滚动。
- 每张 Prompt 保留 version 和 `updatedAt`。
- “重生此张”需要二次确认，避免误覆盖编辑内容。
- `approved` 卡片若再次编辑，自动回到 `pending`。

### 右栏结果

- 大图区域保持稳定高度，空态、loading、失败态不能撑变布局。
- 进度显示 `已出 X / 计划 Y`，真实图片数优先于计划数。
- 缩略图单行横向滚动，不换行。
- 点击缩略图只切换大图。
- 删除记录用红色 icon，确认态使用窄按钮，不挤压记录标题。
- 记录分页/折叠保持当前已有紧凑策略。

## Data And Persistence

本地缓存：

- `uclaw.ecommerceWorkbench.draft.v1`：保存表单字段、平台、输出类型、张数、语言、风格、比例。
- `globalThis.__uclawEcommerceDraftFiles`：同 renderer 生命周期内保存 File/objectURL。
- `uclaw.ecommerceImageRecords.v1`：保存轻量记录，不持久化大 dataUrl。
- `uclaw.ecommerceImageRecordDeletes.v1`：保存删除 tombstone，防止本地 manifest 刷新复活。

新增建议：

- `uclaw.ecommercePromptPacks.v1`：保存最近 Prompt Pack 摘要、slot prompt、reviewStatus、version、task signature。
- `manifest.json` 新增 `promptPack` 字段。
- ZIP 导出新增 `prompts.md` 和 `prompts.json`。

持久化原则：

- 图片生成后立即保存本地。
- Prompt Pack 与图片结果按同一 `requestId` 绑定。
- 前端当前结果、progress、final response、catch fallback 必须按 `requestId` 隔离。
- 刷新后优先从本地 manifest hydrate 图片和 Prompt Pack。

## API / IPC Contract

### 新增：生成 Prompt Pack

```ts
window.uclaw.generateEcommercePromptPack(payload)
```

Payload：

```json
{
  "requestId": "string",
  "platform": "douyin",
  "language": "zh-CN",
  "visualStyle": "platform_auto",
  "aspectRatio": "platform_auto",
  "input": {
    "name": "空气墨盒",
    "category": "办公耗材",
    "audience": "电商购物人群",
    "sellingPoints": ["大容量", "打印清晰"]
  },
  "outputTypes": ["main_image", "detail_image"],
  "outputCounts": {
    "main_image": 3,
    "detail_image": 5
  },
  "images": [
    {
      "fileName": "product.jpg",
      "mimeType": "image/jpeg",
      "buffer": "ArrayBuffer"
    }
  ]
}
```

Response：

```json
{
  "requestId": "string",
  "promptPackId": "string",
  "version": 1,
  "status": "prompt_ready",
  "strategy": {},
  "slots": []
}
```

### 调整：生成图片

现有 `generateEcommerceImages` 保留，但 payload 新增：

```json
{
  "promptPackId": "string",
  "promptPackVersion": 1,
  "approvedSlots": [
    {
      "id": "KV1",
      "type": "main_image",
      "prompt": "string",
      "size": "1024x1024"
    }
  ]
}
```

主进程必须收到非空 `approvedSlots` 才允许调用图片接口；缺少已确认 slot 时直接返回“请先生成并确认 Prompt Pack，再生成图片”。旧的直接生图 fallback 不再作为工作台入口使用，避免绕过扣费前确认门。

## Implementation Decisions

- 不创建 OpenClaw 聊天会话。
- 不调用“龙虾”能力，不走 `chat.send`。
- 不引入独立 `IMG_API_KEY` 或外部 `generate_image.py`。
- Prompt Pack 生成可先由本地模板规则实现，后续再接可识图模型增强参考图理解。
- 参考图在 Prompt 阶段首版只进入“文件名、数量、类型、用户输入摘要、平台规则”的结构化上下文；图片真实像素仍在生图阶段传给 `/images/edits`。
- 若要让 Prompt 生成真正识别参考图内容，需新增视觉理解能力或复用已配置 multimodal model；此为增强项，不阻断首版。
- 页面按 A 方案三栏实现，窄屏降为单栏顺序：输入 -> Prompt Pack -> 结果。
- 三栏之间用细分隔线和紧凑 surface，不做大卡片堆叠。
- 所有 visible UI patch 仍通过 `scripts/patch-openclaw.js`，生成产物不是权威源。

## Testing Decisions

测试只看外部行为：

- 静态 verifier 检查新增 IPC、Prompt Pack 状态、A 方案关键 token、Service Worker cache marker。
- UI verifier 覆盖桌面 1440、窄栏 1100、移动 390。
- Prompt Pack fixture 覆盖主图 3、详情 5、模特 1 的 slot 生成。
- 按钮态测试覆盖缺图、缺商品信息、生成 Prompt、待确认、已确认、生图中、已完成、输入变更。
- 编辑 Prompt 测试覆盖编辑后回 pending、确认后进入 approved。
- 连续任务测试覆盖“纸巾 -> 杯子”：Prompt Pack、当前结果、缩略图、记录均不混。
- 缓存测试覆盖切换模型/工作流后，表单、参考图、Prompt Pack、当前结果不丢。
- ZIP 测试覆盖导出图片、manifest、prompts.md、prompts.json。
- 用量测试确认：生成 Prompt Pack 不扣费；图片成功后才扣费；失败 slot 不扣 fallback 费用。

## Out of Scope

- 真正的多用户审批流。
- 云端素材库和跨设备同步。
- 批量队列。
- 平台自动上传或自动发布。
- 法律合规最终结论。
- 保证参考图内容被视觉模型完全识别。
- 大规模模板管理后台。

## Acceptance Criteria

- 用户能在当前电商工作台点击“生成 Prompt Pack”，且不会创建聊天会话。
- Prompt Pack 生成成功后，用户能看到每张主图/详情图/模特图的标题、用途、模板、Prompt、QA 和状态。
- 用户能编辑、通过、拒绝、重生单张 Prompt。
- 未确认的 Prompt 不会进入图片生成。
- 点击“确认并生成图片”后，沿用现有逐张进度、当前页预览、本地保存、用量同步和记录链路。
- 生成 Prompt Pack 不产生 NewAPI 图片消耗。
- 图片生成成功才进入用量同步。
- 页面在 1440 宽为三栏，在更小宽度自动堆叠，无横向溢出。
- 切换页面再回来，表单、参考图、Prompt Pack 和当前结果仍保留。
- 连续生成不同商品时，右侧当前结果只显示当前 request。
- 删除记录刷新后不复活。
- 导出的 ZIP 包含图片、manifest、prompts.md、prompts.json。

## Further Notes

设计稿选用：

- [Prompt Pack A/B/C 设计稿 HTML](../../.codex-state/product-design/ecommerce-prompt-pack-redesign.html)
- [Prompt Pack A/B/C 设计稿 PNG](../../.codex-state/product-design/ecommerce-prompt-pack-redesign.png)

推荐优先实现 A 方案。B 方案可作为未来“严格审核模式”，C 方案可作为高频看图用户的后续布局变体。

首版实现顺序建议：

1. 新增 Prompt Pack 数据结构、IPC 和模板生成。
2. 前端加入 Prompt Pack 中栏和按钮状态机。
3. 让图片生成 payload 支持 `approvedSlots`。
4. manifest/ZIP 写入 Prompt Pack。
5. 补静态 verifier 和 connected UI verifier。
