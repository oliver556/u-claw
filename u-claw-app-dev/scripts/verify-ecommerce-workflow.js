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
 * Ensures the desktop-owned image API exists outside the OpenClaw chat/session path.
 */
function verifyDirectDesktopApi(errors) {
  const mainContent = readFile(mainProcessFile);
  const preloadContent = readFile(preloadFile);
  const mainTokens = [
    "resolveEcommerceImageCredential",
    "resolveEcommerceImageTargets",
    "generateEcommerceImagesDirect",
    "requestEcommerceImage",
    "model_image",
    "08-model-showcase",
    "ECOMMERCE_IMAGE_DIRECT_MAX_OUTPUTS",
    "outputCounts",
    "/images/edits",
    "uclaw:ecommerce-generate-images",
  ];
  const preloadTokens = [
    "generateEcommerceImages",
    "uclaw:ecommerce-generate-images",
  ];

  for (const token of mainTokens) {
    requireToken(errors, "src/main.js", mainContent, token);
  }
  for (const token of preloadTokens) {
    requireToken(errors, "src/preload.js", preloadContent, token);
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
    "onEcommerceOutputType",
    "onEcommerceOutputCount",
    "startEcommerceImageGeneration",
    "generateEcommerceImages",
    "model_image",
    "outputCounts",
    "uclaw.ecommerceImageRecords.v1",
    "uclaw.ecommerceWorkbench.platform.v1",
    "official_seed",
    "public_summary",
    "needs_backend_confirmation",
  ];

  for (const token of requiredTokens) {
    requireToken(errors, "patch-openclaw.js", content, token);
  }

  requireToken(errors, "patch-openclaw.js", content, "ecommerce-carousel-export-1");
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
      "选择图片",
      "UcEcommercePlatformPresets",
      "UcEcommerceImageTargets",
      "UcEcommerceOutputCountRules",
      "UcEcommerceBuildManifest",
      "UcEcommerceBuildDirectPayload",
      "UcEcommerceBuildExportPackage",
      "downloadEcommercePackage",
      "model_image",
      "outputCounts",
      "startEcommerceImageGeneration",
      "generateEcommerceImages",
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
