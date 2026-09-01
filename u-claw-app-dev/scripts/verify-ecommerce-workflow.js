#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const assetsDir = path.join(root, "node_modules", "openclaw", "dist", "control-ui", "assets");
const patchScript = path.join(root, "scripts", "patch-openclaw.js");
const mainProcessFile = path.join(root, "src", "main.js");
const preloadFile = path.join(root, "src", "preload.js");
const skillFile = path.join(
  root,
  "node_modules",
  "openclaw",
  "skills",
  "ecommerce-main-detail-workflow",
  "SKILL.md",
);

/**
 * Reads a UTF-8 file and fails with a useful path when the file is missing.
 */
function readFile(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing file: ${path.relative(root, file)}`);
  }

  return fs.readFileSync(file, "utf8");
}

/**
 * Lists generated tasks page bundles so UI patch drift is caught early.
 */
function listTasksPageAssets() {
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`Missing assets directory: ${path.relative(root, assetsDir)}`);
  }

  const files = fs
    .readdirSync(assetsDir)
    .filter((name) => /^tasks-page-.*\.js$/.test(name))
    .sort()
    .map((name) => path.join(assetsDir, name));

  if (files.length === 0) {
    throw new Error("Missing generated tasks-page asset");
  }

  return files;
}

/**
 * Lists generated CSS bundles so visual shell tokens are verified in the right
 * artifact instead of the tasks-page JavaScript bundle.
 */
function listCssAssets() {
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`Missing assets directory: ${path.relative(root, assetsDir)}`);
  }

  return fs
    .readdirSync(assetsDir)
    .filter((name) => /^index-.*\.css$/.test(name))
    .sort()
    .map((name) => path.join(assetsDir, name));
}

/**
 * Records a missing token without stopping the remaining checks.
 */
function requireToken(errors, label, content, token) {
  if (!content.includes(token)) {
    errors.push(`${label} missing token: ${token}`);
  }
}

/**
 * Evaluates one top-level helper from main.js in isolation for behavior checks.
 */
function evaluateMainHelper(content, name) {
  const start = content.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`Missing helper: ${name}`);
  const nextFunction = content.indexOf("\nfunction ", start + 1);
  const source = content.slice(start, nextFunction === -1 ? content.length : nextFunction);
  return Function(`${source}; return ${name};`)();
}

/**
 * Verifies direct NewAPI calls use the billable /v1 image surface and safe model ids.
 */
function verifyDirectNewApiRouting(errors) {
  try {
    const mainContent = readFile(mainProcessFile);
    const normalizeBaseUrl = evaluateMainHelper(mainContent, "normalizeNewApiImageBaseUrl");
    const normalizeModel = evaluateMainHelper(mainContent, "normalizeEcommerceNewApiModel");

    const cases = [
      ["https://api.example.com", "https://api.example.com/v1"],
      ["https://api.example.com/v1", "https://api.example.com/v1"],
      ["https://api.example.com/v1/", "https://api.example.com/v1"],
      ["https://api.example.com/proxy", "https://api.example.com/proxy/v1"],
    ];
    for (const [input, expected] of cases) {
      const actual = normalizeBaseUrl(input);
      if (actual !== expected) {
        errors.push(`normalizeNewApiImageBaseUrl(${input}) = ${actual}, expected ${expected}`);
      }
    }

    const routed = normalizeModel("newapi/gpt-image-2");
    if (routed.modelRef !== "newapi/gpt-image-2" || routed.requestModel !== "gpt-image-2") {
      errors.push("normalizeEcommerceNewApiModel must keep modelRef and send bare NewAPI model id");
    }
    const bare = normalizeModel("gpt-image-2");
    if (bare.modelRef !== "gpt-image-2" || bare.requestModel !== "gpt-image-2") {
      errors.push("normalizeEcommerceNewApiModel must preserve bare image model ids");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Ensures the desktop-owned image API exists outside the OpenClaw chat/session path.
 */
function verifyDirectDesktopApi(errors) {
  const mainContent = readFile(mainProcessFile);
  const preloadContent = readFile(preloadFile);
  const mainTokens = [
    "resolveEcommerceImageCredential",
    "normalizeNewApiImageBaseUrl",
    "normalizeEcommerceNewApiModel",
    "resolveEcommerceImageTargets",
    "generateEcommerceImagesDirect",
    "requestEcommerceImage",
    "model_image",
    "08-model-showcase",
    "ECOMMERCE_IMAGE_DIRECT_MAX_OUTPUTS",
    "outputCounts",
    "/images/${images.length ? 'edits' : 'generations'}",
    "requestModel",
    "materializeEcommerceImageUrl",
    "materializeEcommerceImageForRenderer",
    "assertPublicEcommerceImageUrl",
    "isPrivateNetworkAddress",
    "ECOMMERCE_IMAGE_REMOTE_MATERIALIZE_MAX_BYTES",
    "recordEcommerceImageUsage",
    "/v1/newapi/usage/ecommerce-image",
    "ECOMMERCE_IMAGE_USAGE_QUOTA_PER_IMAGE",
    "billing",
    "uclaw:ecommerce-generate-images",
    "uclaw:ecommerce-image-progress",
    "emitEcommerceImageProgress",
    "status: 'completed'",
    "status: 'settled'",
    "uclaw:ecommerce-materialize-image",
  ];
  const preloadTokens = [
    "generateEcommerceImages",
    "uclaw:ecommerce-generate-images",
    "onEcommerceImageProgress",
    "uclaw:ecommerce-image-progress",
    "materializeEcommerceImage",
    "uclaw:ecommerce-materialize-image",
  ];

  for (const token of mainTokens) {
    requireToken(errors, "src/main.js", mainContent, token);
  }
  for (const token of preloadTokens) {
    requireToken(errors, "src/preload.js", preloadContent, token);
  }

  if (/configuredModel\.includes\('\/'\)\s*\?\s*configuredModel\.split\('\/'\)\.pop\(\)/.test(mainContent)) {
    errors.push("src/main.js must not blindly strip provider prefixes from ecommerce image model refs");
  }
  if (/const endpoint = images\.length \? '\/images\/edits' : '\/images\/generations';/.test(mainContent)) {
    errors.push("src/main.js must normalize NewAPI baseUrl before appending image endpoints");
  }
  if (!/recordEcommerceImageUsage\(\{ manifest, credential, generated \}\)/.test(mainContent)) {
    errors.push("src/main.js must report successful ecommerce image generation for NewAPI consumption");
  }
}

/**
 * Ensures the repository-owned patch source contains the workbench contract.
 */
function verifyPatchSource(errors) {
  const content = readFile(patchScript);
  const requiredTokens = [
    "patchTasksPageEcommerceWorkflow",
    "data-uclaw-ecommerce-workbench",
    "UcEcommercePlatformPresets",
    "UcEcommerceImageTargets",
    "UcEcommerceOutputCountRules",
    "UcEcommerceResolvedOutputCounts",
    "UcEcommerceBuildManifest",
    "UcEcommerceBuildDirectPayload",
    "UcEcommerceFileToPayload",
    "UcEcommerceLanguageOptions",
    "UcEcommerceSelectedLanguage",
    "UcEcommerceEnsureDataUrl",
    "UcEcommerceDownloadImage",
    "onEcommerceOutputType",
    "onEcommerceOutputCount",
    "downloadEcommerceImage",
    "onEcommerceImageProgress",
    "onEcommerceDrop",
    "onEcommercePaste",
    "setEcommerceFiles",
    "startEcommerceImageGeneration",
    "onEcommerceImageProgress",
    "generateEcommerceImages",
    "uclaw-ecommerce-progress",
    "uclaw-ecommerce-hero",
    "uclaw-ecommerce-stats",
    "uclaw-ecommerce-layout",
    "uclaw-ecommerce-panel",
    "uclaw-ecommerce-side",
    "uclaw-ecommerce-drop",
    "uclaw-ecommerce-asset-row",
    "uclaw-ecommerce-featured",
    "uclaw-ecommerce-result-body",
    "uclaw-ecommerce-result-strip",
    "uclaw-ecommerce-stepper",
    "model_image",
    "outputCounts",
    "uclaw.ecommerceImageRecords.v1",
    "uclaw.ecommerceWorkbench.platform.v1",
    "defaultLanguage",
    "data-uclaw-ecommerce-language",
    "图片语言",
    "点击下载",
    "选择/拖拽/粘贴图片",
    "出一张显示一张",
    "official_seed",
    "public_summary",
    "needs_backend_confirmation",
  ];

  for (const token of requiredTokens) {
    requireToken(errors, "patch-openclaw.js", content, token);
  }

  requireToken(errors, "patch-openclaw.js", content, "ecommerce-carousel-export-1");
  requireToken(errors, "patch-openclaw.js", content, "ecommerce-design-layout-3");
  if (content.includes("UcEcommerceBuildGenerationPrompt")) {
    errors.push("patch-openclaw.js still contains the old ecommerce chat prompt builder");
  }
  if (content.includes("openEcommerceGenerationRecord")) {
    errors.push("patch-openclaw.js still contains the old ecommerce session opener");
  }
}

/**
 * Ensures the generated Control UI tasks page exposes the direct workbench shell.
 */
function verifyGeneratedTasksPage(errors) {
  for (const file of listTasksPageAssets()) {
    const content = readFile(file);
    const label = path.relative(root, file);
    const requiredTokens = [
      "data-uclaw-ecommerce-workbench",
      "data-uclaw-ecommerce-platform",
      "电商主图/详情图",
      "生成类型",
      "生成类型与数量",
      "模特图",
      "详情图系列",
      "生成图片",
      "打包下载",
      "生成记录",
      "选择/拖拽/粘贴图片",
      "UcEcommercePlatformPresets",
      "UcEcommerceImageTargets",
      "UcEcommerceOutputCountRules",
      "UcEcommerceBuildManifest",
      "UcEcommerceBuildDirectPayload",
      "UcEcommerceBuildExportPackage",
      "UcEcommerceLanguageOptions",
      "UcEcommerceDownloadImage",
      "downloadEcommercePackage",
      "downloadEcommerceImage",
      "onEcommerceImageProgress",
      "onEcommerceDrop",
      "onEcommercePaste",
      "setEcommerceFiles",
      "model_image",
      "outputCounts",
      "defaultLanguage",
      "data-uclaw-ecommerce-language",
      "图片语言",
      "点击下载",
      "startEcommerceImageGeneration",
      "generateEcommerceImages",
      "uclaw-ecommerce-hero",
      "uclaw-ecommerce-stats",
      "uclaw-ecommerce-layout",
      "uclaw-ecommerce-panel",
      "uclaw-ecommerce-side",
      "uclaw-ecommerce-drop",
      "uclaw-ecommerce-asset-row",
      "uclaw-ecommerce-featured",
      "uclaw-ecommerce-result-body",
      "uclaw-ecommerce-result-strip",
      "uclaw-ecommerce-stepper",
      "uclaw-ecommerce-progress",
      "出一张显示一张",
      "uclaw.ecommerceImageRecords.v1",
      "source_type",
      "抖音电商",
      "Amazon",
      "Shopee",
    ];

    for (const token of requiredTokens) {
      requireToken(errors, label, content, token);
    }

    if (/workflow builder|拖拽编排器|一键出图|自动出图|Prompt-only/.test(content)) {
      errors.push(`${label} contains blocked fake workflow wording`);
    }
    if (/UcEcommerceBuildGenerationPrompt|openEcommerceGenerationRecord|打开会话|chat\.send|sessions\.create/.test(content)) {
      errors.push(`${label} still contains old ecommerce session-generation wiring`);
    }
  }
}

/**
 * Ensures generated CSS keeps ecommerce results as a horizontal carousel.
 */
function verifyGeneratedCss(errors) {
  const cssFiles = listCssAssets();
  if (cssFiles.length === 0) {
    errors.push("Missing generated CSS asset");
    return;
  }

  for (const file of cssFiles) {
    const content = readFile(file);
    const label = path.relative(root, file);
    for (const token of [
      ".uclaw-ecommerce-generated-grid",
      "scroll-snap-type",
      "overscroll-behavior-x",
      ".uclaw-ecommerce-result-actions",
      ".uclaw-ecommerce-featured",
      ".uclaw-ecommerce-result-body",
      ".uclaw-ecommerce-result-strip",
      ".uclaw-ecommerce-layout",
      "grid-template-columns: minmax(0, 1fr) 390px",
      ".uclaw-ecommerce-asset-row",
      ".uclaw-ecommerce-drop",
      ".update-banner",
      "ecommerce-design-layout-3",
    ]) {
      requireToken(errors, label, content, token);
    }
  }
}

/**
 * Ensures the bundled skill describes the hidden planning and QA policy for the workbench.
 */
function verifyBundledSkill(errors) {
  const content = readFile(skillFile);
  const requiredTokens = [
    "name: ecommerce-main-detail-workflow",
    "Workbench-first",
    "平台 preset",
    "直接调用 Bavi-box 图片接口",
    "Campaign Style Lock",
    "Main Image Storyboard",
    "Detail Page Storyboard",
    "Model Image Target",
    "生成类型",
    "Prompt Pack",
    "Human Review Gate",
  ];

  for (const token of requiredTokens) {
    requireToken(errors, "ecommerce-main-detail-workflow/SKILL.md", content, token);
  }

  for (const token of ["IMG_API_KEY", "OPENAI_API_KEY", "generate_image.py"]) {
    if (content.includes(token)) {
      errors.push(`Bundled skill must not introduce direct generation token: ${token}`);
    }
  }
}

/**
 * Runs all static ecommerce workflow checks.
 */
function main() {
  const errors = [];

  try {
    verifyDirectDesktopApi(errors);
    verifyDirectNewApiRouting(errors);
    verifyPatchSource(errors);
    verifyGeneratedTasksPage(errors);
    verifyGeneratedCss(errors);
    verifyBundledSkill(errors);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (errors.length > 0) {
    console.error("Ecommerce workflow verification failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("OK ecommerce workflow verified");
}

main();
