#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const assetsDir = path.join(root, "node_modules", "openclaw", "dist", "control-ui", "assets");
const patchScript = path.join(root, "scripts", "patch-openclaw.js");
const mainProcessFile = path.join(root, "src", "main.js");
const preloadFile = path.join(root, "src", "preload.js");
const cloudMigrationDir = path.join(root, "cloud", "uclaw-cloud-api", "migrations");
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
 * Evaluates several dependent main-process helpers with a tiny mocked Electron
 * environment so OS-specific path behavior can be tested on macOS.
 */
function evaluateMainHelpers(content, names, setup = "") {
  const sources = names.map((name) => {
    const start = content.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`Missing helper: ${name}`);
    const nextFunction = content.indexOf("\nfunction ", start + 1);
    return content.slice(start, nextFunction === -1 ? content.length : nextFunction);
  }).join("\n\n");
  return Function(
    "path",
    `
      ${setup}
      ${sources}
      return { ${names.join(", ")} };
    `,
  )(path.win32);
}

/**
 * Evaluates one generated Control UI helper string from patch-openclaw.js.
 */
function evaluatePatchHelper(content, name) {
  const startToken = `"function ${name}(e){`;
  const start = content.indexOf(startToken);
  if (start === -1) throw new Error(`Missing patch helper: ${name}`);
  const bodyStart = start + 1;
  const next = content.indexOf('",\n    "function ', bodyStart);
  if (next === -1) throw new Error(`Unable to isolate patch helper: ${name}`);
  const source = content.slice(bodyStart, next);
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
    const firstNonBlankString = evaluateMainHelper(mainContent, "firstNonBlankString");
    const providerName = evaluateMainHelper(mainContent, "getEcommerceModelProviderName");

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
    if (providerName("newapi/gpt-image-2") !== "newapi") {
      errors.push("getEcommerceModelProviderName must detect NewAPI model refs");
    }
    if (firstNonBlankString("", "   ", "https://api.example.com/v1") !== "https://api.example.com/v1") {
      errors.push("firstNonBlankString must skip blank credential values before fallback");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Reproduces the Windows portable root drift that caused saved ecommerce images
 * to show as broken after the local record was reloaded.
 */
function verifyWindowsEcommerceLocalPathTrust(errors) {
  try {
    const mainContent = readFile(mainProcessFile);
    const helpers = evaluateMainHelpers(
      mainContent,
      [
        "safeGetElectronPath",
        "resolveEcommerceLocalLibraryRoot",
        "resolveEcommerceLocalLibraryRoots",
        "pathsEqual",
        "isPathInsideRoot",
        "resolveTrustedEcommerceLocalPath",
      ],
      `
        const APP_NAME = "Bavi-box";
        const ECOMMERCE_IMAGE_LOCAL_LIBRARY_NAME = "电商图片";
        const userDataPath = "C:\\\\Users\\\\operator\\\\AppData\\\\Local\\\\Bavi-box\\\\usb-portable\\\\electron-profile";
        const app = {
          getPath(name) {
            if (name === "downloads") return "C:\\\\Users\\\\operator\\\\AppData\\\\Local\\\\Bavi-box\\\\usb-portable\\\\data-abc\\\\.home\\\\Downloads";
            if (name === "home") return "C:\\\\Users\\\\operator\\\\AppData\\\\Local\\\\Bavi-box\\\\usb-portable\\\\data-abc\\\\.home";
            return "";
          }
        };
        const process = {
          platform: "win32",
          env: {
            USERPROFILE: "C:\\\\Users\\\\operator\\\\AppData\\\\Local\\\\Bavi-box\\\\usb-portable\\\\data-abc\\\\.home",
            UCLAW_HOST_USERPROFILE: "C:\\\\Users\\\\operator"
          }
        };
      `,
    );
    const trustedHostImage = helpers.resolveTrustedEcommerceLocalPath(
      "C:\\Users\\operator\\Downloads\\Bavi-box\\电商图片\\抖音电商-短袖\\01-主图.png",
    );
    if (!trustedHostImage) {
      errors.push("Windows ecommerce localPath trust must accept images saved under host Downloads");
    }
    const trustedPortableImage = helpers.resolveTrustedEcommerceLocalPath(
      "C:\\Users\\operator\\AppData\\Local\\Bavi-box\\usb-portable\\data-abc\\.home\\Downloads\\Bavi-box\\电商图片\\抖音电商-短袖\\01-主图.png",
    );
    if (!trustedPortableImage) {
      errors.push("Windows ecommerce localPath trust must accept images saved under portable Downloads");
    }
    const escaped = helpers.resolveTrustedEcommerceLocalPath(
      "C:\\Users\\operator\\Pictures\\not-ecommerce\\01.png",
    );
    if (escaped) {
      errors.push("Windows ecommerce localPath trust must reject paths outside ecommerce image libraries");
    }
    const roots = helpers.resolveEcommerceLocalLibraryRoots();
    if (!roots.some((root) => /C:\\Users\\operator\\Downloads\\Bavi-box\\电商图片/i.test(root))) {
      errors.push(`Windows ecommerce library roots missing host Downloads: ${JSON.stringify(roots)}`);
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
  const windowsStartContent = readFile(path.join(root, "scripts", "Windows-Start-App.bat"));
  const mainTokens = [
    "resolveEcommerceImageCredential",
    "normalizeNewApiImageBaseUrl",
    "normalizeEcommerceNewApiModel",
    "getEcommerceModelProviderName",
    "firstNonBlankString",
    "findNewApiCredentials(config)",
    "getProviderValue(modelProvider",
    "resolveEcommerceImageTargets",
    "generateEcommerceImagesDirect",
    "requestEcommerceImage",
    "resolveEcommerceTargetSize",
    "图片风格：",
    "图片比例：",
    "目标尺寸：",
    "model_image",
    "08-model-showcase",
    "ECOMMERCE_IMAGE_DIRECT_MAX_OUTPUTS",
    "outputCounts",
    "/images/${images.length ? 'edits' : 'generations'}",
    "requestModel",
    "materializeEcommerceImageUrl",
    "materializeEcommerceLocalImage",
    "resolveTrustedEcommerceLocalPath",
    "本地图片不存在或不在允许的电商图片目录内",
    "materializeEcommerceImageForRenderer",
    "isInvalidEcommerceImageTokenError",
    "refreshEcommerceImageCredential",
    "verifyEcommerceImageCredential",
    "图片接口 token 已刷新，但 NewAPI 校验失败",
    "/v1/newapi/credentials/refresh",
    "云端刷新接口未上线",
    "assertPublicEcommerceImageUrl",
    "isPrivateNetworkAddress",
    "ECOMMERCE_IMAGE_REMOTE_MATERIALIZE_MAX_BYTES",
    "ECOMMERCE_IMAGE_LOCAL_LIBRARY_NAME",
    "safeGetElectronPath",
    "ensurePortableHomeShellDirs",
    "UCLAW_HOST_USERPROFILE",
    "hostDownloads",
    "resolveEcommerceLocalLibraryRoot",
    "resolveEcommerceLocalLibraryRoots",
    "pathsEqual",
    "isPathInsideRoot",
    "countEcommerceManifestOutputs",
    "formatEcommerceManifestOutputLabels",
    "ecommerceRecordFromLocalManifest",
    "listEcommerceLocalManifests",
    "USERPROFILE",
    "resolveEcommerceLocalLibraryDir",
    "saveEcommerceImageToLocalLibrary",
    "saveEcommerceLocalManifest",
    "openEcommerceLocalPath",
    "uclaw:ecommerce-open-local-path",
    "localPath",
    "localDir",
    "localManifestPath",
    "recordEcommerceImageUsage",
    "syncEcommerceImageUsage",
    "removeEcommerceUsageSyncWarnings",
    "updateEcommerceLocalManifestBilling",
    "/v1/newapi/usage/ecommerce-image",
    "ECOMMERCE_IMAGE_USAGE_QUOTA_PER_IMAGE",
    "formatCloudAPIErrorMessage",
    "NewAPI 管理员登录会话已达上限",
    "summarizeEcommerceImageRequestError",
    "图片接口失败\\s+(400|403)",
    "该张被上游图片接口拒绝 ${status}，其他已成功图片已保留",
    "billing",
    "uclaw:ecommerce-generate-images",
    "uclaw:ecommerce-sync-image-usage",
    "uclaw:ecommerce-list-local-manifests",
    "uclaw:ecommerce-image-progress",
    "emitEcommerceImageProgress",
    "status: 'completed'",
    "status: 'settled'",
    "uclaw:ecommerce-materialize-image",
  ];
  const preloadTokens = [
    "generateEcommerceImages",
    "uclaw:ecommerce-generate-images",
    "syncEcommerceImageUsage",
    "uclaw:ecommerce-sync-image-usage",
    "onEcommerceImageProgress",
    "uclaw:ecommerce-image-progress",
    "materializeEcommerceImage",
    "uclaw:ecommerce-materialize-image",
    "openEcommerceLocalPath",
    "uclaw:ecommerce-open-local-path",
    "listEcommerceLocalManifests",
    "uclaw:ecommerce-list-local-manifests",
  ];

  for (const token of mainTokens) {
    requireToken(errors, "src/main.js", mainContent, token);
  }
  for (const token of preloadTokens) {
    requireToken(errors, "src/preload.js", preloadContent, token);
  }
  for (const token of [
    "set \"HOST_USERPROFILE=%USERPROFILE%\"",
    "set \"UCLAW_HOST_USERPROFILE=%HOST_USERPROFILE%\"",
    "if not exist \"%HOME%\\Desktop\" mkdir \"%HOME%\\Desktop\"",
    "if not exist \"%HOME%\\Downloads\" mkdir \"%HOME%\\Downloads\"",
    "if not exist \"%HOME%\\Documents\" mkdir \"%HOME%\\Documents\"",
    "if not exist \"%HOME%\\Pictures\" mkdir \"%HOME%\\Pictures\"",
  ]) {
    requireToken(errors, "scripts/Windows-Start-App.bat", windowsStartContent, token);
  }

  if (/configuredModel\.includes\('\/'\)\s*\?\s*configuredModel\.split\('\/'\)\.pop\(\)/.test(mainContent)) {
    errors.push("src/main.js must not blindly strip provider prefixes from ecommerce image model refs");
  }
  if (/config\.models\?\.providers\?\.newapi\s*\|\|\s*\{\}/.test(mainContent)) {
    errors.push("src/main.js must not require providers.newapi for ecommerce image credentials");
  }
  if (/const endpoint = images\.length \? '\/images\/edits' : '\/images\/generations';/.test(mainContent)) {
    errors.push("src/main.js must normalize NewAPI baseUrl before appending image endpoints");
  }
  if (!/recordEcommerceImageUsage\(\{ manifest, credential, generated \}\)/.test(mainContent)) {
    errors.push("src/main.js must report successful ecommerce image generation for NewAPI consumption");
  }
  if (!/const base = downloads \|\| hostDownloads \|\| homeDownloads \|\| fallbackDownloads \|\| path\.join\(userDataPath, 'Downloads'\);/.test(mainContent)) {
    errors.push("src/main.js must prefer host Downloads before portable cache Downloads");
  }
  if (!/resolveEcommerceLocalLibraryRoots\(\)\.some\(root => isPathInsideRoot\(resolvedTarget, root\)\)/.test(mainContent)) {
    errors.push("src/main.js must trust every known ecommerce library root when opening or materializing Windows local images");
  }
  if (!/const relative = path\.relative\(resolvedRoot, resolvedTarget\);/.test(mainContent)) {
    errors.push("src/main.js must use path.relative for ecommerce local library containment instead of brittle string prefixes");
  }
  if (/const libraryRoot = path\.resolve\(resolveEcommerceLocalLibraryRoot\(\)\);\s+const resolvedTarget = path\.resolve\(targetPath\);\s+if \(resolvedTarget !== libraryRoot && !resolvedTarget\.startsWith/.test(mainContent)) {
    errors.push("src/main.js still uses single-root prefix matching for ecommerce local paths");
  }
  if (!/for \(const root of roots\) \{/.test(mainContent) || !/return \{ ok: true, root: roots\[0\] \|\| '', roots, records: records\.slice\(0, 30\) \};/.test(mainContent)) {
    errors.push("src/main.js must scan all possible ecommerce library roots when importing local manifests");
  }
  if (!/ensurePortableHomeShellDirs\(\);\s+invalidateControlUiCacheOnVersionChange\(\);/.test(mainContent)) {
    errors.push("src/main.js must create portable Windows shell folders before Electron cache setup continues");
  }
  const activationService = readFile("cloud/uclaw-cloud-api/internal/activation/service.go");
  const provisioningService = readFile("cloud/uclaw-cloud-api/internal/provisioning/service.go");
  const newapiClient = readFile("cloud/uclaw-cloud-api/internal/newapi/client.go");
  const httpapiServer = readFile("cloud/uclaw-cloud-api/internal/httpapi/server.go");
  requireToken(errors, "activation/service.go", activationService, "ForceRotateToken");
  requireToken(errors, "provisioning/service.go", provisioningService, "tokenName(req.ForceRotateToken)");
  requireToken(errors, "provisioning/service.go", provisioningService, "createdToken.APIKey()");
  requireToken(errors, "newapi/client.go", newapiClient, "type tokenState struct");
  requireToken(errors, "newapi/client.go", newapiClient, "withSharedTokenState(c.tokens)");
  requireToken(errors, "httpapi/server.go", httpapiServer, "buildNewAPIAdminClient");
  requireToken(errors, "httpapi/server.go", httpapiServer, "newAPIAdmin := buildNewAPIAdminClient");
  requireToken(errors, "httpapi/server.go", httpapiServer, "buildUsageService(cfg, newAPIAdmin");
  const postgresStore = readFile("cloud/uclaw-cloud-api/internal/postgres/store.go");
  const postgresEcommerceStore = readFile("cloud/uclaw-cloud-api/internal/postgres/ecommerce_usage_store.go");
  requireToken(errors, "postgres/store.go", postgresStore, "EnsureEcommerceImageUsageSchema(ctx)");
  requireToken(errors, "postgres/ecommerce_usage_store.go", postgresEcommerceStore, "ecommerceImageUsageSchemaSQL");
  requireToken(errors, "postgres/ecommerce_usage_store.go", postgresEcommerceStore, "CREATE TABLE IF NOT EXISTS ecommerce_image_usage_events");
  requireToken(errors, "postgres/ecommerce_usage_store.go", postgresEcommerceStore, "idx_ecommerce_image_usage_user_created");
  requireToken(errors, "postgres/ecommerce_usage_store.go", postgresEcommerceStore, "isUndefinedTableError");
  requireToken(errors, "postgres/ecommerce_usage_store.go", postgresEcommerceStore, "ensureEcommerceImageUsageSchemaAfterUndefinedTable");
  requireToken(errors, "postgres/ecommerce_usage_store.go", postgresEcommerceStore, "sqlstate 42p01");
  requireToken(errors, "provisioning/service.go", provisioningService, "isSessionLimitError");
  requireToken(errors, "provisioning/service.go", provisioningService, "WithAdminUser");
}

/**
 * Verifies Cloud API migration ordering for ecommerce billing. Production
 * applies these files as numbered deployment steps, so duplicate numbers can
 * leave the usage table absent while the desktop still reports successful
 * image generation.
 */
function verifyCloudEcommerceUsageMigration(errors) {
  if (!fs.existsSync(cloudMigrationDir)) {
    errors.push(`Missing Cloud API migrations directory: ${path.relative(root, cloudMigrationDir)}`);
    return;
  }

  const migrationFiles = fs
    .readdirSync(cloudMigrationDir)
    .filter((name) => /^\d{6}_.+\.sql$/.test(name))
    .sort();
  const byVersion = new Map();
  for (const fileName of migrationFiles) {
    const version = fileName.slice(0, 6);
    byVersion.set(version, [...(byVersion.get(version) || []), fileName]);
  }
  for (const [version, files] of byVersion) {
    if (files.length > 1) {
      errors.push(`Duplicate Cloud API migration version ${version}: ${files.join(", ")}`);
    }
  }

  const ecommerceMigration = migrationFiles.find((name) => name.includes("ecommerce_image_usage"));
  if (!ecommerceMigration) {
    errors.push("Missing ecommerce image usage migration");
    return;
  }
  if (!ecommerceMigration.startsWith("000004_")) {
    errors.push(`Ecommerce image usage migration must be 000004 or later, got ${ecommerceMigration}`);
  }
  const content = readFile(path.join(cloudMigrationDir, ecommerceMigration));
  for (const token of [
    "CREATE TABLE IF NOT EXISTS ecommerce_image_usage_events",
    "request_id TEXT NOT NULL UNIQUE",
    "status TEXT NOT NULL DEFAULT 'recorded'",
    "idx_ecommerce_image_usage_user_created",
  ]) {
    requireToken(errors, ecommerceMigration, content, token);
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
    "UcEcommerceVisualStylePresets",
    "UcEcommerceSelectedVisualStyle",
    "UcEcommerceAspectRatioPresets",
    "UcEcommerceSelectedAspectRatio",
    "UcEcommerceEnsureDataUrl",
    "hydrateEcommerceResultImages",
    "UcEcommerceDownloadImage",
    "UcEcommerceDownloadFileName",
    "ecommerce-download-filename-1",
    "ecommerce-status-complete-1",
    "ecommerce-swiper-preview-1",
    "UcEcommerceNormalizeRecord",
    "UcEcommerceStripImagePayload",
    "UcEcommerceStripResultPayload",
    "UcEcommerceStripRecordPayload",
    "UcEcommerceRecordPlannedCount",
    "UcEcommerceRecordGeneratedCount",
    "UcEcommerceRecordHasBillingError",
    "UcEcommerceUsageSyncWarnings",
    "UcEcommerceBuildUsageSyncPayload",
    "UcEcommerceRecordEffectiveStatus",
    "UcEcommercePrimaryActionState",
    "UcEcommerceFormSignature",
    "ecommerceUsageSyncing",
    "ecommerceLastSubmittedSignature",
    "创建生成任务",
    "任务已创建",
    "重新创建此任务",
    "创建新任务",
    "待图片接口激活",
    "UcEcommerceStaleGeneratingMs",
    "UcEcommerceProgressState",
    "UcEcommerceImageKey",
    "UcEcommerceMergeImages",
    "UcEcommerceMergeWarnings",
    "openEcommerceLocalPath",
    "requestEcommerceRecordDelete",
    "cancelEcommerceRecordDelete",
    "requestEcommerceRecordsClear",
    "cancelEcommerceRecordsClear",
    "deleteEcommerceRecord",
    "确认删除",
    "确认清空",
    "本地图片不会删除",
    "retryEcommerceUsageSync",
    "重试同步用量",
    "uclaw-ecommerce-record-delete",
    "已保存本地",
    "部分生成",
    "扣费异常",
    "生成进度 ${r||0}/${n||0}",
    "打开文件夹",
    "localPath",
    "localDir",
    "localManifestPath",
    "ecommerce-local-library-1",
    "ecommerce-log-bubble-1",
    "ecommerce-compact-actions-4",
    "uclaw-ecommerce-record-mark",
    "uclaw-ecommerce-record-main",
    "uclaw-ecommerce-record-status",
    "uclaw-ecommerce-record-progress",
    "container-type: inline-size",
    "@container (min-width: 560px)",
    "UcEcommerceRecordInitial",
    "UcEcommerceRecordProgressPercent",
    "uclaw-ecommerce-icon-button",
    "uclaw-ecommerce-result-folder",
    "uclaw-ecommerce-record-view",
    "uclaw-ecommerce-record-sync",
    "uclaw-ecommerce-record-folder",
    "uclaw-ecommerce-record-delete-confirm",
    "uclaw-ecommerce-record-delete-cancel",
    "uclaw-ecommerce-record-clear-confirm",
    "uclaw-ecommerce-record-clear-cancel",
    "ecommerce-record-pagination-1",
    "ecommerce-log-diagnostic-1",
    "ecommerce-record-delete-confirm-1",
    "ecommerce-record-density-1",
    "ecommerce-record-tombstone-1",
    "UcEcommerceLogDiagnosticMarker",
    "UcEcommerceRecordDeleteConfirmMarker",
    "UcEcommerceRecordDensityMarker",
    "UcEcommerceRecordDeleteTombstoneMarker",
    "UcEcommerceDeletedRecordsKey",
    "UcEcommerceRecordDeleteKeys",
    "UcEcommerceReadDeletedRecordKeys",
    "UcEcommerceWriteDeletedRecordKeys",
    "UcEcommerceRememberDeletedRecords",
    "UcEcommerceRecordIsDeleted",
    "uclaw.ecommerceImageRecordDeletes.v1",
    "diagnostic_status",
    "missing_fields",
    "当前日志为进行中快照",
    "selectEcommercePreview",
    "openEcommerceSwiper",
    "stepEcommerceSwiper",
    "ecommercePreviewIndex",
    "UcEcommerceRecordPageSize",
    "UcEcommerceClampRecordPage",
    "setEcommerceRecordsPage",
    "uclaw-ecommerce-record-pagination",
    "上一页",
    "下一页",
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
    "uclaw-ecommerce-featured-preview",
    "uclaw-ecommerce-swiper",
    "uclaw-ecommerce-result-body",
    "uclaw-ecommerce-result-strip",
    "uclaw-ecommerce-stepper",
    "model_image",
    "outputCounts",
    "visualStyle",
    "aspectRatio",
    "uclaw.ecommerceImageRecords.v1",
    "uclaw.ecommerceWorkbench.platform.v1",
    "uclaw.ecommerceWorkbench.draft.v1",
    "UcEcommerceReadDraft",
    "UcEcommerceWriteDraft",
    "UcEcommerceClearDraft",
    "UcEcommerceRememberDraftFiles",
    "UcEcommerceReadDraftFiles",
    "saveEcommerceDraft",
    "resetEcommerceFormAfterTaskCreated",
    "defaultLanguage",
    "data-uclaw-ecommerce-language",
    "data-uclaw-ecommerce-visual-style",
    "data-uclaw-ecommerce-aspect-ratio",
    "图片语言",
    "图片风格",
    "图片比例",
    "Campaign Style Lock",
    "white_packshot",
    "detail_vertical",
    "点击预览",
    "选择/拖拽/粘贴图片",
    "出一张显示一张",
    "已中断",
    "生成已中断",
    "official_seed",
    "public_summary",
    "needs_backend_confirmation",
  ];

  for (const token of requiredTokens) {
    requireToken(errors, "patch-openclaw.js", content, token);
  }

  requireToken(errors, "patch-openclaw.js", content, "ecommerce-carousel-export-1");
  requireToken(errors, "patch-openclaw.js", content, "ecommerce-design-layout-4");
  requireToken(errors, "patch-openclaw.js", content, "ecommerce-ultrawide-layout-2");
  requireToken(errors, "patch-openclaw.js", content, "ecommerce-swiper-preview-1");
  if (/body:has\(openclaw-tasks-page \.uclaw-ecommerce-workbench\) \.(topbar|sidebar|sidebar-shell|nav-item)/.test(content)) {
    errors.push("patch-openclaw.js must not scale global shell chrome on ecommerce route");
  }
  if (content.includes("UcEcommerceBuildGenerationPrompt")) {
    errors.push("patch-openclaw.js still contains the old ecommerce chat prompt builder");
  }
  if (content.includes("openEcommerceGenerationRecord")) {
    errors.push("patch-openclaw.js still contains the old ecommerce session opener");
  }
  if (content.includes("e?.status===`completed`||r.status===`completed`")) {
    errors.push("patch-openclaw.js must not mark partial ecommerce results complete from status alone");
  }
  if (content.includes("Math.max(Number.isFinite(t)?t:0,n)")) {
    errors.push("patch-openclaw.js must not count optimistic generatedImageCount over real result.images length");
  }
  if (content.includes("r.done??(Array.isArray(t)?t.length:0)")) {
    errors.push("patch-openclaw.js progress display must prefer real image count over optimistic progress.done");
  }
  if (content.includes("?disabled=${a.length>0||u}") || content.includes("${u?`生成中`:`生成图片`}")) {
    errors.push("patch-openclaw.js must derive ecommerce primary action from task state, not raw ecommerceGenerating");
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
      "创建生成任务",
      "导出日志",
      "生成记录",
      "选择/拖拽/粘贴图片",
      "UcEcommercePlatformPresets",
      "UcEcommerceImageTargets",
      "UcEcommerceOutputCountRules",
      "UcEcommerceBuildManifest",
      "UcEcommerceBuildDirectPayload",
      "UcEcommerceBuildExportPackage",
      "UcEcommerceLanguageOptions",
      "UcEcommerceVisualStylePresets",
      "UcEcommerceAspectRatioPresets",
      "UcEcommerceDownloadImage",
      "hydrateEcommerceResultImages",
      "UcEcommerceDownloadFileName",
      "UcEcommerceNormalizeRecord",
      "UcEcommerceStripImagePayload",
      "UcEcommerceStripResultPayload",
      "UcEcommerceStripRecordPayload",
      "UcEcommerceMergeRecords",
      "importEcommerceLocalManifests",
      "listEcommerceLocalManifests",
      "ecommerce-local-manifest-import-1",
      "UcEcommerceRecordEffectiveStatus",
      "UcEcommerceRecordPlannedCount",
      "UcEcommerceRecordGeneratedCount",
      "UcEcommerceRecordHasBillingError",
      "UcEcommerceUsageSyncWarnings",
      "UcEcommerceBuildUsageSyncPayload",
      "UcEcommercePrimaryActionState",
      "ecommerceUsageSyncing",
      "UcEcommerceFormSignature",
      "ecommerceLastSubmittedSignature",
      "创建生成任务",
      "任务已创建",
      "重新创建此任务",
      "创建新任务",
      "待图片接口激活",
      "UcEcommerceStaleGeneratingMs",
      "UcEcommerceProgressState",
      "UcEcommerceImageKey",
      "UcEcommerceMergeImages",
      "UcEcommerceMergeWarnings",
      "UcEcommerceWarningSummary",
      "UcEcommerceLogExportPayload",
      "UcEcommerceExportLogName",
      "openEcommerceLocalPath",
      "requestEcommerceRecordDelete",
      "cancelEcommerceRecordDelete",
      "requestEcommerceRecordsClear",
      "cancelEcommerceRecordsClear",
      "retryEcommerceUsageSync",
      "重试同步用量",
      "uclaw-ecommerce-icon-button",
      "uclaw-ecommerce-result-folder",
      "uclaw-ecommerce-record-mark",
      "uclaw-ecommerce-record-main",
      "uclaw-ecommerce-record-status",
      "uclaw-ecommerce-record-progress",
      "uclaw-ecommerce-record-view",
      "uclaw-ecommerce-record-sync",
      "uclaw-ecommerce-record-folder",
      "aria-label='查看结果'",
      "aria-label='打开文件夹'",
      "aria-label='删除记录'",
      "aria-label='确认删除记录'",
      "aria-label='取消删除'",
      "aria-label='确认清空全部记录'",
      "aria-label='取消清空'",
      "uclaw-ecommerce-warning-bubble",
      "deleteEcommerceRecord",
      "uclaw-ecommerce-record-delete",
      "uclaw-ecommerce-record-delete-confirm",
      "uclaw-ecommerce-record-delete-cancel",
      "uclaw-ecommerce-record-clear-confirm",
      "uclaw-ecommerce-record-clear-cancel",
      "已保存本地",
      "部分生成",
      "扣费异常",
      "生成进度 ${r||0}/${n||0}",
      "打开文件夹",
      "localPath",
      "localDir",
      "localManifestPath",
      "ecommerce-record-pagination-1",
      "ecommerce-log-diagnostic-1",
      "ecommerce-record-delete-confirm-1",
      "ecommerce-record-density-1",
      "ecommerce-record-tombstone-1",
      "diagnostic_status",
      "missing_fields",
      "当前日志为进行中快照",
      "selectEcommercePreview",
      "openEcommerceSwiper",
      "stepEcommerceSwiper",
      "ecommercePreviewIndex",
      "setEcommerceRecordsPage",
      "uclaw-ecommerce-record-pagination",
      "上一页",
      "下一页",
      "downloadEcommercePackage",
      "downloadEcommerceImage",
      "exportEcommerceLog",
      "UcEcommerceDownloadBlob(a,t||`ecommerce-image.",
      "@click=${()=>e.downloadEcommerceImage?.(f,w)}",
      "onEcommerceImageProgress",
      "onEcommerceDrop",
      "onEcommercePaste",
      "setEcommerceFiles",
      "model_image",
      "outputCounts",
      "visualStyle",
      "aspectRatio",
      "defaultLanguage",
      "data-uclaw-ecommerce-language",
      "data-uclaw-ecommerce-visual-style",
      "data-uclaw-ecommerce-aspect-ratio",
      "图片语言",
      "图片风格",
      "图片比例",
      "Campaign Style Lock",
      "white_packshot",
      "detail_vertical",
      "点击预览",
      "已中断",
      "生成已中断",
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
      "uclaw-ecommerce-featured-preview",
      "uclaw-ecommerce-swiper",
      "uclaw-ecommerce-result-body",
      "uclaw-ecommerce-result-strip",
      "is-selected",
      "uclaw-ecommerce-stepper",
      "uclaw-ecommerce-progress",
      "出一张显示一张",
      "uclaw.ecommerceImageRecords.v1",
      "uclaw.ecommerceWorkbench.draft.v1",
    "UcEcommerceReadDraft",
    "UcEcommerceWriteDraft",
    "UcEcommerceClearDraft",
    "UcEcommerceRememberDraftFiles",
    "saveEcommerceDraft",
    "resetEcommerceFormAfterTaskCreated",
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
    if (/disconnectedCallback\(\)\{this\.cleanupEcommerceFileUrls\?\.\(\)/.test(content)) {
      errors.push(`${label} still revokes ecommerce draft files during route switch`);
    }
    if (content.includes("this.ecommerceActiveRecord&&this.upsertEcommerceRecord({...this.ecommerceActiveRecord,status:`generating`")) {
      errors.push(`${label} still forces active ecommerce records back to generating`);
    }
    if (content.includes("UcEcommerceRecordStatusText(t.status)") || content.includes("UcEcommerceStatusChip(t.status)")) {
      errors.push(`${label} must derive ecommerce record status from full record data`);
    }
    if (content.includes("e?.status===`completed`||r.status===`completed`")) {
      errors.push(`${label} must not mark partial ecommerce results complete from status alone`);
    }
    if (content.includes("Math.max(Number.isFinite(t)?t:0,n)")) {
      errors.push(`${label} must not count optimistic generatedImageCount over real result.images length`);
    }
    if (content.includes("r.done??(Array.isArray(t)?t.length:0)")) {
      errors.push(`${label} progress display must prefer real image count over optimistic progress.done`);
    }
    if (content.includes("?disabled=${a.length>0||u}") || content.includes("${u?`生成中`:`生成图片`}")) {
      errors.push(`${label} must derive ecommerce primary action from task state, not raw ecommerceGenerating`);
    }
    if (content.includes("<strong>${u?`正在生成`:o.platform_label+` 已生成图片`}</strong>")) {
      errors.push(`${label} still derives result header from raw ecommerceGenerating`);
    }
    if (content.includes("images:Array.isArray(t?.images)?t.images:[]")) {
      errors.push(`${label} still lets final ecommerce image response overwrite progress images`);
    }
    if (!/UcEcommerceMergeImages\(m,Array\.isArray\(t\?\.images\)\?t\.images:\[\]\)/.test(content)) {
      errors.push(`${label} must merge final ecommerce images with progress-delivered images`);
    }
    if (!/UcEcommerceBuildDirectPayload\(n,c\)/.test(content)) {
      errors.push(`${label} must build ecommerce image payload from the submitted file snapshot after clearing the form`);
    }
    if (!content.includes("this.importEcommerceLocalManifests?.(),this.syncGatewayState()")) {
      errors.push(`${label} must import saved ecommerce manifests when the tasks page mounts`);
    }
    if (content.includes("!e.dataUrl&&!e.url&&e.localPath")) {
      errors.push(`${label} must hydrate localPath images even when stale remote URLs are present`);
    }
    if (content.includes("if(!this.ecommerceResult&&r[0]?.result)")) {
      errors.push(`${label} must let local manifests replace stale current ecommerce results for the same request`);
    }
    if (!content.includes("await this.importEcommerceLocalManifests?.()")) {
      errors.push(`${label} must refresh from saved manifests after direct generation settles`);
    }
    if (/JSON\.stringify\(\(e\|\|\[\]\)\.slice\(0,30\)\)/.test(content)) {
      errors.push(`${label} must not persist full ecommerce image records with dataUrl payloads`);
    }
    if (!/delete t\.dataUrl;t\.localPath\|\|delete t\.url/.test(content)) {
      errors.push(`${label} must strip image bytes and localPath-backed remote URLs before record persistence`);
    }
    if (!/UcEcommerceMergeRecords\(\.\.\.e\)\{[\s\S]*UcEcommerceRecordIsDeleted\(r\)/.test(content)) {
      errors.push(`${label} must filter deleted ecommerce records while importing local manifests`);
    }
    if (!/deleteEcommerceRecord\(e\)\{[\s\S]*UcEcommerceRememberDeletedRecords/.test(content)) {
      errors.push(`${label} must tombstone deleted ecommerce records before saving localStorage`);
    }
    if (!/clearEcommerceRecords\(\)\{UcEcommerceRememberDeletedRecords/.test(content)) {
      errors.push(`${label} must tombstone cleared ecommerce records so local manifests do not reappear after refresh`);
    }
    if (!/upsertEcommerceRecord\(e\)\{if\(UcEcommerceRecordIsDeleted\(e\)\)return/.test(content)) {
      errors.push(`${label} must prevent progress or sync upserts from reviving deleted records`);
    }
  }
}

/**
 * Replays the attached bad-log shape against the export helper. A running
 * snapshot with zero images must be labeled as in-flight diagnostic data.
 */
function verifyEcommerceLogDiagnosticPayload(errors) {
  try {
    const content = readFile(patchScript);
    const exportPayload = evaluatePatchHelper(content, "UcEcommerceLogExportPayload");
    const payload = exportPayload({
      id: "ecom-1788359466115-gi682v",
      name: "羽绒服",
      platform: "xiaohongshu",
      platform_label: "小红书",
      output_types: ["main_image", "detail_image", "model_image"],
      output_counts: { main_image: 1, detail_image: 3, model_image: 1 },
      generated_at: "2026-09-02T14:31:06.115Z",
      completed_at: "",
      images: [],
      warnings: [],
      billing: null,
      localDir: "",
      localManifestPath: "",
      model: "",
      progress: { done: 0, total: 5, current: "主图", status: "started" },
    });
    const missingFields = Array.isArray(payload?.diagnostic?.missing_fields) ? payload.diagnostic.missing_fields : [];
    if (payload.diagnostic_status !== "running" || payload?.diagnostic?.status !== "running") {
      errors.push("UcEcommerceLogExportPayload must label started zero-image logs as running");
    }
    if (payload?.diagnostic?.planned_count !== 5 || payload?.diagnostic?.generated_count !== 0) {
      errors.push("UcEcommerceLogExportPayload must include planned/generated counts");
    }
    for (const field of ["images", "model", "billing", "localDir", "localManifestPath"]) {
      if (!missingFields.includes(field)) {
        errors.push(`UcEcommerceLogExportPayload missing diagnostic field: ${field}`);
      }
    }
    if (!String(payload.export_note || "").includes("当前日志为进行中快照")) {
      errors.push("UcEcommerceLogExportPayload must explain running snapshots in export_note");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
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
      ".uclaw-ecommerce-featured-preview",
      ".uclaw-ecommerce-swiper",
      ".uclaw-ecommerce-swiper-stage",
      ".uclaw-ecommerce-result-body",
      ".uclaw-ecommerce-result-strip",
      ".uclaw-ecommerce-layout",
      "max-width: 1132px",
      "grid-template-columns: minmax(720px, 1.5fr) minmax(420px, 0.85fr)",
      "container-type: inline-size",
      "@container (min-width: 560px)",
      "@media (min-width: 1680px)",
      "max-width: 1880px",
      "grid-template-columns: minmax(0, 1.42fr) minmax(520px, 0.9fr)",
      "ecommerce-large-screen-layout-2",
      "ecommerce-ultrawide-layout-2",
      "@media (min-width: 2200px)",
      "grid-template-columns: minmax(0, 1.46fr) minmax(640px, 0.92fr)",
      "body:has(openclaw-tasks-page .uclaw-ecommerce-workbench) .content > openclaw-router-outlet",
      ".uclaw-ecommerce-asset-row",
      ".uclaw-ecommerce-drop",
      ".update-banner",
      "ecommerce-design-layout-4",
    ]) {
      requireToken(errors, label, content, token);
    }
    if (/body:has\(openclaw-tasks-page \.uclaw-ecommerce-workbench\) \.(topbar|sidebar|sidebar-shell|nav-item)/.test(content)) {
      errors.push(`${label} must not scale global shell chrome on ecommerce route`);
    }
  }
}

/**
 * Ensures visible ecommerce workbench changes advance the Service Worker cache marker.
 */
function verifyServiceWorker(errors) {
  const content = readFile(path.join(path.dirname(assetsDir), "sw.js"));
  requireToken(errors, "node_modules/openclaw/dist/control-ui/sw.js", content, "ecommerce-download-filename-1");
  requireToken(errors, "node_modules/openclaw/dist/control-ui/sw.js", content, "ecommerce-status-complete-1");
  requireToken(errors, "node_modules/openclaw/dist/control-ui/sw.js", content, "ecommerce-ultrawide-layout-2");
  requireToken(errors, "node_modules/openclaw/dist/control-ui/sw.js", content, "ecommerce-swiper-preview-1");
  requireToken(errors, "node_modules/openclaw/dist/control-ui/sw.js", content, "ecommerce-local-library-1");
  requireToken(errors, "node_modules/openclaw/dist/control-ui/sw.js", content, "ecommerce-local-manifest-import-1");
  requireToken(errors, "node_modules/openclaw/dist/control-ui/sw.js", content, "ecommerce-record-delete-1");
  requireToken(errors, "node_modules/openclaw/dist/control-ui/sw.js", content, "ecommerce-task-recreate-1");
  requireToken(errors, "node_modules/openclaw/dist/control-ui/sw.js", content, "ecommerce-record-delete-confirm-1");
  requireToken(errors, "node_modules/openclaw/dist/control-ui/sw.js", content, "ecommerce-record-density-1");
  requireToken(errors, "node_modules/openclaw/dist/control-ui/sw.js", content, "ecommerce-record-tombstone-1");
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
    verifyWindowsEcommerceLocalPathTrust(errors);
    verifyPatchSource(errors);
    verifyGeneratedTasksPage(errors);
    verifyEcommerceLogDiagnosticPayload(errors);
    verifyGeneratedCss(errors);
    verifyServiceWorker(errors);
    verifyBundledSkill(errors);
    verifyCloudEcommerceUsageMigration(errors);
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
