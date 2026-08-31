# 电商主图/详情图直出工作台 PRD

更新时间：2026-08-31

## Problem Statement

用户真正想要的不是学习 Bavi-box / OpenClaw 的聊天、Skill、Agent 或任务机制，而是把商品图片和少量商品信息交给系统，直接得到尽量可用、尽量好看的电商主图和详情图结果。

因此“电商主图/详情图”不应表现为 OpenClaw 原生工作流，也不应要求用户在聊天里逐轮描述。它应是一个独立产品工作台：用户选择平台，上传商品图，填写最少必要信息，点击生成，系统自动套用平台规格、合规红线、图片质量检查、构图策略和输出格式，最后给出可下载的图片与文案结果。

底层仍可复用 Bavi-box 已验证能力：图片模型配置、媒体上传/回传、Session 留痕、Skill 规则、Gateway 调用和用量链路。但这些不应成为用户操作心智。

## Solution

新增“电商主图/详情图”直出工作台。首屏即是生产界面，不是说明页：

1. 选择平台：淘宝/天猫、京东、拼多多、抖音电商、快手小店、小红书、Amazon、Shopee、Alibaba 国际站。
2. 上传素材：商品主图、包装图、细节图、场景参考图、资质/检测/授权图。
3. 填最少信息：商品名、类目、核心卖点、规格、禁用词；其他字段自动推断或作为高级选项折叠。
4. 点击生成：系统自动选择平台规格、输出张数、图片比例、详情页宽度、是否需要白底图、是否允许文字、是否要合规保守模式。
5. 查看结果：主图组、详情页模块、图内文案、平台合规提示、失败原因、重新生成按钮和下载包。

默认目标是“少操作直出”：用户只要完成平台选择、上传至少 1 张商品图、填写商品名或卖点之一，即可开始。信息不足时，系统先出保守版并标注缺口，而不是阻断。

## User Stories

1. As a seller, I want to select a platform preset, so that image size, ratio, file limits and content rules are applied automatically.
2. As a seller, I want to upload product images directly, so that the system can preserve product appearance rather than inventing a product.
3. As a seller, I want the form to require as little text as possible, so that I can generate a usable first version quickly.
4. As a seller, I want advanced fields hidden by default, so that I am not forced to understand every compliance or design setting.
5. As a seller, I want Bavi-box to infer category and risk level from my inputs, so that ordinary goods and high-risk goods are treated differently.
6. As a seller, I want the system to generate platform-sized images, so that I do not need to crop or resize manually.
7. As a seller, I want multiple main-image variants, so that I can pick the best first image for click-through.
8. As a seller, I want a detail-page sequence, so that buyers can understand selling points, specs, evidence and use cases.
9. As a seller, I want text on images to be readable and short, so that the image is usable on mobile search and feed pages.
10. As a seller, I want product-accuracy checks, so that the generated result does not change packaging, color, shape, logo or included accessories.
11. As a seller, I want unsupported claims blocked or softened, so that the output is less likely to violate platform or advertising rules.
12. As a seller, I want failed images to explain why they failed, so that I can regenerate only the broken image.
13. As a seller, I want one-click export by platform, so that I can upload files to the merchant backend with minimal rework.
14. As a maintainer, I want platform presets to be data-driven, so that rule updates do not require rewriting UI logic.
15. As a maintainer, I want official-source confidence recorded per preset, so that we know which rules need merchant-backend confirmation.
16. As a maintainer, I want all generation to use Bavi-box image model configuration, so that API keys, billing and model routing remain centralized.
17. As a maintainer, I want Session records hidden but preserved, so that work can be resumed and audited without turning the feature into a chat-first flow.

## Product Flow

### Default Flow

1. User opens left-side 工作流 -> 电商主图/详情图.
2. User selects platform. Default to last-used platform; if none, default to 抖音电商 for domestic content-commerce users.
3. User uploads at least one product image.
4. User fills either 商品名 or 核心卖点. Optional: 类目、规格、品牌、价格带、参考风格、禁用词、资质。
5. System runs preflight:
   - image quality: resolution, blur, overexposure, background, subject crop;
   - product consistency: main subject, package text, color, SKU count;
   - platform preset: ratio, size, file type, count, white-background requirement;
   - compliance risk: ordinary goods, ordinary food, health food, medical/health, cosmetics, baby products, electronics, sports/body-management.
6. System generates:
   - main image set;
   - detail image modules;
   - image copy and selling-point text;
   - compliance notes;
   - export package.
7. User can accept, regenerate selected image, adjust style, or export.

### Minimal Inputs

| Field | Required | Default / Auto Behavior |
| --- | --- | --- |
| 平台 | Yes | Last-used; otherwise 抖音电商 |
| 商品图片 | Yes | At least 1 image; more images improve consistency |
| 商品名 | Conditional | Required if no selling point text |
| 核心卖点 | Conditional | Required if no product name |
| 类目 | No | Auto infer; user can correct |
| 规格/SKU | No | Auto infer from image/text where possible; otherwise mark unknown |
| 资质/检测/授权 | No | Required only when claim needs evidence |
| 风格偏好 | No | Platform default style |
| 禁用词/禁用元素 | No | Empty by default |

