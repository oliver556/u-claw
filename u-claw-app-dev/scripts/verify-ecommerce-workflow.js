#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const assetsDir = path.join(root, "node_modules", "openclaw", "dist", "control-ui", "assets");
const patchScript = path.join(root, "scripts", "patch-openclaw.js");
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
 * Records a missing token without stopping the remaining checks.
 */
function requireToken(errors, label, content, token) {
  if (!content.includes(token)) {
    errors.push(`${label} missing token: ${token}`);
  }
}

/**
 * Ensures the repository-owned patch source contains the workflow contract.
 */
function verifyPatchSource(errors) {
  const content = readFile(patchScript);
  const requiredTokens = [
    "patchTasksPageEcommerceWorkflow",
    "data-uclaw-ecommerce-workflow",
    "ecommerce-main-detail-workflow",
    "uclaw.ecommerceWorkflowSessions.v1",
    "Prompt-only",
    "sessions.create",
  ];

  for (const token of requiredTokens) {
    requireToken(errors, "patch-openclaw.js", content, token);
  }

  requireToken(errors, "patch-openclaw.js", content, "ecommerce-workflow-1");
}

/**
 * Ensures the generated Control UI tasks page exposes the workflow entry only as V0.
 */
function verifyGeneratedTasksPage(errors) {
  for (const file of listTasksPageAssets()) {
    const content = readFile(file);
    const label = path.relative(root, file);
    const requiredTokens = [
      "data-uclaw-ecommerce-workflow",
      "电商主图/详情图",
      "Prompt-only",
      "ecommerce-main-detail-workflow",
      "uclaw.ecommerceWorkflowSessions.v1",
      "sessions.create",
      "startEcommerceWorkflow",
    ];

    for (const token of requiredTokens) {
      requireToken(errors, label, content, token);
    }

    if (/workflow builder|拖拽编排器|一键出图|自动出图/.test(content)) {
      errors.push(`${label} contains blocked fake workflow wording`);
    }
  }
}

/**
 * Ensures the bundled skill stays prompt-only and contains the ecommerce planning stages.
 */
function verifyBundledSkill(errors) {
  const content = readFile(skillFile);
  const requiredTokens = [
    "name: ecommerce-main-detail-workflow",
    "Prompt-only",
    "不直接出图",
    "Campaign Style Lock",
    "Main Image Storyboard",
    "Detail Page Storyboard",
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
    verifyPatchSource(errors);
    verifyGeneratedTasksPage(errors);
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