## Platform Presets

Platform rules change frequently and some official pages require login or JavaScript. This PRD defines seed presets as of 2026-08-31. Each preset must store `source_url`, `source_type`, `confidence`, `last_checked_at`, and `needs_backend_confirmation`.

| Platform | Main Image Preset | Detail Image Preset | Key Rules | Source Confidence |
| --- | --- | --- | --- | --- |
| 淘宝/天猫 | 1:1, 800x800 px baseline; HD 1000x1000+; up to 5 images; JPG/PNG | Mobile 750 px common; PC 790 px common; broader published range 620-1500 px width, single image height <=2000 px | White-background image recommended/needed by scenario; avoid watermark, heavy text and unsupported claims | Medium: public spec summary; backend confirmation required |
| 京东 | 1:1 800x800 common seed; category backend must confirm | Width consistent; width >=480 px; height <=1500 px; recommended 750 px; total detail height recommended <=15000 px; single image <=3 MB | Detail images should stay consistent in width and avoid overlong pages | Medium-High for detail page; main image backend confirmation required |
| 拼多多 | Activity/main seed 750x352 px; carousel image >=480 px; JPG/PNG | Width 480-1200 px; height <=1500 px; up to 20 images; single image <=1 MB seed | Main/activity image often requires clean background and no irrelevant text/logo; rules vary by slot | Low-Medium: public summaries conflict; backend confirmation required |
| 抖音电商 | Square main image >=600x600; white/scenario image >=800x800; 3:4 image min 375x500, recommended 750x1000; JPG/JPEG/PNG; main image <=3 MB | Single detail image recommended width 620-1290 px; detail image <=5 MB seed | First main image should be real product image; no full-screen watermark; no unrelated watermark; image quality affects item quality | High for official rule pages and learning center |
| 快手小店 | 1:1 >=800x800 seed; 3-9 images; <=2 MB; PNG/JPEG/WebP/BMP seed | Width 750 px common; up to 20 images; <=2 MB seed | Product count/color/spec must match listing; no platform watermark; white-background slot should be clean | Medium: official creation guide confirms detail count; public spec summary for sizes |
| 小红书 | 800x800 or 750x1000 seed; JPG/JPEG/PNG; <=3 MB seed | Width 750-1242 px seed; total height <=50000 px seed | Clean,真实, non-watermarked, product complete and centered | Low: public summaries only; official merchant backend confirmation required |
| Amazon | Longest side 500-10000 px; recommend 1000+ for zoom; JPEG preferred seed | A+ / description assets vary by module; use 1000+ px clean product/lifestyle images unless module says otherwise | Main image generally pure white, product-only, no extra text/logo/border; strict suppression risk | High for base image size; category-specific rules still needed |
| Shopee | 1:1 image required before optional 3:4; main >=500x500 seed, recommended 1024x1024 | Product description image official page says at least 1000x32 px; public spec summary recommends 900x900+, max 12 images | 3:4 optional cannot replace required 1:1; product should fill frame and remain clear | Medium-High for 1:1/description official pages; some limits need regional backend |
| Alibaba 国际站 | Near-square ratio 1:1 to 1:1.3 or 1.3:1 to 1:1; >350x350 px; <=5 MB | Use near-square/product-detail slots per backend; recommend 750+ px | Main image failing size/ratio/pixel threshold may block publishing or affect diagnosis/ranking | High for official announcement, but age/rule freshness must be watched |

### Source Notes

- 淘宝/天猫 seed: [标记侠淘宝/天猫规格 2026](https://www.biaojixia.com/specs/taobao), plus [淘宝开放平台 AI 商品图服务资质说明](https://open.alitrip.com/docs/doc.htm?articleId=122245&docType=1&source=search&treeId=253) for AI-service boundary.
- 京东 detail seed: [京东帮助中心商品详情页视觉规范](https://helpcenter.jd.com/vender/issue/1000-45916.html), [京麦商详图片规则更新](https://mtt.m.jd.com/article/articleView/180a744d-d813-4833-918f-8f632e0b68d7).
- 抖音电商 official seed: [商品主图发布规范](https://school.jinritemai.com/doudian/web/article/aHean96XQDdv), [商品创建操作指南](https://school.jinritemai.com/doudian/web/article/101669), [3:4 主图及素材图创建说明](https://school.jinritemai.com/doudian/wap/article/aHKu33ExA3nV), [商品详情装修](https://school.jinritemai.com/doudian/web/article/aHMNDfneBibn), [抖音商城管理规范](https://school.jinritemai.com/doudian/web/article/aHRK3WaAk7AN).
- 快手 seed: [快手小店创建商品教程](https://university.kwaixiaodian.com/kwaishop/knowledge/1672), [标记侠快手小店规格 2026](https://www.biaojixia.com/specs/kuaishou).
- Amazon official seed: [Amazon Product image guide](https://sellercentral.amazon.com/help/hub/reference/external/G1881).
- Shopee official seed: [Shopee product description image upload](https://seller.shopee.sg/edu/article/16368/image-product-description), [Shopee 3:4 product images](https://seller.shopee.sg/edu/article/17318/product-images-3-4-ratio).
- Alibaba 国际站 official seed: [Alibaba 商品图片规范公告](https://activity.alibaba.com/page/04cb5e7a.html).
- 拼多多、小红书 seed: public summaries only; must be marked `needs_backend_confirmation=true` until we can confirm from merchant backend/rule center.

## Output Contract

The result should be structured data first, UI second:

```json
{
  "platform": "douyin",
  "presetVersion": "2026-08-31",
  "inputSummary": {
    "productName": "string",
    "category": "string",
    "riskLevel": "low|medium|high",
    "missingEvidence": ["string"]
  },
  "outputs": {
    "mainImages": [
      {
        "slot": "KV1",
        "purpose": "click|trust|detail|scenario|comparison",
        "size": { "width": 800, "height": 800 },
        "fileType": "jpg",
        "imageUrl": "string",
        "copy": ["string"],
        "qa": ["string"]
      }
    ],
    "detailImages": [
      {
        "module": "M1",
        "purpose": "hook|benefit|proof|spec|usage|trust|cta",
        "size": { "width": 750, "height": 1200 },
        "imageUrl": "string",
        "copy": ["string"],
        "qa": ["string"]
      }
    ]
  },
  "compliance": {
    "blockedClaims": ["string"],
    "softenedClaims": ["string"],
    "humanReviewRequired": true
  },
  "exportPackage": {
    "zipPath": "string",
    "manifestPath": "string"
  }
}
```

## Implementation Decisions

- The visible product must be a task-specific workbench, not a chat-first OpenClaw page.
- The workbench may store an internal Session for history, retry and audit, but user-facing controls should be upload, form, generate, regenerate and export.
- Platform presets must be data, not hard-coded UI strings. Each preset needs source and freshness metadata.
- The generation chain must use existing Bavi-box/OpenClaw image model configuration and media handling; no second `IMG_API_KEY` path.
- The first production slice should generate one platform end-to-end before broadening. Recommended first platform: 抖音电商, because official rules are publicly available and 1:1 / 3:4 both matter.
- The UI should not ask the user to choose image dimensions directly unless they open advanced settings.
- If source product image quality is too poor, the system should still offer a conservative output plan, but mark final image generation as low confidence.
- High-risk categories must force human review before export.
- Regeneration should be per image slot, not all-or-nothing.
- Export should include final images, manifest JSON, platform preset version, input summary and compliance notes.

## Testing Decisions

- Platform preset tests should verify selected platform automatically determines image ratios, output counts, file type and detail width.
- Upload preflight tests should cover missing image, low resolution, blurry image, multiple SKU images and unsupported file type.
- Generation acceptance should use a fixture SKU and verify returned media exists, has expected dimensions, and contains a manifest entry.
- Product consistency tests should compare generated result metadata against source image/SKU facts and flag drift.
- Compliance tests should cover ordinary goods, ordinary food, health food, cosmetics and sports/body-management claims.
- UI tests should use desktop and mobile viewport screenshots; the first screen must show the workbench, not a landing page or chat page.
- Source freshness tests should fail or warn when a platform preset is older than the configured refresh interval.

## Out of Scope

- Building a generic visual workflow builder.
- Requiring users to understand OpenClaw Skill, Agent, Session, task queue or prompt stages.
- Direct platform publishing to seller backend.
- Guaranteed platform approval.
- Legal, medical or advertising compliance certification.
- Independent model/API configuration outside Bavi-box.
- Multi-user approval workflow in the first release.

## Acceptance Criteria

- User can select a platform and generate without manually entering image size.
- User can start with one product image and either product name or selling point.
- The first screen is a production workbench with upload/form/results, not chat.
- Platform preset metadata is visible in result details and export manifest.
- The system generates platform-sized main images and detail modules.
- Results include QA status for product accuracy, text readability, platform size and compliance risk.
- High-risk claims without evidence are blocked, softened or marked for human review.
- Direct image generation uses existing Bavi-box image model configuration.
- When image generation fails, prior analysis and successful images remain available.
- Export package includes images plus machine-readable manifest.

## Further Notes

This PRD intentionally replaces the earlier “workflow launcher + Prompt-only session” user experience with a direct-output product workbench. The earlier implementation can still serve as a temporary technical spike, but it is not the desired user-facing shape.

Next implementation recommendation: build a frontend prototype for 抖音电商 first, with platform selector, upload area, minimal form, generated-result placeholder contract, and preset verifier. After that, wire the existing image generation chain.
