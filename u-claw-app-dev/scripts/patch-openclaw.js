const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const openclawDistDir = path.join(root, "node_modules", "openclaw", "dist");
const controlUiDir = path.join(root, "node_modules", "openclaw", "dist", "control-ui");
const assetsDir = path.join(controlUiDir, "assets");
const swPath = path.join(controlUiDir, "sw.js");
const indexHtmlPath = path.join(controlUiDir, "index.html");
const manifestPath = path.join(controlUiDir, "manifest.webmanifest");
const controlUiGatewayPath = path.join(root, "node_modules", "openclaw", "dist", "control-ui-CuoxgbYo.js");
const installPackageDirPath = path.join(openclawDistDir, "install-package-dir-DhuK4F77.js");
const skillsGatewayPath = path.join(openclawDistDir, "skills-ieKSTXPw.js");
const schemaPath = path.join(openclawDistDir, "schema-BuOFpc7K.js");
const serverMethodsPath = path.join(openclawDistDir, "server-methods-NpEcZnvp.js");
const coreDescriptorsPath = path.join(openclawDistDir, "core-descriptors-DRUtdasO.js");
const officialIconSvgPath = path.join(root, "assets", "icon.svg");
const officialIconPngPath = path.join(root, "assets", "icon.png");
const officialIconIcoPath = path.join(root, "assets", "icon.ico");
const localRootsPath = path.join(openclawDistDir, "local-roots-CAoJyC6u.js");

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function writeIfChanged(file, before, after) {
  if (before === after) return false;
  fs.writeFileSync(file, after);
  return true;
}

function copyFileIfChanged(source, target) {
  if (!fs.existsSync(source)) {
    throw new Error(`Missing U-Claw brand asset: ${source}`);
  }

  const next = fs.readFileSync(source);
  const before = fs.existsSync(target) ? fs.readFileSync(target) : null;
  if (before && before.equals(next)) return false;

  fs.copyFileSync(source, target);
  return true;
}

/**
 * Replaces the Control UI browser and in-app fallback avatars with official U-Claw assets.
 */
function patchControlUiBrandAssets() {
  const copies = [
    [officialIconSvgPath, path.join(controlUiDir, "favicon.svg")],
    [officialIconPngPath, path.join(controlUiDir, "apple-touch-icon.png")],
    [officialIconPngPath, path.join(controlUiDir, "favicon-32.png")],
    [officialIconIcoPath, path.join(controlUiDir, "favicon.ico")],
  ];

  for (const [source, target] of copies) {
    if (copyFileIfChanged(source, target)) {
      console.log(`patched ${path.relative(root, target)}`);
    }
  }
}

/**
 * Adds the minimal OpenClaw Gateway method needed by the installed-skill uninstall UI.
 */
function patchSkillsUninstallGateway() {
  const uninstallFunction = [
    "/**",
    " * Removes one installed skill and clears its ClawHub tracking record when present.",
    " */",
    "async function uninstallWorkspaceSkill(params) {",
    "\tconst status = buildWorkspaceSkillStatus(params.workspaceDir, {",
    "\t\tconfig: params.config,",
    "\t\tagentId: params.agentId",
    "\t});",
    "\tconst skill = status.skills.find((candidate) => candidate.skillKey === params.skillKey || candidate.name === params.skillKey);",
    "\tif (!skill) return {",
    "\t\tok: false,",
    "\t\terror: `Skill not found: ${params.skillKey}`,",
    "\t\terrorKind: \"invalid-request\"",
    "\t};",
    "\tif (skill.bundled || skill.source === \"openclaw-bundled\") return {",
    "\t\tok: false,",
    "\t\terror: `Bundled skill cannot be uninstalled: ${skill.skillKey}`,",
    "\t\terrorKind: \"invalid-request\"",
    "\t};",
    "\tawait fs.rm(skill.baseDir, { recursive: true, force: true });",
    "\tif (skill.clawhub) await untrackClawHubSkill(params.workspaceDir, skill.skillKey);",
    "\treturn {",
    "\t\tok: true,",
    "\t\tskillKey: skill.skillKey,",
    "\t\ttargetDir: skill.baseDir,",
    "\t\t...skill.clawhub ? { tracked: true } : {}",
    "\t};",
    "}",
  ].join("\n");
  const uninstallHandler = [
    "\t\"skills.uninstall\": async ({ params, respond, context }) => {",
    "\t\tif (!params || typeof params !== \"object\") {",
    "\t\t\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, \"skills.uninstall requires a skillKey\"));",
    "\t\t\treturn;",
    "\t\t}",
    "\t\tconst skillKey = typeof params.skillKey === \"string\" ? params.skillKey.trim() : \"\";",
    "\t\tif (!skillKey) {",
    "\t\t\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, \"skills.uninstall requires a skillKey\"));",
    "\t\t\treturn;",
    "\t\t}",
    "\t\tconst resolved = resolveSkillsAgentWorkspace(params, context);",
    "\t\tif (!resolved.ok) {",
    "\t\t\trespond(false, void 0, resolved.error);",
    "\t\t\treturn;",
    "\t\t}",
    "\t\ttry {",
    "\t\t\tconst result = await uninstallWorkspaceSkill({",
    "\t\t\t\tworkspaceDir: resolved.workspaceDir,",
    "\t\t\t\tskillKey,",
    "\t\t\t\tconfig: resolved.cfg,",
    "\t\t\t\tagentId: resolved.agentId",
    "\t\t\t});",
    "\t\t\trespond(result.ok, result, result.ok ? void 0 : errorShape(ErrorCodes.INVALID_REQUEST, result.error));",
    "\t\t} catch (err) {",
    "\t\t\trespond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)));",
    "\t\t}",
    "\t},",
  ].join("\n");

  const skillsBefore = read(skillsGatewayPath);
  let skillsAfter = skillsBefore;
  if (!skillsAfter.includes("l as untrackClawHubSkill")) {
    skillsAfter = skillsAfter.replace(
      "i as readLocalSkillCardContentSync, p as validateRequestedSkillSlug",
      "i as readLocalSkillCardContentSync, l as untrackClawHubSkill, p as validateRequestedSkillSlug",
    );
  }
  if (!skillsAfter.includes("async function uninstallWorkspaceSkill(params)")) {
    skillsAfter = skillsAfter.replace(
      "//#endregion\n//#region src/skills/discovery/bins.ts",
      `${uninstallFunction}\n//#endregion\n//#region src/skills/discovery/bins.ts`,
    );
  }
  if (!skillsAfter.includes("\"skills.uninstall\": async")) {
    skillsAfter = skillsAfter.replace("\t\"skills.update\": async ({ params, respond, context }) => {", `${uninstallHandler}\n\t\"skills.update\": async ({ params, respond, context }) => {`);
  }
  if (
    !skillsAfter.includes("l as untrackClawHubSkill") ||
    !skillsAfter.includes("async function uninstallWorkspaceSkill(params)") ||
    !skillsAfter.includes("\"skills.uninstall\": async")
  ) {
    throw new Error(`Could not patch skills.uninstall gateway handler in ${skillsGatewayPath}`);
  }
  if (writeIfChanged(skillsGatewayPath, skillsBefore, skillsAfter)) {
    console.log(`patched ${path.relative(root, skillsGatewayPath)}`);
  }

  const methodsBefore = read(serverMethodsPath);
  let methodsAfter = methodsBefore;
  if (!methodsAfter.includes("\"skills.uninstall\"")) {
    methodsAfter = methodsAfter.replace("\t\t\t\"skills.install\",\n\t\t\t\"skills.update\",", "\t\t\t\"skills.install\",\n\t\t\t\"skills.uninstall\",\n\t\t\t\"skills.update\",");
  }
  if (!methodsAfter.includes("\"skills.uninstall\"")) {
    throw new Error(`Could not patch skills.uninstall server method in ${serverMethodsPath}`);
  }
  if (writeIfChanged(serverMethodsPath, methodsBefore, methodsAfter)) {
    console.log(`patched ${path.relative(root, serverMethodsPath)}`);
  }

  const descriptorsBefore = read(coreDescriptorsPath);
  let descriptorsAfter = descriptorsBefore;
  if (!descriptorsAfter.includes("name: \"skills.uninstall\"")) {
    descriptorsAfter = descriptorsAfter.replace(
      "\t{\n\t\tname: \"skills.install\",\n\t\tscope: \"operator.admin\"\n\t},\n\t{\n\t\tname: \"skills.update\",",
      "\t{\n\t\tname: \"skills.install\",\n\t\tscope: \"operator.admin\"\n\t},\n\t{\n\t\tname: \"skills.uninstall\",\n\t\tscope: \"operator.admin\"\n\t},\n\t{\n\t\tname: \"skills.update\",",
    );
  }
  if (!descriptorsAfter.includes("name: \"skills.uninstall\"")) {
    throw new Error(`Could not patch skills.uninstall descriptor in ${coreDescriptorsPath}`);
  }
  if (writeIfChanged(coreDescriptorsPath, descriptorsBefore, descriptorsAfter)) {
    console.log(`patched ${path.relative(root, coreDescriptorsPath)}`);
  }
}

/**
 * Installs SkillHub API entries that are not mirrored by the ClawHub install endpoint.
 */
function patchSkillHubInstallGateway() {
  const installFunction = [
    "const UCLAW_SKILLHUB_API_ORIGIN = \"https://api.skillhub.cn\";",
    "async function installSkillFromSkillHub(params) {",
    "\tlet slug;",
    "\ttry {",
    "\t\tslug = validateRequestedSkillSlug(params.slug);",
    "\t} catch (err) {",
    "\t\treturn {",
    "\t\t\tok: false,",
    "\t\t\terror: formatErrorMessage(err),",
    "\t\t\tfailureKind: \"invalid-request\"",
    "\t\t};",
    "\t}",
    "\tconst version = typeof params.version === \"string\" && params.version.trim() ? params.version.trim() : void 0;",
    "\tconst url = new URL(\"/api/v1/download\", UCLAW_SKILLHUB_API_ORIGIN);",
    "\turl.searchParams.set(\"slug\", slug);",
    "\tif (version) url.searchParams.set(\"version\", version);",
    "\tconst tempDir = path.join(resolveStateDir(), \"tmp\", \"skillhub-downloads\");",
    "\tawait fs.mkdir(tempDir, { recursive: true });",
    "\tconst archivePath = path.join(tempDir, `${slug}-${randomUUID()}.zip`);",
    "\ttry {",
    "\t\tconst response = await fetch(url, { redirect: \"follow\" });",
    "\t\tif (!response.ok) {",
    "\t\t\tconst body = await response.text().catch(() => response.statusText);",
    "\t\t\treturn {",
    "\t\t\t\tok: false,",
    "\t\t\t\terror: `SkillHub /api/v1/download?slug=${slug} failed (${response.status}): ${body || response.statusText}`,",
    "\t\t\t\tfailureKind: response.status >= 400 && response.status < 500 ? \"invalid-request\" : \"unavailable\"",
    "\t\t\t};",
    "\t\t}",
    "\t\tconst bytes = Buffer.from(await response.arrayBuffer());",
    "\t\tawait fs.writeFile(archivePath, bytes);",
    "\t\tconst result = await installSkillArchiveFromPath({",
    "\t\t\tworkspaceDir: params.workspaceDir,",
    "\t\t\tslug,",
    "\t\t\tarchivePath,",
    "\t\t\tforce: params.force,",
    "\t\t\ttimeoutMs: params.timeoutMs,",
    "\t\t\tlogger: params.logger,",
    "\t\t\tpolicy: {",
    "\t\t\t\tconfig: params.config,",
    "\t\t\t\tinstallId: \"skillhub\",",
    "\t\t\t\torigin: {",
    "\t\t\t\t\ttype: \"skillhub\",",
    "\t\t\t\t\tregistry: UCLAW_SKILLHUB_API_ORIGIN,",
    "\t\t\t\t\tslug,",
    "\t\t\t\t\t...version ? { version } : {}",
    "\t\t\t\t},",
    "\t\t\t\tsource: {",
    "\t\t\t\t\tkind: \"skillhub\",",
    "\t\t\t\t\tauthority: \"third-party\",",
    "\t\t\t\t\tmutable: false,",
    "\t\t\t\t\tnetwork: true",
    "\t\t\t\t},",
    "\t\t\t\trequestedSpecifier: `skillhub:${slug}${version ? `@${version}` : \"\"}`",
    "\t\t\t}",
    "\t\t});",
    "\t\treturn result.ok ? {",
    "\t\t\tok: true,",
    "\t\t\tslug,",
    "\t\t\t...version ? { version } : {},",
    "\t\t\ttargetDir: result.targetDir",
    "\t\t} : result;",
    "\t} catch (err) {",
    "\t\treturn {",
    "\t\t\tok: false,",
    "\t\t\terror: formatErrorMessage(err),",
    "\t\t\tfailureKind: \"unavailable\"",
    "\t\t};",
    "\t} finally {",
    "\t\tawait fs.rm(archivePath, { force: true }).catch(() => {});",
    "\t}",
    "}",
  ].join("\n");

  const installHandler = [
    "\t\tif (params && typeof params === \"object\" && \"source\" in params && params.source === \"skillhub\") {",
    "\t\t\tconst p = params;",
    "\t\t\tconst result = await installSkillFromSkillHub({",
    "\t\t\t\tworkspaceDir: workspaceDirRaw,",
    "\t\t\t\tslug: p.slug,",
    "\t\t\t\tversion: p.version,",
    "\t\t\t\tforce: Boolean(p.force),",
    "\t\t\t\ttimeoutMs: p.timeoutMs,",
    "\t\t\t\tconfig: cfg,",
    "\t\t\t\tlogger: context.logGateway",
    "\t\t\t});",
    "\t\t\tconst errorCode = !result.ok && result.failureKind === \"invalid-request\" ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE;",
    "\t\t\trespond(result.ok, result.ok ? {",
    "\t\t\t\tok: true,",
    "\t\t\t\tmessage: `已安装 ${result.slug}${result.version ? `@${result.version}` : \"\"}`,",
    "\t\t\t\tstdout: \"\",",
    "\t\t\t\tstderr: \"\",",
    "\t\t\t\tcode: 0,",
    "\t\t\t\tslug: result.slug,",
    "\t\t\t\t...result.version ? { version: result.version } : {},",
    "\t\t\t\ttargetDir: result.targetDir",
    "\t\t\t} : result, result.ok ? void 0 : errorShape(errorCode, result.error));",
    "\t\t\treturn;",
    "\t\t}",
  ].join("\n");

  const skillsBefore = read(skillsGatewayPath);
  let skillsAfter = skillsBefore;
  if (!skillsAfter.includes("async function installSkillFromSkillHub(params)")) {
    skillsAfter = skillsAfter.replace(
      "//#endregion\n//#region src/skills/discovery/bins.ts",
      `${installFunction}\n//#endregion\n//#region src/skills/discovery/bins.ts`,
    );
  }
  if (!skillsAfter.includes("params.source === \"skillhub\"")) {
    skillsAfter = skillsAfter.replace(
      "\t\tif (params && typeof params === \"object\" && \"source\" in params && params.source === \"upload\") {",
      `${installHandler}\n\t\tif (params && typeof params === \"object\" && \"source\" in params && params.source === \"upload\") {`,
    );
  }
  skillsAfter = skillsAfter
    .replaceAll("message: `Installed ${record.slug}`", "message: `已安装 ${record.slug}`")
    .replaceAll("message: `Installed ${result.slug}@${result.version}`", "message: `已安装 ${result.slug}@${result.version}`")
    .replaceAll("message: `Installed ${result.slug}${result.version ? `@${result.version}` : \"\"}`", "message: `已安装 ${result.slug}${result.version ? `@${result.version}` : \"\"}`");
  if (
    !skillsAfter.includes("async function installSkillFromSkillHub(params)") ||
    !skillsAfter.includes("params.source === \"skillhub\"")
  ) {
    throw new Error(`Could not patch SkillHub install gateway handler in ${skillsGatewayPath}`);
  }
  if (writeIfChanged(skillsGatewayPath, skillsBefore, skillsAfter)) {
    console.log(`patched ${path.relative(root, skillsGatewayPath)}`);
  }

  const schemaBefore = read(schemaPath);
  let schemaAfter = schemaBefore;
  const skillHubInstallSchema = [
    "\tType.Object({",
    "\t\tagentId: Type.Optional(NonEmptyString),",
    "\t\tsource: Type.Literal(\"skillhub\"),",
    "\t\tslug: NonEmptyString,",
    "\t\tversion: Type.Optional(NonEmptyString),",
    "\t\tforce: Type.Optional(Type.Boolean()),",
    "\t\ttimeoutMs: Type.Optional(Type.Integer({ minimum: 1e3 }))",
    "\t}, { additionalProperties: false }),",
  ].join("\n");
  if (!schemaAfter.includes("source: Type.Literal(\"skillhub\")")) {
    schemaAfter = schemaAfter.replace(
      "\tType.Object({\n\t\tagentId: Type.Optional(NonEmptyString),\n\t\tsource: Type.Literal(\"upload\"),",
      `${skillHubInstallSchema}\n\tType.Object({\n\t\tagentId: Type.Optional(NonEmptyString),\n\t\tsource: Type.Literal(\"upload\"),`,
    );
  }
  if (!schemaAfter.includes("source: Type.Literal(\"skillhub\")")) {
    throw new Error(`Could not patch SkillHub install schema in ${schemaPath}`);
  }
  if (writeIfChanged(schemaPath, schemaBefore, schemaAfter)) {
    console.log(`patched ${path.relative(root, schemaPath)}`);
  }
}

/**
 * Adds a Windows fallback when atomic staged directory rename is denied.
 */
function patchWindowsInstallPublishFallback() {
  const before = read(installPackageDirPath);
  let after = before;
  const helper = [
    "function isUcWindowsSkillPublishRenameDenied(error) {",
    "\treturn process.platform === \"win32\" && error?.code === \"EPERM\" && String(error).includes(\".fs-safe-move-\");",
    "}",
    "async function publishInstallStageWithUcWindowsFallback(params) {",
    "\ttry {",
    "\t\tawait movePathWithCopyFallback({",
    "\t\t\tfrom: params.from,",
    "\t\t\tsourceHardlinks: params.sourceHardlinks,",
    "\t\t\tto: params.to",
    "\t\t});",
    "\t\treturn;",
    "\t} catch (error) {",
    "\t\tif (!isUcWindowsSkillPublishRenameDenied(error)) throw error;",
    "\t\tparams.logger?.warn?.(`Windows denied staged rename into ${params.to}; retrying with direct copy.`);",
    "\t\tawait fs.cp(params.from, params.to, {",
    "\t\t\trecursive: true,",
    "\t\t\tforce: true,",
    "\t\t\terrorOnExist: false,",
    "\t\t\tverbatimSymlinks: true",
    "\t\t});",
    "\t\tawait fs.rm(params.from, { recursive: true, force: true }).catch(() => void 0);",
    "\t}",
    "}",
  ].join("\n");
  if (!after.includes("publishInstallStageWithUcWindowsFallback")) {
    after = after.replace(
      "async function installPackageDir(params) {",
      `${helper}\nasync function installPackageDir(params) {`,
    );
  }
  after = after.replace(
    /\t\tawait movePathWithCopyFallback\(\{\n\t\t\tfrom: stageDir,\n\t\t\tsourceHardlinks,\n\t\t\tto: canonicalTargetDir\n\t\t\}\);/,
    "\t\tawait publishInstallStageWithUcWindowsFallback({\n\t\t\tfrom: stageDir,\n\t\t\tsourceHardlinks,\n\t\t\tto: canonicalTargetDir,\n\t\t\tlogger: params.logger\n\t\t});",
  );
  if (!after.includes("publishInstallStageWithUcWindowsFallback")) {
    throw new Error(`Could not patch Windows install publish fallback in ${installPackageDirPath}`);
  }
  if (writeIfChanged(installPackageDirPath, before, after)) {
    console.log(`patched ${path.relative(root, installPackageDirPath)}`);
  }
}

/**
 * Returns generated asset files whose names match the current OpenClaw build hash.
 */
function listAssetFiles(pattern, label) {
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`Missing OpenClaw control-ui assets: ${assetsDir}`);
  }

  const files = fs
    .readdirSync(assetsDir)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(assetsDir, name));

  if (files.length === 0) {
    throw new Error(`Missing ${label} asset in ${assetsDir}`);
  }

  return files;
}

/**
 * Applies deterministic string replacements to minified UI assets.
 */
function replacePairs(source, pairs) {
  let next = source;
  for (const [from, to] of pairs) {
    next = next.replaceAll(from, to);
  }
  return next;
}

/**
 * Escapes a literal string for safe use inside a RegExp.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patchChatPage() {
  const files = listAssetFiles(/^chat-page-.*\.js$/, "chat-page");

  const replacement =
    "function Li(e){if(!e||typeof e!=`object`)return!1;let o=Q(e),t=Q(o?.message)??o;if(!t)return!1;let n=Q(t.provenance),r=typeof n?.sourceTool==`string`?n.sourceTool.toLowerCase():``;if(O(t.role)===`user`&&n?.kind===`inter_session`&&[`agent_harness_task`,`image_generate`,`music_generate`,`video_generate`].includes(r))return!0;if(O(t.role)!==`assistant`||typeof t.senderLabel==`string`&&t.senderLabel.trim())return!1;let{text:i,hasVisibleNonTextContent:a}=Ii(typeof t.content==`string`||Array.isArray(t.content)?t.content:t.text);return a?!1:Pi(i).shouldSkip}var Ri=";

  for (const file of files) {
    const before = read(file);
    let after = before;

    if (!(before.includes("Q(o?.message)??o") && before.includes("`video_generate`"))) {
      after = after.replace(/function Li\(e\)\{[\s\S]*?\}var Ri=/, replacement);
      if (after === before) {
        throw new Error(`Could not patch internal media event filter in ${file}`);
      }
    }

    const emptyVideoToolOutput =
      "l?e.preview?s`${h} ${wx(e.outputText)}`:Tx({label:d?`Tool error`:`Tool output`,text:e.outputText}):d?Tx({label:`Tool error`,text:`No output — tool failed.`}):c";
    const videoToolOutput =
      "l?e.preview?s`${h} ${wx(e.outputText)}`:Tx({label:d?`Tool error`:`Tool output`,text:e.outputText}):d?Tx({label:`Tool error`,text:`No output — tool failed.`}):e.name===`video_generate`?Tx({label:`Tool output`,text:`视频生成中，请稍等。完成后会自动显示视频。`}):c";
    if (!after.includes("视频生成中，请稍等")) {
      after = after.replace(emptyVideoToolOutput, videoToolOutput);
    }

    const localMediaGuard =
      "function zS(e,t){if(FS(e))return!0;let n=IS(e),r=n?[RS(n)]:";
    const uclawMediaGuard =
      "function zS(e,t){if(FS(e))return!0;let n=IS(e);if(n&&RS(n).includes(`/.openclaw/media/`))return!0;let r=n?[RS(n)]:";
    if (!after.includes("RS(n).includes(`/.openclaw/media/`)")) {
      after = after.replace(localMediaGuard, uclawMediaGuard);
    }

    const mediaDirectiveSplit =
      "let r=t[1],i=zr(r),u=i??r,d=i?[i]:r.split(/\\s+/).filter(Boolean),f=c.length,p=0,m=[],h=!1;for(let e of d){";
    const mediaDirectiveWithOpenclawPath =
      "let r=t[1],i=zr(r),u=i??r,d=i?[i]:r.split(/\\s+/).filter(Boolean),f=c.length,p=0,m=[],h=!1,y=/[\\\\/]\\.openclaw[\\\\/]media[\\\\/]/.test(u);if(!i&&y){let e=wr(Er(u));Rr(e,{allowSpaces:!0,allowBareFilename:!0})&&(d=[e])}for(let e of d){";
    if (!after.includes("openclaw[\\\\/]media")) {
      after = after.replace(mediaDirectiveSplit, mediaDirectiveWithOpenclawPath);
    }

    const lightboxFunction = `function uClawEnsureMediaLightboxStyle(){if(document.getElementById(\`uclaw-media-lightbox-style\`))return;let e=document.createElement(\`style\`);e.id=\`uclaw-media-lightbox-style\`,e.textContent=[\`.uclaw-media-lightbox{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.84);display:flex;align-items:center;justify-content:center;padding:32px;outline:0}.uclaw-media-lightbox__viewer{max-width:96vw;max-height:92vh;display:flex;align-items:center;justify-content:center}.uclaw-media-lightbox__viewer img,.uclaw-media-lightbox__viewer video{max-width:96vw;max-height:92vh;object-fit:contain;border-radius:8px;background:#000;box-shadow:0 20px 80px rgba(0,0,0,.45)}.uclaw-media-lightbox__toolbar{position:fixed;top:16px;right:16px;display:flex;gap:10px;z-index:1}.uclaw-media-lightbox__button{border:0;border-radius:999px;background:rgba(255,255,255,.92);color:#111;min-width:38px;height:38px;padding:0 13px;display:inline-flex;align-items:center;justify-content:center;font:600 13px/1 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-decoration:none;box-shadow:0 6px 22px rgba(0,0,0,.28);cursor:pointer}.uclaw-media-lightbox__button:hover{background:#fff}.uclaw-media-lightbox__button--close{font-size:20px;font-weight:500;padding-bottom:2px}@media (max-width:720px){.uclaw-media-lightbox{padding:14px}.uclaw-media-lightbox__viewer img,.uclaw-media-lightbox__viewer video{max-width:96vw;max-height:88vh}.uclaw-media-lightbox__toolbar{top:12px;right:12px}}\`].join(\`\`),document.head.appendChild(e)}function uClawOpenMediaLightbox(e,t={}){let n=typeof e==\`string\`?e.trim():\`\`;if(!n)return;uClawEnsureMediaLightboxStyle(),document.querySelector(\`.uclaw-media-lightbox\`)?.remove();let r=document.createElement(\`div\`);r.className=\`uclaw-media-lightbox\`,r.tabIndex=-1,r.setAttribute(\`role\`,\`dialog\`),r.setAttribute(\`aria-modal\`,\`true\`);let i=()=>{document.removeEventListener(\`keydown\`,a,!0),r.remove()},a=e=>{e.key===\`Escape\`&&(e.preventDefault(),i())};r.addEventListener(\`click\`,e=>{e.target===r&&i()});let o=document.createElement(\`div\`);o.className=\`uclaw-media-lightbox__toolbar\`;let s=document.createElement(\`a\`);s.className=\`uclaw-media-lightbox__button\`,s.href=n,s.target=\`_blank\`,s.rel=\`noreferrer\`,s.download=t.label||\`\`,s.textContent=\`下载\`;let c=document.createElement(\`button\`);c.className=\`uclaw-media-lightbox__button uclaw-media-lightbox__button--close\`,c.type=\`button\`,c.setAttribute(\`aria-label\`,\`关闭预览\`),c.textContent=\`×\`,c.addEventListener(\`click\`,i),o.append(s,c);let l=document.createElement(\`div\`);l.className=\`uclaw-media-lightbox__viewer\`;let u=(t.kind||\`\`).toLowerCase()===\`video\`||/\\.(?:m4v|mov|mp4|webm)(?:[?#].*)?$/i.test(n),d=document.createElement(u?\`video\`:\`img\`);d.src=n,u?(d.controls=!0,d.autoplay=!0,d.playsInline=!0,d.preload=\`metadata\`):d.alt=t.label||\`Preview\`,d.addEventListener(\`click\`,e=>e.stopPropagation()),l.appendChild(d),r.append(o,l),document.body.appendChild(r),document.addEventListener(\`keydown\`,a,!0),requestAnimationFrame(()=>r.focus({preventScroll:!0}))}`;
    const lightboxFunctionV2 = `function uClawEnsureMediaLightboxStyle(){if(document.getElementById(\`uclaw-media-lightbox-style\`))return;let e=document.createElement(\`style\`);e.id=\`uclaw-media-lightbox-style\`,e.textContent=[\`.uclaw-media-lightbox{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.84);display:flex;align-items:center;justify-content:center;padding:32px 48px;outline:0;overflow:hidden}.uclaw-media-lightbox__viewer{max-width:96vw;max-height:90vh;display:flex;align-items:center;justify-content:center;overflow:hidden}.uclaw-media-lightbox__viewer img,.uclaw-media-lightbox__viewer video{max-width:96vw;max-height:90vh;object-fit:contain;border-radius:8px;background:#000;box-shadow:0 20px 80px rgba(0,0,0,.45);transform-origin:center center;transition:transform .14s ease}.uclaw-media-lightbox__toolbar{position:fixed;top:16px;right:16px;display:flex;gap:10px;z-index:1}.uclaw-media-lightbox__button{border:0;border-radius:999px;background:rgba(255,255,255,.92);color:#111;width:38px;height:38px;padding:0;display:inline-flex;align-items:center;justify-content:center;text-decoration:none;box-shadow:0 6px 22px rgba(0,0,0,.28);cursor:pointer}.uclaw-media-lightbox__button:hover{background:#fff}.uclaw-media-lightbox__button svg{width:19px;height:19px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.uclaw-media-lightbox__button--close{font-size:22px;font-weight:500;padding-bottom:2px}.uclaw-media-lightbox__zoom{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:1;display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:999px;background:rgba(20,20,20,.72);box-shadow:0 8px 28px rgba(0,0,0,.34);backdrop-filter:blur(10px)}.uclaw-media-lightbox__zoom-button{border:0;border-radius:999px;width:32px;height:32px;background:rgba(255,255,255,.9);color:#111;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font:600 14px/1 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.uclaw-media-lightbox__zoom-button:hover{background:#fff}.uclaw-media-lightbox__zoom-button svg{width:17px;height:17px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.uclaw-media-lightbox__zoom-value{min-width:48px;color:#fff;text-align:center;font:600 12px/1 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}@media (max-width:720px){.uclaw-media-lightbox{padding:14px}.uclaw-media-lightbox__viewer img,.uclaw-media-lightbox__viewer video{max-width:96vw;max-height:84vh}.uclaw-media-lightbox__toolbar{top:12px;right:12px}.uclaw-media-lightbox__zoom{bottom:12px}}\`].join(\`\`),document.head.appendChild(e)}function uClawOpenMediaLightbox(e,t={}){let n=typeof e==\`string\`?e.trim():\`\`;if(!n)return;uClawEnsureMediaLightboxStyle(),document.querySelector(\`.uclaw-media-lightbox\`)?.remove();let r=document.createElement(\`div\`);r.className=\`uclaw-media-lightbox\`,r.tabIndex=-1,r.setAttribute(\`role\`,\`dialog\`),r.setAttribute(\`aria-modal\`,\`true\`);let i=1,a=()=>{d.style.transform=\`scale(\${i})\`,v.textContent=\`\${Math.round(i*100)}%\`},o=()=>{document.removeEventListener(\`keydown\`,s,!0),r.remove()},s=e=>{e.key===\`Escape\`&&(e.preventDefault(),o())};r.addEventListener(\`click\`,e=>{e.target===r&&o()});let c=document.createElement(\`div\`);c.className=\`uclaw-media-lightbox__toolbar\`;let l=\`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg>\`,u=document.createElement(\`a\`);u.className=\`uclaw-media-lightbox__button\`,u.href=n,u.target=\`_blank\`,u.rel=\`noreferrer\`,u.download=t.label||\`\`,u.title=\`下载\`,u.setAttribute(\`aria-label\`,\`下载\`),u.innerHTML=l;let f=document.createElement(\`button\`);f.className=\`uclaw-media-lightbox__button uclaw-media-lightbox__button--close\`,f.type=\`button\`,f.setAttribute(\`aria-label\`,\`关闭预览\`),f.title=\`关闭\`,f.textContent=\`×\`,f.addEventListener(\`click\`,o),c.append(u,f);let p=document.createElement(\`div\`);p.className=\`uclaw-media-lightbox__viewer\`;let m=(t.kind||\`\`).toLowerCase()===\`video\`||/\\.(?:m4v|mov|mp4|webm)(?:[?#].*)?$/i.test(n),d=document.createElement(m?\`video\`:\`img\`);d.src=n,m?(d.controls=!0,d.autoplay=!0,d.playsInline=!0,d.preload=\`metadata\`):d.alt=t.label||\`Preview\`,d.addEventListener(\`click\`,e=>e.stopPropagation()),p.appendChild(d);let h=document.createElement(\`div\`);h.className=\`uclaw-media-lightbox__zoom\`;let y=(e,t,n)=>{let r=document.createElement(\`button\`);return r.className=\`uclaw-media-lightbox__zoom-button\`,r.type=\`button\`,r.title=t,r.setAttribute(\`aria-label\`,t),r.innerHTML=e,r.addEventListener(\`click\`,e=>{e.preventDefault(),e.stopPropagation(),n()}),r},g=\`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"></path></svg>\`,b=\`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>\`,w=\`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M8 21H5a2 2 0 0 1-2-2v-3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path></svg>\`,v=document.createElement(\`span\`);v.className=\`uclaw-media-lightbox__zoom-value\`,h.append(y(g,\`缩小\`,()=>{i=Math.max(.5,Math.round((i-.25)*100)/100),a()}),v,y(b,\`放大\`,()=>{i=Math.min(3,Math.round((i+.25)*100)/100),a()}),y(w,\`适配\`,()=>{i=1,a()})),r.append(c,p,h),document.body.appendChild(r),a(),document.addEventListener(\`keydown\`,s,!0),requestAnimationFrame(()=>r.focus({preventScroll:!0}))}`;
    const lightboxFunctionV3 = `function uClawEnsureMediaLightboxStyle(){let e=document.getElementById("uclaw-media-lightbox-style");e&&e.remove();e=document.createElement("style");e.id="uclaw-media-lightbox-style";e.textContent=".uclaw-media-lightbox{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.84);display:flex;align-items:center;justify-content:center;padding:42px 52px;outline:0;overflow:hidden}.uclaw-media-lightbox--full{padding:0}.uclaw-media-lightbox__viewer{width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden}.uclaw-media-lightbox__viewer img,.uclaw-media-lightbox__viewer video{max-width:96vw;max-height:90vh;object-fit:contain;border-radius:8px;background:#000;box-shadow:0 20px 80px rgba(0,0,0,.45);transform-origin:center center;transition:transform .14s ease,width .14s ease,height .14s ease,border-radius .14s ease}.uclaw-media-lightbox--full .uclaw-media-lightbox__viewer img,.uclaw-media-lightbox--full .uclaw-media-lightbox__viewer video{width:100vw;height:100vh;max-width:100vw;max-height:100vh;border-radius:0;box-shadow:none}.uclaw-media-lightbox__toolbar{position:fixed;top:16px;right:16px;display:flex;gap:10px;z-index:1}.uclaw-media-lightbox__button{border:0;border-radius:999px;background:rgba(255,255,255,.92);color:#111;width:38px;height:38px;padding:0;display:inline-flex;align-items:center;justify-content:center;text-decoration:none;box-shadow:0 6px 22px rgba(0,0,0,.28);cursor:pointer}.uclaw-media-lightbox__button:hover{background:#fff}.uclaw-media-lightbox__button svg{width:19px;height:19px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.uclaw-media-lightbox__button--close{font-size:22px;font-weight:500;padding-bottom:2px}.uclaw-media-lightbox__zoom{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:1;display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:999px;background:rgba(20,20,20,.74);box-shadow:0 8px 28px rgba(0,0,0,.34);backdrop-filter:blur(10px)}.uclaw-media-lightbox__zoom-button{border:0;border-radius:999px;width:32px;height:32px;background:rgba(255,255,255,.92);color:#111;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font:600 14px/1 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.uclaw-media-lightbox__zoom-button:hover{background:#fff}.uclaw-media-lightbox__zoom-button svg{width:17px;height:17px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.uclaw-media-lightbox__zoom-value{min-width:48px;color:#fff;text-align:center;font:600 12px/1 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}@media (max-width:720px){.uclaw-media-lightbox{padding:14px}.uclaw-media-lightbox--full{padding:0}.uclaw-media-lightbox__viewer img,.uclaw-media-lightbox__viewer video{max-width:96vw;max-height:84vh}.uclaw-media-lightbox__toolbar{top:12px;right:12px}.uclaw-media-lightbox__zoom{bottom:12px}}";document.head.appendChild(e)}function uClawOpenMediaLightbox(e,t={}){let n=typeof e=="string"?e.trim():"";if(!n)return;uClawEnsureMediaLightboxStyle();document.querySelector(".uclaw-media-lightbox")?.remove();let r=document.createElement("div");r.className="uclaw-media-lightbox";r.tabIndex=-1;r.setAttribute("role","dialog");r.setAttribute("aria-modal","true");let i=1,a=false,o='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M8 21H5a2 2 0 0 1-2-2v-3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path></svg>',s='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v5H3"></path><path d="M16 3v5h5"></path><path d="M8 21v-5H3"></path><path d="M16 21v-5h5"></path></svg>',c=()=>{d.style.transform="scale("+i+")";v.textContent=Math.round(i*100)+"%";r.classList.toggle("uclaw-media-lightbox--full",a);w.innerHTML=a?s:o;w.title=a?"退出全屏":"全屏";w.setAttribute("aria-label",w.title)},l=()=>{document.removeEventListener("keydown",u,true);r.remove()},u=e=>{if(e.key==="Escape"){e.preventDefault();l()}else if(e.key==="+"||e.key==="="){e.preventDefault();i=Math.min(3,Math.round((i+.25)*100)/100);c()}else if(e.key==="-"||e.key==="_"){e.preventDefault();i=Math.max(.5,Math.round((i-.25)*100)/100);c()}else if(e.key==="0"){e.preventDefault();i=1;c()}else if(e.key.toLowerCase()==="f"){e.preventDefault();a=!a;i=1;c()}};r.addEventListener("click",e=>{e.target===r&&l()});let f=document.createElement("div");f.className="uclaw-media-lightbox__toolbar";let p='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg>',m=document.createElement("a");m.className="uclaw-media-lightbox__button";m.href=n;m.target="_blank";m.rel="noreferrer";m.download=t.label||"";m.title="下载";m.setAttribute("aria-label","下载");m.innerHTML=p;let h=document.createElement("button");h.className="uclaw-media-lightbox__button uclaw-media-lightbox__button--close";h.type="button";h.setAttribute("aria-label","关闭预览");h.title="关闭";h.textContent="×";h.addEventListener("click",l);f.append(m,h);let y=document.createElement("div");y.className="uclaw-media-lightbox__viewer";let g=(t.kind||"").toLowerCase()==="video"||/\\.(?:m4v|mov|mp4|webm)(?:[?#].*)?$/i.test(n),d=document.createElement(g?"video":"img");d.src=n;if(g){d.controls=true;d.autoplay=true;d.playsInline=true;d.preload="metadata"}else d.alt=t.label||"Preview";d.addEventListener("click",e=>e.stopPropagation());d.addEventListener("dblclick",e=>{e.preventDefault();a=!a;i=1;c()});y.appendChild(d);let b=document.createElement("div");b.className="uclaw-media-lightbox__zoom";let S=(e,t,n)=>{let r=document.createElement("button");r.className="uclaw-media-lightbox__zoom-button";r.type="button";r.title=t;r.setAttribute("aria-label",t);r.innerHTML=e;r.addEventListener("click",e=>{e.preventDefault();e.stopPropagation();n()});return r},C='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"></path></svg>',T='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>',v=document.createElement("span");v.className="uclaw-media-lightbox__zoom-value";let w=S(o,"全屏",()=>{a=!a;i=1;c()});b.append(S(C,"缩小",()=>{i=Math.max(.5,Math.round((i-.25)*100)/100);c()}),v,S(T,"放大",()=>{i=Math.min(3,Math.round((i+.25)*100)/100);c()}),w);r.append(f,y,b);document.body.appendChild(r);c();document.addEventListener("keydown",u,true);requestAnimationFrame(()=>r.focus({preventScroll:true}))}`;
    if (after.includes("function uClawEnsureMediaLightboxStyle()")) {
      after = after.replace(
        /function uClawEnsureMediaLightboxStyle\(\)\{[\s\S]*?\}function mS\(\)\{return s`/,
        `${lightboxFunctionV3}function mS(){return s\``,
      );
    } else {
      after = after.replace("function mS(){return s`", `${lightboxFunctionV3}function mS(){return s\``);
    }

    const userImageBrowserOpen = "an(e,{allowDataImage:!0})";
    const userImageLightboxOpen = "uClawOpenMediaLightbox(e,{kind:`image`})";
    if (after.includes(userImageBrowserOpen)) {
      after = after.replace(userImageBrowserOpen, userImageLightboxOpen);
    }

    const assistantImageBrowserOpen = "@click=${()=>an(l,{allowDataImage:!0})}";
    const assistantImageLightboxOpen =
      "@click=${()=>uClawOpenMediaLightbox(l,{kind:`image`,label:e.label})}";
    if (after.includes(assistantImageBrowserOpen)) {
      after = after.replace(assistantImageBrowserOpen, assistantImageLightboxOpen);
    }

    const inlineVideo =
      `              <video
                controls
                preload="metadata"
                src=\${l}
                @loadedmetadata=\${()=>a?.()}
              ></video>`;
    const inlineVideoWithPreview =
      `              <button
                class="uclaw-media-preview-button"
                type="button"
                aria-label="Open video preview"
                title="Open preview"
                @click=\${t=>{t.preventDefault(),t.stopPropagation(),uClawOpenMediaLightbox(l,{kind:\`video\`,label:e.label})}}
              >
                ⤢
              </button>
              <video
                controls
                preload="metadata"
                src=\${l}
                @loadedmetadata=\${()=>a?.()}
              ></video>`;
    if (!after.includes("uclaw-media-preview-button")) {
      after = after.replace(inlineVideo, inlineVideoWithPreview);
    }

    const videoAttachmentFilenameLink = `              <a
                class="chat-assistant-attachment-card__link"
                href=\${l}
                target="_blank"
                rel="noreferrer"
                >\${e.label}</a
              >
`;
    if (after.includes(videoAttachmentFilenameLink)) {
      after = after.replace(videoAttachmentFilenameLink, "");
    }

    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

function patchControlCss() {
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`Missing OpenClaw control-ui assets: ${assetsDir}`);
  }

  const files = fs
    .readdirSync(assetsDir)
    .filter((name) => /^index-.*\.css$/.test(name))
    .map((name) => path.join(assetsDir, name));

  if (files.length === 0) {
    throw new Error(`Missing control-ui stylesheet in ${assetsDir}`);
  }

  const css = [
    ".chat-assistant-attachment-card--video{position:relative}",
    ".uclaw-media-preview-button{position:absolute;top:8px;right:8px;z-index:1;border:0;border-radius:999px;background:rgba(0,0,0,.62);color:#fff;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;font-size:17px;line-height:1;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}",
    ".uclaw-media-preview-button:hover{background:rgba(0,0,0,.82)}",
  ].join("");

  for (const file of files) {
    const before = read(file);
    if (before.includes(".uclaw-media-preview-button")) continue;
    const after = `${before}\n${css}\n`;
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

function patchLocalMediaRoots() {
  if (!fs.existsSync(localRootsPath)) {
    throw new Error(`Missing OpenClaw local roots module: ${localRootsPath}`);
  }

  let source = read(localRootsPath);
  const before = source;

  if (!source.includes("function getUClawMediaPreviewRoots")) {
    source = source.replace(
      "let cachedPreferredTmpDir;\nfunction resolveCachedPreferredTmpDir()",
      `let cachedPreferredTmpDir;
function getUClawMediaPreviewRoots(env = process.env) {
\tconst raw = env.UCLAW_MEDIA_PREVIEW_ROOTS?.trim();
\tif (!raw) return [];
\treturn raw.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean).map((entry) => path.resolve(resolveUserPath(entry, env))).filter((entry) => entry !== path.parse(entry).root);
}
function resolveCachedPreferredTmpDir()`,
    );
  }

  if (!source.includes("...getUClawMediaPreviewRoots()")) {
    source = source.replace(
      'path.join(resolvedStateDir, "media"),\n\t\tpath.join(resolvedStateDir, "canvas"),',
      'path.join(resolvedStateDir, "media"),\n\t\t...getUClawMediaPreviewRoots(),\n\t\tpath.join(resolvedStateDir, "canvas"),',
    );
  }

  if (source === before) return;
  if (!source.includes("function getUClawMediaPreviewRoots") || !source.includes("...getUClawMediaPreviewRoots()")) {
    throw new Error(`Could not patch local media preview roots in ${localRootsPath}`);
  }
  writeIfChanged(localRootsPath, before, source);
  console.log(`patched ${path.relative(root, localRootsPath)}`);
}

/**
 * Keeps OpenAI-compatible image generation independent of provider-hosted CDN
 * URLs. New API defaults image responses to `url`; request inline base64 first,
 * then safely download a returned URL when an upstream channel ignores that
 * request option.
 */
function patchOpenAiCompatibleImageResponses() {
  if (!fs.existsSync(openclawDistDir)) {
    throw new Error(`Missing OpenClaw dist directory: ${openclawDistDir}`);
  }

  const imageRuntimeFiles = fs
    .readdirSync(openclawDistDir)
    .filter((name) => /^image-generation-.*\.js$/.test(name))
    .map((name) => path.join(openclawDistDir, name))
    .filter((file) => read(file).includes("function createOpenAiCompatibleImageGenerationProvider(options)"));
  if (imageRuntimeFiles.length === 0) {
    throw new Error(`Missing OpenAI-compatible image generation runtime in ${openclawDistDir}`);
  }

  const webMediaRuntimeName = fs
    .readdirSync(openclawDistDir)
    .find((name) => /^web-media-.*\.js$/.test(name) && read(path.join(openclawDistDir, name)).includes("async function loadWebMediaRaw"));
  if (!webMediaRuntimeName) {
    throw new Error(`Missing web media runtime in ${openclawDistDir}`);
  }
  const webMediaImport = `import { r as loadWebMediaRaw } from "./${webMediaRuntimeName}";`;
  const streamRuntimeName = fs
    .readdirSync(openclawDistDir)
    .find((name) => /^stream-.*\.js$/.test(name) && read(path.join(openclawDistDir, name)).includes("function resolveProviderTransportSsrFPolicy"));
  if (!streamRuntimeName) {
    throw new Error(`Missing provider transport SSRF policy runtime in ${openclawDistDir}`);
  }
  const transportPolicyImport = `import { s as resolveProviderTransportSsrFPolicy } from "./${streamRuntimeName}";`;

  for (const file of imageRuntimeFiles) {
    const before = read(file);
    let after = before;

    if (!after.includes(webMediaImport)) {
      after = after.replace(
        /(import \{ r as resolveGeneratedMediaMaxBytes \} from "\.\/configured-max-bytes-[^"]+\.js";)/,
        `$1\n${webMediaImport}`,
      );
    }
    if (!after.includes(transportPolicyImport)) {
      after = after.replace(
        /(import \{ c as postJsonRequest,[^;]+ from "\.\/shared-[^"]+\.js";)/,
        `$1\n${transportPolicyImport}`,
      );
    }
    after = after.replace(
      "p as resolveProviderHttpRequestConfig",
      "m as resolveProviderHttpRequestConfigWithOriginTrust",
    );
    after = after.replace(
      "const { baseUrl, allowPrivateNetwork: resolvedAllowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({",
      "const { baseUrl, allowPrivateNetwork: resolvedAllowPrivateNetwork, headers, dispatcherPolicy, trustConfiguredBaseUrlOrigin } = resolveProviderHttpRequestConfigWithOriginTrust({",
    );

    if (!after.includes("async function materializeOpenAiCompatibleImageUrls")) {
      after = after.replace(
        "function parseOpenAiCompatibleImageResponse(payload, options = {}) {",
        `async function materializeOpenAiCompatibleImageUrls(payload, options = {}) {
\tif (!isRecord(payload) || !Array.isArray(payload.data)) return payload;
\tconst maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
\tconst data = await Promise.all(payload.data.map(async (entry, index) => {
\t\tif (!isRecord(entry) || normalizeOptionalString(entry.b64_json)) return entry;
\t\tconst url = normalizeOptionalString(entry.url);
\t\tif (!url) return entry;
\t\tconst media = await loadWebMediaRaw(url, {
\t\t\tmaxBytes,
\t\t\tssrfPolicy: options.ssrfPolicy,
\t\t\treadIdleTimeoutMs: options.timeoutMs
\t\t});
\t\tif (media.kind !== "image") throw new Error(\`OpenAI-compatible image \${index + 1} URL did not return an image\`);
\t\treturn {
\t\t\t...entry,
\t\t\tb64_json: media.buffer.toString("base64"),
\t\t\tmime_type: normalizeOptionalString(entry.mime_type) ?? normalizeOptionalString(media.contentType)
\t\t};
\t}));
\treturn {
\t\t...payload,
\t\tdata
\t};
}
function parseOpenAiCompatibleImageResponse(payload, options = {}) {`,
      );
    }

    const originalParse = `const images = parseOpenAiCompatibleImageResponse(await readProviderJsonResponse(response, \`${"${options.id}"}.image-generation\`, { maxBytes: resolveInlineImageJsonResponseMaxBytes(resolveResponseMaxImages({
\t\t\t\t\tcount,
\t\t\t\t\tmode,
\t\t\t\t\toptions
\t\t\t\t}), resolveGeneratedMediaMaxBytes(req.cfg, "image")) }), {`;
    const patchedParse = `const generatedMediaMaxBytes = resolveGeneratedMediaMaxBytes(req.cfg, "image");
\t\t\t\tconst payload = await readProviderJsonResponse(response, \`${"${options.id}"}.image-generation\`, { maxBytes: resolveInlineImageJsonResponseMaxBytes(resolveResponseMaxImages({
\t\t\t\t\tcount,
\t\t\t\t\tmode,
\t\t\t\t\toptions
\t\t\t\t}), generatedMediaMaxBytes) });
\t\t\t\tconst materializedPayload = await materializeOpenAiCompatibleImageUrls(payload, {
\t\t\t\t\tmaxBytes: generatedMediaMaxBytes,
\t\t\t\t\tssrfPolicy: requestSsrFPolicy,
\t\t\t\t\ttimeoutMs
\t\t\t\t});
\t\t\t\tconst images = parseOpenAiCompatibleImageResponse(materializedPayload, {`;
    if (!after.includes("const materializedPayload = await materializeOpenAiCompatibleImageUrls")) {
      after = after.replace(originalParse, patchedParse);
    }
    if (!after.includes("const requestSsrFPolicy = resolveProviderTransportSsrFPolicy({")) {
      after = after.replace(
        "const { response, release } = await (requestBody.kind === \"multipart\" ? postMultipartRequest({\n\t\t\t\turl: appendImagesPath(baseUrl, mode),",
        `const requestUrl = appendImagesPath(baseUrl, mode);
\t\t\tconst requestSsrFPolicy = resolveProviderTransportSsrFPolicy({
\t\t\t\turl: requestUrl,
\t\t\t\tbaseUrl,
\t\t\t\tallowPrivateNetwork: resolvedAllowPrivateNetwork,
\t\t\t\ttrustConfiguredBaseUrlOrigin
\t\t\t});
\t\t\tconst { response, release } = await (requestBody.kind === "multipart" ? postMultipartRequest({
\t\t\t\turl: requestUrl,`,
      );
      after = after.replace(
        "})(),\n\t\t\t\tbody: requestBody.body,\n\t\t\t\ttimeoutMs,\n\t\t\t\tfetchFn: fetch,\n\t\t\t\tallowPrivateNetwork: resolvedAllowPrivateNetwork,\n\t\t\t\tssrfPolicy: req.ssrfPolicy,\n\t\t\t\tdispatcherPolicy",
        "})(),\n\t\t\t\tbody: requestBody.body,\n\t\t\t\ttimeoutMs,\n\t\t\t\tfetchFn: fetch,\n\t\t\t\tallowPrivateNetwork: resolvedAllowPrivateNetwork,\n\t\t\t\tssrfPolicy: requestSsrFPolicy,\n\t\t\t\tdispatcherPolicy",
      );
      after = after.replace(
        "url: appendImagesPath(baseUrl, mode),",
        "url: requestUrl,",
      );
      after = after.replace(
        "ssrfPolicy: req.ssrfPolicy,\n\t\t\t\tdispatcherPolicy\n\t\t\t}));",
        "ssrfPolicy: requestSsrFPolicy,\n\t\t\t\tdispatcherPolicy\n\t\t\t}));",
      );
    }
    after = after.replace(
      "ssrfPolicy: req.ssrfPolicy,\n\t\t\t\t\ttimeoutMs\n\t\t\t\t});",
      "ssrfPolicy: requestSsrFPolicy,\n\t\t\t\t\ttimeoutMs\n\t\t\t\t});",
    );

    if (
      !after.includes("async function materializeOpenAiCompatibleImageUrls")
      || !after.includes("const materializedPayload = await materializeOpenAiCompatibleImageUrls")
      || !after.includes(webMediaImport)
      || !after.includes(transportPolicyImport)
      || !after.includes("resolveProviderHttpRequestConfigWithOriginTrust")
      || !after.includes("const requestSsrFPolicy = resolveProviderTransportSsrFPolicy({")
    ) {
      throw new Error(`Could not patch OpenAI-compatible image URL responses in ${file}`);
    }
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }

  const litellmProviderFiles = fs
    .readdirSync(openclawDistDir)
    .filter((name) => /^image-generation-provider-.*\.js$/.test(name))
    .map((name) => path.join(openclawDistDir, name))
    .filter((file) => read(file).includes("function buildLitellmImageGenerationProvider()"));
  if (litellmProviderFiles.length === 0) {
    throw new Error(`Missing LiteLLM image generation provider in ${openclawDistDir}`);
  }

  for (const file of litellmProviderFiles) {
    const before = read(file);
    let after = before;
    if (!after.includes('response_format: "b64_json"')) {
      after = after.replace(
        "size: req.size ?? DEFAULT_SIZE",
        'size: req.size ?? DEFAULT_SIZE,\n\t\t\t\tresponse_format: "b64_json"',
      );
    }
    if (!after.includes('response_format: "b64_json"')) {
      throw new Error(`Could not request inline LiteLLM image responses in ${file}`);
    }
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Keeps U-Claw image generation on configured image models only. Agent-supplied
 * overrides outside imageGenerationModel.primary/fallbacks are ignored.
 */
function patchConfiguredUclawImageGenerationModelsOnly() {
  if (!fs.existsSync(openclawDistDir)) {
    throw new Error(`Missing OpenClaw dist directory: ${openclawDistDir}`);
  }

  const files = fs
    .readdirSync(openclawDistDir)
    .filter((name) => /^openclaw-tools-.*\.js$/.test(name))
    .map((name) => path.join(openclawDistDir, name))
    .filter((file) => read(file).includes("const ImageGenerateToolSchema = Type.Object({"));
  if (files.length === 0) {
    throw new Error(`Missing image_generate tool runtime in ${openclawDistDir}`);
  }

  for (const file of files) {
    const before = read(file);
    let after = before;

    after = after.replace(
      'const UCLAW_FIXED_IMAGE_GENERATION_MODEL = "litellm/gpt-image-2";\n',
      '',
    );
    after = after.replace(
      'model: Type.Optional(Type.String({ description: "Provider/model override, e.g. openai/gpt-image-2; transparent OpenAI: openai/gpt-image-1.5." })),',
      'model: Type.Optional(Type.String({ description: "Optional provider/model override; U-Claw accepts only models declared in imageGenerationModel config." })),',
    );
    after = after.replace(
      'model: Type.Optional(Type.String({ description: "U-Claw ignores image model overrides and uses litellm/gpt-image-2." })),',
      'model: Type.Optional(Type.String({ description: "Optional provider/model override; U-Claw accepts only models declared in imageGenerationModel config." })),',
    );
    after = after.replace(
      'background: optionalStringEnum(SUPPORTED_BACKGROUNDS, { description: "OpenAI background: transparent, opaque, auto. Transparent needs png/webp; default model routes to gpt-image-1.5." }),',
      'background: optionalStringEnum(SUPPORTED_BACKGROUNDS, { description: "OpenAI background: transparent, opaque, auto. Transparent needs png/webp." }),',
    );
    after = after.replace(
      'description: "Create/edit images. Session chats: background task; do not call image_generate again for same request; wait completion, then report through the current visible-reply contract with generated media attached using structured media fields. Transparent: outputFormat=\\"png\\" or \\"webp\\" + background=\\"transparent\\"; OpenAI also supports openai.background and routes default model to gpt-image-1.5. Use action=\\"list\\" for providers/models/readiness/auth, \\"status\\" for active task.",',
      'description: "Create/edit images. Session chats: background task; do not call image_generate again for same request; wait completion, then report through the current visible-reply contract with generated media attached using structured media fields. U-Claw accepts only image models declared in imageGenerationModel config. Transparent: outputFormat=\\"png\\" or \\"webp\\" + background=\\"transparent\\". Use action=\\"list\\" for providers/models/readiness/auth, \\"status\\" for active task.",',
    );
    after = after.replace(
      'description: "Create/edit images. Session chats: background task; do not call image_generate again for same request; wait completion, then report through the current visible-reply contract with generated media attached using structured media fields. U-Claw uses fixed image model litellm/gpt-image-2 and ignores model overrides. Transparent: outputFormat=\\"png\\" or \\"webp\\" + background=\\"transparent\\". Use action=\\"list\\" for providers/models/readiness/auth, \\"status\\" for active task.",',
      'description: "Create/edit images. Session chats: background task; do not call image_generate again for same request; wait completion, then report through the current visible-reply contract with generated media attached using structured media fields. U-Claw accepts only image models declared in imageGenerationModel config. Transparent: outputFormat=\\"png\\" or \\"webp\\" + background=\\"transparent\\". Use action=\\"list\\" for providers/models/readiness/auth, \\"status\\" for active task.",',
    );
    after = after.replace(
      'const model = readStringParam(params, "model");',
      'const configuredImageGenerationModelConfig = coerceToolModelConfig(cfg.agents?.defaults?.imageGenerationModel);\n\t\t\tconst requestedModel = readStringParam(params, "model");\n\t\t\tconst configuredImageModelRefs = new Set([\n\t\t\t\tconfiguredImageGenerationModelConfig.primary,\n\t\t\t\t...configuredImageGenerationModelConfig.fallbacks ?? []\n\t\t\t].filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim()));\n\t\t\tconst model = requestedModel && configuredImageModelRefs.has(requestedModel.trim()) ? requestedModel.trim() : void 0;',
    );
    after = after.replace(
      'const requestedModel = readStringParam(params, "model");\n\t\t\tconst model = requestedModel?.trim() === UCLAW_FIXED_IMAGE_GENERATION_MODEL ? UCLAW_FIXED_IMAGE_GENERATION_MODEL : void 0;\n\t\t\tconst configuredImageGenerationModelConfig = coerceToolModelConfig(cfg.agents?.defaults?.imageGenerationModel);',
      'const configuredImageGenerationModelConfig = coerceToolModelConfig(cfg.agents?.defaults?.imageGenerationModel);\n\t\t\tconst requestedModel = readStringParam(params, "model");\n\t\t\tconst configuredImageModelRefs = new Set([\n\t\t\t\tconfiguredImageGenerationModelConfig.primary,\n\t\t\t\t...configuredImageGenerationModelConfig.fallbacks ?? []\n\t\t\t].filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim()));\n\t\t\tconst model = requestedModel && configuredImageModelRefs.has(requestedModel.trim()) ? requestedModel.trim() : void 0;',
    );

    if (
      after.includes('const UCLAW_FIXED_IMAGE_GENERATION_MODEL = "litellm/gpt-image-2";')
      || !after.includes("U-Claw accepts only image models declared in imageGenerationModel config")
      || !after.includes("const configuredImageModelRefs = new Set([")
      || !after.includes("const requestedModel = readStringParam(params, \"model\");")
      || after.includes("routes default model to gpt-image-1.5")
    ) {
      throw new Error(`Could not patch configured-only U-Claw image models in ${file}`);
    }
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Allows the xAI video provider to call U-Claw's configured adapter origin
 * with the same scoped SSRF trust used by text transports.
 */
function patchXaiVideoLoopbackAccess() {
  if (!fs.existsSync(openclawDistDir)) {
    throw new Error(`Missing OpenClaw dist directory: ${openclawDistDir}`);
  }

  const streamRuntimeName = fs
    .readdirSync(openclawDistDir)
    .find((name) => /^stream-.*\.js$/.test(name) && read(path.join(openclawDistDir, name)).includes("function resolveProviderTransportSsrFPolicy"));
  if (!streamRuntimeName) {
    throw new Error(`Missing provider transport SSRF policy runtime in ${openclawDistDir}`);
  }
  const transportPolicyImport = `import { s as resolveProviderTransportSsrFPolicy } from "./${streamRuntimeName}";`;
  const files = fs
    .readdirSync(openclawDistDir)
    .filter((name) => /^video-generation-provider-.*\.js$/.test(name))
    .map((name) => path.join(openclawDistDir, name));
  const patchedPolicy =
    "allowPrivateNetwork: /^http:\\/\\/127\\.0\\.0\\.1(?::\\d+)?(?:\\/|$)/i.test(resolveXaiVideoBaseUrl(req)),";
  let xaiProviderCount = 0;

  for (const file of files) {
    const before = read(file);
    if (!before.includes("//#region extensions/xai/video-generation-provider.ts")) continue;
    xaiProviderCount += 1;
    let after = before;

    after = after.replace(
      /import \{ ([^}]+) \} from "(\.\/shared-[^"]+\.js)";/,
      (match, imports, specifier) => {
        let nextImports = imports
          .replace("a as fetchProviderOperationResponse, ", "")
          .replace("i as fetchProviderDownloadResponse, ", "")
          .replace("p as resolveProviderHttpRequestConfig", "m as resolveProviderHttpRequestConfigWithOriginTrust");
        if (!nextImports.includes("o as fetchWithTimeoutGuarded")) {
          nextImports = nextImports.replace(
            "n as createProviderOperationDeadline",
            "n as createProviderOperationDeadline, o as fetchWithTimeoutGuarded",
          );
        }
        return `import { ${nextImports} } from "${specifier}";`;
      },
    );
    if (!after.includes(transportPolicyImport)) {
      after = after.replace(
        /(import \{ d as toImageDataUrl \} from "\.\/image-generation-[^"]+\.js";)/,
        `$1\n${transportPolicyImport}`,
      );
    }
    if (!after.includes(patchedPolicy)) {
      after = after.replace(
        "allowPrivateNetwork: false,\n\t\t\t\tdefaultHeaders:",
        `${patchedPolicy}\n\t\t\t\tdefaultHeaders:`,
      );
    }
    after = after.replace(
      "const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({",
      "const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy, trustConfiguredBaseUrlOrigin } = resolveProviderHttpRequestConfigWithOriginTrust({",
    );
    if (!after.includes("const requestSsrFPolicy = resolveProviderTransportSsrFPolicy({")) {
      after = after.replace(
        "const submitHeaders = new Headers(headers);\n\t\t\tconst submitHeaders = new Headers(headers);",
        "const submitHeaders = new Headers(headers);",
      );
      after = after.replace(
        "const submitHeaders = new Headers(headers);\n\t\t\tsubmitHeaders.set(\"x-idempotency-key\", crypto.randomUUID());\n\t\t\tconst { response, release } = await postJsonRequest({\n\t\t\t\turl: `${baseUrl}${resolveCreateEndpoint(req)}`,",
        `const submitHeaders = new Headers(headers);
\t\t\tsubmitHeaders.set("x-idempotency-key", crypto.randomUUID());
\t\t\tconst submitUrl = \`\${baseUrl}\${resolveCreateEndpoint(req)}\`;
\t\t\tconst requestSsrFPolicy = resolveProviderTransportSsrFPolicy({
\t\t\t\turl: submitUrl,
\t\t\t\tbaseUrl,
\t\t\t\tallowPrivateNetwork,
\t\t\t\ttrustConfiguredBaseUrlOrigin
\t\t\t});
\t\t\tconst { response, release } = await postJsonRequest({
\t\t\t\turl: submitUrl,`,
      );
      after = after.replace(
        "fetchFn,\n\t\t\t\tallowPrivateNetwork,\n\t\t\t\tdispatcherPolicy",
        "fetchFn,\n\t\t\t\tallowPrivateNetwork,\n\t\t\t\tssrfPolicy: requestSsrFPolicy,\n\t\t\t\tdispatcherPolicy",
      );
    }
    if (!after.includes("const statusResult = await fetchWithTimeoutGuarded(statusUrl,")) {
      after = after.replace(
        "const statusUrl = `${params.baseUrl}/videos/${params.requestId}`;\n\tfor (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {\n\t\tconst payload = readXaiStatusResponse(await readXaiVideoJson(await fetchProviderOperationResponse({\n\t\t\tstage: \"poll\",\n\t\t\turl: statusUrl,\n\t\t\tinit: {\n\t\t\t\tmethod: \"GET\",\n\t\t\t\theaders: params.headers\n\t\t\t},\n\t\t\ttimeoutMs: createProviderOperationTimeoutResolver({\n\t\t\t\tdeadline,\n\t\t\t\tdefaultTimeoutMs: DEFAULT_TIMEOUT_MS\n\t\t\t}),\n\t\t\tfetchFn: params.fetchFn,\n\t\t\tprovider: \"xai\",\n\t\t\trequestFailedMessage: \"xAI video status request failed\"\n\t\t})));\n\t\tconst normalizedStatus = payload.status.toLowerCase();\n\t\tif (normalizedStatus === \"done\") return payload;\n\t\tif (XAI_VIDEO_TERMINAL_FAILURE_STATUSES.has(normalizedStatus)) throw new Error(normalizeOptionalString(payload.error?.message) ?? `xAI video generation ${normalizedStatus}`);",
        `const statusUrl = \`\${params.baseUrl}/videos/\${params.requestId}\`;
\tfor (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
\t\tconst statusResult = await fetchWithTimeoutGuarded(statusUrl, {
\t\t\t\tmethod: "GET",
\t\t\t\theaders: params.headers
\t\t\t}, createProviderOperationTimeoutResolver({
\t\t\t\tdeadline,
\t\t\t\tdefaultTimeoutMs: DEFAULT_TIMEOUT_MS
\t\t\t}), params.fetchFn, {
\t\t\tssrfPolicy: params.ssrfPolicy,
\t\t\tdispatcherPolicy: params.dispatcherPolicy
\t\t});
\t\ttry {
\t\t\tawait assertOkOrThrowHttpError(statusResult.response, "xAI video status request failed");
\t\t\tconst payload = readXaiStatusResponse(await readXaiVideoJson(statusResult.response));
\t\t\tconst normalizedStatus = payload.status.toLowerCase();
\t\t\tif (normalizedStatus === "done") return payload;
\t\t\tif (XAI_VIDEO_TERMINAL_FAILURE_STATUSES.has(normalizedStatus)) throw new Error(normalizeOptionalString(payload.error?.message) ?? \`xAI video generation \${normalizedStatus}\`);
\t\t} finally {
\t\t\tawait statusResult.release();
\t\t}`,
      );
    }
    after = after.replace(
      "baseUrl,\n\t\t\t\t\tfetchFn\n\t\t\t\t});",
      "baseUrl,\n\t\t\t\t\tfetchFn,\n\t\t\t\t\tssrfPolicy: requestSsrFPolicy,\n\t\t\t\t\tdispatcherPolicy\n\t\t\t\t});",
    );
    if (
      !after.includes(transportPolicyImport)
      || !after.includes("resolveProviderHttpRequestConfigWithOriginTrust")
      || !after.includes("const requestSsrFPolicy = resolveProviderTransportSsrFPolicy({")
      || !after.includes("const statusResult = await fetchWithTimeoutGuarded(statusUrl,")
      || !after.includes("ssrfPolicy: requestSsrFPolicy")
    ) {
      throw new Error(`Could not patch xAI video configured-origin trust in ${file}`);
    }
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }

  if (xaiProviderCount === 0) {
    throw new Error(`Missing xAI video provider in ${openclawDistDir}`);
  }
}

/**
 * Trust provider-returned media URLs only for their exact returned hostname,
 * including fake-IP DNS compatibility. Keep private-network defaults strict.
 */
function patchConfiguredMediaResultDownloadTrust() {
  if (!fs.existsSync(openclawDistDir)) {
    throw new Error(`Missing OpenClaw dist directory: ${openclawDistDir}`);
  }

  const ssrfRuntimeName = fs
    .readdirSync(openclawDistDir)
    .find((name) => /^ssrf-.*\.js$/.test(name) && read(path.join(openclawDistDir, name)).includes("function ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist"));
  if (!ssrfRuntimeName) {
    throw new Error(`Missing SSRF policy runtime in ${openclawDistDir}`);
  }
  const resultPolicyImport = `import { m as mergeSsrFPolicies, x as ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist } from "./${ssrfRuntimeName}";`;

  const imageFiles = fs
    .readdirSync(openclawDistDir)
    .filter((name) => /^image-generation-.*\.js$/.test(name))
    .map((name) => path.join(openclawDistDir, name))
    .filter((file) => read(file).includes("async function materializeOpenAiCompatibleImageUrls"));
  if (imageFiles.length === 0) {
    throw new Error(`Missing OpenAI-compatible image runtime in ${openclawDistDir}`);
  }
  for (const file of imageFiles) {
    const before = read(file);
    let after = before;
    if (!after.includes(resultPolicyImport)) {
      after = after.replace(
        /(import \{ a as resolveApiKeyForProvider \} from "[^"]+\.js";)/,
        `$1\n${resultPolicyImport}`,
      );
    }
    after = after.replace(
      "ssrfPolicy: options.ssrfPolicy,",
      "ssrfPolicy: mergeSsrFPolicies(options.ssrfPolicy, ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist(url)),",
    );
    if (
      !after.includes(resultPolicyImport)
      || !after.includes("ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist(url)")
    ) {
      throw new Error(`Could not patch image result URL SSRF trust in ${file}`);
    }
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }

  const videoFiles = fs
    .readdirSync(openclawDistDir)
    .filter((name) => /^video-generation-provider-.*\.js$/.test(name))
    .map((name) => path.join(openclawDistDir, name))
    .filter((file) => read(file).includes("//#region extensions/xai/video-generation-provider.ts"));
  if (videoFiles.length === 0) {
    throw new Error(`Missing xAI video runtime in ${openclawDistDir}`);
  }
  for (const file of videoFiles) {
    const before = read(file);
    let after = before;
    if (!after.includes(resultPolicyImport)) {
      after = after.replace(
        /(import \{ s as resolveProviderTransportSsrFPolicy \} from "[^"]+\.js";)/,
        `$1\n${resultPolicyImport}`,
      );
    }
    if (!after.includes("const downloadSsrFPolicy = mergeSsrFPolicies(")) {
      after = after.replace(
        "async function downloadXaiVideo(params) {\n\tconst result = await fetchWithTimeoutGuarded(",
        "async function downloadXaiVideo(params) {\n\tconst downloadSsrFPolicy = mergeSsrFPolicies(params.ssrfPolicy, ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist(params.url));\n\tconst result = await fetchWithTimeoutGuarded(",
      );
    }
    after = after.replace(
      "ssrfPolicy: params.ssrfPolicy,\n\t\tdispatcherPolicy",
      "ssrfPolicy: downloadSsrFPolicy,\n\t\tdispatcherPolicy",
    );
    if (
      !after.includes(resultPolicyImport)
      || !after.includes("const downloadSsrFPolicy = mergeSsrFPolicies(")
      || !after.includes("ssrfPolicy: downloadSsrFPolicy")
    ) {
      throw new Error(`Could not patch video result URL SSRF trust in ${file}`);
    }
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Preserves the completed xAI task ID and original video URL when the local
 * machine cannot download the provider-hosted file. OpenClaw already supports
 * URL-only generated videos, so the task remains deliverable without coupling
 * this fallback to any specific CDN hostname.
 */
function patchXaiVideoDownloadFallback() {
  if (!fs.existsSync(openclawDistDir)) {
    throw new Error(`Missing OpenClaw dist directory: ${openclawDistDir}`);
  }

  const providerFiles = fs
    .readdirSync(openclawDistDir)
    .filter((name) => /^video-generation-provider-.*\.js$/.test(name))
    .map((name) => path.join(openclawDistDir, name));
  let xaiProviderCount = 0;

  const downloadOriginal = `\t\t\t\treturn {
\t\t\t\t\tvideos: [await downloadXaiVideo({
\t\t\t\t\t\turl: videoUrl,
\t\t\t\t\t\ttimeoutMs: createProviderOperationTimeoutResolver({
\t\t\t\t\t\t\tdeadline,
\t\t\t\t\t\t\tdefaultTimeoutMs: DEFAULT_TIMEOUT_MS
\t\t\t\t\t\t}),
\t\t\t\t\t\tfetchFn,
\t\t\t\t\t\tmaxBytes: resolveGeneratedVideoMaxBytes(req)
\t\t\t\t\t})],
\t\t\t\t\tmodel: normalizeOptionalString(req.model) ?? DEFAULT_XAI_VIDEO_MODEL,
\t\t\t\t\tmetadata: {
\t\t\t\t\t\trequestId,
\t\t\t\t\t\tstatus: completed.status,
\t\t\t\t\t\tvideoUrl,
\t\t\t\t\t\tmode: resolveXaiVideoMode(req)
\t\t\t\t\t}
\t\t\t\t};`;
  const downloadPatched = `\t\t\t\tlet downloadedVideo;
\t\t\t\tlet uClawDownloadWarning;
\t\t\t\ttry {
\t\t\t\t\tdownloadedVideo = await downloadXaiVideo({
\t\t\t\t\t\turl: videoUrl,
\t\t\t\t\t\ttimeoutMs: createProviderOperationTimeoutResolver({
\t\t\t\t\t\t\tdeadline,
\t\t\t\t\t\t\tdefaultTimeoutMs: DEFAULT_TIMEOUT_MS
\t\t\t\t\t\t}),
\t\t\t\t\t\tfetchFn,
\t\t\t\t\t\tmaxBytes: resolveGeneratedVideoMaxBytes(req)
\t\t\t\t\t});
\t\t\t\t} catch (error) {
\t\t\t\t\tconst downloadError = error instanceof Error ? error.message : String(error);
\t\t\t\t\tuClawDownloadWarning = \`\u539f\u89c6\u9891\u5df2\u751f\u6210\u6210\u529f\uff0c\u4f46 U-Claw \u8fde\u63a5\u539f\u89c6\u9891\u5730\u5740\u4e0b\u8f7d\u5931\u8d25\u3002\u751f\u6210\u94fe\u8def\u5df2\u7ecf\u5b8c\u6210\uff1b\u5931\u8d25\u53d1\u751f\u5728\u5f53\u524d\u8bbe\u5907\u4e0b\u8f7d\u539f\u89c6\u9891\u9636\u6bb5\uff0c\u5e38\u89c1\u539f\u56e0\u662f\u4ee3\u7406\u3001DNS \u6216\u7f51\u7edc\u9650\u5236\u3002\u8bf7\u590d\u5236\u4e0b\u65b9\u539f\u59cb\u89c6\u9891\u94fe\u63a5\u5230\u6d4f\u89c8\u5668\u6253\u5f00\u6216\u4e0b\u8f7d\u3002\\n\u4efb\u52a1 ID\uff1a\${requestId}\\n\u539f\u59cb\u89c6\u9891\u94fe\u63a5\uff1a\${videoUrl}\\n\u4e0b\u8f7d\u9519\u8bef\uff1a\${downloadError}\`;
\t\t\t\t\tdownloadedVideo = {
\t\t\t\t\t\turl: videoUrl,
\t\t\t\t\t\tmimeType: \"video/mp4\",
\t\t\t\t\t\tfileName: \`video-\${requestId}.mp4\`
\t\t\t\t\t};
\t\t\t\t}
\t\t\t\treturn {
\t\t\t\t\tvideos: [downloadedVideo],
\t\t\t\t\tmodel: normalizeOptionalString(req.model) ?? DEFAULT_XAI_VIDEO_MODEL,
\t\t\t\t\tmetadata: {
\t\t\t\t\t\trequestId,
\t\t\t\t\t\tstatus: completed.status,
\t\t\t\t\t\tvideoUrl,
\t\t\t\t\t\t...uClawDownloadWarning ? { uClawDownloadWarning } : {},
\t\t\t\t\t\tmode: resolveXaiVideoMode(req)
\t\t\t\t\t}
\t\t\t\t};`;

  for (const file of providerFiles) {
    const before = read(file);
    if (!before.includes("//#region extensions/xai/video-generation-provider.ts")) continue;
    xaiProviderCount += 1;
    if (before.includes("uClawDownloadWarning")) continue;
    const after = before.replace(downloadOriginal, downloadPatched);
    if (after === before) {
      throw new Error(`Could not patch xAI video download fallback in ${file}`);
    }
    writeIfChanged(file, before, after);
    console.log(`patched ${path.relative(root, file)}`);
  }

  if (xaiProviderCount === 0) {
    throw new Error(`Missing xAI video provider in ${openclawDistDir}`);
  }

  const toolFiles = fs
    .readdirSync(openclawDistDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(openclawDistDir, name))
    .filter((file) => read(file).includes("async function executeVideoGenerationJob(params)"));
  if (toolFiles.length === 0) {
    throw new Error(`Missing video generation tool runtime in ${openclawDistDir}`);
  }

  for (const file of toolFiles) {
    const before = read(file);
    const jobStart = before.indexOf("async function executeVideoGenerationJob(params)");
    const jobEnd = before.indexOf("\nfunction createVideoGenerateTool", jobStart);
    if (jobStart === -1 || jobEnd === -1) {
      throw new Error(`Could not locate video generation job in ${file}`);
    }

    const misplacedWarningLine = "\n\t\t...uClawDownloadWarning ? [uClawDownloadWarning] : [],";
    const prefix = before.slice(0, jobStart).replaceAll(misplacedWarningLine, "");
    let job = before.slice(jobStart, jobEnd);
    const suffix = before.slice(jobEnd);
    if (!job.includes("const uClawDownloadWarning = normalizeOptionalString")) {
      job = job.replace(
        "\tconst warning = ignoredOverrides.length > 0 ? `Ignored unsupported overrides for ${result.provider}/${result.model}: ${ignoredOverrides.map(formatIgnoredVideoGenerationOverride).join(\", \")}.` : void 0;",
        "\tconst warning = ignoredOverrides.length > 0 ? `Ignored unsupported overrides for ${result.provider}/${result.model}: ${ignoredOverrides.map(formatIgnoredVideoGenerationOverride).join(\", \")}.` : void 0;\n\tconst uClawDownloadWarning = normalizeOptionalString(result.metadata?.uClawDownloadWarning);",
      );
    }
    if (!job.includes("...uClawDownloadWarning ? [uClawDownloadWarning] : []")) {
      job = job.replace(
        "\t\t...warning ? [`Warning: ${warning}`] : [],",
        "\t\t...warning ? [`Warning: ${warning}`] : [],\n\t\t...uClawDownloadWarning ? [uClawDownloadWarning] : [],",
      );
    }
    const after = `${prefix}${job}${suffix}`;
    if (
      !job.includes("const uClawDownloadWarning = normalizeOptionalString")
      || !job.includes("...uClawDownloadWarning ? [uClawDownloadWarning] : []")
    ) {
      throw new Error(`Could not patch video download warning output in ${file}`);
    }
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

function patchServiceWorker() {
  if (!fs.existsSync(swPath)) {
    throw new Error(`Missing OpenClaw service worker: ${swPath}`);
  }

  let source = read(swPath);
  source = source.replace(
    /const EMBEDDED_CACHE_VERSION = "[^"]+";/,
    'const EMBEDDED_CACHE_VERSION = "2026.7.1-2-0790d9f593ad-uclaw-media-filter-2-skillhub-branding-1-bundled-filter-1-ui-polish-7-ui-polish-8-ui-polish-9-ui-polish-10-ui-polish-11-ui-polish-12-ui-polish-13-ui-polish-14-ui-polish-15-chat-skillhub-dropdown-1-visible-shell-branding-1-chat-command-i18n-1-config-overview-i18n-1-chat-index-channels-i18n-1-i18n-login-channels-1-secondary-pages-i18n-1-tertiary-pages-i18n-1-visible-tertiary-i18n-1-deep-agents-chat-i18n-1-responsive-polish-1-skillhub-store-discovery-6-brand-visual-system-4-workspace-background-1-final-ui-polish-8-skillhub-risk-copy-1-skillhub-dense-ui-6-skillhub-field-map-1-skillhub-proxy-fallback-1-chat-composer-controls-polish-3-skillhub-scene-i18n-1-skillhub-scene-filter-1-media-preview-roots-1-skillhub-uninstall-1-skillhub-detail-fallback-2-skill-store-copy-1-primary-nav-ia-2-expert-landing-1-expert-create-1-expert-management-1-expert-custom-form-1-expert-session-label-1-expert-create-center-2-expert-create-modal-1-expert-main-session-2-expert-visual-density-1-expert-modal-layout-1";',
  );
  source = source.replace(/const CONTROL_CACHE_LIMIT = \d+;/, "const CONTROL_CACHE_LIMIT = 1;");
  source = source
    .replaceAll("// OpenClaw Control – Service Worker", "// U-Claw Control – Service Worker")
    .replaceAll('title: "OpenClaw"', 'title: "U-Claw"')
    .replaceAll('data.title || "OpenClaw"', 'data.title || "U-Claw"');

  const fetchStart = source.indexOf('self.addEventListener("fetch", (event) => {');
  const webPushStart = source.indexOf("// --- Web Push ---");
  if (fetchStart === -1 || webPushStart === -1 || fetchStart > webPushStart) {
    throw new Error("Could not locate service worker fetch handler");
  }

  const fetchHandler = `self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET and cross-origin requests.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // Skip top-level navigations so the browser can handle HTTP auth
  // challenges natively - WWW-Authenticate dialogs are bypassed when the
  // response comes from a service worker, breaking reverse-proxy setups
  // with basic/digest auth in front of the gateway.
  if (event.request.mode === "navigate") {
    return;
  }

  // Skip non-UI routes - API, RPC, and plugin routes should never be cached.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/rpc") ||
    url.pathname.startsWith("/plugins/")
  ) {
    return;
  }

  // Network-first for assets in the portable build so patched bundled UI files
  // are not masked by stale Service Worker cache.
  if (url.pathname.includes("/assets/")) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.open(CACHE_NAME).then((cache) => cache.match(event.request))),
    );
  } else {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request)),
    );
  }
});

`;

  const next = source.slice(0, fetchStart) + fetchHandler + source.slice(webPushStart);
  if (writeIfChanged(swPath, read(swPath), next)) {
    console.log(`patched ${path.relative(root, swPath)}`);
  }
}

/**
 * Localizes shared Config form section labels while preserving schema keys.
 */
function patchConfigFormUiCopy() {
  const pairs = [
    ["`Hide value`", "`隐藏值`"],
    ["`Reveal value`", "`显示值`"],
    ["`Disable stream mode to reveal value`", "`关闭 stream mode 后可显示值`"],
    ["Unsupported schema node. Use Raw mode.", "不支持的 schema 节点，请使用 Raw mode。"],
    ["Unsupported array schema. Use Raw mode.", "不支持的数组 schema，请使用 Raw mode。"],
    ["Structured value (SecretRef) - use Raw mode to edit", "结构化 SecretRef，请使用 Raw mode 编辑"],
    ["Structured value (SecretRef) - edit the config file directly", "结构化 SecretRef，请直接编辑配置文件"],
    ["Reset to default", "恢复默认值"],
    ["No items yet. Click \"Add\" to create one.", "暂无条目。点击“添加”创建。"],
    ["Remove item", "移除条目"],
    ["Custom entries", "自定义条目"],
    ["Add item", "添加条目"],
    ["label:`Environment Variables`", "label:`环境变量`"],
    ["description:`Environment variables passed to the gateway process`", "description:`传给 Gateway 进程的环境变量`"],
    ["label:`Updates`", "label:`更新`"],
    ["description:`Auto-update settings and release channel`", "description:`自动更新设置与发布通道`"],
    ["label:`Agents`", "label:`Agents`"],
    ["description:`Agent configurations, models, and identities`", "description:`Agent 配置、模型与身份`"],
    ["label:`Authentication`", "label:`认证`"],
    ["description:`API keys and authentication profiles`", "description:`API keys 与认证配置`"],
    ["label:`Channels`", "label:`渠道`"],
    ["description:`Messaging channels (Telegram, Discord, Slack, etc.)`", "description:`消息渠道（Telegram、Discord、Slack 等）`"],
    ["label:`Messages`", "label:`消息`"],
    ["description:`Message handling and routing settings`", "description:`消息处理与路由设置`"],
    ["label:`Commands`", "label:`命令`"],
    ["description:`Custom slash commands`", "description:`自定义 slash commands`"],
    ["label:`Hooks`", "label:`Hooks`"],
    ["description:`Webhooks and event hooks`", "description:`Webhooks 与事件 hooks`"],
    ["label:`Skills`", "label:`技能`"],
    ["description:`Skill packs and capabilities`", "description:`技能商店技能包与能力`"],
    ["description:`SkillHub 技能包与能力`", "description:`技能商店技能包与能力`"],
    ["label:`Tools`", "label:`工具`"],
    ["description:`Tool configurations (browser, search, etc.)`", "description:`工具配置（browser、search 等）`"],
    ["label:`Gateway`", "label:`Gateway`"],
    ["description:`Gateway server settings (port, auth, binding)`", "description:`Gateway 服务设置（端口、认证、绑定）`"],
    ["label:`Setup Wizard`", "label:`设置向导`"],
    ["description:`Setup wizard state and history`", "description:`设置向导状态与历史`"],
    ["label:`Metadata`", "label:`元数据`"],
    ["description:`Gateway metadata and version information`", "description:`Gateway 元数据与版本信息`"],
    ["label:`Logging`", "label:`日志`"],
    ["description:`Log levels and output configuration`", "description:`日志级别与输出配置`"],
    ["label:`Browser`", "label:`浏览器`"],
    ["description:`Browser automation settings`", "description:`浏览器自动化设置`"],
    ["label:`UI`", "label:`界面`"],
    ["description:`User interface preferences`", "description:`用户界面偏好`"],
    ["label:`Models`", "label:`模型`"],
    ["description:`AI model configurations and providers`", "description:`AI 模型配置与 providers`"],
    ["label:`Bindings`", "label:`快捷键`"],
    ["description:`Key bindings and shortcuts`", "description:`按键绑定与快捷键`"],
    ["label:`Broadcast`", "label:`通知广播`"],
    ["description:`Broadcast and notification settings`", "description:`广播与通知设置`"],
    ["label:`Audio`", "label:`音频`"],
    ["description:`Audio input/output settings`", "description:`音频输入/输出设置`"],
    ["label:`Session`", "label:`会话`"],
    ["description:`Session management and persistence`", "description:`会话管理与持久化`"],
    ["label:`Cron`", "label:`定时任务`"],
    ["description:`Scheduled tasks and automation`", "description:`计划任务与自动化`"],
    ["label:`Web`", "label:`Web`"],
    ["description:`Web server and API settings`", "description:`Web server 与 API 设置`"],
    ["label:`Discovery`", "label:`服务发现`"],
    ["description:`Service discovery and networking`", "description:`服务发现与网络设置`"],
    ["label:`Canvas Host`", "label:`Canvas Host`"],
    ["description:`Canvas rendering and display`", "description:`Canvas 渲染与显示`"],
    ["label:`Talk`", "label:`语音`"],
    ["description:`Voice and speech settings`", "description:`语音与朗读设置`"],
    ["label:`Plugins`", "label:`插件`"],
    ["description:`Plugin management and extensions`", "description:`插件管理与扩展`"],
    ["label:`Diagnostics`", "label:`诊断`"],
    ["description:`Instrumentation, OpenTelemetry, and cache-trace settings`", "description:`Instrumentation、OpenTelemetry 与 cache trace 设置`"],
    ["label:`CLI`", "label:`CLI`"],
    ["description:`CLI banner and startup behavior`", "description:`CLI banner 与启动行为`"],
    ["label:`Secrets`", "label:`Secrets`"],
    ["description:`Secret provider configuration`", "description:`Secret provider 配置`"],
    ["description:`Agent Communication Protocol runtime and streaming settings`", "description:`Agent Communication Protocol runtime 与 streaming 设置`"],
    ["description:`Model Context Protocol server definitions`", "description:`Model Context Protocol server 定义`"],
    ["Schema unavailable.", "Schema 不可用。"],
    ["Unsupported schema. Use Raw.", "不支持的 schema，请使用 Raw。"],
  ];

  for (const file of listAssetFiles(/^config-form-.*\.js$/, "config-form")) {
    const before = read(file);
    const after = replacePairs(before, pairs);
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Localizes high-value Config page helper copy without changing config behavior.
 */
function patchConfigPageUiCopy() {
  const pairs = [
    ["label:`Personal Assistant`", "label:`U-Claw 助手`"],
    ["description:`Balanced default for daily use.`", "description:`适合日常使用的均衡默认配置。`"],
    ["label:`Code Agent`", "label:`代码 Agent`"],
    ["description:`Highest context budget for repo work.`", "description:`面向代码仓库工作的高上下文预算配置。`"],
    ["label:`Team Bot`", "label:`团队 Bot`"],
    ["description:`Lean follow-ups for shared bots.`", "description:`适合共享 Bot 的轻量后续对话配置。`"],
    ["label:`Minimal`", "label:`轻量`"],
    ["description:`Smallest context budget and lowest cost.`", "description:`最小上下文预算与最低成本配置。`"],
    ["aria-label=\"Assistant identity\"", "aria-label=\"U-Claw 助手身份\""],
    ["l(e.assistantName)??`Assistant`", "l(e.assistantName)??`U-Claw`"],
    ["l(e.assistantName)??`Assistant`", "l(e.assistantName)??`U-Claw`"],
    ["`Remote URLs are blocked by Control UI image policy`", "`远程 URL 被界面图片策略阻止`"],
    ["`File not found`", "`文件未找到`"],
    ["`Unsupported image type`", "`不支持的图片类型`"],
    ["`Outside workspace`", "`超出工作区`"],
    ["`Image is too large`", "`图片过大`"],
    ["`Cannot render avatar`", "`无法渲染头像`"],
    ["`UI override`", "`界面覆盖`"],
    ["`Override from settings`", "`来自设置的覆盖`"],
    ["`Fallback avatar`", "`备用头像`"],
    ["`From IDENTITY.md`", "`来自 IDENTITY.md`"],
    ["`Fallback logo`", "`备用 Logo`"],
    ["Save & Publish", "保存并发布"],
    ["No MCP servers configured.", "尚未配置 MCP servers。"],
    [
      "Choose how much workspace context OpenClaw injects into each run.",
      "选择 U-Claw 每次运行注入多少工作区上下文。",
    ],
    ['<span class="qs-row__label">Model</span>', '<span class="qs-row__label">模型</span>'],
    ['<span class="qs-row__label">Thinking</span>', '<span class="qs-row__label">思考级别</span>'],
    ['<span class="qs-row__label">Fast mode</span>', '<span class="qs-row__label">快速模式</span>'],
    ["${t.charAt(0).toUpperCase()+t.slice(1)}", "${{off:`关闭`,low:`低`,medium:`中`,high:`高`,xhigh:`超高`,max:`最大`}[t]??t}"],
    ["[[`auto`,`Auto`],[`on`,`Fast`],[`off`,`Standard`]]", "[[`auto`,`自动`],[`on`,`快速`],[`off`,`标准`]]"],
    ["${t} connected", "${t} 已连接"],
    ["${V(g.send,`Channels`,n)}", "${V(g.send,`渠道`,n)}"],
    ["No channels configured", "暂无渠道配置"],
    ["t.detail??`Connected`", "t.detail??`已连接`"],
    ["${V(g.eye,`Security`,i`<button", "${V(g.eye,`安全`,i`<button"],
    ['<span class="qs-row__label">Gateway auth</span>', '<span class="qs-row__label">Gateway 认证</span>'],
    ['<span class="qs-row__label">Exec policy</span>', '<span class="qs-row__label">Exec 策略</span>'],
    ["${V(g.monitor,`Gateway Host`)}", "${V(g.monitor,`Gateway 主机`)}"],
    ["${H(`Host`,t?.machineName??`—`,n)}", "${H(`主机`,t?.machineName??`—`,n)}"],
    ["${H(`Address`,r)}", "${H(`地址`,r)}"],
    ["${H(`Uptime`,t?oe(t.uptimeMs):`—`)}", "${H(`运行时间`,t?oe(t.uptimeMs):`—`)}"],
    ["${H(`Memory`,d)}", "${H(`内存`,d)}"],
    ["H(`Disk`,p,t?.diskPath)", "H(`磁盘`,p,t?.diskPath)"],
    ["`${A(t.memoryFreeBytes)} free of ${A(t.memoryTotalBytes)}`", "`可用 ${A(t.memoryFreeBytes)} / 共 ${A(t.memoryTotalBytes)}`"],
    ["`${A(t.diskAvailableBytes)} free of ${A(t.diskTotalBytes)}`", "`可用 ${A(t.diskAvailableBytes)} / 共 ${A(t.diskTotalBytes)}`"],
    ["`Load average: ${t.loadAverage.map(e=>e.toFixed(1)).join(` · `)}`", "`平均负载：${t.loadAverage.map(e=>e.toFixed(1)).join(` · `)}`"],
    ["`${t.cpuCount} cores", "`${t.cpuCount} 核"],
    ["` · load ${t.loadAverage[0].toFixed(1)}`", "` · 负载 ${t.loadAverage[0].toFixed(1)}`"],
    ['<span class="qs-row__label">Device auth</span>', '<span class="qs-row__label">设备认证</span>'],
    ["                  ${t}\n                </button>", "                  ${{minimal:`最小`,coding:`编程`,messaging:`消息`,full:`完整`}[t]??t}\n                </button>"],
    ["`Imported theme`", "`已导入主题`"],
    ["`Import`", "`导入`"],
    ["${V(g.spark,`Appearance`)}", "${V(g.spark,`外观`)}"],
    ['<span class="qs-row__label">Theme</span>', '<span class="qs-row__label">主题</span>'],
    ["${t.enabled?`Disable`:`Enable`}", "${t.enabled?`停用`:`启用`}"],
    ["Profiles only change bootstrap size and follow-up reinjection.", "配置档只影响启动上下文大小与后续补注入。"],
    ["missing transport", "缺少 transport"],
    ["TLS verify off", "TLS 验证关闭"],
    ["tool filter", "工具筛选"],
    ["parallel", "并行"],
  ];

  for (const file of listAssetFiles(/^config-page-.*\.js$/, "config-page")) {
    const before = read(file);
    const after = replacePairs(before, pairs);
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Localizes shared shell/runtime UI copy in the main index bundle.
 */
function patchIndexUiCopy() {
  const pairs = [
    ["Config hash missing; reload and retry.", "配置版本缺失，请重新加载后重试。"],
    ["Config hash missing; refresh and retry.", "配置版本缺失，请刷新后重试。"],
    [
      "`Review the ClawHub warning before installing this skill.`",
      "`安装前请复核技能商店风险提示。`",
    ],
    ["Ye=[`overview`]", "Ye=[`agents`,`tasks`,`skills`,`config`]"],
    ["Ye=[`overview`,`skills`]", "Ye=[`agents`,`tasks`,`skills`,`config`]"],
    [
      "sidebarPinnedRoutes:Xe(c.sidebarPinnedRoutes)??r.sidebarPinnedRoutes",
      "sidebarPinnedRoutes:[`agents`,`tasks`,`skills`,`config`]",
    ],
    [
      "sidebarPinnedRoutes:[...new Set([...(Xe(c.sidebarPinnedRoutes)??r.sidebarPinnedRoutes),`skills`])]",
      "sidebarPinnedRoutes:[`agents`,`tasks`,`skills`,`config`]",
    ],
    [
      "sidebarPinnedRoutes:[...new Set([...(Xe(c.sidebarPinnedRoutes)??r.sidebarPinnedRoutes),`agents`,`tasks`,`skills`,`config`])]",
      "sidebarPinnedRoutes:[`agents`,`tasks`,`skills`,`config`]",
    ],
  ];

  for (const file of listAssetFiles(/^index-.*\.js$/, "index js")) {
    const before = read(file);
    let after = replacePairs(before, pairs);
    const sidebarSessionNameHelper =
      "function UcIsVisibleSessionAgentId(e){let t=j(e??``);return!!t&&!t.startsWith(`uclaw-expert-`)}function UcSidebarSessionName(e,t){let n=Ae(t.key,t),r=A(t.key)?.agentId;if(!r||n!==t.key)return n;let i=e.context?.agentIdentity?.get?.(r),a=w(i?.name)??w(i?.identity?.name)??``;if(!a){let t=e.context?.agents.state.agentsList?.agents?.find(e=>j(e.id)===j(r));a=w(t?.identity?.name)??w(t?.name)??``}if(!a){let e={\"uclaw-expert-copywriter\":`文案写手`,\"uclaw-expert-xiaohongshu\":`小红书写手`,\"uclaw-expert-career\":`职业顾问`,\"uclaw-expert-machine-learning\":`机器学习`,\"uclaw-expert-resume\":`简历写手`,\"uclaw-expert-startup-ideas\":`创业点子王`};a=e[j(r)]??``}return a&&a!==r?a:n}";
    if (after.includes("function UcIsVisibleSessionAgentId(e)")) {
      after = after.replace(
        /function UcIsVisibleSessionAgentId\(e\)\{[\s\S]*?\}function UcSidebarSessionName\(e,t\)\{[\s\S]*?\}var F=class extends d\{/,
        `${sidebarSessionNameHelper}var F=class extends d{`,
      );
    } else if (after.includes("function UcSidebarSessionName(e,t)")) {
      after = after.replace(
        /function UcSidebarSessionName\(e,t\)\{[\s\S]*?\}var F=class extends d\{/,
        `${sidebarSessionNameHelper}var F=class extends d{`,
      );
    } else {
      after = after.replace("var F=class extends d{", `${sidebarSessionNameHelper}var F=class extends d{`);
    }
    after = after.replace(
      "label:Ae(t.key,t),meta:Br(t.updatedAt)",
      "label:UcSidebarSessionName(this,t),meta:Br(t.updatedAt)",
    );
    after = after.replace(
      "function Ar(e){let t=new Set,n=[],r=r=>{let i=j(r);t.has(i)||(t.add(i),n.push({id:i,label:jr(e,i)}))};r(Er(e,e.sessionKey)),r(e.agentsList?.defaultId??`main`);for(let t of e.agentsList?.agents??[])r(t.id);for(let t of e.sessionsResult?.sessions??[]){let e=A(t.key);e&&r(e.agentId)}return n}",
      "function Ar(e){let t=new Set,n=[],r=r=>{let i=j(r);UcIsVisibleSessionAgentId(i)&&!t.has(i)&&(t.add(i),n.push({id:i,label:jr(e,i)}))};r(e.agentsList?.defaultId??`main`);return n.length?n:[{id:`main`,label:`main`}]}",
    );
    const moreStart = "renderMoreSection(){";
    const moreEnd = "renderChatFallback(){";
    const moreStartIndex = after.indexOf(moreStart);
    const moreEndIndex = moreStartIndex >= 0 ? after.indexOf(moreEnd, moreStartIndex) : -1;
    if (moreStartIndex >= 0 && moreEndIndex > moreStartIndex) {
      after = `${after.slice(0, moreStartIndex)}renderMoreSection(){return l}${after.slice(moreEndIndex)}`;
    }
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Projects the first-level U-Claw navigation to four user-facing capability groups.
 */
function patchPrimaryNavigationProjection() {
  const pairs = [
    [
      "enabledRouteIds(){return Xa(this.context?.runtimeConfig.state.configSnapshot)?we:Xv}",
      "enabledRouteIds(){return[`agents`,`tasks`,`skills`,`config`]}",
    ],
    [
      "config:{titleKey:`nav.settings`,subtitleKey:`subtitles.config`}",
      "config:{titleKey:`tabs.config`,subtitleKey:`subtitles.config`}",
    ],
    [
      "function Hc(){return[{id:`nav-overview`,label:D(`overview.palette.items.overview`),icon:`barChart`,category:`navigation`,action:`nav:overview`},{id:`nav-sessions`,label:D(`overview.palette.items.sessions`),icon:`fileText`,category:`navigation`,action:`nav:sessions`},{id:`nav-cron`,label:D(`overview.palette.items.scheduled`),icon:`scrollText`,category:`navigation`,action:`nav:cron`},{id:`nav-skills`,label:D(`overview.palette.items.skills`),icon:`zap`,category:`navigation`,action:`nav:skills`},{id:`nav-config`,label:D(`overview.palette.items.settings`),icon:`settings`,category:`navigation`,action:`nav:config`},{id:`nav-agents`,label:D(`overview.palette.items.agents`),icon:`folder`,category:`navigation`,action:`nav:agents`},{id:`slash:verbose`,label:`/verbose`,icon:`terminal`,category:`search`,action:`/verbose full`,description:`Toggle verbose mode.`}]}",
      "function Hc(){return[{id:`nav-agents`,label:`智能体`,icon:`folder`,category:`navigation`,action:`nav:agents`},{id:`nav-workflows`,label:`工作流`,icon:`scrollText`,category:`navigation`,action:`nav:tasks`},{id:`nav-skills`,label:`技能库`,icon:`zap`,category:`navigation`,action:`nav:skills`},{id:`nav-models`,label:`模型`,icon:`settings`,category:`navigation`,action:`nav:config`},{id:`slash:verbose`,label:`/verbose`,icon:`terminal`,category:`search`,action:`/verbose full`,description:`Toggle verbose mode.`}]}",
    ],
  ];

  for (const file of listAssetFiles(/^index-.*\.js$/, "index js")) {
    const before = read(file);
    const after = replacePairs(before, pairs);
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Localizes high-visibility shared i18n copy while preserving real runtime commands.
 */
function patchI18nUiCopy() {
  const pairs = [
    ["yes:`Yes`", "yes:`是`"],
    ["no:`No`", "no:`否`"],
    ["active:`Active`", "active:`活跃`"],
    ["loading:`Loading…`", "loading:`加载中…`"],
    ["refreshing:`Refreshing…`", "refreshing:`刷新中…`"],
    ["online:`Online`", "online:`在线`"],
    ["offline:`Offline`", "offline:`离线`"],
    ["connect:`Connect`", "connect:`连接`"],
    ["connected:`Connected`", "connected:`已连接`"],
    ["refresh:`Refresh`", "refresh:`刷新`"],
    ["reload:`Reload`", "reload:`重新加载`"],
    ["reset:`Reset`", "reset:`重置`"],
    ["probe:`Probe`", "probe:`检测`"],
    ["confirm:`Confirm`", "confirm:`确认`"],
    ["cancel:`Cancel`", "cancel:`取消`"],
    ["next:`Next`", "next:`下一步`"],
    ["back:`Back`", "back:`返回`"],
    ["create:`Create`", "create:`创建`"],
    ["copy:`Copy`", "copy:`复制`"],
    ["copied:`Copied!`", "copied:`已复制`"],
    ["copyCode:`Copy code`", "copyCode:`复制代码`"],
    ["delete:`Delete`", "delete:`删除`"],
    ["dismiss:`Dismiss`", "dismiss:`关闭`"],
    ["unselect:`Unselect`", "unselect:`取消选择`"],
    ["enabled:`Enabled`", "enabled:`已启用`"],
    ["disabled:`Disabled`", "disabled:`已停用`"],
    ["none:`none`", "none:`无`"],
    ["na:`n/a`", "na:`不可用`"],
    ["never:`never`", "never:`从未`"],
    ["configured:`Configured`", "configured:`已配置`"],
    ["running:`Running`", "running:`运行中`"],
    ["linked:`Linked`", "linked:`已关联`"],
    ["mode:`Mode`", "mode:`模式`"],
    ["system:`System`", "system:`系统`"],
    ["light:`Light`", "light:`浅色`"],
    ["dark:`Dark`", "dark:`深色`"],
    ["baseUrl:`Base URL`", "baseUrl:`Base URL`"],
    ["lastStart:`Last start`", "lastStart:`上次启动`"],
    ["lastProbe:`Last probe`", "lastProbe:`上次检测`"],
    ["lastInbound:`Last inbound`", "lastInbound:`上次收信`"],
    ["lastConnect:`Last connect`", "lastConnect:`上次连接`"],
    ["lastMessage:`Last message`", "lastMessage:`上次消息`"],
    ["authAge:`Auth age`", "authAge:`认证时长`"],
    ["credential:`Credential`", "credential:`凭据`"],
    ["audience:`Audience`", "audience:`受众`"],
    ["publicKey:`Public Key`", "publicKey:`公钥`"],
    ["probeOk:`Probe ok`", "probeOk:`检测通过`"],
    ["probeFailed:`Probe failed`", "probeFailed:`检测失败`"],
    ["reloadConfig:`Reload Config`", "reloadConfig:`重新加载配置`"],
    ["loadConfig:`Load config`", "loadConfig:`加载配置`"],
    ["settingsSections:`Settings sections`", "settingsSections:`设置分区`"],
    ["version:`Version`", "version:`版本`"],
    ["docs:`Docs`", "docs:`文档`"],
    ["theme:`Theme`", "theme:`主题`"],
    ["colorMode:`Color mode`", "colorMode:`颜色模式`"],
    ["colorModeOption:`Color mode: {mode}`", "colorModeOption:`颜色模式：{mode}`"],
    ["resources:`Resources`", "resources:`资源`"],
    ["search:`Search`", "search:`搜索`"],
    ["save:`Save`", "save:`保存`"],
    ["saving:`Saving…`", "saving:`保存中…`"],
    ["saveAndPublish:`Save & Publish`", "saveAndPublish:`保存并发布`"],
    ["agents:`Agents`", "agents:`智能体`"],
    ["agents:`代理`", "agents:`智能体`"],
    ["tasks:`Tasks`", "tasks:`工作流`"],
    ["tasks:`任务`", "tasks:`工作流`"],
    ["config:`Config`", "config:`模型`"],
    ["config:`配置`", "config:`模型`"],
    ["skills:`Skills`", "skills:`技能库`"],
    ["skills:`技能`", "skills:`技能库`"],
    ["skills:`SkillHub`", "skills:`技能库`"],
    ["skills:`技能商店`", "skills:`技能库`"],
    ["skillWorkshop:`Skill Workshop`", "skillWorkshop:`技能商店工坊`"],
    ["skillWorkshop:`技能工坊`", "skillWorkshop:`技能商店工坊`"],
    ["skillWorkshop:`SkillHub 工坊`", "skillWorkshop:`技能商店工坊`"],
    ["skillsFilter:`SkillHub 筛选`", "skillsFilter:`技能商店筛选`"],
    ["agents:`Workspace, tools, and identity.`", "agents:`专家、会话与身份。`"],
    ["agents:`工作区、工具与身份。`", "agents:`专家、会话与身份。`"],
    ["agents:`工作区、工具、身份。`", "agents:`专家、会话与身份。`"],
    ["tasks:`Background jobs: subagents, cron runs, and CLI.`", "tasks:`自动任务、子智能体与运行记录。`"],
    ["tasks:`后台任务：子智能体、定时运行与 CLI。`", "tasks:`自动任务、子智能体与运行记录。`"],
    ["config:`Edit openclaw.json.`", "config:`模型、供应商与默认参数。`"],
    ["config:`编辑 openclaw.json。`", "config:`模型、供应商与默认参数。`"],
    ["skills:`Skills and API keys.`", "skills:`技能库、安装与本地技能管理。`"],
    ["skills:`技能和 API 密钥。`", "skills:`技能库、安装与本地技能管理。`"],
    ["skills:`SkillHub 商店、安装与本地技能管理。`", "skills:`技能库、安装与本地技能管理。`"],
    ["skills:`SkillHub store, installs, and local skill management.`", "skills:`技能库、安装与本地技能管理。`"],
    ["skills:`技能商店、安装与本地技能管理。`", "skills:`技能库、安装与本地技能管理。`"],
    ["importing:`Importing…`", "importing:`导入中…`"],
    ["importFromRelays:`Import from Relays`", "importFromRelays:`从 relays 导入`"],
    ["showAdvanced:`Show Advanced`", "showAdvanced:`显示高级项`"],
    ["hideAdvanced:`Hide Advanced`", "hideAdvanced:`隐藏高级项`"],
    ["unsavedChanges:`You have unsaved changes`", "unsavedChanges:`有未保存变更`"],
    ["working:`Working…`", "working:`处理中…`"],
    ["showQr:`Show QR`", "showQr:`显示二维码`"],
    ["relink:`Relink`", "relink:`重新关联`"],
    ["waitForScan:`Wait for scan`", "waitForScan:`等待扫码`"],
    ["logout:`Logout`", "logout:`退出登录`"],
    ["title:`Channel health`", "title:`渠道健康`"],
    ["subtitle:`Channel status snapshots from the gateway.`", "subtitle:`来自 Gateway 的渠道状态快照。`"],
    ["noSnapshotYet:`No snapshot yet.`", "noSnapshotYet:`暂无快照。`"],
    ["subtitle:`Channel status and configuration.`", "subtitle:`渠道状态与配置。`"],
    ["title:`Change Gateway URL`", "title:`更换 Gateway URL`"],
    ["subtitle:`This will reconnect to a different gateway server`", "subtitle:`这会重新连接到另一台 Gateway server`"],
    [
      "warning:`Only confirm if you trust this URL. Malicious URLs can compromise your system.`",
      "warning:`仅在信任此 URL 时确认。恶意 URL 可能危及系统安全。`",
    ],
    ["profile:`Profile`", "profile:`资料`"],
    ["editProfile:`Edit Profile`", "editProfile:`编辑资料`"],
    ["profilePicture:`Profile picture`", "profilePicture:`头像`"],
    ["noProfile:`No profile set.`", "noProfile:`尚未设置资料。`"],
    [
      "noProfileHint:`Click \"Edit Profile\" to add your name, bio, and avatar.`",
      "noProfileHint:`点击“编辑资料”添加名称、简介与头像。`",
    ],
    ["name:`Name`", "name:`名称`"],
    ["displayName:`Display Name`", "displayName:`显示名称`"],
    ["about:`About`", "about:`简介`"],
    ["advanced:`Advanced`", "advanced:`高级`"],
    ["profilePicturePreview:`Profile picture preview`", "profilePicturePreview:`头像预览`"],
    ["account:`Account`", "account:`账号`"],
    ["username:`Username`", "username:`用户名`"],
    ["usernameHelp:`Short username (e.g., satoshi)`", "usernameHelp:`短用户名，例如 satoshi`"],
    ["bio:`Bio`", "bio:`简介`"],
    ["bioPlaceholder:`Tell people about yourself...`", "bioPlaceholder:`简单介绍自己...`"],
    ["bioHelp:`A brief bio or description`", "bioHelp:`简短简介或说明`"],
    ["displayNameHelp:`Your full display name`", "displayNameHelp:`完整显示名称`"],
    ["avatarUrl:`Avatar URL`", "avatarUrl:`头像 URL`"],
    ["avatarHelp:`HTTPS URL to your profile picture`", "avatarHelp:`头像图片的 HTTPS URL`"],
    ["bannerUrl:`Banner URL`", "bannerUrl:`横幅 URL`"],
    ["bannerHelp:`HTTPS URL to a banner image`", "bannerHelp:`横幅图片的 HTTPS URL`"],
    ["website:`Website`", "website:`网站`"],
    ["websiteHelp:`Your personal website`", "websiteHelp:`个人网站`"],
    ["nip05Identifier:`NIP-05 Identifier`", "nip05Identifier:`NIP-05 标识`"],
    ["nip05Help:`Verifiable identifier (e.g., you@domain.com)`", "nip05Help:`可验证标识，例如 you@domain.com`"],
    ["lightningAddress:`Lightning Address`", "lightningAddress:`Lightning 地址`"],
    ["lightningHelp:`Lightning address for tips (LUD-16)`", "lightningHelp:`用于打赏的 Lightning 地址 (LUD-16)`"],
    ["title:`OpenClaw mobile`", "title:`U-Claw 移动端`"],
    ["title:`OpenClaw 移动版`", "title:`U-Claw 移动端`"],
    ["qrAlt:`OpenClaw mobile pairing QR code`", "qrAlt:`U-Claw 移动端配对二维码`"],
    ["qrAlt:`OpenClaw 移动版配对二维码`", "qrAlt:`U-Claw 移动端配对二维码`"],
    ["waiting:`The official OpenClaw mobile app will connect automatically after scan.`", "waiting:`U-Claw 移动端扫码后会自动连接。`"],
    ["waiting:`官方 OpenClaw 移动应用在扫描后会自动连接。`", "waiting:`U-Claw 移动端扫码后会自动连接。`"],
    ["subtitle:`Isolated repository checkouts owned by OpenClaw.`", "subtitle:`由 U-Claw 管理的隔离代码库检出。`"],
    ["subtitle:`由 OpenClaw 拥有的隔离代码库检出。`", "subtitle:`由 U-Claw 管理的隔离代码库检出。`"],
    ["subtitle:`Gateway Dashboard`", "subtitle:`U-Claw Gateway`"],
    ["showToken:`Show token`", "showToken:`显示 token`"],
    ["hideToken:`Hide token`", "hideToken:`隐藏 token`"],
    ["toggleTokenVisibility:`Toggle token visibility`", "toggleTokenVisibility:`切换 token 可见性`"],
    ["showPassword:`Show password`", "showPassword:`显示密码`"],
    ["hidePassword:`Hide password`", "hidePassword:`隐藏密码`"],
    ["togglePasswordVisibility:`Toggle password visibility`", "togglePasswordVisibility:`切换密码可见性`"],
    ["rawError:`Raw error`", "rawError:`原始错误`"],
    ["docsAuth:`Control UI auth docs`", "docsAuth:`U-Claw 认证文档`"],
    ["docsPairing:`Device pairing docs`", "docsPairing:`设备配对文档`"],
    ["docsInsecure:`Insecure HTTP docs`", "docsInsecure:`HTTP 安全说明`"],
    ["title:`Auth required`", "title:`需要认证`"],
    [
      "summary:`The Gateway is reachable, but it needs a matching token or password before this browser can connect.`",
      "summary:`Gateway 可达，但此浏览器需要匹配 token 或密码后才能连接。`",
    ],
    [
      "stepPaste:`Paste the token from openclaw dashboard --no-open or enter the configured password.`",
      "stepPaste:`粘贴 openclaw dashboard --no-open 输出的 token，或输入已配置密码。`",
    ],
    [
      "stepGenerate:`If no token is configured, run openclaw doctor --generate-gateway-token on the gateway host.`",
      "stepGenerate:`若尚未配置 token，请在 Gateway 主机运行 openclaw doctor --generate-gateway-token。`",
    ],
    ["stepConnect:`Click Connect again after updating the credential.`", "stepConnect:`更新凭据后再次点击连接。`"],
    ["title:`Auth did not match`", "title:`认证不匹配`"],
    [
      "summary:`The supplied credential was rejected. The most common cause is a stale token or a token copied from another Gateway URL.`",
      "summary:`提交的凭据被拒绝，常见原因是 token 过期或来自另一个 Gateway URL。`",
    ],
    [
      "stepDashboard:`Run openclaw dashboard --no-open and open the fresh URL or paste its token.`",
      "stepDashboard:`运行 openclaw dashboard --no-open，并打开新 URL 或粘贴其中 token。`",
    ],
    [
      "stepReplace:`Replace stale token/password values; do not reuse a token from another Gateway URL.`",
      "stepReplace:`替换旧 token/password；不要复用另一个 Gateway URL 的 token。`",
    ],
    [
      "stepMode:`Use one matching auth mode at a time: gateway token for token mode, password for password mode.`",
      "stepMode:`一次只使用一种匹配认证模式：token mode 用 gateway token，password mode 用密码。`",
    ],
    ["title:`Too many failed attempts`", "title:`失败次数过多`"],
    [
      "summary:`The Gateway is temporarily limiting authentication attempts for this client.`",
      "summary:`Gateway 暂时限制此客户端的认证尝试。`",
    ],
    ["stepStop:`Stop retrying from this tab for a moment.`", "stepStop:`请先停止在此标签页反复重试。`"],
    [
      "stepWait:`Wait for the auth limiter to cool down, then reconnect with the corrected credential.`",
      "stepWait:`等待认证限流恢复后，用修正后的凭据重连。`",
    ],
    ["title:`Device pairing required`", "title:`需要设备配对`"],
    ["scopeTitle:`Scope upgrade pending`", "scopeTitle:`Scope 升级待确认`"],
    ["roleTitle:`Role upgrade pending`", "roleTitle:`Role 升级待确认`"],
    ["metadataTitle:`Device refresh pending`", "metadataTitle:`设备信息更新待确认`"],
    [
      "summary:`This browser needs one-time approval from the Gateway host before it can use the Control UI.`",
      "summary:`此浏览器需由 Gateway 主机一次性批准后才能使用 U-Claw 界面。`",
    ],
    ["stepList:`Run openclaw devices list on the Gateway host.`", "stepList:`在 Gateway 主机运行 openclaw devices list。`"],
    [
      "stepApproveId:`Approve this request: openclaw devices approve {requestId}.`",
      "stepApproveId:`批准此请求：openclaw devices approve {requestId}。`",
    ],
    ["stepApprove:`Approve the pending browser/device request from that list.`", "stepApprove:`从列表中批准待处理浏览器/设备请求。`"],
    ["stepReconnect:`Reconnect after the approval completes.`", "stepReconnect:`批准完成后重新连接。`"],
    ["title:`Secure browser context required`", "title:`需要安全浏览器上下文`"],
    [
      "title:`How to connect`",
      "title:`如何连接`",
    ],
    [
      "step1:`Start the gateway on your host machine:`",
      "step1:`在主机启动 Gateway：`",
    ],
    [
      "step2:`Get a tokenized dashboard URL:`",
      "step2:`获取带 token 的 dashboard URL：`",
    ],
    [
      "step3:`Paste the WebSocket URL and token above, or open the tokenized URL directly.`",
      "step3:`在上方粘贴 WebSocket URL 与 token，或直接打开带 token 的 URL。`",
    ],
    ["step4:`Or generate a reusable token:`", "step4:`或生成可复用 token：`"],
    ["docsHint:`For remote access, Tailscale Serve is recommended. `", "docsHint:`远程访问建议使用 Tailscale Serve。`"],
    ["docsLink:`Read the docs →`", "docsLink:`查看文档 →`"],
    ["copyCommand:`Copy command`", "copyCommand:`复制命令`"],
    ["copyCommandAria:`Copy command: {command}`", "copyCommandAria:`复制命令：{command}`"],
    ["lostTitle:`Gateway connection lost`", "lostTitle:`Gateway 连接已断开`"],
    ["reconnecting:`Reconnecting…`", "reconnecting:`重连中…`"],
    [
      "offlineHint:`Live updates and actions are paused until the connection returns.`",
      "offlineHint:`连接恢复前，实时更新与操作会暂停。`",
    ],
    ["retryNow:`Retry now`", "retryNow:`立即重试`"],
  ];

  for (const file of listAssetFiles(/^(i18n|zh-CN)-.*\.js$/, "i18n and zh-CN locale")) {
    const before = read(file);
    const after = replacePairs(before, pairs);
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Localizes second-batch operational pages that share the default i18n bundle.
 */
function patchSecondaryPagesI18nUiCopy() {
  const pairs = [
    ["health:`Health`", "health:`健康`"],
    ["call:`Call`", "call:`调用`"],
    ["loadApprovals:`Load approvals`", "loadApprovals:`加载审批`"],
    ["secondsAgo:`{count}s ago`", "secondsAgo:`{count} 秒前`"],
    ["eventArchived:`Archived`", "eventArchived:`已归档`"],
    ["eventUnarchived:`Unarchived`", "eventUnarchived:`已恢复`"],
    ["eventUnarchived:`已取消归档`", "eventUnarchived:`已恢复`"],
    ["eventStale:`Stale session`", "eventStale:`过期会话`"],
    ["loadingTitle:`Loading panel`", "loadingTitle:`正在加载面板`"],
    ["errorTitle:`Panel failed to load`", "errorTitle:`面板加载失败`"],
    [
      "errorSubtitle:`Reload the page to load the latest Control UI bundle, or retry if the network request failed.`",
      "errorSubtitle:`重新加载页面以获取最新 U-Claw 界面资源；若为网络失败，请重试。`",
    ],
    ["retry:`Retry`", "retry:`重试`"],
    ["unknownError:`Unknown module load error.`", "unknownError:`未知模块加载错误。`"],
    ["button:`Pair mobile device`", "button:`配对移动设备`"],
    [
      "adminRequired:`Administrator access is required to create setup codes.`",
      "adminRequired:`创建设置码需要管理员权限。`",
    ],
    ["title:`OpenClaw mobile`", "title:`U-Claw 移动端`"],
    [
      "subtitle:`Scan this QR code in the mobile app to connect a new phone.`",
      "subtitle:`在移动端扫描此二维码以连接新手机。`",
    ],
    ["generating:`Creating a secure setup code…`", "generating:`正在创建安全设置码…`"],
    ["failed:`Could not create a setup code.`", "failed:`无法创建设置码。`"],
    ["qrAlt:`OpenClaw mobile pairing QR code`", "qrAlt:`U-Claw 移动端配对二维码`"],
    ["qrUnavailable:`QR unavailable. Copy the setup code instead.`", "qrUnavailable:`二维码不可用，请复制设置码。`"],
    ["copySetupCode:`Copy setup code`", "copySetupCode:`复制设置码`"],
    ["newCode:`New code`", "newCode:`新代码`"],
    ["showSetupCode:`Show setup code`", "showSetupCode:`显示设置码`"],
    ["pending:`Device requests waiting for review: {count}`", "pending:`待审核设备请求：{count}`"],
    ["review:`Review`", "review:`复核`"],
    [
      "waiting:`Official OpenClaw mobile apps connect automatically after scanning.`",
      "waiting:`U-Claw 移动端扫码后会自动连接。`",
    ],
    ["help:`Pairing help`", "help:`配对帮助`"],
    ["manageDevices:`Manage devices`", "manageDevices:`管理设备`"],
    ["loadConfigHint:`Load config to edit bindings.`", "loadConfigHint:`加载配置后可编辑绑定。`"],
    ["formModeHint:`Switch the Config tab to Form mode to edit bindings here.`", "formModeHint:`将 Config 切到 Form mode 后可在此编辑绑定。`"],
    ["execNodeBinding:`Exec node binding`", "execNodeBinding:`Exec 节点绑定`"],
    ["execNodeBindingSubtitle:`Pin agents to a specific node when using exec host=node.`", "execNodeBindingSubtitle:`使用 exec host=node 时，将 Agent 固定到指定节点。`"],
    ["defaultBinding:`Default binding`", "defaultBinding:`默认绑定`"],
    ["defaultBindingHint:`Used when agents do not override a node binding.`", "defaultBindingHint:`Agent 未覆盖节点绑定时使用。`"],
    ["instances:{title:`Connected Instances`", "instances:{title:`已连接实例`"],
    ["instances:{title:`已连接的实例`", "instances:{title:`已连接实例`"],
    ["subtitle:`Presence beacons from the gateway and clients.`", "subtitle:`来自 Gateway 与客户端的在线信标。`"],
    ["showHosts:`Show hosts and IPs`", "showHosts:`显示 hosts 与 IP`"],
    ["hideHosts:`Hide hosts and IPs`", "hideHosts:`隐藏 hosts 与 IP`"],
    ["toggleHostVisibility:`Toggle host visibility`", "toggleHostVisibility:`切换 host 可见性`"],
    ["noInstances:`No instances reported yet.`", "noInstances:`暂无实例上报。`"],
    ["lastInput:`Last input {time}`", "lastInput:`上次输入 {time}`"],
    ["reason:`Reason {reason}`", "reason:`原因 {reason}`"],
    ["worktrees:{title:`Managed Worktrees`", "worktrees:{title:`托管工作树`"],
    ["worktrees:{title:`托管 Worktrees`", "worktrees:{title:`托管工作树`"],
    ["worktrees:{title:`托管的 Worktrees`", "worktrees:{title:`托管工作树`"],
    ["subtitle:`Isolated repository checkouts owned by OpenClaw.`", "subtitle:`U-Claw 托管的隔离仓库 checkout。`"],
    ["subtitle:`由 U-Claw 管理的隔离代码库检出。`", "subtitle:`U-Claw 托管的隔离仓库 checkout。`"],
    ["cleanNow:`Clean up now`", "cleanNow:`立即清理`"],
    ["repo:`Repository`", "repo:`仓库`"],
    ["branch:`Branch`", "branch:`分支`"],
    ["status:`Status`", "status:`状态`"],
    ["lastActive:`Last active`", "lastActive:`上次活跃`"],
    ["actions:`Actions`", "actions:`操作`"],
    ["empty:`No managed worktrees.`", "empty:`暂无托管 worktree。`"],
    ["restorable:`Restorable`", "restorable:`可恢复`"],
    ["restore:`Restore`", "restore:`恢复`"],
    ["confirmDelete:`Snapshot and delete {name}?`", "confirmDelete:`为 {name} 创建快照并删除？`"],
    ["confirmForceDelete:`Snapshot failed: {error}\n\nDelete without a snapshot?`", "confirmForceDelete:`快照失败：{error}\n\n是否不带快照删除？`"],
    ["sessionsView:{title:`Sessions`", "sessionsView:{title:`会话`"],
    ["subtitle:`Active session keys and per-session overrides.`", "subtitle:`活跃会话 key 与单会话覆盖项。`"],
    ["subtitle:`活动会话密钥和每个会话的覆盖设置。`", "subtitle:`活跃会话 key 与单会话覆盖项。`"],
    ["store:`Store: {path}`", "store:`存储：{path}`"],
    ["active:`Updated within`", "active:`更新时间`"],
    ["limit:`Limit`", "limit:`上限`"],
    ["filters:`Filters`", "filters:`筛选`"],
    ["sourceFilters:`Session source filters`", "sourceFilters:`会话来源筛选`"],
    ["global:`Global`", "global:`全局`"],
    ["unknown:`Unknown`", "unknown:`未知`"],
    ["archivedOnly:`Archived only`", "archivedOnly:`仅归档`"],
    ["activeTooltip:`Loads sessions updated in the last {count} minutes.`", "activeTooltip:`加载最近 {count} 分钟更新的会话。`"],
    ["limitTooltip:`Max sessions to load.`", "limitTooltip:`最多加载的会话数。`"],
    ["globalTooltip:`Include global sessions.`", "globalTooltip:`包含全局会话。`"],
    ["unknownTooltip:`Include unknown sessions.`", "unknownTooltip:`包含未知会话。`"],
    ["archivedOnlyTooltip:`Show only archived sessions.`", "archivedOnlyTooltip:`仅显示已归档会话。`"],
    ["liveCount:`{count} live`", "liveCount:`{count} 个在线`"],
    ["minutesPlaceholder:`min`", "minutesPlaceholder:`分钟`"],
    ["searchPlaceholder:`Filter by key, agent, label, kind…`", "searchPlaceholder:`按 key、Agent、标签或类型筛选…`"],
    ["selected:`{count} selected`", "selected:`已选择 {count} 项`"],
    ["deleteSelected:`Delete`", "deleteSelected:`删除`"],
    ["selectAllOnPage:`Select all on page`", "selectAllOnPage:`选择本页全部`"],
    ["selectSession:`Select session`", "selectSession:`选择会话`"],
    ["optionalPlaceholder:`(optional)`", "optionalPlaceholder:`（可选）`"],
    ["key:`Key`", "key:`Key`"],
    ["kind:`Kind`", "kind:`类型`"],
    ["updated:`Updated`", "updated:`更新`"],
    ["tokens:`Tokens`", "tokens:`Tokens`"],
    ["compaction:`Compaction`", "compaction:`压缩`"],
    ["goal:`Goal`", "goal:`目标`"],
    ["goalNote:`Goal note`", "goalNote:`目标备注`"],
    ["actions:`Actions`", "actions:`操作`"],
    ["addToWorkboard:`Add to Workboard`", "addToWorkboard:`加入 Workboard`"],
    ["openWorkboardCard:`Open Workboard card`", "openWorkboardCard:`打开 Workboard 卡片`"],
    ["noSessions:`No sessions found.`", "noSessions:`未找到会话。`"],
    ["noSessionsMatchFilters:`No sessions match your filters.`", "noSessionsMatchFilters:`没有会话符合当前筛选。`"],
    ["showAll:`Show all`", "showAll:`显示全部`"],
    ["defaultOption:`Default ({value})`", "defaultOption:`默认 ({value})`"],
    ["offExplicit:`off (explicit)`", "offExplicit:`off（显式）`"],
    ["customOption:`{value} (custom)`", "customOption:`{value}（自定义）`"],
    ["autoThreshold:`auto-threshold`", "autoThreshold:`自动阈值`"],
    ["overflowRetry:`overflow retry`", "overflowRetry:`溢出重试`"],
    ["timeoutRetry:`timeout retry`", "timeoutRetry:`超时重试`"],
    ["tokenRange:`{before} to {after} tokens`", "tokenRange:`{before} 到 {after} tokens`"],
    ["tokensBefore:`{count} tokens before`", "tokensBefore:`之前 {count} tokens`"],
    ["tokenDeltaUnavailable:`token delta unavailable`", "tokenDeltaUnavailable:`token delta 不可用`"],
    ["checkpoints:`{count} Checkpoints`", "checkpoints:`{count} 个检查点`"],
    ["checkpoint:`{count} Checkpoint`", "checkpoint:`{count} 个检查点`"],
    ["showSessionDetails:`Show session details for {count}`", "showSessionDetails:`显示 {count} 的会话详情`"],
    ["hideSessionDetails:`Hide session details for {count}`", "hideSessionDetails:`隐藏 {count} 的会话详情`"],
    ["sessionDetails:`Session details`", "sessionDetails:`会话详情`"],
    ["overrides:`Overrides`", "overrides:`覆盖项`"],
    ["compactionHistory:`Compaction history`", "compactionHistory:`压缩历史`"],
    ["statusLive:`Live`", "statusLive:`在线`"],
    ["statusIdle:`Idle`", "statusIdle:`空闲`"],
    ["statusUnknown:`Unknown`", "statusUnknown:`未知`"],
    ["statusRunning:`Running`", "statusRunning:`运行中`"],
    ["statusDone:`Done`", "statusDone:`已完成`"],
    ["statusFailed:`Failed`", "statusFailed:`失败`"],
    ["statusKilled:`Killed`", "statusKilled:`已终止`"],
    ["statusTimeout:`Timed out`", "statusTimeout:`已超时`"],
    ["surface:`Surface`", "surface:`入口`"],
    ["subject:`Subject`", "subject:`主题`"],
    ["room:`Room`", "room:`房间`"],
    ["space:`Space`", "space:`空间`"],
    ["sessionId:`Session ID`", "sessionId:`Session ID`"],
    ["activeRun:`Active run`", "activeRun:`当前运行`"],
    ["archived:`Archived`", "archived:`已归档`"],
    ["pinned:`Pinned`", "pinned:`已置顶`"],
    ["unread:`Unread`", "unread:`未读`"],
    ["renameSession:`Rename session`", "renameSession:`重命名会话`"],
    ["renameSessionPrompt:`Rename session`", "renameSessionPrompt:`重命名会话`"],
    ["renameSessionMenu:`Rename…`", "renameSessionMenu:`重命名…`"],
    ["pinSession:`Pin session`", "pinSession:`置顶会话`"],
    ["unpinSession:`Unpin session`", "unpinSession:`取消置顶`"],
    ["markUnread:`Mark as unread`", "markUnread:`标为未读`"],
    ["markRead:`Mark as read`", "markRead:`标为已读`"],
    ["forkSession:`Fork`", "forkSession:`Fork`"],
    ["archiveSession:`Archive session`", "archiveSession:`归档会话`"],
    ["restoreSession:`Restore session`", "restoreSession:`恢复会话`"],
    ["deleteSessionMenu:`Delete…`", "deleteSessionMenu:`删除…`"],
    ["deleteSessionConfirm:`Delete \"{session}\" and its transcript?`", "deleteSessionConfirm:`删除“{session}”及其 transcript？`"],
    ["groupBy:`Group by`", "groupBy:`分组方式`"],
    ["groupByNone:`None`", "groupByNone:`不分组`"],
    ["groupByCategory:`Custom groups`", "groupByCategory:`自定义分组`"],
    ["groupByChannel:`Channel`", "groupByChannel:`渠道`"],
    ["groupByKind:`Kind`", "groupByKind:`类型`"],
    ["groupByAgent:`Agent`", "groupByAgent:`Agent`"],
    ["groupByDate:`Date`", "groupByDate:`日期`"],
    ["group:`Group`", "group:`分组`"],
    ["ungrouped:`Ungrouped`", "ungrouped:`未分组`"],
    ["newGroup:`New group…`", "newGroup:`新建分组…`"],
    ["newGroupPrompt:`New group name`", "newGroupPrompt:`新分组名称`"],
    ["moveToGroup:`Move session to a group`", "moveToGroup:`移动会话到分组`"],
    ["moveToGroupMenu:`Move to group`", "moveToGroupMenu:`移动到分组`"],
    ["removeFromGroup:`Remove from group`", "removeFromGroup:`移出分组`"],
    ["groupMenu:`Group options for {group}`", "groupMenu:`{group} 分组选项`"],
    ["renameGroupMenu:`Rename group…`", "renameGroupMenu:`重命名分组…`"],
    ["renameGroupPrompt:`Rename group`", "renameGroupPrompt:`重命名分组`"],
    ["deleteGroupMenu:`Delete group…`", "deleteGroupMenu:`删除分组…`"],
    ["deleteGroupConfirm:`Delete group \"{group}\"? Its sessions move to Ungrouped.`", "deleteGroupConfirm:`删除分组“{group}”？其中会话将移至未分组。`"],
    ["dragSessionHint:`Drag to move between groups`", "dragSessionHint:`拖拽可在分组间移动`"],
    ["dateToday:`Today`", "dateToday:`今天`"],
    ["dateYesterday:`Yesterday`", "dateYesterday:`昨天`"],
    ["dateThisWeek:`This week`", "dateThisWeek:`本周`"],
    ["dateOlder:`Older`", "dateOlder:`更早`"],
    ["dateNoActivity:`No activity`", "dateNoActivity:`无活动`"],
    ["groupRowCount:`{count} sessions`", "groupRowCount:`{count} 个会话`"],
    ["groupRowCountOne:`{count} session`", "groupRowCountOne:`{count} 个会话`"],
    ["loadingCheckpoints:`Loading checkpoints…`", "loadingCheckpoints:`正在加载检查点…`"],
    ["noCheckpoints:`No compaction checkpoints recorded for this session.`", "noCheckpoints:`此会话尚无压缩检查点。`"],
    ["noSummary:`No summary captured.`", "noSummary:`未记录摘要。`"],
    ["branchFromCheckpoint:`Branch from checkpoint`", "branchFromCheckpoint:`从检查点分支`"],
    ["restoreCheckpoint:`Restore checkpoint`", "restoreCheckpoint:`恢复检查点`"],
    ["tabs:{agents:`Agents`", "tabs:{agents:`Agents`"],
    ["cronJobs:`Cron Jobs`", "cronJobs:`定时任务`"],
    ["activity:`Activity`", "activity:`活动`"],
    ["overview:`Overview`", "overview:`概览`"],
    ["workboard:`Workboard`", "workboard:`工作板`"],
    ["worktrees:`Worktrees`", "worktrees:`工作树`"],
    ["instances:`Instances`", "instances:`实例`"],
    ["sessions:`Sessions`", "sessions:`会话`"],
    ["usage:`Usage`", "usage:`用量`"],
    ["cron:`Cron Jobs`", "cron:`定时任务`"],
    ["tasks:`Tasks`", "tasks:`任务`"],
    ["skillWorkshop:`Skill Workshop`", "skillWorkshop:`Skill 工作坊`"],
    ["nodes:`Nodes`", "nodes:`节点`"],
    ["chat:`Chat`", "chat:`聊天`"],
    ["config:`Config`", "config:`配置`"],
    ["communications:`Communications`", "communications:`通讯`"],
    ["appearance:`Appearance`", "appearance:`外观`"],
    ["automation:`Automation`", "automation:`自动化`"],
    ["infrastructure:`Infrastructure`", "infrastructure:`基础设施`"],
    ["aiAgents:`AI & Agents`", "aiAgents:`AI 与 Agents`"],
    ["debug:`Debug`", "debug:`调试`"],
    ["logs:`Logs`", "logs:`日志`"],
    ["dreams:`Dreaming`", "dreams:`记忆整理`"],
    ["plugin:`Plugin`", "plugin:`插件`"],
    ["agents:`Workspaces, tools, identities.`", "agents:`工作区、工具与身份。`"],
    ["activity:`Browser-local tool activity summaries.`", "activity:`浏览器本地工具活动摘要。`"],
    ["overview:`Status, entry points, health.`", "overview:`状态、入口与健康度。`"],
    ["workboard:`Agent work queue and session handoff.`", "workboard:`Agent 工作队列与会话交接。`"],
    ["worktrees:`Isolated agent task checkouts and recovery snapshots.`", "worktrees:`隔离 Agent 任务 checkout 与恢复快照。`"],
    ["channels:`Channels and settings.`", "channels:`渠道与设置。`"],
    ["instances:`Connected clients and nodes.`", "instances:`已连接客户端与节点。`"],
    ["sessions:`Active sessions and defaults.`", "sessions:`活跃会话与默认项。`"],
    ["usage:`API usage and costs.`", "usage:`API 用量与成本。`"],
    ["cron:`Wakeups and recurring runs.`", "cron:`唤醒与周期运行。`"],
    ["tasks:`Background tasks: subagents, cron runs, CLI.`", "tasks:`后台任务：子智能体、定时运行与 CLI。`"],
    ["tasks:`后台任务：子代理、cron 运行、CLI。`", "tasks:`后台任务：子智能体、定时运行与 CLI。`"],
    ["skills:`Skills and API keys.`", "skills:`技能与 API keys。`"],
    ["skillWorkshop:`Review, refine, and apply proposals before they become live skills.`", "skillWorkshop:`在提案成为正式技能前进行复核、打磨与应用。`"],
    ["nodes:`Paired devices and commands.`", "nodes:`已配对设备与命令。`"],
    ["chat:`Gateway chat for quick interventions.`", "chat:`用于快速介入的 Gateway 聊天。`"],
    ["config:`Edit openclaw.json.`", "config:`编辑 openclaw.json。`"],
    ["communications:`Channels, messages, and audio settings.`", "communications:`渠道、消息与音频设置。`"],
    ["appearance:`Theme, UI, and setup wizard settings.`", "appearance:`主题、界面与设置向导。`"],
    ["automation:`Commands, hooks, cron, and plugins.`", "automation:`命令、hooks、cron 与插件。`"],
    ["infrastructure:`Gateway, web, browser, and media settings.`", "infrastructure:`Gateway、web、browser 与媒体设置。`"],
    ["aiAgents:`Agents, models, skills, tools, memory, session.`", "aiAgents:`Agents、模型、技能、工具、记忆与会话。`"],
    ["debug:`Snapshots, events, RPC.`", "debug:`快照、事件与 RPC。`"],
    ["logs:`Live gateway logs.`", "logs:`实时 Gateway 日志。`"],
    ["dreams:`Memory dreaming, consolidation, and reflection.`", "dreams:`记忆整理、合并与反思。`"],
    ["plugin:`Plugin-provided panel.`", "plugin:`插件提供的面板。`"],
    ["recent:`Recent`", "recent:`最近`"],
    ["loading:`Loading tasks…`", "loading:`正在加载任务…`"],
    ["empty:`No background tasks yet.`", "empty:`暂无后台任务。`"],
    ["emptyActive:`No queued or running tasks.`", "emptyActive:`暂无排队或运行中的任务。`"],
    ["emptyRecent:`No recent completed tasks.`", "emptyRecent:`暂无最近完成任务。`"],
    ["disconnected:`Connect to the gateway to load and manage tasks.`", "disconnected:`连接 Gateway 后可加载并管理任务。`"],
    ["loadFailed:`Could not load tasks.`", "loadFailed:`无法加载任务。`"],
    ["cancelFailed:`Could not cancel the task.`", "cancelFailed:`无法取消任务。`"],
    ["invalidResponse:`The gateway returned an invalid task list.`", "invalidResponse:`Gateway 返回了无效任务列表。`"],
    ["untitled:`Background task`", "untitled:`后台任务`"],
    ["taskCount:`{count} tasks`", "taskCount:`{count} 个任务`"],
    ["taskCountOne:`1 task`", "taskCountOne:`1 个任务`"],
    ["agent:`Agent: {agent}`", "agent:`Agent：{agent}`"],
    ["openSession:`Open session`", "openSession:`打开会话`"],
    ["cancelTask:`Cancel {title}`", "cancelTask:`取消 {title}`"],
    ["cancelling:`Cancelling…`", "cancelling:`正在取消…`"],
    ["queued:`Queued`", "queued:`排队中`"],
    ["completed:`Completed`", "completed:`已完成`"],
    ["failed:`Failed`", "failed:`失败`"],
    ["cancelled:`Cancelled`", "cancelled:`已取消`"],
    ["timedOut:`Timed out`", "timedOut:`已超时`"],
    ["unknown:`Task`", "unknown:`任务`"],
    ["activity:{title:`Activity`", "activity:{title:`活动`"],
    ["subtitle:`Ephemeral tool activity derived from live session events.`", "subtitle:`从实时会话事件生成的临时工具活动。`"],
    ["visibleCount:`{visible} of {total}`", "visibleCount:`{visible} / {total}`"],
    ["filtersLabel:`Activity filters`", "filtersLabel:`活动筛选`"],
    ["searchPlaceholder:`Filter by tool, summary, run, session`", "searchPlaceholder:`按工具、摘要、运行或会话筛选`"],
    ["toolFilter:`Tool`", "toolFilter:`工具`"],
    ["allTools:`All tools`", "allTools:`全部工具`"],
    ["statusFilters:`Status filters`", "statusFilters:`状态筛选`"],
    ["autoFollow:`Auto-follow`", "autoFollow:`自动跟随`"],
    ["expandAll:`Expand all`", "expandAll:`全部展开`"],
    ["collapseAll:`Collapse all`", "collapseAll:`全部折叠`"],
    ["clear:`Clear`", "clear:`清除`"],
    ["empty:`No tool activity yet.`", "empty:`暂无工具活动。`"],
    ["emptyFiltered:`No activity matches these filters.`", "emptyFiltered:`没有活动符合当前筛选。`"],
    ["argumentHiddenOne:`1 argument hidden`", "argumentHiddenOne:`1 个参数已隐藏`"],
    ["argumentHiddenOne:`已隐藏 1 个参数`", "argumentHiddenOne:`1 个参数已隐藏`"],
    ["argumentsHidden:`{count} arguments hidden`", "argumentsHidden:`{count} 个参数已隐藏`"],
    ["streamLabel:`Tool activity entries`", "streamLabel:`工具活动条目`"],
    ["toolCallId:`Tool call`", "toolCallId:`工具调用`"],
    ["runId:`Run`", "runId:`运行`"],
    ["session:`Session`", "session:`会话`"],
    ["outputTruncated:`Preview redacted and truncated.`", "outputTruncated:`预览已脱敏并截断。`"],
    ["noOutputPreview:`No output preview.`", "noOutputPreview:`暂无输出预览。`"],
    ["done:`Done`", "done:`已完成`"],
    ["error:`Error`", "error:`错误`"],
    ["logsView:{title:`Logs`", "logsView:{title:`日志`"],
    ["subtitle:`Gateway file logs (JSONL).`", "subtitle:`Gateway 文件日志 (JSONL)。`"],
    ["exportButton:`Export {label}`", "exportButton:`导出 {label}`"],
    ["filtered:`filtered`", "filtered:`已筛选`"],
    ["visible:`visible`", "visible:`可见`"],
    ["filter:`Filter`", "filter:`筛选`"],
    ["searchPlaceholder:`Search logs`", "searchPlaceholder:`搜索日志`"],
    ["file:`File: {file}`", "file:`文件：{file}`"],
    ["truncated:`Log output truncated; showing latest chunk.`", "truncated:`日志输出已截断，显示最新片段。`"],
    ["empty:`No log entries.`", "empty:`暂无日志条目。`"],
    ["unavailableTitle:`Plugin panel unavailable`", "unavailableTitle:`插件面板不可用`"],
    [
      "unavailableSubtitle:`The plugin that owns this tab is not active on the connected gateway, or it did not provide a panel.`",
      "unavailableSubtitle:`拥有此 tab 的插件未在当前 Gateway 启用，或未提供面板。`",
    ],
    ["disabledHelpStart:`Workboard is disabled. Enable`", "disabledHelpStart:`Workboard 已停用。启用`"],
    ["disabledHelpStart:`Workboard 已禁用。启用`", "disabledHelpStart:`Workboard 已停用。启用`"],
    ["disabledHelpEnd:`, then reload this tab.`", "disabledHelpEnd:`，然后重新加载此 tab。`"],
    ["triage:`Triage`", "triage:`分诊`"],
    ["backlog:`Backlog`", "backlog:`Backlog`"],
    ["todo:`Todo`", "todo:`Todo`"],
    ["scheduled:`Scheduled`", "scheduled:`已计划`"],
    ["ready:`Ready`", "ready:`就绪`"],
    ["blocked:`Blocked`", "blocked:`阻塞`"],
    ["done:`Done`", "done:`完成`"],
    ["noLinkedSession:`No linked session`", "noLinkedSession:`未关联会话`"],
    ["stopSession:`Stop session`", "stopSession:`停止会话`"],
    ["editCard:`Edit card`", "editCard:`编辑卡片`"],
    ["editCardHelp:`Update queue metadata and session handoff.`", "editCardHelp:`更新队列元数据与会话交接。`"],
    ["newCard:`New card`", "newCard:`新卡片`"],
    ["newCardHelp:`Queue work for an agent session.`", "newCardHelp:`为 Agent 会话排队工作。`"],
    ["archiveCard:`Archive card`", "archiveCard:`归档卡片`"],
    ["unarchiveCard:`Restore from archive`", "unarchiveCard:`从归档恢复`"],
    ["showArchived:`Show archived cards`", "showArchived:`显示归档卡片`"],
    ["hideArchived:`Hide archived cards`", "hideArchived:`隐藏归档卡片`"],
    ["showArchivedShort:`Archived`", "showArchivedShort:`归档`"],
    ["hideArchivedShort:`Hide archived`", "hideArchivedShort:`隐藏归档`"],
    ["deleteCard:`Delete card`", "deleteCard:`删除卡片`"],
    ["viewDetails:`View details`", "viewDetails:`查看详情`"],
    ["detailTitle:`Card details`", "detailTitle:`卡片详情`"],
    ["detailTask:`Gateway task`", "detailTask:`Gateway 任务`"],
    ["detailRun:`Run`", "detailRun:`运行`"],
    ["detailUpdated:`Updated`", "detailUpdated:`已更新`"],
    ["detailProof:`Proof`", "detailProof:`凭证`"],
    ["detailDiagnostics:`Diagnostics`", "detailDiagnostics:`诊断`"],
    ["detailWorkerLogs:`Worker logs`", "detailWorkerLogs:`Worker 日志`"],
    ["detailWorkerProtocol:`Worker protocol`", "detailWorkerProtocol:`Worker 协议`"],
    ["detailAutomation:`Automation`", "detailAutomation:`自动化`"],
  ];

  for (const file of listAssetFiles(/^(?:i18n|zh-CN)-.*\.js$/, "i18n and zh-CN locale")) {
    const before = read(file);
    const after = replacePairs(before, pairs);
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Localizes hard-coded strings in second-batch pages that do not come from i18n.
 */
function patchSecondaryPagesInlineUiCopy() {
  const pageGroups = [
    {
      pattern: /^activity-page-.*\.js$/,
      label: "activity-page",
      pairs: [
        ["b={running:`running`,done:`completed`,error:`failed`}", "b={running:`运行中`,done:`已完成`,error:`失败`}"],
        ["let r=`${n} argument${n===1?``:`s`} hidden`;return`${e} ${M(t)}; ${r}`", "let r=`${n} 个参数已隐藏`;return`${e} ${M(t)}; ${r}`"],
      ],
    },
    {
      pattern: /^nodes-page-.*\.js$/,
      label: "nodes-page",
      pairs: [
        ["Saving…", "保存中…"],
        [">Save<", ">保存<"],
        [">Select node</option>", ">选择节点</option>"],
        ["No nodes advertise exec approvals yet.", "暂无节点声明 exec approvals。"],
        ["Default: ${n.security}.", "默认：${n.security}。"],
        ["Use default (${n.security})", "使用默认值 (${n.security})"],
        ["Default prompt policy.", "默认 prompt 策略。"],
        ["Default: ${n.ask}.", "默认：${n.ask}。"],
        ["Use default (${n.ask})", "使用默认值 (${n.ask})"],
        ["Applied when the UI prompt is unavailable.", "当 UI prompt 不可用时应用。"],
        ["Default: ${n.askFallback}.", "默认：${n.askFallback}。"],
        ["Use default (${n.askFallback})", "使用默认值 (${n.askFallback})"],
        ["Allow skill executables listed by the Gateway.", "允许 Gateway 列出的 skill executables。"],
        ["Using default (${n.autoAllowSkills?", "使用默认值 (${n.autoAllowSkills?"],
        ["Override (${m?", "覆盖 (${m?"],
        [">Remove</button>", ">移除</button>"],
        ["Last used: ${r}", "上次使用：${r}"],
        ["roles: ${O(e.roles)} · scopes: ${O(e.scopes)}", "roles：${O(e.roles)} · scopes：${O(e.scopes)}"],
        ["reconnect details changed; approval required", "重连信息已变更，需要批准"],
        [" · repair", " · 修复"],
        [">Any node</option>", ">任意节点</option>"],
        ["uses default (${t.defaultBinding??", "使用默认值 (${t.defaultBinding??"],
        ["Tokens: none", "Tokens：无"],
      ],
    },
    {
      pattern: /^instances-page-.*\.js$/,
      label: "instances-page",
      pairs: [
        ["No instances yet.", "暂无实例。"],
        ["No presence payload.", "暂无 presence payload。"],
      ],
    },
    {
      pattern: /^logs-page-.*\.js$/,
      label: "logs-page",
      pairs: [["openclaw-logs-${t}-${a}.log", "u-claw-logs-${t}-${a}.log"]],
    },
  ];

  for (const group of pageGroups) {
    for (const file of listAssetFiles(group.pattern, group.label)) {
      const before = read(file);
      const after = replacePairs(before, group.pairs);
      if (writeIfChanged(file, before, after)) {
        console.log(`patched ${path.relative(root, file)}`);
      }
    }
  }
}

/**
 * Localizes third-batch utility pages and shared chrome copy.
 */
function patchTertiaryPagesI18nUiCopy() {
  const pairs = [
    ["subtitles:{agents:`工作区、工具与身份。`,activity:`浏览器本地工具活动摘要。`,overview:`状态、入口与健康度。`,workboard:`Agent 工作队列与会话交接。`,worktrees:`隔离 Agent 任务 checkout 与恢复快照。`,channels:`渠道与设置。`,instances:`已连接客户端与节点。`,sessions:`活跃会话与默认项。`,usage:`API 用量与成本。`,cron:`唤醒与周期运行。`,tasks:`后台任务：子智能体、定时运行与 CLI。`,skills:`SkillHub 商店、安装与本地技能管理。`", "subtitles:{agents:`工作区、工具与身份。`,activity:`浏览器本地工具活动摘要。`,overview:`状态、入口与健康度。`,workboard:`Agent 工作队列与会话交接。`,worktrees:`隔离 Agent 任务 checkout 与恢复快照。`,channels:`渠道与设置。`,instances:`已连接客户端与节点。`,sessions:`活跃会话与默认项。`,usage:`API 用量与成本。`,cron:`唤醒与周期运行。`,tasks:`后台任务：子智能体、定时运行与 CLI。`,skills:`技能商店、安装与本地技能管理。`"],
    ["subtitles:{agents:`工作区、工具与身份。`,activity:`浏览器本地工具活动摘要。`,overview:`状态、入口与健康度。`,workboard:`Agent 工作队列与会话交接。`,worktrees:`隔离 Agent 任务 checkout 与恢复快照。`,channels:`渠道与设置。`,instances:`已连接客户端与节点。`,sessions:`活跃会话与默认项。`,usage:`API 用量与成本。`,cron:`唤醒与周期运行。`,tasks:`后台任务：子智能体、定时运行与 CLI。`,skills:`技能和 API 密钥。`", "subtitles:{agents:`工作区、工具与身份。`,activity:`浏览器本地工具活动摘要。`,overview:`状态、入口与健康度。`,workboard:`Agent 工作队列与会话交接。`,worktrees:`隔离 Agent 任务 checkout 与恢复快照。`,channels:`渠道与设置。`,instances:`已连接客户端与节点。`,sessions:`活跃会话与默认项。`,usage:`API 用量与成本。`,cron:`唤醒与周期运行。`,tasks:`后台任务：子智能体、定时运行与 CLI。`,skills:`技能商店、安装与本地技能管理。`"],
    ["mcp:`MCP servers, auth, tools, and diagnostics.`", "mcp:`MCP servers、认证、工具与诊断。`"],
    ["debug:{snapshotsTitle:`Snapshots`", "debug:{snapshotsTitle:`快照`"],
    ["snapshotsSubtitle:`Status, health, and heartbeat data.`", "snapshotsSubtitle:`状态、健康度与心跳数据。`"],
    ["lastHeartbeat:`Last heartbeat`", "lastHeartbeat:`上次心跳`"],
    ["audit:`Security audit`", "audit:`安全审计`"],
    ["critical:`{count} critical`", "critical:`{count} 个严重问题`"],
    ["warnings:`{count} warnings`", "warnings:`{count} 个警告`"],
    ["noCriticalIssues:`No critical issues`", "noCriticalIssues:`无严重问题`"],
    ["info:`{count} info`", "info:`{count} 条信息`"],
    ["runPrefix:`Run`", "runPrefix:`运行`"],
    ["runSuffix:`for details.`", "runSuffix:`查看详情。`"],
    ["manualRpcTitle:`Manual RPC`", "manualRpcTitle:`手动 RPC`"],
    ["manualRpcSubtitle:`Send a raw gateway method with JSON params.`", "manualRpcSubtitle:`用 JSON params 调用原始 Gateway method。`"],
    ["method:`Method`", "method:`Method`"],
    ["selectMethod:`Select a method…`", "selectMethod:`选择 method…`"],
    ["paramsJson:`Params (JSON)`", "paramsJson:`Params (JSON)`"],
    ["modelsTitle:`Models`", "modelsTitle:`模型`"],
    ["modelsSubtitle:`Catalog from models.list.`", "modelsSubtitle:`来自 models.list 的模型目录。`"],
    ["eventLogTitle:`Event Log`", "eventLogTitle:`事件日志`"],
    ["eventLogSubtitle:`Latest gateway events.`", "eventLogSubtitle:`最新 Gateway 事件。`"],
    ["noEvents:`No events yet.`", "noEvents:`暂无事件。`"],
    ["browserEnabled:`Browser enabled`", "browserEnabled:`Browser 已启用`"],
    ["toolProfile:`Tool profile`", "toolProfile:`工具配置档`"],
    ["expiresIn:`expires in {time}`", "expiresIn:`{time} 后过期`"],
    ["expired:`expired`", "expired:`已过期`"],
    ["execApprovalNeeded:`Exec approval needed`", "execApprovalNeeded:`需要 Exec 审批`"],
    ["pluginApprovalNeeded:`Plugin approval needed`", "pluginApprovalNeeded:`需要插件审批`"],
    ["pending:`{count} pending`", "pending:`{count} 个待处理`"],
    ["allowOnce:`Allow once`", "allowOnce:`允许一次`"],
    ["alwaysAllow:`Always allow`", "alwaysAllow:`总是允许`"],
    [
      "allowAlwaysUnavailable:`The effective approval policy requires approval every time, so Allow Always is unavailable.`",
      "allowAlwaysUnavailable:`当前审批策略要求每次确认，因此“总是允许”不可用。`",
    ],
    ["deny:`Deny`", "deny:`拒绝`"],
    ["resolved:`Resolved`", "resolved:`已解析`"],
    ["severity:`Severity`", "severity:`严重级别`"],
    ["connectedSource:`Connected: {id}`", "connectedSource:`已连接：{id}`"],
    ["channelSource:`Channel: {id}`", "channelSource:`渠道：{id}`"],
    ["builtIn:`Built-in`", "builtIn:`内置`"],
    ["settings:`Settings`", "settings:`设置`"],
    ["expand:`Expand sidebar`", "expand:`展开侧栏`"],
    ["collapse:`Collapse sidebar`", "collapse:`收起侧栏`"],
    ["resize:`Resize sidebar`", "resize:`调整侧栏宽度`"],
    ["more:`More`", "more:`更多`"],
    ["customize:`Edit pinned items`", "customize:`编辑固定项`"],
    ["customizeReset:`Reset pinned items`", "customizeReset:`重置固定项`"],
    ["terminal:{title:`Terminal`", "terminal:{title:`终端`"],
    ["toggle:`Toggle terminal`", "toggle:`切换终端`"],
    ["open:`Open terminal`", "open:`打开终端`"],
    ["hide:`Hide terminal`", "hide:`隐藏终端`"],
    ["resize:`Resize terminal panel`", "resize:`调整终端面板大小`"],
    ["newSession:`New terminal session`", "newSession:`新建终端会话`"],
    ["closeSession:`Close terminal session`", "closeSession:`关闭终端会话`"],
    ["starting:`Starting terminal…`", "starting:`正在启动终端…`"],
    ["exited:`exited`", "exited:`已退出`"],
    ["exitedCode:`exited ({code})`", "exitedCode:`已退出 ({code})`"],
    ["detached:`detached`", "detached:`已分离`"],
    ["dockBottom:`Dock to bottom`", "dockBottom:`停靠底部`"],
    ["dockRight:`Dock to right`", "dockRight:`停靠右侧`"],
    ["unavailable:`The terminal is not available on this gateway.`", "unavailable:`当前 Gateway 不可用终端。`"],
    ["channels:`Channels`", "channels:`渠道`"],
    ["worktrees:`Worktrees`", "worktrees:`工作树`"],
    ["tabs:{agents:`Agents`", "tabs:{agents:`Agents`"],
    ["usage:`Usage`", "usage:`用量概览`"],
    ["usage:`用量`", "usage:`用量概览`"],
    ["usage:`使用情况`", "usage:`用量概览`"],
    ["usage:`API 使用情况和成本。`", "usage:`API 用量与成本。`"],
    ["skillWorkshop:{header:{useCurrentChat:`Use current chat`", "skillWorkshop:{header:{useCurrentChat:`使用当前聊天`"],
    ["useCurrentChatAria:`Use current chat for revision requests`", "useCurrentChatAria:`使用当前聊天发送修订请求`"],
    [
      "useCurrentChatTooltip:`Send revision requests to the current chat session instead of the proposal's workshop session.`",
      "useCurrentChatTooltip:`将修订请求发送到当前聊天会话，而不是提案的工坊会话。`",
    ],
    ["nav:{previousDay:`Previous day`", "nav:{previousDay:`前一天`"],
    ["nextDay:`Next day`", "nextDay:`后一天`"],
    ["today:`Today`", "today:`今天`"],
    ["capturing:`Capturing every {seconds}s`", "capturing:`每 {seconds}s 捕获一次`"],
    ["paused:`Capture paused`", "paused:`捕获已暂停`"],
    ["disabled:`Capture off`", "disabled:`捕获已关闭`"],
    ["nodeHelp:`Node providing screen snapshots.`", "nodeHelp:`提供屏幕快照的节点。`"],
    ["pending:`{count} frames queued`", "pending:`{count} 帧排队中`"],
    ["pendingHelp:`Snapshots waiting for the next analysis batch.`", "pendingHelp:`等待下一批分析的快照。`"],
    ["analyzing:`Analyzing…`", "analyzing:`分析中…`"],
    ["captureError:`Capture error`", "captureError:`捕获错误`"],
    ["batchError:`Analysis error`", "batchError:`分析错误`"],
    ["modelMissing:`No vision model`", "modelMissing:`缺少视觉模型`"],
    [
      "modelMissingHelp:`Set plugins.entries.logbook.config.visionModel (for example codex/gpt-5.5) or configure tools.media models.`",
      "modelMissingHelp:`设置 plugins.entries.logbook.config.visionModel，例如 codex/gpt-5.5，或配置 tools.media models。`",
    ],
    ["pause:`Pause`", "pause:`暂停`"],
    ["resume:`Resume`", "resume:`继续`"],
    ["analyzeNow:`Analyze now`", "analyzeNow:`立即分析`"],
    ["title:`Nothing on the timeline yet.`", "title:`时间线暂无内容。`"],
    [
      "subtitle:`Logbook is collecting snapshots; cards appear after the first analysis batch completes.`",
      "subtitle:`Logbook 正在收集快照；首批分析完成后会生成卡片。`",
    ],
    ["keyframeAlt:`Screen snapshot from this activity`", "keyframeAlt:`此活动的屏幕快照`"],
    ["distractions:`Distractions`", "distractions:`分心项`"],
    ["title:`Day at a glance`", "title:`今日概览`"],
    ["tracked:`{duration} tracked`", "tracked:`已跟踪 {duration}`"],
    ["title:`Daily standup`", "title:`每日站会`"],
    ["generate:`Generate`", "generate:`生成`"],
    ["refresh:`Regenerate`", "refresh:`重新生成`"],
    ["empty:`Turn today's timeline into a ready-to-paste standup update.`", "empty:`将今天的时间线转成可直接粘贴的站会更新。`"],
    ["title:`Ask your day`", "title:`询问今天`"],
    ["placeholder:`When did I review the gateway PR?`", "placeholder:`我什么时候 review 了 Gateway PR？`"],
    ["submit:`Ask`", "submit:`询问`"],
    ["detailUpdatedValue:`Updated: {time}`", "detailUpdatedValue:`更新：{time}`"],
    ["detailAutomationTenant:`Tenant: {tenant}`", "detailAutomationTenant:`Tenant：{tenant}`"],
    ["detailAutomationBoard:`Board: {board}`", "detailAutomationBoard:`Board：{board}`"],
    ["detailAutomationSkills:`Skills: {skills}`", "detailAutomationSkills:`Skills：{skills}`"],
    ["detailAutomationWorkspace:`Workspace: {workspace}`", "detailAutomationWorkspace:`Workspace：{workspace}`"],
    ["detailAutomationSummary:`Summary: {summary}`", "detailAutomationSummary:`摘要：{summary}`"],
    ["detailOperatorNotes:`Operator notes`", "detailOperatorNotes:`操作备注`"],
    ["detailNoNotes:`No operator notes yet.`", "detailNoNotes:`暂无操作备注。`"],
    ["detailNotePlaceholder:`Add a decision, blocker, or proof note...`", "detailNotePlaceholder:`添加决策、阻塞或凭证备注...`"],
    ["detailAddNote:`Add note`", "detailAddNote:`添加备注`"],
    ["openLinkedSession:`Open linked session`", "openLinkedSession:`打开关联会话`"],
    ["defaultAgent:`Default agent`", "defaultAgent:`默认 Agent`"],
    ["allAgents:`All agents`", "allAgents:`全部 Agents`"],
    ["agentFilter:`Filter by agent`", "agentFilter:`按 Agent 筛选`"],
    ["agentFilterUnassigned:`Unassigned (uses {agent})`", "agentFilterUnassigned:`未分配（使用 {agent}）`"],
    ["agentFilterUnassignedHelp:`Cards without an explicit agent.`", "agentFilterUnassignedHelp:`未显式指定 Agent 的卡片。`"],
    ["agentFilterConfiguredDefault:`{agent} (default)`", "agentFilterConfiguredDefault:`{agent}（默认）`"],
    ["viewPreset:`Workboard view`", "viewPreset:`Workboard 视图`"],
    ["viewAll:`All cards`", "viewAll:`全部卡片`"],
    ["viewDefaultAgent:`Default agent`", "viewDefaultAgent:`默认 Agent`"],
    ["viewReady:`Ready`", "viewReady:`就绪`"],
    ["viewRunning:`Running`", "viewRunning:`运行中`"],
    ["viewBlocked:`Blocked`", "viewBlocked:`阻塞`"],
    ["viewReview:`Review`", "viewReview:`复核`"],
    ["viewStale:`Stale`", "viewStale:`过期`"],
    ["viewMissingProof:`Missing proof`", "viewMissingProof:`缺少凭证`"],
    ["viewRecentlyDone:`Recently done`", "viewRecentlyDone:`最近完成`"],
    ["viewPresetCount:`{count} cards`", "viewPresetCount:`{count} 张卡片`"],
    ["agentLinked:`Linked to {agent}`", "agentLinked:`已关联到 {agent}`"],
    ["agentDefaultLinked:`Using default agent {agent}`", "agentDefaultLinked:`使用默认 Agent {agent}`"],
    ["usage:{common:{emptyValue:`—`,unknown:`unknown`}", "usage:{common:{emptyValue:`—`,unknown:`未知`}"],
    ["loading:{title:`Usage Overview`,badge:`Loading`}", "loading:{title:`用量概览`,badge:`加载中`}"],
    ["metrics:{tokens:`Tokens`,cost:`Cost`,session:`session`,sessions:`sessions`}", "metrics:{tokens:`Tokens`,cost:`成本`,session:`会话`,sessions:`会话`}"],
    ["providerUsage:{title:`Provider plans & billing`", "providerUsage:{title:`Provider 套餐与账单`"],
    ["providerUsage:{title:`供应商套餐与计费`", "providerUsage:{title:`Provider 套餐与账单`"],
    ["subtitle:`Live plan, quota, balance, and budget data reported by configured providers.`", "subtitle:`已配置 providers 返回的实时套餐、配额、余额与预算数据。`"],
    ["balance:`Balance`", "balance:`余额`"],
    ["spend:`Usage`", "spend:`用量`"],
    ["budget:`Budget`", "budget:`预算`"],
    ["today:`Today`", "today:`今天`"],
    ["last7Days:`7 days`", "last7Days:`7 天`"],
    ["lastDays:`{count} days`", "lastDays:`{count} 天`"],
    ["dailyCost:`Daily provider cost`", "dailyCost:`每日 provider 成本`"],
    ["requests:`{count} requests`", "requests:`{count} 次请求`"],
    ["inputTokens:`{count} input`", "inputTokens:`{count} 输入`"],
    ["cacheTokens:`{count} cache`", "cacheTokens:`{count} 缓存`"],
    ["outputTokens:`{count} output`", "outputTokens:`{count} 输出`"],
    ["topModels:`Top models`", "topModels:`高用量模型`"],
    ["costCategories:`Cost categories`", "costCategories:`成本分类`"],
    ["remaining:`{percent}% left`", "remaining:`剩余 {percent}%`"],
    ["resets:`Resets {date}`", "resets:`重置于 {date}`"],
    ["last30d:`30d`", "last30d:`30 天`"],
    ["last90d:`90d`", "last90d:`90 天`"],
    ["last1y:`1y`", "last1y:`1 年`"],
    ["all:`All`", "all:`全部`"],
    ["instance:`Current instance`", "instance:`当前实例`"],
    ["instanceHint:`Show only the active session id for each logical session.`", "instanceHint:`每个逻辑会话仅显示活跃 session id。`"],
    ["family:`Historical lineage`", "family:`历史谱系`"],
    ["familyHint:`Roll up known rotated transcript-backed session ids.`", "familyHint:`汇总已知轮换的 transcript-backed session ids。`"],
    ["familyIncluded:`Historical lineage includes {count} session instances.`", "familyIncluded:`历史谱系包含 {count} 个会话实例。`"],
    ["filters:{title:`Filters`", "filters:{title:`筛选`"],
    ["startDate:`Start date`", "startDate:`开始日期`"],
    ["endDate:`End date`", "endDate:`结束日期`"],
    ["timeZone:`Time zone`", "timeZone:`时区`"],
    ["timeZoneLocal:`Local`", "timeZoneLocal:`本地`"],
    ["timeZoneUtc:`UTC`", "timeZoneUtc:`UTC`"],
    ["pin:`Pin`", "pin:`固定`"],
    ["unpin:`Unpin filters`", "unpin:`取消固定筛选`"],
    ["selectAll:`Select All`", "selectAll:`全选`"],
    ["clearAll:`Clear All`", "clearAll:`清除全部`"],
    ["remove:`Remove filter`", "remove:`移除筛选`"],
    ["days:`Days`", "days:`天`"],
    ["hours:`Hours`", "hours:`小时`"],
    ["daysCount:`{count} days`", "daysCount:`{count} 天`"],
    ["hoursCount:`{count} hours`", "hoursCount:`{count} 小时`"],
    ["sessionsCount:`{count} sessions`", "sessionsCount:`{count} 个会话`"],
    ["placeholder:`Filter sessions (e.g. key:agent:main:cron* model:gpt-4o has:errors minTokens:2000)`", "placeholder:`筛选会话，例如 key:agent:main:cron* model:gpt-4o has:errors minTokens:2000`"],
    ["apply:`Filter (client-side)`", "apply:`筛选（本地）`"],
    ["matching:`{shown} of {total} sessions match`", "matching:`{shown} / {total} 个会话匹配`"],
    ["inRange:`{total} sessions in range`", "inRange:`范围内 {total} 个会话`"],
    ["tip:`Tip: use filters or click bars to refine days.`", "tip:`提示：使用筛选或点击柱状图细化日期。`"],
    ["export:{label:`Export`", "export:{label:`导出`"],
    ["sessionsCsv:`Sessions CSV`", "sessionsCsv:`会话 CSV`"],
    ["dailyCsv:`Daily CSV`", "dailyCsv:`每日 CSV`"],
    ["json:`JSON`", "json:`JSON`"],
    ["warning:`Usage cache is rebuilding in the background. Displayed totals may be stale.`", "warning:`用量缓存正在后台重建，显示总量可能滞后。`"],
    ["status:{refreshing:`refreshing`,stale:`stale`,partial:`partial`}", "status:{refreshing:`刷新中`,stale:`已过期`,partial:`部分可用`}"],
    ["empty:{title:`Start with a date range`", "empty:{title:`先选择日期范围`"],
    ["subtitle:`Load usage data to compare costs, inspect sessions, and drill into timelines without leaving the dashboard.`", "subtitle:`加载用量数据后，可比较成本、查看会话并下钻时间线。`"],
    ["hint:`Select a date range and click Refresh to load usage.`", "hint:`选择日期范围并点击刷新加载用量。`"],
    ["noData:`No data`", "noData:`暂无数据`"],
    ["featureOverview:`Overview cards`", "featureOverview:`概览卡片`"],
    ["featureSessions:`Session ranking`", "featureSessions:`会话排行`"],
    ["featureTimeline:`Timeline drilldown`", "featureTimeline:`时间线下钻`"],
    ["daily:{title:`Daily Usage`", "daily:{title:`每日用量`"],
    ["total:`Total`", "total:`总计`"],
    ["byType:`By Type`", "byType:`按类型`"],
    ["tokensTitle:`Daily Token Usage`", "tokensTitle:`每日 Token 用量`"],
    ["costTitle:`Daily Cost`", "costTitle:`每日成本`"],
    ["compressedScaleHint:`Square-root scale keeps low-usage days visible.`", "compressedScaleHint:`平方根比例让低用量日期也保持可见。`"],
    ["costWindows:{title:`Cost Windows`", "costWindows:{title:`成本窗口`"],
    ["subtitle:`Calendar windows ending {date}`", "subtitle:`截至 {date} 的日历窗口`"],
    ["selectedRange:`Selected Range`", "selectedRange:`已选范围`"],
    ["lastDays:`Last {count} days`", "lastDays:`最近 {count} 天`"],
    ["perDay:`/ day`", "perDay:`/ 天`"],
    ["breakdown:{output:`Output`,input:`Input`,cacheWrite:`Cache Write`,cacheRead:`Cache Read`,total:`Total`", "breakdown:{output:`输出`,input:`输入`,cacheWrite:`写入缓存`,cacheRead:`读取缓存`,total:`总计`"],
    ["tokensByType:`Tokens by Type`", "tokensByType:`按类型统计 Tokens`"],
    ["costByType:`Cost by Type`", "costByType:`按类型统计成本`"],
    ["overview:{title:`Usage Overview`", "overview:{title:`用量概览`"],
    ["overview:{title:`使用概览`", "overview:{title:`用量概览`"],
    ["messages:`Messages`", "messages:`消息`"],
    ["messagesHint:`Total user and assistant messages in range.`", "messagesHint:`范围内用户与助手消息总数。`"],
    ["messagesAbbrev:`msgs`", "messagesAbbrev:`消息`"],
    ["assistant:`assistant`", "assistant:`assistant`"],
    ["toolCalls:`Tool Calls`", "toolCalls:`工具调用`"],
    ["toolCallsHint:`Total tool call count across sessions.`", "toolCallsHint:`所有会话的工具调用总数。`"],
    ["toolsUsed:`tools used`", "toolsUsed:`个工具已使用`"],
    ["quickCreate:{schedules:{everyMorning:{label:`Every morning`", "quickCreate:{schedules:{everyMorning:{label:`每天早上`"],
    ["description:`Daily at 8:00 AM`", "description:`每天 8:00 AM`"],
    ["everyEvening:{label:`Every evening`", "everyEvening:{label:`每天晚上`"],
    ["description:`Daily at 6:00 PM`", "description:`每天 6:00 PM`"],
    ["hourly:{label:`Hourly`", "hourly:{label:`每小时`"],
    ["description:`Every hour`", "description:`每小时`"],
    ["weekdays:{label:`Weekdays`", "weekdays:{label:`工作日`"],
    ["description:`Mon–Fri at 9:00 AM`", "description:`周一至周五 9:00 AM`"],
    ["weekly:{label:`Weekly`", "weekly:{label:`每周`"],
    ["description:`Every Monday at 9:00 AM`", "description:`每周一 9:00 AM`"],
    ["once:{label:`Run once`", "once:{label:`运行一次`"],
    ["description:`One-time, delete after run`", "description:`一次性运行，结束后删除`"],
    ["notify:{label:`Notify me`", "notify:{label:`通知我`"],
    ["description:`Deliver results to chat`", "description:`将结果发送到聊天`"],
    ["silent:{label:`Silent`", "silent:{label:`静默`"],
    ["description:`Run without notification`", "description:`运行时不通知`"],
    ["isolated:{label:`Independent session`", "isolated:{label:`独立会话`"],
    ["description:`Run in its own session`", "description:`在独立会话中运行`"],
    ["steps:{what:`What`,when:`When`,how:`How`}", "steps:{what:`内容`,when:`时间`,how:`方式`}"],
    ["defaultName:`Automation`", "defaultName:`自动化`"],
    ["whatHeading:`What should it do?`", "whatHeading:`它应该做什么？`"],
    ["whatHint:`Describe the task in natural language. The agent will run this prompt each time.`", "whatHint:`用自然语言描述任务，Agent 每次都会运行此 prompt。`"],
    ["promptPlaceholder:`e.g., Check my inbox for urgent emails and summarize them...`", "promptPlaceholder:`例如，检查收件箱中的紧急邮件并总结...`"],
    ["nameOptional:`Name (optional)`", "nameOptional:`名称（可选）`"],
    ["namePlaceholder:`e.g., Morning inbox check`", "namePlaceholder:`例如，早间收件箱检查`"],
    ["whenHeading:`When should it run?`", "whenHeading:`什么时候运行？`"],
    ["whenHint:`Pick a schedule. You can fine-tune it later.`", "whenHint:`选择计划，稍后可细调。`"],
    ["howHeading:`How should it work?`", "howHeading:`如何运行？`"],
    ["howHint:`Choose how results are delivered.`", "howHint:`选择结果投递方式。`"],
    ["title:`New Cron Job`", "title:`新建定时任务`"],
    ["title:`新建自动化`", "title:`新建定时任务`"],
    ["summary:{enabled:`已启用`,yes:`是`,no:`否`,jobs:`Jobs`", "summary:{enabled:`已启用`,yes:`是`,no:`否`,jobs:`任务`"],
    ["nextWake:`Next wake`", "nextWake:`下次唤醒`"],
    ["refreshing:`Refreshing...`", "refreshing:`刷新中...`"],
    ["jobs:{title:`Jobs`", "jobs:{title:`任务`"],
    ["jobs:{title:`任务列表`", "jobs:{title:`任务`"],
    ["subtitle:`All scheduled jobs stored in the gateway.`", "subtitle:`Gateway 中存储的全部定时任务。`"],
    ["shownOf:`{shown} shown of {total}`", "shownOf:`显示 {shown} / {total}`"],
    ["searchJobs:`Search jobs`", "searchJobs:`搜索任务`"],
    ["searchPlaceholder:`Name, description, or agent`", "searchPlaceholder:`名称、描述或 Agent`"],
    ["schedule:`Schedule`", "schedule:`计划`"],
    ["lastRun:`Last run`", "lastRun:`上次运行`"],
    ["sort:`Sort`", "sort:`排序`"],
    ["nextRun:`Next run`", "nextRun:`下次运行`"],
    ["recentlyUpdated:`Recently updated`", "recentlyUpdated:`最近更新`"],
    ["direction:`Direction`", "direction:`方向`"],
    ["ascending:`Ascending`", "ascending:`升序`"],
    ["descending:`Descending`", "descending:`降序`"],
    ["emptyTitle:`No scheduled jobs yet.`", "emptyTitle:`暂无定时任务。`"],
    ["emptyHint:`Create one from a plain-language prompt; advanced fields can wait.`", "emptyHint:`可先用自然语言 prompt 创建，高级字段稍后再配。`"],
    ["emptyFilteredHint:`Clear or change filters to see scheduled jobs.`", "emptyFilteredHint:`清除或修改筛选以查看定时任务。`"],
    ["noMatching:`No matching jobs.`", "noMatching:`没有匹配任务。`"],
    ["loading:`Loading...`", "loading:`加载中...`"],
    ["loadMore:`Load more jobs`", "loadMore:`加载更多任务`"],
    ["runs:{title:`Run history`", "runs:{title:`运行历史`"],
    ["subtitleAll:`Latest runs across all jobs.`", "subtitleAll:`全部任务的最新运行记录。`"],
    ["subtitleJob:`Latest runs for {title}.`", "subtitleJob:`{title} 的最新运行记录。`"],
    ["scope:`Scope`", "scope:`范围`"],
    ["allJobs:`All jobs`", "allJobs:`全部任务`"],
    ["selectedJob:`Selected job`", "selectedJob:`已选任务`"],
    ["searchRuns:`Search runs`", "searchRuns:`搜索运行`"],
    ["searchPlaceholder:`Summary, error, or job`", "searchPlaceholder:`摘要、错误或任务`"],
    ["newestFirst:`Newest first`", "newestFirst:`最新优先`"],
    ["oldestFirst:`Oldest first`", "oldestFirst:`最早优先`"],
    ["delivery:`Delivery`", "delivery:`投递`"],
    ["allStatuses:`All statuses`", "allStatuses:`全部状态`"],
    ["allDelivery:`All delivery`", "allDelivery:`全部投递`"],
    ["selectJobHint:`Select a job to inspect run history.`", "selectJobHint:`选择任务以查看运行历史。`"],
    ["noMatching:`No matching runs.`", "noMatching:`没有匹配运行记录。`"],
    ["loadMore:`Load more runs`", "loadMore:`加载更多运行`"],
    ["runStatusOk:`OK`", "runStatusOk:`成功`"],
    ["runStatusError:`Error`", "runStatusError:`错误`"],
    ["runStatusSkipped:`Skipped`", "runStatusSkipped:`已跳过`"],
    ["runStatusUnknown:`Unknown`", "runStatusUnknown:`未知`"],
    ["deliveryDelivered:`Delivered`", "deliveryDelivered:`已投递`"],
    ["deliveryNotDelivered:`Not delivered`", "deliveryNotDelivered:`未投递`"],
    ["deliveryUnknown:`Unknown`", "deliveryUnknown:`未知`"],
    ["deliveryNotRequested:`Not requested`", "deliveryNotRequested:`未请求`"],
  ];

  for (const file of listAssetFiles(/^(?:i18n|zh-CN)-.*\.js$/, "base and zh-CN i18n")) {
    const before = read(file);
    const after = replacePairs(before, pairs);
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Localizes hard-coded SkillHub Workshop page copy not routed through the shared i18n bundle.
 */
function patchSkillWorkshopPageUiCopy() {
  const pairs = [
    [
      "k={all:`All`,pending:`Pending`,applied:`Applied`,rejected:`Rejected`,quarantined:`Quarantined`,stale:`Stale`}",
      "k={all:`全部`,pending:`待复核`,applied:`已应用`,rejected:`已拒绝`,quarantined:`已隔离`,stale:`已过期`}",
    ],
    ["M={today:`Today`,yesterday:`Yesterday`,earlier:`Earlier this week`}", "M={today:`今天`,yesterday:`昨天`,earlier:`本周早些时候`}"],
    ["title:`No matching proposals`", "title:`没有匹配提案`"],
    ["body:`Clear the search or try a different keyword.`", "body:`清除搜索或换一个关键词。`"],
    ["title:`No pending proposals`", "title:`暂无待复核提案`"],
    ["body:`New drafts will appear here when they need review.`", "body:`需要复核的新草稿会出现在这里。`"],
    ["title:`Nothing applied yet`", "title:`尚未应用提案`"],
    ["body:`Use a pending proposal and it will appear here as a live skill.`", "body:`应用待复核提案后，它会作为可用技能出现在这里。`"],
    ["title:`No rejected proposals`", "title:`暂无已拒绝提案`"],
    ["body:`Skipped proposals will stay here for a clean review history.`", "body:`跳过的提案会保留在这里，形成清晰复核记录。`"],
    ["title:`Nothing quarantined`", "title:`暂无隔离提案`"],
    ["body:`Scanner-blocked or safety-held proposals will appear here.`", "body:`扫描阻止或安全暂挂的提案会出现在这里。`"],
    ["title:`No stale proposals`", "title:`暂无过期提案`"],
    ["body:`Proposals that can no longer apply cleanly will appear here.`", "body:`无法干净应用的提案会出现在这里。`"],
    ["title:`No proposals here`", "title:`这里暂无提案`"],
    [
      "body:`Skill Workshop proposals will appear here when your agent drafts them.`",
      "body:`Agent 起草技能商店工坊提案后会出现在这里。`",
    ],
    ['aria-label="No Skill Workshop proposals"', 'aria-label="暂无技能商店工坊提案"'],
    ['<p class="sw-empty-state__eyebrow">Skill Workshop</p>', '<p class="sw-empty-state__eyebrow">技能商店工坊</p>'],
    ["<h2>No proposals yet</h2>", "<h2>暂无提案</h2>"],
    [
      "<p>${G(e,`Your agent`)} hasn't drafted any skill proposals.</p>",
      "<p>当前 Agent 尚未起草任何 技能商店提案。</p>",
    ],
    ["<p>${G(e,`你的 Agent`)} 尚未起草任何 技能商店提案。</p>", "<p>当前 Agent 尚未起草任何 技能商店提案。</p>"],
    [
      '<div class="sw-empty-state__footer">New proposals will appear here for review.</div>',
      '<div class="sw-empty-state__footer">新提案会出现在这里等待复核。</div>',
    ],
    ['<p class="sw-empty__title">Nothing waiting today</p>', '<p class="sw-empty__title">今天暂无待处理项</p>'],
    [
      "Your agent hasn't drafted anything new. Switch to Board to browse history.",
      "Agent 尚未起草新内容。切换到看板可浏览历史。",
    ],
    ["${n.length} proposals waiting", "${n.length} 个提案待复核"],
    ["Browse what's already applied.", "浏览已应用内容。"],
    ["<span>Board</span>", "<span>看板</span>"],
    ["<span>Today</span>", "<span>今日</span>"],
    ["`Could not load proposals.`", "`无法加载提案。`"],
    ["`Loading proposals…`", "`正在加载提案…`"],
    ["`No proposals match the current filter.`", "`没有提案符合当前筛选。`"],
    ["`No ${k[e.statusFilter].toLowerCase()} proposals.`", "`暂无${k[e.statusFilter]}提案。`"],
    ["`Skill Workshop is not ready.`", "`技能商店工坊尚未就绪。`"],
    [
      "`Could not prepare a Skill Workshop session.`",
      "`无法准备技能商店工坊会话。`",
    ],
    [
      "label:`Skill Workshop: ${n.slug||n.key}`.slice(0,80)",
      "label:`技能商店工坊：${n.slug||n.key}`.slice(0,80)",
    ],
    [
      "label:`SkillHub 工坊：${n.slug||n.key}`.slice(0,80)",
      "label:`技能商店工坊：${n.slug||n.key}`.slice(0,80)",
    ],
  ];

  for (const file of listAssetFiles(/^skill-workshop-page-.*\.js$/, "skill-workshop-page")) {
    const before = read(file);
    const after = replacePairs(before, pairs)
      .replaceAll("Agent 起草 SkillHub 工坊提案后会出现在这里。", "Agent 起草技能商店工坊提案后会出现在这里。")
      .replaceAll("暂无 SkillHub 工坊提案", "暂无技能商店工坊提案")
      .replaceAll("SkillHub 工坊", "技能商店工坊")
      .replaceAll("当前 Agent 尚未起草任何 SkillHub 提案。", "当前 Agent 尚未起草任何技能商店提案。")
      .replaceAll("无法准备 SkillHub 工坊会话。", "无法准备技能商店工坊会话。");
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Localizes deeper Agents and Chat defaults that surface inside expanded sub-panels.
 */
function patchDeepAgentsChatI18nUiCopy() {
  const pairs = [
    ["agents:{noAgents:`No agents`", "agents:{noAgents:`暂无 Agent`"],
    ["copyId:`Copy ID`", "copyId:`复制 ID`"],
    ["copyIdTitle:`Copy agent ID to clipboard`", "copyIdTitle:`复制 Agent ID 到剪贴板`"],
    ["setDefault:`Set Default`", "setDefault:`设为默认`"],
    ["alreadyDefaultTitle:`Already the default agent`", "alreadyDefaultTitle:`已是默认 Agent`"],
    ["setDefaultTitle:`Set as the default agent`", "setDefaultTitle:`设为默认 Agent`"],
    ["selectTitle:`Select an agent`", "selectTitle:`选择 Agent`"],
    ["selectSubtitle:`Pick an agent to inspect its workspace and tools.`", "selectSubtitle:`选择 Agent 以查看工作区与工具。`"],
    ["tabs:{overview:`概览`,files:`Files`,tools:`Tools`,skills:`技能商店`,channels:`渠道`,cronJobs:`Cron Jobs`}", "tabs:{overview:`概览`,files:`文件`,tools:`工具`,skills:`技能商店`,channels:`渠道`,cronJobs:`定时任务`}"],
    ["context:{title:`Agent Context`", "context:{title:`Agent 上下文`"],
    ["openFilesTab:`Open Files tab`", "openFilesTab:`打开文件 tab`"],
    ["primaryModel:`Primary Model`", "primaryModel:`主模型`"],
    ["thinkingDefault:`Thinking Default`", "thinkingDefault:`Thinking 默认值`"],
    ["identityName:`Identity Name`", "identityName:`身份名称`"],
    ["identityAvatar:`Identity Avatar`", "identityAvatar:`身份头像`"],
    ["skillsFilter:`Skills Filter`", "skillsFilter:`技能商店筛选`"],
    ["configurationSubtitle:`Workspace, identity, and model configuration.`", "configurationSubtitle:`工作区、身份与模型配置。`"],
    ["schedulingSubtitle:`Workspace and scheduling targets.`", "schedulingSubtitle:`工作区与定时任务目标。`"],
    ["channels:{title:`Channels`", "channels:{title:`渠道`"],
    ["subtitle:`Gateway-wide channel status snapshot.`", "subtitle:`Gateway 全局渠道状态快照。`"],
    ["lastRefresh:`Last refresh: {time}`", "lastRefresh:`上次刷新：{time}`"],
    ["loadHint:`Load channels to see live status.`", "loadHint:`加载渠道后查看实时状态。`"],
    ["empty:`No channels found.`", "empty:`暂无渠道。`"],
    ["connectedCount:`{connected}/{total} connected`", "connectedCount:`{connected}/{total} 已连接`"],
    ["noAccounts:`no accounts`", "noAccounts:`无账号`"],
    ["configuredCount:`{count} configured`", "configuredCount:`已配置 {count} 个`"],
    ["notConfigured:`not configured`", "notConfigured:`未配置`"],
    ["enabledCount:`{count} enabled`", "enabledCount:`已启用 {count} 个`"],
    ["setupGuide:`Setup guide`", "setupGuide:`设置指南`"],
    ["cronPanel:{schedulerTitle:`Scheduler`", "cronPanel:{schedulerTitle:`调度器`"],
    ["schedulerSubtitle:`Gateway cron status.`", "schedulerSubtitle:`Gateway 定时任务状态。`"],
    ["agentJobsTitle:`Agent Cron Jobs`", "agentJobsTitle:`Agent 定时任务`"],
    ["agentJobsSubtitle:`Scheduled jobs targeting this agent.`", "agentJobsSubtitle:`面向此 Agent 的定时任务。`"],
    ["noJobs:`No jobs assigned.`", "noJobs:`暂无分配任务。`"],
    ["runNow:`Run Now`", "runNow:`立即运行`"],
    ["files:{emptyDraft:`Empty draft`", "files:{emptyDraft:`空草稿`"],
    ["minRead:`{count} min read`", "minRead:`约 {count} 分钟阅读`"],
    ["markdownPreview:`Markdown Preview`", "markdownPreview:`Markdown 预览`"],
    ["extensionPreview:`{ext} Preview`", "extensionPreview:`{ext} 预览`"],
    ["expandPreview:`Expand preview`", "expandPreview:`展开预览`"],
    ["collapsePreview:`Collapse preview`", "collapsePreview:`收起预览`"],
    ["editFile:`Edit file`", "editFile:`编辑文件`"],
    ["closePreview:`Close preview`", "closePreview:`关闭预览`"],
    ["coreFilesTitle:`Core Files`", "coreFilesTitle:`核心文件`"],
    ["coreFilesSubtitle:`Bootstrap persona, identity, and tool guidance.`", "coreFilesSubtitle:`启动人格、身份与工具指引。`"],
    ["loadHint:`Load the agent workspace files to edit core instructions.`", "loadHint:`加载 Agent 工作区文件后可编辑核心指令。`"],
    ["empty:`No files found.`", "empty:`暂无文件。`"],
    ["selectFile:`Select a file to edit.`", "selectFile:`选择文件以编辑。`"],
    ["previewMarkdownTitle:`Preview rendered markdown`", "previewMarkdownTitle:`预览渲染后的 Markdown`"],
    ["willCreateOnSave:`Will Create on Save`", "willCreateOnSave:`保存时创建`"],
    ["liveDraftPreview:`Live Draft Preview`", "liveDraftPreview:`实时草稿预览`"],
    ["savedPreview:`Saved Preview`", "savedPreview:`已保存预览`"],
    ["updated:`Updated {time}`", "updated:`更新于 {time}`"],
    ["notCreatedYet:`Not Created Yet`", "notCreatedYet:`尚未创建`"],
    ["updatedUnknown:`Updated Unknown`", "updatedUnknown:`更新时间未知`"],
    ["missingHint:`This file is missing. Saving will create it in the agent workspace.`", "missingHint:`此文件缺失，保存后会在 Agent 工作区创建。`"],
    ["content:`Content`", "content:`内容`"],
    ["words:`{count} words`", "words:`{count} 字`"],
    ["lines:`lines`", "lines:`行`"],
    ["chat:{disconnected:`Disconnected from gateway.`", "chat:{disconnected:`Gateway 已断开。`"],
    ["archivedSessionDisabled:`Restore this session to send messages.`", "archivedSessionDisabled:`恢复此会话后才能发送消息。`"],
    ["refreshTitle:`Refresh chat data`", "refreshTitle:`刷新聊天数据`"],
    ["settings:`Chat settings`", "settings:`聊天设置`"],
    ["usageRemaining:`Usage Remaining`", "usageRemaining:`剩余额度`"],
    ["voiceSettings:`Voice`", "voiceSettings:`语音`"],
    ["thinkingToggle:`Toggle assistant thinking/working output`", "thinkingToggle:`切换助手思考/工作输出`"],
    ["toolCallsToggle:`Toggle tool calls and tool results`", "toolCallsToggle:`切换工具调用与结果`"],
    ["commentaryToggle:`Keep commentary after the final answer`", "commentaryToggle:`最终回答后保留 commentary`"],
    ["autoScrollMode:`Auto-scroll mode`", "autoScrollMode:`自动滚动模式`"],
    ["autoScrollAlways:`Always`", "autoScrollAlways:`始终`"],
    ["autoScrollNearBottom:`Near bottom`", "autoScrollNearBottom:`接近底部时`"],
    ["autoScrollOff:`Off`", "autoScrollOff:`关闭`"],
    ["sendShortcut:`Send shortcut`", "sendShortcut:`发送快捷键`"],
    ["hideCronSessions:`Hide cron sessions`", "hideCronSessions:`隐藏定时任务会话`"],
    ["showCronSessions:`Show cron sessions`", "showCronSessions:`显示定时任务会话`"],
    ["showCronSessionsHidden:`Show cron sessions ({count} hidden)`", "showCronSessionsHidden:`显示定时任务会话（已隐藏 {count} 个）`"],
    ["gatewayStatus:`Gateway status: {status}`", "gatewayStatus:`Gateway 状态：{status}`"],
    ["commandPaletteTitle:`Search or jump to… (⌘K)`", "commandPaletteTitle:`搜索或跳转… (⌘K)`"],
    ["openCommandPalette:`Open command palette`", "openCommandPalette:`打开命令面板`"],
    ["docsOpensInNewTab:`{label} (opens in new tab)`", "docsOpensInNewTab:`{label}（新标签页打开）`"],
    ["updateAvailable:`Update available:`", "updateAvailable:`发现更新：`"],
    ["runningVersion:`running v{version}`", "runningVersion:`当前 v{version}`"],
    ["updating:`Updating…`", "updating:`更新中…`"],
    ["updateNow:`Update now`", "updateNow:`立即更新`"],
    ["dismissUpdateBanner:`Dismiss update banner`", "dismissUpdateBanner:`关闭更新提示`"],
    ["switchedSession:`Switched to {session}`", "switchedSession:`已切换到 {session}`"],
    ["splitView:{open:`Open split view`", "splitView:{open:`打开分屏`"],
    ["splitRight:`Split right`", "splitRight:`右侧分屏`"],
    ["splitDown:`Split down`", "splitDown:`下方分屏`"],
    ["closePane:`Close pane`", "closePane:`关闭面板`"],
    ["sessionSelect:`Pane session`", "sessionSelect:`面板会话`"],
    ["dropOpenHere:`Open here`", "dropOpenHere:`在此打开`"],
    ["sidebar:{allSessions:`All sessions`", "sidebar:{allSessions:`全部会话`"],
    ["openSessionMenu:`Open session menu`", "openSessionMenu:`打开会话菜单`"],
    ["sortBy:`Sort by`", "sortBy:`排序方式`"],
    ["sortCreated:`Created`", "sortCreated:`创建时间`"],
    ["sortSessions:`Sort sessions`", "sortSessions:`会话排序`"],
    ["sortUpdated:`Last updated`", "sortUpdated:`最近更新`"],
    ["sessionMenu:`Actions for {session}`", "sessionMenu:`{session} 操作`"],
    ["welcome:{ready:`Ready to chat`", "welcome:{ready:`U-Claw 已就绪`"],
    ["hintBeforeShortcut:`Type a message below ·`", "hintBeforeShortcut:`在下方输入消息 ·`"],
    ["hintAfterShortcut:`for commands`", "hintAfterShortcut:`查看命令`"],
    ["whatCanYouDo:`What can you do?`", "whatCanYouDo:`你能做什么？`"],
    ["summarizeRecentSessions:`Summarize my recent sessions`", "summarizeRecentSessions:`总结最近会话`"],
    ["configureChannel:`Help me configure a channel`", "configureChannel:`帮我配置渠道`"],
    ["checkSystemHealth:`Check system health`", "checkSystemHealth:`检查系统健康`"],
    ["runControls:{newSession:`New session`", "runControls:{newSession:`新会话`"],
    ["newSessionWorktree:`New chat in worktree`", "newSessionWorktree:`在 worktree 中新建聊天`"],
    ["exportChat:`Export chat`", "exportChat:`导出聊天`"],
    ["queueMessage:`Queue message`", "queueMessage:`排队消息`"],
    ["stopGenerating:`Stop generating`", "stopGenerating:`停止生成`"],
    ["sendMessage:`Send message`", "sendMessage:`发送消息`"],
    ["retrySend:`Retry send`", "retrySend:`重试发送`"],
    ["retryQueuedMessage:`Retry queued message`", "retryQueuedMessage:`重试排队消息`"],
    ["modelPicker:{discard:`Discard`", "modelPicker:{discard:`丢弃`"],
    ["faster:`Faster`", "faster:`更快`"],
    ["smarter:`Smarter`", "smarter:`更强`"],
    ["useDefaultModel:`Use default model`", "useDefaultModel:`使用默认模型`"],
    ["pairingQrExpired:{title:`Pairing QR expired`", "pairingQrExpired:{title:`配对二维码已过期`"],
    ["reason:`Run /pair qr again to generate a fresh setup code.`", "reason:`再次运行 /pair qr 生成新的设置码。`"],
    ["badge:`Expired`", "badge:`已过期`"],
    ["composer:{placeholder:`Message {name}`", "composer:{placeholder:`给 {name} 发消息`"],
    ["placeholderWithAttachments:`Add a message or paste more images...`", "placeholderWithAttachments:`输入消息或继续粘贴图片...`"],
    ["placeholderDisconnected:`Connect to the gateway to start chatting...`", "placeholderDisconnected:`连接 Gateway 后开始聊天...`"],
    ["addAttachment:`Add attachment`", "addAttachment:`添加附件`"],
    ["attachPhoto:`Photo`", "attachPhoto:`照片`"],
    ["attachFile:`Attach file`", "attachFile:`附加文件`"],
    ["attachFileOption:`File`", "attachFileOption:`文件`"],
    ["contextUsage:{title:`Context usage details`", "contextUsage:{title:`上下文用量详情`"],
    ["open:`Open context usage details`", "open:`打开上下文用量详情`"],
    ["summary:`Session context usage: {used} of {limit} ({pct}%)`", "summary:`会话上下文用量：{used} / {limit} ({pct}%)`"],
    ["contextWindow:`Context window`", "contextWindow:`上下文窗口`"],
    ["latestRunTokens:`Latest run tokens`", "latestRunTokens:`最近运行 tokens`"],
    ["estimatedCost:`Est. cost`", "estimatedCost:`预估成本`"],
    ["takePhoto:`Take photo`", "takePhoto:`拍照`"],
    ["dismissVoiceInputError:`Dismiss voice input error`", "dismissVoiceInputError:`关闭语音输入错误`"],
    ["loadingMicrophones:`Loading microphones…`", "loadingMicrophones:`正在加载麦克风…`"],
    ["microphoneAccessFailed:`Unable to access microphone inputs.`", "microphoneAccessFailed:`无法访问麦克风输入。`"],
    ["microphoneBusy:`Microphone inputs are busy or unavailable to the browser.`", "microphoneBusy:`麦克风正忙或浏览器不可用。`"],
    ["microphoneFallback:`Microphone {number}`", "microphoneFallback:`麦克风 {number}`"],
    ["microphoneInput:`Microphone input`", "microphoneInput:`麦克风输入`"],
    ["microphoneListUnsupported:`This browser cannot list microphone inputs.`", "microphoneListUnsupported:`此浏览器无法列出麦克风输入。`"],
    ["noMicrophones:`No additional microphones found`", "noMicrophones:`未找到其他麦克风`"],
    ["microphoneNoneFound:`No microphone inputs were found.`", "microphoneNoneFound:`未找到麦克风输入。`"],
    ["microphonePageInactive:`Microphone inputs are unavailable while this page is inactive.`", "microphonePageInactive:`页面未激活时麦克风不可用。`"],
    ["microphonePermissionBlocked:`Microphone access is blocked. Allow it in browser site settings to list inputs.`", "microphonePermissionBlocked:`麦克风访问被阻止，请在浏览器站点设置中允许。`"],
    ["realtimeTalkRequiresMicrophone:`Realtime voice input requires browser microphone access.`", "realtimeTalkRequiresMicrophone:`实时语音输入需要浏览器麦克风权限。`"],
    ["selectedMicrophoneUnavailable:`The selected microphone is unavailable. Choose another input or System default.`", "selectedMicrophoneUnavailable:`所选麦克风不可用，请选择其他输入或系统默认。`"],
    ["startVoiceInput:`Start voice input`", "startVoiceInput:`开始语音输入`"],
    ["stillListening:`Still listening`", "stillListening:`仍在聆听`"],
    ["stopVoiceInput:`Stop voice input`", "stopVoiceInput:`停止语音输入`"],
    ["systemDefaultMicrophone:`System default`", "systemDefaultMicrophone:`系统默认`"],
    ["talkAdvancedSettingsRequiresAdmin:`Advanced settings require admin`", "talkAdvancedSettingsRequiresAdmin:`高级设置需要管理员权限`"],
    ["talkAdvancedSettingsRequiresAdminTitle:`Advanced Talk settings require operator.admin access.`", "talkAdvancedSettingsRequiresAdminTitle:`高级语音设置需要 operator.admin 权限。`"],
    ["talkDefault:`Default`", "talkDefault:`默认`"],
    ["talkModel:`Model`", "talkModel:`模型`"],
    ["talkModelAuto:`Auto`", "talkModelAuto:`自动`"],
    ["talkMoreInSettings:`More in Settings`", "talkMoreInSettings:`更多设置`"],
    ["talkSensitivity:`Sensitivity`", "talkSensitivity:`灵敏度`"],
    ["talkSensitivityHigh:`High`", "talkSensitivityHigh:`高`"],
    ["talkSensitivityLow:`Low`", "talkSensitivityLow:`低`"],
    ["talkSensitivityMedium:`Medium`", "talkSensitivityMedium:`中`"],
    ["talkVoice:`Voice`", "talkVoice:`语音`"],
    ["voiceOptions:`Voice options`", "voiceOptions:`语音选项`"],
    ["voiceTranscript:`Voice transcript`", "voiceTranscript:`语音转写`"],
    ["selectors:{agentFilter:`Filter sessions by agent`", "selectors:{agentFilter:`按 Agent 筛选会话`"],
    ["session:`Chat session`", "session:`聊天会话`"],
    ["sessionSearch:`Search sessions`", "sessionSearch:`搜索会话`"],
    ["clearSessionSearch:`Clear session search`", "clearSessionSearch:`清除会话搜索`"],
    ["loadMoreSessions:`Load more sessions`", "loadMoreSessions:`加载更多会话`"],
    ["model:`Chat model`", "model:`聊天模型`"],
    ["thinkingLevel:`Chat thinking level`", "thinkingLevel:`聊天 thinking 级别`"],
    ["workspaceFiles:{label:`Session workspace`", "workspaceFiles:{label:`会话工作区`"],
    ["expand:`Expand session workspace`", "expand:`展开会话工作区`"],
    ["collapse:`Collapse session workspace`", "collapse:`收起会话工作区`"],
    ["workspace:`Session`", "workspace:`会话`"],
    ["files:`Workspace`", "files:`工作区`"],
    ["refresh:`Refresh session workspace`", "refresh:`刷新会话工作区`"],
    ["loading:`Loading session workspace…`", "loading:`正在加载会话工作区…`"],
    ["empty:`No files touched in this session yet`", "empty:`此会话尚未触碰文件`"],
    ["changed:`Changed`", "changed:`已改动`"],
    ["read:`Read`", "read:`已读取`"],
    ["artifacts:`Artifacts`", "artifacts:`产物`"],
    ["browser:`Project files`", "browser:`项目文件`"],
    ["path:`Workspace path`", "path:`工作区路径`"],
    ["root:`Root`", "root:`根目录`"],
    ["search:`Search files`", "search:`搜索文件`"],
    ["searchResults:`Search results`", "searchResults:`搜索结果`"],
    ["parentFolder:`Parent folder`", "parentFolder:`上级文件夹`"],
    ["noBrowserFiles:`No files in this folder.`", "noBrowserFiles:`此文件夹暂无文件。`"],
    ["noSearchResults:`No matching files.`", "noSearchResults:`没有匹配文件。`"],
    ["truncated:`Showing the first matching files. Refine the search to narrow results.`", "truncated:`仅显示首批匹配文件，请细化搜索以缩小范围。`"],
    ["summary:`Session workspace summary`", "summary:`会话工作区摘要`"],
    ["changedCount:`{count} changed`", "changedCount:`{count} 个已改动`"],
    ["readCount:`{count} read`", "readCount:`{count} 个已读取`"],
    ["artifactCount:`{count} artifacts`", "artifactCount:`{count} 个产物`"],
    ["browserCount:`{count} shown`", "browserCount:`显示 {count} 个`"],
    ["actions:`Workspace file actions`", "actions:`工作区文件操作`"],
    ["copyPath:`Copy path`", "copyPath:`复制路径`"],
  ];

  for (const file of listAssetFiles(/^(?:i18n|zh-CN)-.*\.js$/, "i18n and zh-CN locale")) {
    const before = read(file);
    const after = replacePairs(before, pairs);
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Localizes Overview attention items that are visible on the first operational page.
 */
function patchOverviewPageUiCopy() {
  const pairs = [
    ["title:`Gateway Error`", "title:`Gateway 错误`"],
    ["title:`Missing operator.read scope`", "title:`缺少 operator.read 权限`"],
    [
      "description:`This connection does not have the operator.read scope. Some features may be unavailable.`",
      "description:`当前连接缺少 operator.read scope，部分能力可能不可用。`",
    ],
    ["title:`Skills with missing dependencies`", "title:`技能缺少依赖`"],
    ["` +${i.length-3} more`", "` +${i.length-3} 项`"],
    ["`${a.length} skill${a.length===1?``:`s`} blocked`", "`${a.length} 个技能被阻止`"],
    ["`${o.length} cron job${o.length===1?``:`s`} failed`", "`${o.length} 个定时任务失败`"],
    ["`${c.length} overdue job${c.length===1?``:`s`}`", "`${c.length} 个任务已逾期`"],
  ];

  for (const file of listAssetFiles(/^overview-page-.*\.js$/, "overview-page")) {
    const before = read(file);
    const after = replacePairs(before, pairs);
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Rebrands the static shell HTML shown before the UI bundle mounts.
 */
function patchControlUiHtmlBranding() {
  if (!fs.existsSync(indexHtmlPath)) {
    throw new Error(`Missing OpenClaw control-ui HTML: ${indexHtmlPath}`);
  }

  const pairs = [
    ["<title>OpenClaw Control</title>", "<title>U-Claw Control</title>"],
    ["OpenClaw Control UI", "U-Claw Control UI"],
    ["Control UI did not start", "U-Claw 界面未启动"],
    [
      "The browser loaded the static page, but the app bundle did not start. The gateway may be\n          restarting, or this page may reference assets from a different OpenClaw version.",
      "浏览器已加载静态页面，但界面资源尚未启动。Gateway 可能正在重启，或页面仍引用旧版资源。",
    ],
    ["OpenClaw will retry the current app bundle automatically.", "U-Claw 会自动重试当前界面资源。"],
    ["If this persists, reload or try a clean browser profile.", "若持续出现，请刷新页面或使用干净的浏览器配置。"],
    ["Control UI troubleshooting", "界面故障排查"],
    ["\n            See\n            <a", "\n            查看\n            <a"],
    [">.\n          </li>", ">。\n          </li>"],
    ["Try again", "重试"],
    ["Keep waiting", "继续等待"],
    [
      "The gateway is still unavailable. Try again, then check the troubleshooting guide if the problem persists.",
      "Gateway 仍不可用。请重试；若仍失败，请查看故障排查。",
    ],
    [
      "The gateway is still unavailable. 重试, then check the troubleshooting guide if the problem persists.",
      "Gateway 仍不可用。请重试；若仍失败，请查看故障排查。",
    ],
    [
      "The gateway is not reachable yet. OpenClaw will keep retrying while it restarts.",
      "Gateway 暂不可达。U-Claw 会在重启期间持续重试。",
    ],
    [
      "A fresh page still could not start the Control UI. Try again, then check the troubleshooting guide if the problem persists.",
      "刷新后的页面仍无法启动界面。请重试；若仍失败，请查看故障排查。",
    ],
  ];

  const before = read(indexHtmlPath);
  const after = replacePairs(before, pairs);
  if (writeIfChanged(indexHtmlPath, before, after)) {
    console.log(`patched ${path.relative(root, indexHtmlPath)}`);
  }
}

/**
 * Rebrands PWA/install metadata without touching Gateway runtime names.
 */
function patchControlUiManifestBranding() {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing OpenClaw control-ui manifest: ${manifestPath}`);
  }

  const before = read(manifestPath);
  const manifest = JSON.parse(before);
  manifest.name = "U-Claw Control";
  manifest.short_name = "U-Claw";
  manifest.description = "U-Claw Control UI";
  const after = `${JSON.stringify(manifest, null, 2)}\n`;
  if (writeIfChanged(manifestPath, before, after)) {
    console.log(`patched ${path.relative(root, manifestPath)}`);
  }
}

/**
 * Rebrands visible shell chrome without renaming OpenClaw runtime identifiers.
 */
function patchControlUiShellBranding() {
  const pairs = [
    ["<span class=\"sidebar-brand__title\">OpenClaw</span>", "<span class=\"sidebar-brand__title\">U-Claw</span>"],
    ["<span class=\"dashboard-header__breadcrumb-link\">OpenClaw</span>", "<span class=\"dashboard-header__breadcrumb-link\">U-Claw</span>"],
    ["                  OpenClaw\n                </a>", "                  U-Claw\n                </a>"],
    ["alt=\"OpenClaw\"", "alt=\"U-Claw\""],
    ["aria-label=\"OpenClaw\"", "aria-label=\"U-Claw\""],
    ["<span class=\"topbar-brand__title\">OpenClaw</span>", "<span class=\"topbar-brand__title\">U-Claw</span>"],
    ["<div class=\"login-gate__title\">OpenClaw</div>", "<div class=\"login-gate__title\">U-Claw</div>"],
  ];

  for (const file of listAssetFiles(/^index-.*\.js$/, "index js")) {
    const before = read(file);
    const after = replacePairs(before, pairs);
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Adds a fixed same-origin SkillHub list proxy for browser CORS and icon loading.
 */
function patchControlUiSkillHubProxy() {
  if (!fs.existsSync(controlUiGatewayPath)) {
    throw new Error(`Missing Control UI gateway asset: ${controlUiGatewayPath}`);
  }

  const before = read(controlUiGatewayPath);
  let after = before.replace(
    '"img-src \'self\' data: blob:",',
    '"img-src \'self\' data: blob: https:",',
  );

  const helper = `const UCLAW_SKILLHUB_PROXY_PATH = "/__uclaw__/skillhub/skills";
const UCLAW_SKILLHUB_API_ORIGIN = "https://api.skillhub.cn";
const UCLAW_SKILLHUB_API_PATH = "/api/skills";
const UCLAW_SKILLHUB_SORTS = new Set(["score", "downloads", "stars"]);
function clampUcSkillHubInt(value, fallback, min, max) {
\tconst number = Number(value);
\tif (!Number.isFinite(number)) return fallback;
\treturn Math.min(max, Math.max(min, Math.trunc(number)));
}
function buildUcSkillHubApiUrl(source) {
\tconst target = new URL(UCLAW_SKILLHUB_API_PATH, UCLAW_SKILLHUB_API_ORIGIN);
\ttarget.searchParams.set("page", String(clampUcSkillHubInt(source.searchParams.get("page"), 1, 1, 100000)));
\ttarget.searchParams.set("pageSize", String(clampUcSkillHubInt(source.searchParams.get("pageSize"), 24, 1, 50)));
\tconst sortBy = source.searchParams.get("sortBy") || "score";
\ttarget.searchParams.set("sortBy", UCLAW_SKILLHUB_SORTS.has(sortBy) ? sortBy : "score");
\ttarget.searchParams.set("order", source.searchParams.get("order") === "asc" ? "asc" : "desc");
\tconst keyword = source.searchParams.get("keyword")?.trim() || source.searchParams.get("q")?.trim();
\tif (keyword) target.searchParams.set("keyword", keyword.slice(0, 120));
\tfor (const key of ["category", "apiKey"]) {
\t\tconst value = source.searchParams.get(key)?.trim();
\t\tif (value) target.searchParams.set(key, value.slice(0, 120));
\t}
\treturn target;
}
async function handleUcSkillHubSkillsProxyRequest(req, res) {
\tconst urlRaw = req.url;
\tif (!urlRaw || !isReadHttpMethod(req.method)) return false;
\tconst url = new URL(urlRaw, "http://localhost");
\tif (url.pathname !== UCLAW_SKILLHUB_PROXY_PATH) return false;
\tconst target = buildUcSkillHubApiUrl(url);
\tres.setHeader("Content-Type", "application/json; charset=utf-8");
\tres.setHeader("Cache-Control", "no-cache");
\tif (req.method === "HEAD") {
\t\tres.statusCode = 200;
\t\tres.end();
\t\treturn true;
\t}
\ttry {
\t\tconst response = await fetch(target, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
\t\tconst body = await response.text();
\t\tres.statusCode = response.ok ? 200 : 502;
\t\tres.end(body);
\t} catch (error) {
\t\tres.statusCode = 502;
\t\tres.end(JSON.stringify({ code: 1, message: error instanceof Error ? error.message : String(error), data: { skills: [], total: 0 } }));
\t}
\treturn true;
}
`;

  if (!after.includes("handleUcSkillHubSkillsProxyRequest")) {
    after = after.replace(
      "async function handleControlUiHttpRequest(req, res, opts) {",
      `${helper}async function handleControlUiHttpRequest(req, res, opts) {`,
    );
  }
  after = after.replace('for (const key of ["q", "category", "apiKey"]) {', 'for (const key of ["category", "apiKey"]) {');
  after = after.replace('for (const key of ["q", "category"]) {', 'for (const key of ["category", "apiKey"]) {');
  after = after.replace('for (const key of ["q"]) {', 'for (const key of ["category", "apiKey"]) {');
  if (!after.includes('target.searchParams.set("keyword", keyword.slice(0, 120));')) {
    after = after.replace(
      '\ttarget.searchParams.set("order", source.searchParams.get("order") === "asc" ? "asc" : "desc");\n\tfor (const key of ["category", "apiKey"]) {',
      '\ttarget.searchParams.set("order", source.searchParams.get("order") === "asc" ? "asc" : "desc");\n\tconst keyword = source.searchParams.get("keyword")?.trim() || source.searchParams.get("q")?.trim();\n\tif (keyword) target.searchParams.set("keyword", keyword.slice(0, 120));\n\tfor (const key of ["category", "apiKey"]) {',
    );
  }

  after = after.replace(
    "async function handleControlUiHttpRequest(req, res, opts) {\n\tconst urlRaw = req.url;",
    "async function handleControlUiHttpRequest(req, res, opts) {\n\tif (await handleUcSkillHubSkillsProxyRequest(req, res)) return true;\n\tconst urlRaw = req.url;",
  );

  if (!after.includes("UCLAW_SKILLHUB_PROXY_PATH") || !after.includes("https://api.skillhub.cn")) {
    throw new Error(`Could not patch SkillHub proxy in ${controlUiGatewayPath}`);
  }

  if (writeIfChanged(controlUiGatewayPath, before, after)) {
    console.log(`patched ${path.relative(root, controlUiGatewayPath)}`);
  }
}

/**
 * Finds generated OpenClaw Skills page assets so each patch targets the same bundle set.
 */
function listSkillsPageAssets() {
  return listAssetFiles(/^skills-page-.*\.js$/, "skills-page");
}

/**
 * Applies U-Claw user-facing naming while preserving OpenClaw's ClawHub runtime calls.
 */
function patchSkillsPageBranding() {
  for (const file of listSkillsPageAssets()) {
    const before = read(file);
  const after = before
      .replaceAll(">技能商店<", ">技能商店<")
      .replaceAll(">SkillHub<", ">技能商店<")
      .replaceAll("ClawHub link invalid", "技能商店链接无效")
      .replaceAll("SkillHub 链接无效", "技能商店链接无效")
      .replaceAll("Search ClawHub skills…", "搜索技能商店技能…")
      .replaceAll("技能商店暂无匹配技能。", "技能商店暂无匹配技能。");

    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Hides bundled OpenClaw skills from the user-facing list without changing Gateway data.
 */
function patchSkillsPageBundledVisibility() {
  const original = "function K(e){let t=e.report?.skills??[],n=";
  const patched =
    "function K(e){let t=(e.report?.skills??[]).filter(e=>!(e?.source===`openclaw-bundled`||e?.bundled===!0)),n=";

  for (const file of listSkillsPageAssets()) {
    const before = read(file);
    const after = before.replace(original, patched);
    if (after === before && !before.includes(patched)) {
      if (path.basename(file).startsWith("index-")) {
        continue;
      }
      throw new Error(`Could not patch bundled skills visibility in ${file}`);
    }

    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Localizes user-facing Skills page copy without changing ClawHub runtime calls.
 */
function patchSkillsPageUiCopy() {
  const recoveryPairs = [
    ["onDetail关闭", "onDetailClose"],
    ["onClawHubDetail关闭", "onClawHubDetailClose"],
    ["<div class=\"card-title\">技能</div>", "<div class=\"card-title\">技能库</div>"],
    ["搜索、安装技能商店技能，并管理已安装项。", "发现更懂你的专家技能，并管理已安装项。"],
    ["从技能商店检索新技能", "让 AI 从通用走向专用"],
    ["已安装技能及其当前状态。", "发现更懂你的专家技能，并管理已安装项。"],
    ["从技能商店检索并安装技能", "让 AI 从通用走向专用"],
    ["未找到技能。", "暂无已安装技能商店技能。"],
    ["暂无已安装 SkillHub 技能。", "暂无已安装技能商店技能。"],
  ];
  const pairs = [
    ["label:`All`", "label:`全部`"],
    ["label:`Ready`", "label:`可用`"],
    ["label:`Needs Setup`", "label:`需配置`"],
    ["label:`Disabled`", "label:`已停用`"],
    ["<div class=\"card-title\">Skills</div>", "<div class=\"card-title\">技能库</div>"],
    ["Installed skills and their status.", "发现更懂你的专家技能，并管理已安装项。"],
    ["Search and install skills from the registry", "让 AI 从通用走向专用"],
    ["Acknowledge risk and install", "确认风险并安装"],
    ["Refreshing…", "刷新中…"],
    ["Full security report", "完整安全报告"],
    ["Loading Skill Card...", "正在加载 Skill Card..."],
    ["Skill Card not loaded.", "Skill Card 未加载。"],
    ["`Install ${t.skill.displayName}`", "`安装 ${t.skill.displayName}`"],
    ["Skill not found.", "未找到技能。"],
    ["SkillHub 详情暂不可用。", "技能商店详情暂不可用。"],
    ["兼容模式：请重启 U-Claw 以启用完整技能商店分页。", "兼容模式：请重启 U-Claw 以启用完整技能商店分页。"],
    ["\n                          By\n", "\n                          作者：\n"],
    ["`${n} (default)`", "`${n} (默认)`"],
    ["placeholder=\"Filter installed skills\"", "placeholder=\"筛选已安装技能\""],
    ["${u.length} shown", "${u.length} 项"],
    ["Searching…", "搜索中…"],
    [
      "${e.clawhubSearchLoading?a`<span class=\"muted\">搜索中…</span>`:o}",
      "${e.clawhubSearchLoading?a`<span class=\"muted\">正在检索技能商店…</span>`:a`<span class=\"chip\">远程检索</span>`}",
    ],
    [
      "${e.clawhubSearchError}",
      "${UcSkillHubErrorText(e.clawhubSearchError)}",
    ],
    ["Not connected to gateway.", "尚未连接 Gateway。"],
    ["No skills found.", "暂无已安装技能商店技能。"],
    ["`Unavailable`", "`不可用`"],
    ["`Clean`", "`安全`"],
    ["`Pending`", "`待检测`"],
    ["`Blocked`", "`已阻止`"],
    ["`Review`", "`需复核`"],
    ["`Installing…`", "`安装中…`"],
    ["`Install`", "`安装`"],
    ["\n            Close\n", "\n            关闭\n"],
    ["Latest: v", "最新版本：v"],
    ["Platforms: ", "平台："],
    ["Overview", "概览"],
    ["Missing requirements", "缺少必要条件"],
    ["Reason: ", "原因："],
    ["Missing: ", "缺少："],
    ['<div class="list-sub">${w(e.description,140)}</div>', '<div class="list-sub">${w(UcSkillHubDisplayText(e.description),140)}</div>'],
    ["${e.description}", "${UcSkillHubDisplayText(e.description)}"],
    ["`Disabled`", "`已停用`"],
    ["`Enabled`", "`已启用`"],
  ];

  for (const file of listSkillsPageAssets()) {
    const before = read(file);
    const recovered = replacePairs(before, recoveryPairs);
    const after = replacePairs(recovered, pairs);
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Enriches SkillHub marketplace cards using fields already returned by OpenClaw.
 */
function patchSkillsPageStoreDiscovery() {
  const patched = [
    "function UcSkillHubSceneQueryMap(){return{all:``,office:`productivity automation docs office`,content:`content writing copy`,coding:`coding developer github`,data:`data analytics sheet`,design:`design image video`,agent:`agent assistant browser`,knowledge:`knowledge research search`,business:`business sales marketing`,education:`education learn course`,industry:`legal medical finance`,itops:`security devops server`,life:`travel weather service`}}",
    "function UcSkillHubApiCategoryMap(){return{office:`office-efficiency`,content:`content-creation`,coding:`dev-programming`,data:`data-analysis`,design:`design-multimedia`,knowledge:`knowledge-management`,business:`business-operations`,education:`education-learning`,industry:`industry-professional`,itops:`it-ops-security`,life:`life-service`}}",
    "function UcSkillHubApiSort(e){return e===`downloads`?{sortBy:`downloads`,order:`desc`}:e===`stars`?{sortBy:`stars`,order:`desc`}:e===`name`?{sortBy:`score`,order:`desc`}:{sortBy:`score`,order:`desc`}}",
    "function UcSkillHubApiQuery(e){let t=e.clawhubQuery?.trim?.()||e.clawhubSearchQuery?.trim?.()||``,n=e.skillHubApiKeyFilter===`needs-key`?`api key configuration`:e.skillHubApiKeyFilter===`configured`?`verified official`:``;return[t,n].filter(Boolean).join(` `).trim()}",
    "function UcSkillHubApiCategory(e){let t=e.skillHubCategory||`all`;return t===`all`?``:UcSkillHubApiCategoryMap()[t]||t}",
    "function UcSkillHubApiUrl(e,t){let n=UcSkillHubApiSort(e.skillHubSort),r=new URL(`/__uclaw__/skillhub/skills`,window.location.origin);r.searchParams.set(`page`,String(Math.max(1,Number(t)||1))),r.searchParams.set(`pageSize`,String(e.skillHubPageSize||24)),r.searchParams.set(`sortBy`,n.sortBy),r.searchParams.set(`order`,n.order);let i=UcSkillHubApiQuery(e),s=UcSkillHubApiCategory(e);return i&&r.searchParams.set(`keyword`,i),s&&r.searchParams.set(`category`,s),e.skillHubApiKeyFilter&&r.searchParams.set(`apiKey`,e.skillHubApiKeyFilter),r.toString()}",
    "async function UcSkillHubLoadApiSkills(e,t){let n=await fetch(UcSkillHubApiUrl(e,t),{headers:{Accept:`application/json`}}),r=await n.text(),i=n.headers.get(`content-type`)||``;if(!i.includes(`application/json`))throw Error(`技能商店 Gateway 代理未生效，请重启 U-Claw 后重试。`);let s=JSON.parse(r);if(!n.ok||s?.code&&s.code!==0)throw Error(s?.message||`技能商店 API ${n.status}`);let c=Array.isArray(s?.data?.skills)?s.data.skills:[],l=c.map(UcSkillHubNormalizeApiSkill);return{items:l,total:Math.max(0,Number(s?.data?.total)||l.length),message:l.length?`第 ${t} 页已加载`:t>1?`本页暂无数据，可返回上一页。`:`暂无匹配技能商店技能。`,compat:!1}}",
    "async function UcSkillHubFallbackSkillsSearch(e,t,n){let r=e.client;if(!r?.request)throw n;let i=UcSkillHubApiQuery(e)||`agent`,s=Math.max(1,Number(e.skillHubPageSize)||24),c=Math.min(80,Math.max(s,t*s)),l=await r.request(`skills.search`,{query:i,limit:c}),u=Array.isArray(l?.results)?l.results:[],d=(t-1)*s,m=u.slice(d,d+s);if(!m.length&&t>1)throw n;return{items:m,total:u.length,message:`当前 Gateway 尚未启用技能商店分页代理，已使用兼容模式加载。重启 U-Claw 后可使用完整分页。`,compat:!0}}",
    "function UcSkillHubNormalizeApiSkill(e){let t=e?.namespace??{},n=t.handle||t.publicSlug||e?.ownerHandle||``,r=e?.slug||t.publicSlug||e?.name,i=t.canonicalName||(n&&r?`@${n}/${r}`:r),s=e?.labels??{},c=s.requires_api_key===!0||String(s.requires_api_key).toLowerCase()===`true`,l=e?.iconUrl||e?.icon_url||e?.iconURL||e?.logoUrl||e?.imageUrl||e?.avatarUrl||e?.publisher?.logoUrl||``;return{...e,id:i,slug:r,displayName:e?.name||r,summary:e?.description_zh||e?.description||``,description:e?.description_zh||e?.description||``,ownerHandle:n,owner:{handle:n,displayName:t.displayName||n},publisher:e?.publisher,iconUrl:l,logoUrl:e?.logoUrl||e?.publisher?.logoUrl,imageUrl:e?.imageUrl,avatarUrl:e?.avatarUrl,downloads:e?.downloads,stars:e?.stars,version:e?.version,categories:[e?.category,...(e?.subCategories??[]).map(e=>e?.key),...(e?.subCategories??[]).map(e=>e?.name)].filter(Boolean),topics:e?.tags??[],labels:{...s,requires_api_key:c},install:{reference:i},trust:{installability:`installable`},native:{skill:e}}}",
    "function UcSkillHubStoreTabs(e){let t=e.clawhubQuery?.trim()?`search`:e.skillHubTab||`recommended`,n=[{id:`recommended`,label:`推荐`},{id:`installable`,label:`可安装`},{id:`installed`,label:`已安装`},{id:`needs-setup`,label:`需配置`}];return e.clawhubQuery?.trim()?[{id:`search`,label:`搜索结果`},...n]:n}",
    "function UcSkillHubCategoryDefs(){return[{id:`all`,label:`全部`,icon:`🗂`},{id:`office`,label:`办公效率`,icon:`📎`},{id:`content`,label:`内容创作`,icon:`✍️`},{id:`coding`,label:`开发编程`,icon:`💻`},{id:`data`,label:`数据分析`,icon:`📊`},{id:`design`,label:`设计多媒体`,icon:`🎨`},{id:`agent`,label:`AI Agent`,icon:`🤖`},{id:`knowledge`,label:`知识管理`,icon:`🧠`},{id:`business`,label:`商业运营`,icon:`📣`},{id:`education`,label:`教育学习`,icon:`🎓`},{id:`industry`,label:`行业专业`,icon:`🏢`},{id:`itops`,label:`IT 运维与安全`,icon:`🛡️`},{id:`life`,label:`生活服务`,icon:`🎯`},{id:`other`,label:`其他`,icon:`▫`}]}",
    "function UcSkillHubCategoryDef(e){return UcSkillHubCategoryDefs().find(t=>t.id===e)||UcSkillHubCategoryDefs().at(-1)}",
    "function UcSkillHubCategoryLabel(e){let t={agent:`AI Agent`,browser:`AI Agent`,research:`知识管理`,automation:`办公效率`,productivity:`办公效率`,coding:`开发编程`,development:`开发编程`,data:`数据分析`,communication:`商业运营`,communications:`商业运营`,multimodal:`设计多媒体`,design:`设计多媒体`,content:`内容创作`,utility:`办公效率`,utilities:`办公效率`,integrations:`办公效率`,knowledge:`知识管理`,office:`办公效率`,business:`商业运营`,education:`教育学习`,industry:`行业专业`,itops:`IT 运维与安全`,life:`生活服务`,other:`其他`,\"office-efficiency\":`办公效率`,\"knowledge-management\":`知识管理`,\"dev-programming\":`开发编程`,\"content-creation\":`内容创作`,\"life-service\":`生活服务`,\"data-analysis\":`数据分析`,\"design-multimedia\":`设计多媒体`,\"business-operations\":`商业运营`,\"education-learning\":`教育学习`,\"industry-professional\":`行业专业`,\"it-ops-security\":`IT 运维与安全`};return t[e]??e}",
    "function UcSkillHubNormalizeCategoryId(e){let t=String(e??``).toLowerCase().replaceAll(` `,`-`),n={browser:`agent`,research:`knowledge`,automation:`office`,productivity:`office`,development:`coding`,communication:`business`,communications:`business`,multimodal:`design`,utility:`office`,utilities:`office`,integrations:`office`,\"office-efficiency\":`office`,\"knowledge-management\":`knowledge`,\"dev-programming\":`coding`,\"content-creation\":`content`,\"life-service\":`life`,\"data-analysis\":`data`,\"design-multimedia\":`design`,\"business-operations\":`business`,\"education-learning\":`education`,\"industry-professional\":`industry`,\"it-ops-security\":`itops`};return n[t]??t}",
    "function UcSkillHubArray(e){return Array.isArray(e)?e.filter(e=>typeof e==`string`&&e.trim()).map(e=>e.trim()):[]}",
    "function UcSkillHubCategories(e){let t=e.native?.skill?.categories??e.categories??[];return UcSkillHubArray(t)}",
    "function UcSkillHubTopics(e){let t=e.native?.skill?.topics??e.topics??[];return UcSkillHubArray(t)}",
    "function UcSkillHubText(e){return[e.displayName,e.slug,e.summary,e.description,...UcSkillHubTopics(e)].filter(Boolean).join(` `).toLowerCase()}",
    "function UcSkillHubDerivedCategories(e){let t=UcSkillHubText(e),n=[];if(/agent|assistant|persona|identity|智能体/.test(t))n.push(`agent`);if(/article|write|content|copy|markdown|创作|写作|内容/.test(t))n.push(`content`);if(/browser|web|网页|scrap|crawl|puppeteer|playwright|automation|automate|workflow|scheduled|lark|feishu|docs|calendar|mail|notion|workspace|office|协作|飞书|效率|task|todo/.test(t))n.push(`office`);if(/code|coding|developer|github|git|debug|test|开发|编程/.test(t))n.push(`coding`);if(/data|sheet|table|extract|analytics|stock|finance|数据|报表|分析/.test(t))n.push(`data`);if(/image|video|audio|voice|multimodal|design|图片|视频|语音|设计|多媒体/.test(t))n.push(`design`);if(/research|search|browser|study|knowledge|paper|docs|论文|研究|知识|检索/.test(t))n.push(`knowledge`);if(/business|sales|commerce|operation|运营|商业|营销|电商/.test(t))n.push(`business`);if(/education|learn|course|teach|学习|教育|课程/.test(t))n.push(`education`);if(/industry|legal|medical|finance|专业|行业|法律|医疗/.test(t))n.push(`industry`);if(/security|ops|devops|server|deploy|安全|运维/.test(t))n.push(`itops`);if(/life|travel|train|weather|生活|出行|天气|服务/.test(t))n.push(`life`);return n.length?n:[`other`]}",
    "function UcSkillHubItemCategories(e){let t=[...UcSkillHubCategories(e),...UcSkillHubTopics(e).map(e=>e.toLowerCase().replaceAll(` `,`-`)),...UcSkillHubDerivedCategories(e)].map(UcSkillHubNormalizeCategoryId);return[...new Set(t)]}",
    "function UcSkillHubSceneLabels(e){let t=e.native?.skill??e,n=Array.isArray(t?.subCategories)?t.subCategories:[],r=n.map(e=>e?.name).filter(e=>typeof e==`string`&&/[\\u4e00-\\u9fff]/.test(e)).map(e=>e.trim()).filter(Boolean);if(r.length)return[...new Set(r)];let i=[t?.categoryName,t?.category_zh,t?.categoryZh,t?.sceneName,t?.scene_zh].filter(e=>typeof e==`string`&&e.trim()).map(e=>e.trim());if(i.length)return[...new Set(i)];return UcSkillHubItemCategories(e).map(UcSkillHubCategoryLabel).filter(Boolean)}",
    "function UcSkillHubMatchesCategory(e,t){return!t||t===`all`?!0:UcSkillHubItemCategories(e).includes(t)}",
    "function UcSkillHubStats(e){let t=e.native?.skill?.stats??{},n=e.metrics??{};return{downloads:e.downloads??t.downloads??0,stars:e.stars??t.stars??0,installs:e.installs??t.installs??n.rolling60DayInstalls??null}}",
    "function UcSkillHubTrustLabel(e){let t=e.trust?.installability;return t===`installable`?`可安装`:t===`blocked`?`已阻止`:t===`review`?`需复核`:t===`unknown`?`待检测`:`技能商店校验`}",
    "function UcSkillHubDisplayText(e){let t=String(e??``).trim();if(!t)return``;let n=t.replaceAll(`OpenClaw`,`U-Claw`).replaceAll(`ClawHub`,`技能商店`);if(/controlling web pages/i.test(n)&&/browser tool/i.test(n))return`用于控制网页、处理多步骤流程、登录检查、标签页管理与失败恢复。`;if(/connected .*node canvases/i.test(n)||/node canvases/i.test(n))return`在已连接的 U-Claw 节点画布上展示 HTML，支持导航、快照与调试。`;if(/^Use when\\b/i.test(n))return`适用：${n.replace(/^Use when\\s*/i,``)}`;if(/^Present\\b/i.test(n))return`用于展示：${n.replace(/^Present\\s*/i,``)}`;return n}",
    "function UcSkillHubInstallRef(e){return e.install?.reference||[e.ownerHandle||e.owner?.handle,e.slug].filter(Boolean).join(`/`)||e.slug}",
    "function UcSkillHubQualifiedRef(e){let t=e.ownerHandle||e.owner?.handle||e.publisher?.handle||e.native?.ownerHandle||e.native?.owner?.handle,n=e.slug;return t&&n?`@${t}/${n}`:UcSkillHubInstallRef(e)}",
    "function UcSkillHubDetailRef(e,t){let n=e?.owner?.handle||e?.native?.ownerHandle||e?.native?.owner?.handle,r=e?.skill?.slug||t;return typeof r==`string`&&r.startsWith(`@`)?r:n&&r?`@${n}/${r}`:r}",
    "function UcSkillHubCachedPageDetail(e,t){let n=String(t??``).trim(),r=n.startsWith(`@`)?n.slice(1).split(`/`):[],i=r.length===2?r[1]:n,a=r.length===2?r[0]:``,s=[...(e.skillHubHomeResults??[]),...(e.clawhubResults??[])],c=s.find(e=>{let t=e.native?.skill??e,r=e.slug||t.slug,c=e.ownerHandle||e.owner?.handle||t.namespace?.handle||t.ownerHandle,l=c&&r?`@${c}/${r}`:r;return l===n||r===i&&(!a||c===a)});if(!c)return null;let l=c.native?.skill??c,u=c.slug||l.slug||i,d=c.ownerHandle||c.owner?.handle||l.namespace?.handle||l.ownerHandle,m=c.displayName||l.name||u,h=c.summary||l.description_zh||l.description||``,p=Array.isArray(c.categories)?c.categories:Array.isArray(l.subCategories)?[l.category,...l.subCategories.map(e=>e?.name||e?.key)].filter(Boolean):[],g=Array.isArray(c.topics)?c.topics:Array.isArray(l.tags)?l.tags:[];return{skill:{slug:u,displayName:m,summary:h,categories:p,topics:g,labels:c.labels||l.labels||{},homepage:l.homepage,iconUrl:c.iconUrl||l.iconUrl,downloads:c.downloads??l.downloads,stars:c.stars??l.stars},latestVersion:c.version||l.version?{version:c.version||l.version}:null,owner:{handle:d,displayName:c.owner?.displayName||l.namespace?.displayName||d},readmeMarkdown:l.readmeMarkdown||l.readme||h,metadata:{}}}",
    "function UcSkillHubIdentity(e){return UcSkillHubQualifiedRef(e)||e.id||e.slug}",
    "function UcSkillHubSortScore(e){let t=UcSkillHubStats(e),n=e.trust?.installability===`installable`?1e6:e.trust?.installability===`review`?5e5:0;return n+(t.downloads||0)+(t.stars||0)*100+(t.installs||0)*20}",
    "function UcSkillHubMergeResults(e){let t=new Map;for(let n of e){let e=UcSkillHubIdentity(n);if(!e||t.has(e))continue;t.set(e,n)}return[...t.values()].sort((e,t)=>UcSkillHubSortScore(t)-UcSkillHubSortScore(e))}",
    "function UcSkillHubApplySort(e,t){let n=[...e];return t===`downloads`?n.sort((e,t)=>(UcSkillHubStats(t).downloads||0)-(UcSkillHubStats(e).downloads||0)):t===`stars`?n.sort((e,t)=>(UcSkillHubStats(t).stars||UcSkillHubStats(t).installs||0)-(UcSkillHubStats(e).stars||UcSkillHubStats(e).installs||0)):t===`name`?n.sort((e,t)=>String(e.displayName||e.name||e.slug||``).localeCompare(String(t.displayName||t.name||t.slug||``))):n.sort((e,t)=>UcSkillHubSortScore(t)-UcSkillHubSortScore(e))}",
    "function UcSkillHubMatchesApiKeyFilter(e,t,n){return!t||t===`all`?!0:t===`configured`?n?!UcSkillHubLocalNeedsSetup(e):e.trust?.installability===`installable`:t===`needs-key`?n?UcSkillHubLocalNeedsSetup(e):e.trust?.installability!==`installable`:!0}",
    "function UcSkillHubLocalSkills(e){return(e.report?.skills??[]).filter(e=>!(e?.source===`openclaw-bundled`||e?.bundled===!0))}",
    "function UcSkillHubLocalNeedsSetup(e){let t=e.missing??{};return e.eligible===!1||Object.values(t).some(e=>Array.isArray(e)&&e.length>0)}",
    "async function UcSkillHubUninstall(e,t){let n=e.client;if(!n?.request||!e.connected||!t||e.skillsBusyKey)return;e.skillsBusyKey=t,e.requestUpdate?.();try{let r=await n.request(`skills.uninstall`,{agentId:e.skillsAgentId??e.agentsList?.defaultId??void 0,skillKey:t});if(!r?.ok)throw Error(r?.error||`卸载失败`);e.skillsDetailKey===t&&(e.skillsDetailKey=null),await S(e,{clearMessages:!0})}catch(r){e.skillMessages={...e.skillMessages,[t]:{kind:`error`,message:`卸载技能失败：${r instanceof Error?r.message:String(r)}`}},e.requestUpdate?.()}finally{e.skillsBusyKey===t&&(e.skillsBusyKey=null,e.requestUpdate?.())}}",
    "function UcSkillHubErrorText(e){let t=String(e??``),n=t.toLowerCase();return n.includes(`timeout`)||n.includes(`timed out`)?`技能商店请求超时，请稍后重试。`:n.includes(`429`)||n.includes(`rate limit`)?`技能商店请求过于频繁，请稍后再试。`:n.includes(`401`)||n.includes(`403`)||n.includes(`unauthorized`)||n.includes(`forbidden`)||n.includes(`auth`)?`技能商店连接未授权，请检查 Gateway 登录状态。`:/\\b5\\d\\d\\b/.test(n)||n.includes(`server error`)?`技能商店服务暂不可用，请稍后重试。`:n.includes(`network`)||n.includes(`fetch`)?`技能商店网络请求失败，请检查连接。`:t?`技能商店搜索失败：${t}`:`技能商店搜索失败。`}",
    "function UcSkillHubFormatMetric(e){let t=Number(e??0);return Number.isFinite(t)&&t>0?t>=1e4?`${(t/1e4).toFixed(t>=1e5?1:0)}万`:String(Math.round(t)):`-`}",
    "function UcSkillHubIconUrl(e){let t=e.iconUrl||e.icon_url||e.iconURL||e.logoUrl||e.imageUrl||e.avatarUrl||e.icon||e.logo||e.avatar||e.native?.skill?.iconUrl||e.native?.skill?.icon_url||e.native?.skill?.iconURL||e.native?.skill?.logoUrl||e.native?.skill?.imageUrl||e.native?.skill?.icon||e.native?.skill?.publisher?.logoUrl||e.publisher?.logoUrl||e.publisher?.image||e.publisher?.avatarUrl||e.owner?.image||e.owner?.avatarUrl;return typeof t==`string`&&(/^(https:|data:|\\/)/.test(t)?t:``)}",
    "function UcSkillHubIconGlyph(e){let t=UcSkillHubCategoryDef(UcSkillHubItemCategories(e)[0])?.icon,n=e.icon;return typeof n==`string`&&!/^(https?:|data:|\\/)/.test(n)&&n.length<=4?n:t||`▫`}",
    "function UcSkillHubRenderIcon(e){let t=UcSkillHubIconUrl(e),n=UcSkillHubIconGlyph(e);return a`<span class=\"skillhub-icon\" aria-hidden=\"true\" style=\"width: 36px; height: 36px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; position: relative; overflow: hidden; flex: 0 0 auto; background: linear-gradient(135deg, #e9f2ff, #f6fbff); color: #0f5fd7; font-size: 18px; font-weight: 700; box-shadow: inset 0 0 0 1px rgba(15,95,215,.12);\"><span>${n}</span>${t?a`<img data-skillhub-icon-img=\"true\" src=${t} alt=\"\" loading=\"lazy\" @error=${e=>{e.currentTarget.style.display=`none`}} style=\"position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;\"/>`:o}</span>`}",
    "function UcSkillHubBuildViewModel(e){let t=e.clawhubQuery?.trim(),n=t?`search`:e.skillHubTab||`recommended`,r=e.skillHubCategory||`all`,i=UcSkillHubLocalSkills(e),s=e.skillHubHomeResults??[],c=[];if(n===`installed`)c=i;else if(n===`needs-setup`)c=i.filter(UcSkillHubLocalNeedsSetup);else c=s.filter(e=>n===`installable`?e.trust?.installability===`installable`:!0);let l=n===`installed`||n===`needs-setup`;l&&(c=c.filter(e=>UcSkillHubMatchesCategory(e,r)).filter(t=>UcSkillHubMatchesApiKeyFilter(t,e.skillHubApiKeyFilter,l)),e.skillHubSort!==`recommended`&&(c=UcSkillHubApplySort(c,e.skillHubSort)));let u=t?`搜索结果`:n===`recommended`?`推荐首页`:n===`installable`?`可安装技能`:n===`installed`?`已安装技能`:`需配置技能`,d=Math.max(1,Number(e.skillHubPage)||1),m=Math.max(1,Number(e.skillHubPageSize)||24),h=Math.max(0,Number(e.skillHubTotal)||c.length),p=Math.max(1,Math.ceil(h/m));return{query:t,tab:n,category:r,apiKeyFilter:e.skillHubApiKeyFilter||`all`,sort:e.skillHubSort||`recommended`,items:c,totalItems:h,page:d,pageSize:m,pageCount:p,hasMore:!l&&d<p,loadMoreMessage:e.skillHubLoadMoreMessage||``,isLocal:l,title:u,localCount:i.length,needsSetupCount:i.filter(UcSkillHubLocalNeedsSetup).length,installableCount:s.filter(e=>e.trust?.installability===`installable`).length,pageError:e.skillHubPageError||``}}",
    "function UcSkillHubRenderTopTabs(e,t){let n=e.skillHubTab===`recommended`,r=[{id:`all`,label:`全部`},{id:`ready`,label:`可用`},{id:`needs-setup`,label:`需配置`},{id:`disabled`,label:`已停用`}];return a`<div class=\"agent-tabs\" data-skillhub-primary-tabs=\"true\" style=\"margin-top: 0; flex: 1 1 auto; min-width: 0;\"> <button class=\"agent-tab ${n?`active`:``}\" @click=${()=>e.onSkillHubTabChange?.(`recommended`)}>推荐</button>${r.map(r=>a`<button class=\"agent-tab ${!n&&e.statusFilter===r.id?`active`:``}\" @click=${()=>{e.onSkillHubTabChange?.(`local`),e.onStatusFilterChange?.(r.id)}}>${r.label}<span class=\"agent-tab-count\">${t[r.id]}</span></button>`)}</div>`}",
    "function UcSkillHubRenderToolbar(e,t){let n=e.clawhubSearchLoading||e.skillHubHomeLoading,r=UcSkillHubCategoryDefs().filter(e=>e.id!==`other`);return a`<div data-skillhub-toolbar=\"true\" style=\"display: grid; grid-template-columns: minmax(280px,1fr) 154px 154px 154px; align-items: center; gap: 8px; min-height: 40px;\"><label class=\"field\" data-skillhub-search=\"true\" style=\"margin: 0; min-width: 0; position: relative;\"><input .value=${e.clawhubQuery} @input=${t=>e.onClawHubQueryChange(t.target.value)} placeholder=\"搜索技能商店技能…\" autocomplete=\"off\" name=\"clawhub-search\" aria-busy=${n?`true`:`false`} style=\"height: 36px; width: 100%; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); padding: 0 ${n?`72px`:`12px`} 0 12px; box-shadow: inset 0 0 0 1px rgba(15,95,215,.04);\"/>${n?a`<span data-skillhub-loading=\"true\" class=\"muted\" style=\"position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 12px; pointer-events: none;\">搜索中…</span>`:o}</label><label class=\"field\" style=\"margin: 0;\"><select aria-label=\"场景筛选\" .value=${t.category} @change=${t=>e.onSkillHubCategoryChange?.(t.target.value)} style=\"height: 36px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); padding: 0 10px; width: 100%;\">${r.map(e=>a`<option value=${e.id}>${e.id===`all`?`全部场景`:e.label}</option>`)}</select></label><label class=\"field\" style=\"margin: 0;\"><select aria-label=\"API Key 筛选\" .value=${t.apiKeyFilter} @change=${t=>e.onSkillHubApiKeyFilterChange?.(t.target.value)} style=\"height: 36px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); padding: 0 10px; width: 100%;\"><option value=\"all\">API Key 不限</option><option value=\"configured\">仅看已配置</option><option value=\"needs-key\">仅看需配置</option></select></label><label class=\"field\" style=\"margin: 0;\"><select aria-label=\"排序\" .value=${t.sort} @change=${t=>e.onSkillHubSortChange?.(t.target.value)} style=\"height: 36px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); padding: 0 10px; width: 100%;\"><option value=\"recommended\">排序 推荐精选</option><option value=\"downloads\">下载最多</option><option value=\"stars\">收藏最多</option><option value=\"name\">名称 A-Z</option></select></label></div>`}",
    "function UcSkillHubRenderTableHead(){return a`<div class=\"skillhub-dense-head\" style=\"display: grid; grid-template-columns: minmax(280px,1fr) 120px 88px 88px 96px; gap: 14px; padding: 8px 12px; font-size: 12px; color: var(--muted); border-bottom: 1px solid var(--border); background: var(--panel-2);\"><span>技能</span><span>场景</span><span>下载</span><span>收藏</span><span>操作</span></div>`}",
    "function UcSkillHubRenderSkillRow(e,t,n){let r=UcSkillHubSceneLabels(t),i=UcSkillHubStats(t),s=n?UcSkillHubLocalNeedsSetup(t):!1,c=n?t.name:t.displayName,l=n?UcSkillHubDisplayText(t.description):t.summary?UcSkillHubDisplayText(t.summary):UcSkillHubInstallRef(t),u=n?`已安装`:UcSkillHubTrustLabel(t),d=n?t.source:UcSkillHubInstallRef(t),m=n?`-`:UcSkillHubFormatMetric(i.downloads),h=n?`-`:UcSkillHubFormatMetric(i.stars||i.installs),p=n?t.skillKey:UcSkillHubQualifiedRef(t),g=r.join(`、`);return a`<div class=\"skillhub-dense-row list-item-clickable\" style=\"display: grid; grid-template-columns: minmax(280px,1fr) 120px 88px 88px 96px; gap: 14px; align-items: center; min-height: 68px; padding: 9px 12px; border-bottom: 1px solid var(--border); background: var(--panel);\" @click=${()=>n?e.onDetailOpen(t.skillKey):e.onClawHubDetailOpen(p)}><div style=\"display: flex; min-width: 0; gap: 10px; align-items: center;\">${UcSkillHubRenderIcon(t)}<div style=\"min-width: 0;\"><div style=\"display: flex; align-items: center; gap: 6px; min-width: 0;\"><span style=\"font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;\">${c}</span>${t.version?a`<span class=\"muted\" style=\"font-size: 12px;\">v${t.version}</span>`:o}${t.official?a`<span class=\"chip chip-ok\">官方</span>`:o}</div><div class=\"list-sub\" style=\"white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;\">${w(l,120)}</div><div class=\"muted\" style=\"font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;\">${d}</div></div></div><div>${r.length?a`<span class=\"chip\" title=${g}>${r[0]}</span>`:a`<span class=\"chip\">其他</span>`}</div><div class=\"muted\">↓ ${m}</div><div class=\"muted\">☆ ${h}</div><div style=\"display: flex; justify-content: flex-end; align-items: center; gap: 6px;\">${n?a`<span class=\"chip ${s?`chip-warn`:`chip-ok`}\">${s?`需配置`:u}</span><button type=\"button\" data-skillhub-uninstall-button=\"true\" class=\"btn btn--sm\" ?disabled=${e.skillsBusyKey===t.skillKey} .onclick=${n=>{n.preventDefault(),n.stopPropagation(),e.onUninstall?.(t.skillKey)}}>${e.skillsBusyKey===t.skillKey?`卸载中…`:`卸载`}</button>`:a`<button type=\"button\" data-skillhub-install-button=\"true\" data-skillhub-install-ready=${typeof e.onClawHubInstall} class=\"btn btn--sm\" ?disabled=${e.clawhubInstallSlug!==null} .onclick=${n=>{n.preventDefault(),n.stopPropagation(),e.onClawHubInstall?.(t)}}>${e.clawhubInstallSlug===p?`安装中…`:e.clawhubInstallSlug?`等待中`:`安装`}</button>`}</div></div>`}",
    "function UcSkillHubPageNumbers(e){let t=e.page,n=e.pageCount,r=new Set([1,n,t,t-1,t+1,t-2,t+2].filter(e=>e>=1&&e<=n)),i=[...r].sort((e,t)=>e-t),s=[];for(let e=0;e<i.length;e++)e>0&&i[e]-i[e-1]>1&&s.push(`ellipsis-${i[e]}`),s.push(i[e]);return s}",
    "function UcSkillHubRenderPagination(e,t){let n=e.clawhubSearchLoading||e.skillHubHomeLoading,r=UcSkillHubPageNumbers(t);return t.isLocal?o:a`<div data-skillhub-pagination=\"true\" class=\"muted\" style=\"display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 12px; border-top: 1px solid var(--border); flex-wrap: wrap;\"><span data-skillhub-page-summary=\"true\">第 ${t.page} / ${t.pageCount} 页 · 共 ${UcSkillHubFormatMetric(t.totalItems)} 项</span><div style=\"display: flex; gap: 6px; align-items: center; flex-wrap: wrap;\"><button type=\"button\" class=\"btn btn--sm\" data-skillhub-prev-page-button=\"true\" ?disabled=${n||t.page<=1} @click=${r=>{r.preventDefault(),r.stopPropagation(),e.onSkillHubPageChange?.(t.page-1)}}>上一页</button>${r.map(r=>typeof r==`string`?a`<span style=\"padding: 0 2px;\">…</span>`:a`<button type=\"button\" class=\"btn btn--sm ${r===t.page?`primary`:``}\" data-skillhub-page-button=\"true\" data-skillhub-page=${r} ?disabled=${n||r===t.page} @click=${i=>{i.preventDefault(),i.stopPropagation(),e.onSkillHubPageChange?.(r)}}>${r}</button>`)}<button type=\"button\" class=\"btn btn--sm\" data-skillhub-next-page-button=\"true\" ?disabled=${n||t.page>=t.pageCount} @click=${r=>{r.preventDefault(),r.stopPropagation(),e.onSkillHubPageChange?.(t.page+1)}}>${n?`加载中…`:`下一页`}</button></div>${t.loadMoreMessage?a`<span data-skillhub-load-more-message=\"true\">${t.loadMoreMessage}</span>`:o}</div>`}",
    "function UcSkillHubRenderList(e,t){let n=e.clawhubSearchLoading||e.skillHubHomeLoading;return t.items.length===0?a`<div class=\"muted\" style=\"padding: 18px 12px;\">${n?`正在检索技能商店技能…`:t.pageError?UcSkillHubErrorText(t.pageError):`暂无匹配技能商店技能。`}</div>`:a`<div class=\"skillhub-dense-table\" data-skillhub-dense-list=\"true\" style=\"border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--panel);\">${UcSkillHubRenderTableHead()}${t.items.map(n=>UcSkillHubRenderSkillRow(e,n,t.isLocal))}${UcSkillHubRenderPagination(e,t)}</div>`}",
    "function q(e){let t=UcSkillHubBuildViewModel(e);return a`",
    "    <section class=\"skillhub-content\" data-skillhub-content=\"dense\" style=\"min-width: 0; display: grid; gap: 10px; align-content: start; margin-top: 10px;\">",
    "        ${UcSkillHubRenderToolbar(e,t)}",
    "        ${e.clawhubSearchError?a`<div class=\"callout danger\">${UcSkillHubErrorText(e.clawhubSearchError)}</div>`:o}",
    "        ${e.clawhubInstallMessage?a`<div class=\"callout ${e.clawhubInstallMessage.kind===`error`?`danger`:`success`}\" style=\"position: relative; padding-right: 44px;\"><button type=\"button\" class=\"btn btn--sm\" aria-label=\"关闭安装提示\" data-skillhub-install-message-close=\"true\" style=\"position: absolute; top: 8px; right: 8px; width: 28px; height: 28px; padding: 0;\" .onclick=${n=>{n.preventDefault(),e.onClawHubInstallMessageClose?.()}}>×</button><div style=\"max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;\">${e.clawhubInstallMessage.text}</div><div style=\"display: flex; flex-wrap: wrap; gap: 8px; margin-top: ${e.clawhubInstallMessage.acknowledgeSlug||e.clawhubInstallMessage.forceSlug?`10px`:`0`};\">${e.clawhubInstallMessage.acknowledgeSlug?a`<button type=\"button\" class=\"btn btn--sm\" style=\"white-space: normal;\" ?disabled=${e.clawhubInstallSlug===e.clawhubInstallMessage.acknowledgeSlug} .onclick=${n=>{n.preventDefault(),e.onClawHubInstall(e.clawhubInstallMessage?.acknowledgeSlug??``,!0,e.clawhubInstallMessage?.acknowledgeVersion)}}>${e.clawhubInstallMessage.acknowledgeLabel??`确认风险并安装`}</button>`:o}${e.clawhubInstallMessage.forceSlug?a`<button type=\"button\" class=\"btn btn--sm primary\" data-skillhub-force-install-button=\"true\" style=\"white-space: normal;\" ?disabled=${e.clawhubInstallSlug===e.clawhubInstallMessage.forceSlug} .onclick=${n=>{n.preventDefault(),e.onClawHubInstall(e.clawhubInstallMessage?.forceSlug??``,!1,e.clawhubInstallMessage?.forceVersion,!0)}}>${e.clawhubInstallMessage.forceLabel??`覆盖重装`}</button>`:o}</div></div>`:o}",
    "        ${e.skillHubHomeLoading&&!t.query&&t.tab===`recommended`?a`<div class=\"muted\" style=\"font-size: 12px;\">正在加载技能商店推荐…</div>`:o}",
    "        ${e.skillHubHomeErrors?.length&&!t.query&&t.tab===`recommended`?a`<div class=\"callout\">部分推荐源暂不可用：${e.skillHubHomeErrors.join(`、`)} <button class=\"btn btn--sm\" style=\"margin-left: 8px;\" @click=${()=>e.onSkillHubRetryHome?.()}>重试</button></div>`:o}",
    "        ${!e.connected?a`<div class=\"muted\">技能商店暂不可用，请连接 Gateway 后重试。</div>`:o}",
    "        ${UcSkillHubRenderList(e,t)}",
    "      </section>",
    "  `}",
    "function J(e){let t=e.clawhubDetail??UcSkillHubCachedPageDetail(e,e.clawhubDetailSlug),n=t?.skill,i=t?.latestVersion,s=Array.isArray(n?.categories)?n.categories:[],c=Array.isArray(n?.topics)?n.topics:[],u=t?.readmeMarkdown??t?.readme??i?.readmeMarkdown??i?.readme??null,d=t?.owner;return a`",
    "    <dialog",
    "      class=\"md-preview-dialog\"",
    "      ${l(R)}",
    "      @click=${e=>{let t=e.currentTarget;e.target===t&&t.close()}}",
    "      @close=${e.onClawHubDetailClose}",
    "    >",
    "      <div class=\"md-preview-dialog__panel\">",
    "        <div class=\"md-preview-dialog__header\">",
    "          <div class=\"md-preview-dialog__title\">",
    "            ${n?.displayName??e.clawhubDetailSlug}",
    "          </div>",
    "          <button",
    "            class=\"btn btn--sm\"",
    "            @click=${e=>{e.currentTarget.closest(`dialog`)?.close()}}",
    "          >",
    "            关闭",
    "          </button>",
    "        </div>",
    "        <div class=\"md-preview-dialog__body\" style=\"display: grid; gap: 16px;\">",
    "          ${e.clawhubDetailLoading?a`<div class=\"muted\">${f(`common.loading`)}</div>`:e.clawhubDetailError&&!t?a`<div class=\"callout danger\">${UcSkillHubErrorText(e.clawhubDetailError)}</div>`:n?a`",
    "                    <div class=\"callout\" style=\"display: grid; gap: 6px; border-color: var(--border); background: var(--panel-2);\">",
    "                      <div style=\"font-weight: 600;\">安装来源</div>",
    "                      <div class=\"muted\" style=\"font-size: 13px; overflow-wrap: anywhere;\">${d?.handle?`${d.handle}/`:``}${n.slug??e.clawhubDetailSlug}</div>",
    "                      <div class=\"muted\" style=\"font-size: 12px;\">安装动作走 U-Claw 技能商店安装与信任检查链路。</div>",
    "                    </div>",
    "                    <div style=\"font-size: 14px; line-height: 1.5;\">",
    "                      ${UcSkillHubDisplayText(n.summary)}",
    "                    </div>",
    "                    ${(s.length||c.length)?a`<div style=\"display: flex; flex-wrap: wrap; gap: 6px;\">${[...s.map(UcSkillHubCategoryLabel),...c].slice(0,8).map(e=>a`<span class=\"chip\">${e}</span>`)}</div>`:o}",
    "                    ${d?.displayName?a`<div class=\"muted\" style=\"font-size: 13px;\">",
    "                          作者：",
    "                          ${d.displayName}${d.handle?a` (@${d.handle})`:o}",
    "                        </div>`:o}",
    "                    ${i?a`<div class=\"muted\" style=\"font-size: 13px;\">",
    "                          最新版本：v${i.version}",
    "                        </div>`:o}",
    "                    ${i?.changelog?a`<div",
    "                          style=\"font-size: 13px; border-top: 1px solid var(--border); padding-top: 12px; white-space: pre-wrap;\"",
    "                        >",
    "                          ${i.changelog}",
    "                        </div>`:o}",
    "                    ${t.metadata?.os?a`<div class=\"muted\" style=\"font-size: 12px;\">",
    "                          平台：${t.metadata.os.join(`, `)}",
    "                        </div>`:o}",
    "                    ${u?a`<article class=\"sidebar-markdown\" style=\"max-width: 100%; overflow-wrap: anywhere; border-top: 1px solid var(--border); padding-top: 12px;\">${r(F(u))}</article>`:a`<div class=\"muted\" style=\"font-size: 12px;\">README 暂无；请以安装前 U-Claw 风险提示为准。</div>`}",
    "                    <button",
    "                      type=\"button\"",
    "                      class=\"btn primary\"",
    "                      ?disabled=${e.clawhubInstallSlug!==null}",
    "                      .onclick=${n=>{n.preventDefault(),e.clawhubDetailSlug&&e.onClawHubInstall(UcSkillHubDetailRef(t,e.clawhubDetailSlug))}}",
    "                    >",
    "                      ${e.clawhubInstallSlug===UcSkillHubDetailRef(t,e.clawhubDetailSlug)?`安装中…`:e.clawhubInstallSlug?`等待 ${e.clawhubInstallSlug}`:`安装 ${n.displayName}`}",
    "                    </button>",
    "                  `:a`<div class=\"muted\">技能商店详情暂不可用。</div>`}",
    "        </div>",
    "      </div>",
    "    </dialog>",
    "  `}",
  ].join("\n");
  const singleLayerLayout = [
    "return a`",
    "    <section class=\"card\" data-skillhub-single-layer=\"true\">",
    "      <div class=\"row\" style=\"justify-content: space-between; align-items: center; gap: 12px;\">",
    "        ${UcSkillHubRenderTopTabs(e,i)}",
    "        <button",
    "          class=\"btn\"",
    "          ?disabled=${e.loading||!e.connected}",
    "          @click=${e.onRefresh}",
    "        >",
    "          ${e.loading?f(`common.loading`):f(`common.refresh`)}",
    "        </button>",
    "      </div>",
    "",
    "      ${e.skillHubTab===`recommended`?q(e):a`",
    "        <div",
    "          class=\"filters\"",
    "          style=\"display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 12px;\"",
    "        >",
    "          ${n.length>0?a`",
    "                <label class=\"field\" style=\"min-width: 180px;\">",
    "                  <span>${f(`usage.filters.agent`)}</span>",
    "                  <select",
    "                    name=\"skills-agent\"",
    "                    .value=${r}",
    "                    ?disabled=${e.loading||!e.connected||n.length<2}",
    "                    @change=${t=>e.onAgentChange(t.target.value)}",
    "                  >",
    "                    ${n.map(t=>a`",
    "                        <option value=${t.id} ?selected=${t.id===r}>",
    "                          ${G(t,e.agentsList?.defaultId)}",
    "                        </option>",
    "                      `)}",
    "                  </select>",
    "                </label>",
    "              `:o}",
    "          <label class=\"field\" style=\"flex: 1; min-width: 180px;\">",
    "            <span>${f(`common.search`)}</span>",
    "            <input",
    "              .value=${e.filter}",
    "              @input=${t=>e.onFilterChange(t.target.value)}",
    "              placeholder=\"筛选已安装技能\"",
    "              autocomplete=\"off\"",
    "              name=\"skills-filter\"",
    "            />",
    "          </label>",
    "          <div class=\"muted\">${u.length} 项</div>",
    "        </div>",
    "",
    "        ${e.error?a`<div class=\"callout danger\" style=\"margin-top: 12px;\">${e.error}</div>`:o}",
    "        ${u.length===0?a`",
    "              <div class=\"muted\" style=\"margin-top: 16px\">",
    "                ${!e.connected&&!e.report?`尚未连接 Gateway。`:`暂无已安装技能商店技能。`}",
    "              </div>",
    "            `:a`",
    "              <div class=\"agent-skills-groups\" style=\"margin-top: 16px;\">",
    "                ${p.map(t=>a`",
    "                    <details class=\"agent-skills-group\" open>",
    "                      <summary class=\"agent-skills-header\">",
    "                        <span>${t.label}</span>",
    "                        <span class=\"muted\">${t.skills.length}</span>",
    "                      </summary>",
    "                      <div class=\"list skills-grid\">",
    "                        ${s(t.skills,e=>e.skillKey,t=>Y(t,e))}",
    "                      </div>",
    "                    </details>",
    "                  `)}",
    "              </div>",
    "            `}",
    "      `}",
    "    </section>",
    "",
    "    ${m?X(m,e):o}",
  ].join("\n");

  for (const file of listSkillsPageAssets()) {
    const before = read(file);
    const helperStarts = [
      before.indexOf("function UcSkillHubHomeSeeds("),
      before.indexOf("function UcSkillHubSceneQueryMap("),
      before.indexOf("function UcSkillHubApiUrl("),
      before.indexOf("function UcSkillHubCategoryLabel("),
    ].filter((index) => index >= 0);
    const existingHelperStart = helperStarts.length > 0 ? Math.min(...helperStarts) : -1;
    const start =
      existingHelperStart >= 0 ? existingHelperStart : before.indexOf("function q(e){let t=e.clawhubResults;");
    const end = start >= 0 ? before.indexOf("function Y(e,t)", start) : -1;
    if (start < 0 || end < 0) {
      if (before.includes("function UcSkillHubCategories(") || !path.basename(file).startsWith("skills-page-")) {
        continue;
      }
      throw new Error(`Could not patch SkillHub store discovery in ${file}`);
    }
    let after = `${before.slice(0, start)}${patched}${before.slice(end)}`;
    const layoutPattern =
      /return a`\s*<section class="card">[\s\S]*?<\/section>\s*\n\n\s*\$\{m\?X\(m,e\):o\}/;
    after = after.replace(layoutPattern, singleLayerLayout);
    after = after.replace(
      /<div style="margin-top: 16px; border-top: 1px solid var\(--border\); padding-top: 16px;">[\s\S]*?\$\{q\(e\)\}\s*<\/div>/,
      "${q(e)}",
    );
    after = after.replaceAll("e.onClawHubInstall?.(p)}}", "e.onClawHubInstall?.(t)}}");
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Keeps installed SkillHub rows actionable after the marketplace layout patch.
 */
function patchSkillsPageLocalUninstallActions() {
  const localToggle = `        <label class="skill-toggle-wrap" @click=\${e=>e.stopPropagation()}>
          <input
            type="checkbox"
            class="skill-toggle"
            .checked=\${!e.disabled}
            ?disabled=\${n}
            @change=\${n=>{n.stopPropagation(),t.onToggle(e.skillKey,e.disabled)}}
          />
        </label>`;
  const localToggleWithUninstall = `${localToggle}
        <button
          class="btn btn--sm"
          ?disabled=\${n}
          @click=\${i=>{i.stopPropagation(),t.onUninstall?.(e.skillKey)}}
        >
          \${n?\`卸载中…\`:\`卸载\`}
        </button>`;
  const detailStatus = `            <span style="font-size: 13px; font-weight: 500;">
              \${e.disabled?\`已停用\`:\`已启用\`}
            </span>`;
  const detailStatusWithUninstall = `${detailStatus}
            <button
              class="btn btn--sm"
              ?disabled=\${n}
              @click=\${()=>t.onUninstall(e.skillKey)}
            >
              \${n?\`卸载中…\`:\`卸载\`}
            </button>`;

  for (const file of listSkillsPageAssets()) {
    const before = read(file);
    let after = before;

    if (!after.includes("t.onUninstall?.(e.skillKey)")) {
      after = after.replace(localToggle, localToggleWithUninstall);
    }
    after = after.replace(
      "@click=${e=>{e.stopPropagation(),t.onUninstall?.(e.skillKey)}}",
      "@click=${i=>{i.stopPropagation(),t.onUninstall?.(e.skillKey)}}",
    );
    if (!after.includes("@click=${()=>t.onUninstall(e.skillKey)}")) {
      after = after.replace(detailStatus, detailStatusWithUninstall);
    }
    after = after.replace(
      "onInstall:(e,t,n)=>void m(this,e,t,n),onDetailOpen",
      "onInstall:(e,t,n)=>void m(this,e,t,n),onUninstall:e=>void UcSkillHubUninstall(this,e),onDetailOpen",
    );

    if (
      !after.includes("onUninstall:e=>void UcSkillHubUninstall(this,e)") ||
      !after.includes("t.onUninstall?.(e.skillKey)") ||
      !after.includes("@click=${()=>t.onUninstall(e.skillKey)}")
    ) {
      if (!path.basename(file).startsWith("skills-page-")) {
        continue;
      }
      throw new Error(`Could not patch SkillHub local uninstall actions in ${file}`);
    }

    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Refreshes the Skills page gateway snapshot before marketplace search requests.
 */
function patchSkillsPageSearchConnectionSync() {
  const original =
    "changeClawHubQuery(e){p(this,e),this.clawhubSearchTimer&&clearTimeout(this.clawhubSearchTimer),this.clawhubSearchTimer=setTimeout(()=>void ee(this,e),300)}";
  const patched =
    "changeClawHubQuery(e){this.syncGatewayState(),this.skillHubPage=1,this.skillHubLoadMoreMessage=null,p(this,e),this.clawhubSearchTimer&&clearTimeout(this.clawhubSearchTimer),this.clawhubSearchTimer=setTimeout(()=>{this.skillHubTab=`recommended`,void this.loadSkillHubPage?.(1)},300)}";
  const semiPatched =
    "changeClawHubQuery(e){this.syncGatewayState(),p(this,e),this.clawhubSearchTimer&&clearTimeout(this.clawhubSearchTimer),this.clawhubSearchTimer=setTimeout(()=>void ee(this,e),300)}";
  const previousPatched =
    "changeClawHubQuery(e){this.syncGatewayState(),p(this,e),this.clawhubSearchTimer&&clearTimeout(this.clawhubSearchTimer),this.clawhubSearchTimer=setTimeout(()=>{e?.trim?.()?void ee(this,e):void this.loadSkillHubHome?.()},300)}";
  const previousRecommendedPatched =
    "changeClawHubQuery(e){this.syncGatewayState(),p(this,e),this.clawhubSearchTimer&&clearTimeout(this.clawhubSearchTimer),this.clawhubSearchTimer=setTimeout(()=>{e?.trim?.()?void ee(this,e):(this.skillHubTab=`recommended`,void this.loadSkillHubHome?.())},300)}";
  const currentRecommendedPatched =
    "changeClawHubQuery(e){this.syncGatewayState(),this.skillHubVisibleCount=40,p(this,e),this.clawhubSearchTimer&&clearTimeout(this.clawhubSearchTimer),this.clawhubSearchTimer=setTimeout(()=>{e?.trim?.()?void ee(this,e):(this.skillHubTab=`recommended`,void this.loadSkillHubHome?.())},300)}";
  const previousSeedPatched =
    "changeClawHubQuery(e){this.syncGatewayState(),this.skillHubVisibleCount=40,this.skillHubSearchSeedIndex=0,this.skillHubSearchCanLoadMore=!0,this.skillHubLoadMoreMessage=null,p(this,e),this.clawhubSearchTimer&&clearTimeout(this.clawhubSearchTimer),this.clawhubSearchTimer=setTimeout(()=>{e?.trim?.()?void ee(this,e):(this.skillHubTab=`recommended`,void this.loadSkillHubHome?.())},300)}";

  for (const file of listSkillsPageAssets()) {
    const before = read(file);
    const after = before
      .replace(original, patched)
      .replace(semiPatched, patched)
      .replace(previousPatched, patched)
      .replace(previousRecommendedPatched, patched)
      .replace(currentRecommendedPatched, patched)
      .replace(previousSeedPatched, patched);
    if (after === before && !before.includes("void this.loadSkillHubPage?.(1)")) {
      if (!path.basename(file).startsWith("skills-page-")) {
        continue;
      }
      throw new Error(`Could not patch SkillHub search connection sync in ${file}`);
    }

    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Shows real SkillHub marketplace data on first load by aggregating verified seed searches.
 */
function patchSkillsPageDefaultStoreSearch() {
  const original =
    "ensureInitialData(){!this.connected||!this.client||this.routeData?.agentsList||this.routeData?.report||this.routeData?.error||(!this.agentsList&&!this.agentsLoading&&this.loadAgents(),!this.skillsReport&&!this.skillsLoading&&S(this))}";
  const legacyPatched =
    "ensureInitialData(){(!this.connected||!this.client||this.routeData?.agentsList||this.routeData?.report||this.routeData?.error)||(!this.agentsList&&!this.agentsLoading&&this.loadAgents(),!this.skillsReport&&!this.skillsLoading&&S(this)),this.connected&&this.client&&!this.clawhubSearchQuery&&!this.clawhubSearchResults&&!this.clawhubSearchLoading&&(p(this,`agent`),void ee(this,`agent`))}";
  const patched =
    "ensureInitialData(){(!this.connected||!this.client||this.routeData?.agentsList||this.routeData?.report||this.routeData?.error)||(!this.agentsList&&!this.agentsLoading&&this.loadAgents(),!this.skillsReport&&!this.skillsLoading&&S(this)),!this.clawhubSearchQuery&&!this.skillHubHomeResults&&!this.skillHubHomeLoading&&void this.loadSkillHubPage?.(1)}";

  for (const file of listSkillsPageAssets()) {
    const before = read(file);
    const after = before.replace(original, patched).replace(legacyPatched, patched);
    if (after === before && !before.includes("this.loadSkillHubPage?.(1)")) {
      if (!path.basename(file).startsWith("skills-page-")) {
        continue;
      }
      throw new Error(`Could not patch SkillHub default marketplace search in ${file}`);
    }

    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Adds UI-only SkillHub homepage, tab, and category state to the Skills page.
 */
function patchSkillsPageStoreHomeState() {
  const constructorOriginal = "this.clawhubSearchTimer=null}createRenderRoot(){return this}";
  const legacyConstructorPatched =
    "this.clawhubSearchTimer=null,this.skillHubTab=`recommended`,this.skillHubCategory=`all`,this.skillHubHomeResults=null,this.skillHubHomeLoading=!1,this.skillHubHomeErrors=[],this.skillHubHomeLoaded=!1,this.loadSkillHubHome=async()=>{let e=this.client;if(!e||!this.connected||this.skillHubHomeLoading)return;this.skillHubHomeLoading=!0,this.skillHubHomeErrors=[],this.requestUpdate?.();let t=[];try{let n=await Promise.allSettled(UcSkillHubHomeSeeds().map(t=>e.request(`skills.search`,{query:t,limit:20}).then(e=>e?.results??[])));for(let[e,r]of n.entries())r.status===`fulfilled`?t.push(...r.value):this.skillHubHomeErrors=[...this.skillHubHomeErrors,UcSkillHubHomeSeeds()[e]];this.skillHubHomeResults=UcSkillHubMergeResults(t).slice(0,40),this.skillHubHomeLoaded=!0}catch(e){this.skillHubHomeErrors=[String(e)]}finally{this.skillHubHomeLoading=!1,this.requestUpdate?.()}},this.changeSkillHubTab=e=>{this.skillHubTab=e,this.requestUpdate?.()},this.changeSkillHubCategory=e=>{this.skillHubCategory=e||`all`,this.requestUpdate?.()}}createRenderRoot(){return this}";
  const constructorPatched =
    "this.clawhubSearchTimer=null,this.skillHubTab=`recommended`,this.skillHubCategory=`all`,this.skillHubApiKeyFilter=`all`,this.skillHubSort=`recommended`,this.skillHubPage=1,this.skillHubPageSize=24,this.skillHubTotal=0,this.skillHubPageError=null,this.skillHubHomeResults=null,this.skillHubHomeLoading=!1,this.skillHubHomeErrors=[],this.skillHubHomeLoaded=!1,this.skillHubHomeRequestId=0,this.skillHubLoadMoreMessage=null,this.loadSkillHubPage=async(e=1)=>{let t=Math.max(1,Number(e)||1),n=(this.skillHubHomeRequestId||0)+1;this.skillHubHomeRequestId=n,this.skillHubPage=t,this.skillHubHomeLoading=!0,this.skillHubPageError=null,this.skillHubHomeErrors=[],this.skillHubLoadMoreMessage=`正在加载第 ${t} 页…`,this.requestUpdate?.();try{let e;try{e=await UcSkillHubLoadApiSkills(this,t)}catch(n){e=await UcSkillHubFallbackSkillsSearch(this,t,n)}if(this.skillHubHomeRequestId!==n)return;let r=e.items||[],i=this.skillHubSort===`name`?UcSkillHubApplySort(r,`name`):r;this.skillHubHomeResults=i,this.skillHubTotal=Math.max(0,Number(e.total)||i.length),this.skillHubHomeLoaded=!0,this.skillHubPageError=e.compat?`兼容模式：请重启 U-Claw 以启用完整技能商店分页。`:null,this.skillHubLoadMoreMessage=e.message}catch(e){this.skillHubHomeRequestId===n&&(this.skillHubPageError=String(e),this.skillHubHomeErrors=[String(e)],this.skillHubHomeResults=[],this.skillHubTotal=0,this.skillHubLoadMoreMessage=`第 ${t} 页加载失败，请稍后重试。`)}finally{this.skillHubHomeRequestId===n&&(this.skillHubHomeLoading=!1,this.requestUpdate?.())}},this.loadSkillHubHome=async(e=1)=>this.loadSkillHubPage?.(e),this.reloadSkillHubStore=()=>{this.skillHubPage=1,this.skillHubLoadMoreMessage=null,void this.loadSkillHubPage?.(1)},this.changeSkillHubTab=e=>{this.skillHubTab=e,this.skillHubPage=1,this.skillHubLoadMoreMessage=null,this.requestUpdate?.(),(e===`recommended`||this.clawhubSearchQuery?.trim?.())&&this.reloadSkillHubStore?.()},this.changeSkillHubCategory=e=>{this.skillHubCategory=e||`all`,this.reloadSkillHubStore?.()},this.changeSkillHubApiKeyFilter=e=>{this.skillHubApiKeyFilter=e||`all`,this.reloadSkillHubStore?.()},this.changeSkillHubSort=e=>{this.skillHubSort=e||`recommended`,this.reloadSkillHubStore?.()},this.changeSkillHubPage=e=>{void this.loadSkillHubPage?.(e)}}createRenderRoot(){return this}";
  const legacyHandlerState =
    "this.changeSkillHubTab=e=>{this.skillHubTab=e,this.requestUpdate?.()},this.changeSkillHubCategory=e=>{this.skillHubCategory=e||`all`,this.requestUpdate?.()}";
  const oldHandlerState =
    "this.changeSkillHubTab=e=>{this.skillHubTab=e,this.skillHubVisibleCount=40},this.changeSkillHubCategory=e=>{this.skillHubCategory=e||`all`},this.changeSkillHubApiKeyFilter=e=>{this.skillHubApiKeyFilter=e||`all`},this.changeSkillHubSort=e=>{this.skillHubSort=e||`recommended`},this.loadMoreSkillHub=()=>{this.skillHubVisibleCount=Math.min(320,(this.skillHubVisibleCount||40)+40),this.requestUpdate?.()}";
  const newHandlerState =
    "this.changeSkillHubTab=e=>{this.skillHubTab=e,this.skillHubPage=1,this.skillHubLoadMoreMessage=null,this.requestUpdate?.(),(e===`recommended`||this.clawhubSearchQuery?.trim?.())&&this.reloadSkillHubStore?.()},this.changeSkillHubCategory=e=>{this.skillHubCategory=e||`all`,this.reloadSkillHubStore?.()},this.changeSkillHubApiKeyFilter=e=>{this.skillHubApiKeyFilter=e||`all`,this.reloadSkillHubStore?.()},this.changeSkillHubSort=e=>{this.skillHubSort=e||`recommended`,this.reloadSkillHubStore?.()},this.changeSkillHubPage=e=>{void this.loadSkillHubPage?.(e)}";
  const constructorLeak =
    "this.clawhubInstallSlug=null,this.clawhubInstallMessage=null,this.skillHubHomeResults=null,this.skillHubHomeLoading=!1,this.skillHubHomeErrors=[],this.skillHubHomeLoaded=!1,this.clawhubVerdicts={},this.clawhubVerdictsLoading=!1";
  const constructorLeakClean =
    "this.clawhubInstallSlug=null,this.clawhubInstallMessage=null,this.clawhubVerdicts={},this.clawhubVerdictsLoading=!1";
  const resetOriginal =
    "resetLoadedSkillState(){this.agentsLoading=!1,this.agentsError=null,this.agentsList=null,this.skillsAgentId=null,this.skillsAgentRevision++,this.skillsLoading=!1,this.skillsReport=null,this.skillsError=null,this.skillsBusyKey=null,this.skillEdits={},this.skillMessages={},this.skillsDetailKey=null,this.skillsDetailTab=`overview`,this.clawhubInstallSlug=null,this.clawhubInstallMessage=null,this.clawhubVerdicts={},this.clawhubVerdictsLoading=!1";
  const resetPatched =
    "resetLoadedSkillState(){this.agentsLoading=!1,this.agentsError=null,this.agentsList=null,this.skillsAgentId=null,this.skillsAgentRevision++,this.skillsLoading=!1,this.skillsReport=null,this.skillsError=null,this.skillsBusyKey=null,this.skillEdits={},this.skillMessages={},this.skillsDetailKey=null,this.skillsDetailTab=`overview`,this.clawhubInstallSlug=null,this.clawhubInstallMessage=null,this.skillHubPage=1,this.skillHubPageSize=24,this.skillHubTotal=0,this.skillHubPageError=null,this.skillHubHomeResults=null,this.skillHubHomeLoading=!1,this.skillHubHomeErrors=[],this.skillHubHomeLoaded=!1,this.skillHubHomeRequestId=0,this.skillHubLoadMoreMessage=null,this.clawhubVerdicts={},this.clawhubVerdictsLoading=!1";
  const currentResetPatched =
    "resetLoadedSkillState(){this.agentsLoading=!1,this.agentsError=null,this.agentsList=null,this.skillsAgentId=null,this.skillsAgentRevision++,this.skillsLoading=!1,this.skillsReport=null,this.skillsError=null,this.skillsBusyKey=null,this.skillEdits={},this.skillMessages={},this.skillsDetailKey=null,this.skillsDetailTab=`overview`,this.clawhubInstallSlug=null,this.clawhubInstallMessage=null,this.skillHubVisibleCount=40,this.skillHubHomeResults=null,this.skillHubHomeLoading=!1,this.skillHubHomeErrors=[],this.skillHubHomeLoaded=!1,this.clawhubVerdicts={},this.clawhubVerdictsLoading=!1";
  const renderOriginal =
    "clawhubInstallSlug:this.clawhubInstallSlug,clawhubInstallMessage:this.clawhubInstallMessage,onAgentChange:e=>this.changeAgent(e)";
  const legacyRenderPatched =
    "clawhubInstallSlug:this.clawhubInstallSlug,clawhubInstallMessage:this.clawhubInstallMessage,skillHubTab:this.skillHubTab,skillHubCategory:this.skillHubCategory,skillHubHomeResults:this.skillHubHomeResults,skillHubHomeLoading:this.skillHubHomeLoading,skillHubHomeErrors:this.skillHubHomeErrors,onSkillHubTabChange:e=>this.changeSkillHubTab(e),onSkillHubCategoryChange:e=>this.changeSkillHubCategory(e),onSkillHubRetryHome:()=>void this.loadSkillHubHome?.(),onAgentChange:e=>this.changeAgent(e)";
  const renderPatched =
    "clawhubInstallSlug:this.clawhubInstallSlug,clawhubInstallMessage:this.clawhubInstallMessage,onClawHubInstallMessageClose:()=>{this.clawhubInstallMessage=null,this.requestUpdate?.()},skillHubTab:this.skillHubTab,skillHubCategory:this.skillHubCategory,skillHubApiKeyFilter:this.skillHubApiKeyFilter,skillHubSort:this.skillHubSort,skillHubPage:this.skillHubPage,skillHubPageSize:this.skillHubPageSize,skillHubTotal:this.skillHubTotal,skillHubPageError:this.skillHubPageError,skillHubLoadMoreMessage:this.skillHubLoadMoreMessage,skillHubHomeResults:this.skillHubHomeResults,skillHubHomeLoading:this.skillHubHomeLoading,skillHubHomeErrors:this.skillHubHomeErrors,onSkillHubTabChange:e=>this.changeSkillHubTab(e),onSkillHubCategoryChange:e=>this.changeSkillHubCategory(e),onSkillHubApiKeyFilterChange:e=>this.changeSkillHubApiKeyFilter(e),onSkillHubSortChange:e=>this.changeSkillHubSort(e),onSkillHubPageChange:e=>this.changeSkillHubPage(e),onSkillHubRetryHome:()=>void this.loadSkillHubPage?.(this.skillHubPage||1),onAgentChange:e=>this.changeAgent(e)";
  const currentRenderPatched =
    "clawhubInstallSlug:this.clawhubInstallSlug,clawhubInstallMessage:this.clawhubInstallMessage,onClawHubInstallMessageClose:()=>{this.clawhubInstallMessage=null,this.requestUpdate?.()},skillHubTab:this.skillHubTab,skillHubCategory:this.skillHubCategory,skillHubApiKeyFilter:this.skillHubApiKeyFilter,skillHubSort:this.skillHubSort,skillHubVisibleCount:this.skillHubVisibleCount,skillHubCanLoadMore:this.skillHubCanLoadMore,skillHubHomeResults:this.skillHubHomeResults,skillHubHomeLoading:this.skillHubHomeLoading,skillHubHomeErrors:this.skillHubHomeErrors,onSkillHubTabChange:e=>this.changeSkillHubTab(e),onSkillHubCategoryChange:e=>this.changeSkillHubCategory(e),onSkillHubApiKeyFilterChange:e=>this.changeSkillHubApiKeyFilter(e),onSkillHubSortChange:e=>this.changeSkillHubSort(e),onSkillHubLoadMore:()=>this.loadMoreSkillHub?.(),onSkillHubRetryHome:()=>void this.loadSkillHubHome?.(!1),onAgentChange:e=>this.changeAgent(e)";
  const installHandlerOriginal = "onClawHubInstall:(e,t,n)=>void b(this,e,t,n)";
  const installHandlerPrevious = "onClawHubInstall:(e,t,n)=>{this.syncGatewayState(),void b(this,e,t,n)}";
  const installHandlerPatched = "onClawHubInstall:(e,t,n,r)=>{this.syncGatewayState(),void b(this,e,t,n,r)}";

  for (const file of listSkillsPageAssets()) {
    const before = read(file);
    let after = before.replace(constructorLeak, constructorLeakClean);
    after = after.replace(legacyConstructorPatched, constructorPatched);
    after = after.replace(legacyHandlerState, newHandlerState);
    after = after.replace(oldHandlerState, newHandlerState);
    after = after.replace(constructorOriginal, constructorPatched);
    after = after.replace(
      /this\.clawhubSearchTimer=null,this\.skillHubTab=`recommended`[\s\S]*?\}createRenderRoot\(\)\{return this\}/,
      constructorPatched,
    );
    after = after.replace(resetOriginal, resetPatched);
    after = after.replace(currentResetPatched, resetPatched);
    after = after.replace(
      /resetLoadedSkillState\(\)\{this\.agentsLoading=!1,this\.agentsError=null,this\.agentsList=null,this\.skillsAgentId=null,this\.skillsAgentRevision\+\+,this\.skillsLoading=!1,this\.skillsReport=null,this\.skillsError=null,this\.skillsBusyKey=null,this\.skillEdits=\{\},this\.skillMessages=\{\},this\.skillsDetailKey=null,this\.skillsDetailTab=`overview`,this\.clawhubInstallSlug=null,this\.clawhubInstallMessage=null,this\.skillHubVisibleCount=40[\s\S]*?this\.clawhubVerdicts=\{\},this\.clawhubVerdictsLoading=!1/,
      resetPatched,
    );
    after = after.replace(legacyRenderPatched, renderPatched);
    after = after.replace(currentRenderPatched, renderPatched);
    after = after.replace(
      /clawhubInstallSlug:this\.clawhubInstallSlug,clawhubInstallMessage:this\.clawhubInstallMessage,skillHubTab:this\.skillHubTab[\s\S]*?onAgentChange:e=>this\.changeAgent\(e\)/,
      renderPatched,
    );
    after = after.replace(
      /clawhubInstallSlug:this\.clawhubInstallSlug,clawhubInstallMessage:this\.clawhubInstallMessage,onClawHubInstallMessageClose:\(\)=>\{this\.clawhubInstallMessage=null,this\.requestUpdate\?\.\(\)\},skillHubTab:this\.skillHubTab[\s\S]*?onAgentChange:e=>this\.changeAgent\(e\)/,
      renderPatched,
    );
    after = after.replace(renderOriginal, renderPatched);
    after = after.replaceAll(installHandlerPrevious, installHandlerPatched);
    after = after.replaceAll(installHandlerOriginal, installHandlerPatched);
    after = after.replace(
      "connectedCallback(){super.connectedCallback(),window.addEventListener(`scroll`,this.skillHubWindowScrollHandler,{capture:!0,passive:!0}),window.addEventListener(`resize`,this.skillHubWindowScrollHandler,{passive:!0}),this.syncGatewayState()",
      "connectedCallback(){super.connectedCallback(),this.syncGatewayState()",
    );
    after = after.replace(
      "disconnectedCallback(){window.removeEventListener(`scroll`,this.skillHubWindowScrollHandler,!0),window.removeEventListener(`resize`,this.skillHubWindowScrollHandler),this.stopGatewaySubscription?.()",
      "disconnectedCallback(){this.stopGatewaySubscription?.()",
    );
    if (
      after === before &&
      !before.includes("this.loadSkillHubHome=async") &&
      !before.includes("skillHubHomeResults:this.skillHubHomeResults")
    ) {
      if (!path.basename(file).startsWith("skills-page-")) {
        continue;
      }
      throw new Error(`Could not patch SkillHub store homepage state in ${file}`);
    }

    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Keeps SkillHub marketplace requests identity-safe across duplicate slugs.
 */
function patchSkillsPageSearchIdentityRequests() {
  const searchOriginal = "n.request(`skills.search`,{query:t,limit:20})";
  const searchPatched = "n.request(`skills.search`,{query:t,limit:40})";
  const riskTextOriginal =
    "function Ks(e,t){return t?`${e}\\n\\n${t}`:e}function qs(e){return Ks(`安装前请复核技能商店风险提示。`,e)}";
  const riskTextSkillHubPrevious =
    "function Ks(e,t){return t?`${e}\\n\\n${t}`:e}function qs(e){return Ks(`安装前请复核 SkillHub 风险提示。`,e)}";
  const riskTextPatched =
    "function UcSkillHubRiskText(e){let t=String(e??``).trim();if(!t)return``;let n=[...t.matchAll(/https?:\\/\\/\\S+/g)].map(e=>e[0].replace(/[|)]+$/g,``)),r=[`技能商店安全扫描提示：该版本存在安全发现，安装前请确认你信任来源与用途。`];/suspicious|not clean|risk|blast radius/i.test(t)&&r.push(`原因：安全状态未完全通过，可能包含较大的指令或工具调用权限范围。`);let i=[...new Set(n)];return i.length&&r.push(`相关链接：\\n${i.join(`\\n`)}`),r.join(`\\n\\n`)}function Ks(e,t){let n=UcSkillHubRiskText(t);return n?`${e}\\n\\n${n}`:e}function qs(e){return Ks(`安装前请复核技能商店风险提示。`,e)}";
  const detailOriginal =
    "async function _c(e,t){if(!e.client||!e.connected)return;let n=e.client;e.clawhubDetailSlug=t,e.clawhubDetailLoading=!0,e.clawhubDetailError=null,e.clawhubDetail=null,await rc(()=>t===e.clawhubDetailSlug,()=>n.request(`skills.detail`,{slug:t}),t=>{e.clawhubDetail=t??null},t=>{e.clawhubDetailError=Ws(t)},()=>{e.clawhubDetailLoading=!1})}";
  const refPartsOriginal =
    "function UcSkillHubRefParts(e){let t=typeof e==`string`?e.trim():``;if(t.startsWith(`@`)){let e=t.slice(1).split(`/`);if(e.length===2&&e[0]&&e[1])return{display:t,slug:e[1],ownerHandle:e[0]}}return{display:t,slug:t}}";
  const refPartsPatched =
    "function UcSkillHubRefParts(e){if(e&&typeof e==`object`){let t=e.native?.skill??e,n=e.slug||t?.slug||t?.namespace?.publicSlug||t?.name||``,r=e.ownerHandle||e.owner?.handle||t?.namespace?.handle||t?.ownerHandle||``,i=e.source||t?.source||``,a=r&&n?`@${r}/${n}`:String(n||``),o=i&&i!==`clawhub`?`skillhub`:`clawhub`;return{display:a,slug:String(n||a).trim(),ownerHandle:r,installSource:o,input:e}}let t=typeof e==`string`?e.trim():``;if(t.startsWith(`@`)){let e=t.slice(1).split(`/`);if(e.length===2&&e[0]&&e[1])return{display:t,slug:e[1],ownerHandle:e[0],installSource:`clawhub`,input:t}}return{display:t,slug:t,installSource:`clawhub`,input:t}}";
  const detailPatched =
    "function UcSkillHubRefParts(e){let t=typeof e==`string`?e.trim():``;if(t.startsWith(`@`)){let e=t.slice(1).split(`/`);if(e.length===2&&e[0]&&e[1])return{display:t,slug:e[1],ownerHandle:e[0]}}return{display:t,slug:t}}function UcSkillHubCachedDetail(e,t){let n=UcSkillHubRefParts(t),r=[...(e.skillHubHomeResults??[]),...(e.clawhubSearchResults??[])],i=r.find(e=>{let r=e?.native?.skill??e,i=e?.slug||r?.slug,a=e?.ownerHandle||e?.owner?.handle||r?.namespace?.handle||r?.ownerHandle,o=a&&i?`@${a}/${i}`:i;return n.display&&[e?.id,e?.install?.reference,o].includes(n.display)||i&&i===n.slug&&(!n.ownerHandle||a===n.ownerHandle)});if(!i)return null;let a=i.native?.skill??i,o=i.slug||a.slug||n.slug,s=i.ownerHandle||i.owner?.handle||a.namespace?.handle||a.ownerHandle,c=i.displayName||a.name||o,l=i.summary||a.description_zh||a.description||``,u=Array.isArray(i.categories)?i.categories:Array.isArray(a.subCategories)?[a.category,...a.subCategories.map(e=>e?.name||e?.key)].filter(Boolean):[],d=Array.isArray(i.topics)?i.topics:Array.isArray(a.tags)?a.tags:[];return{skill:{slug:o,displayName:c,summary:l,categories:u,topics:d,labels:i.labels||a.labels||{},homepage:a.homepage,iconUrl:i.iconUrl||a.iconUrl,downloads:i.downloads??a.downloads,stars:i.stars??a.stars},latestVersion:i.version||a.version?{version:i.version||a.version}:null,owner:{handle:s,displayName:i.owner?.displayName||a.namespace?.displayName||s},readmeMarkdown:a.readmeMarkdown||a.readme||l,metadata:{}}}async function _c(e,t){if(!e.client||!e.connected)return;let r=UcSkillHubRefParts(t),n=e.client;e.clawhubDetailSlug=r.display,e.clawhubDetailLoading=!0,e.clawhubDetailError=null,e.clawhubDetail=null;let i=UcSkillHubCachedDetail(e,t);if(i){e.clawhubDetail=i,e.clawhubDetailLoading=!1,e.requestUpdate?.();return}await rc(()=>r.display===e.clawhubDetailSlug,()=>n.request(`skills.detail`,{slug:r.slug}),t=>{e.clawhubDetail=t??null},t=>{e.clawhubDetailError=Ws(t)},()=>{e.clawhubDetailLoading=!1})}";
  const detailUnsafeOwnerHandle =
    "function UcSkillHubRefParts(e){let t=typeof e==`string`?e.trim():``;if(t.startsWith(`@`)){let e=t.slice(1).split(`/`);if(e.length===2&&e[0]&&e[1])return{display:t,slug:e[1],ownerHandle:e[0]}}return{display:t,slug:t}}async function _c(e,t){if(!e.client||!e.connected)return;let r=UcSkillHubRefParts(t),n=e.client;e.clawhubDetailSlug=r.display,e.clawhubDetailLoading=!0,e.clawhubDetailError=null,e.clawhubDetail=null,await rc(()=>r.display===e.clawhubDetailSlug,()=>n.request(`skills.detail`,{slug:r.slug,...r.ownerHandle?{ownerHandle:r.ownerHandle}:{}}),t=>{e.clawhubDetail=t??null},t=>{e.clawhubDetailError=Ws(t)},()=>{e.clawhubDetailLoading=!1})}";
  const detailNoCachePrevious =
    "function UcSkillHubRefParts(e){let t=typeof e==`string`?e.trim():``;if(t.startsWith(`@`)){let e=t.slice(1).split(`/`);if(e.length===2&&e[0]&&e[1])return{display:t,slug:e[1],ownerHandle:e[0]}}return{display:t,slug:t}}async function _c(e,t){if(!e.client||!e.connected)return;let r=UcSkillHubRefParts(t),n=e.client;e.clawhubDetailSlug=r.display,e.clawhubDetailLoading=!0,e.clawhubDetailError=null,e.clawhubDetail=null,await rc(()=>r.display===e.clawhubDetailSlug,()=>n.request(`skills.detail`,{slug:r.slug}),t=>{e.clawhubDetail=t??null},t=>{e.clawhubDetailError=Ws(t)},()=>{e.clawhubDetailLoading=!1})}";
  const installOriginal =
    "async function yc(e,t,n=!1,r){if(!e.client||!e.connected)return;let i=nc(e);e.clawhubInstallSlug=t,e.clawhubInstallMessage=null;try{let a=await e.client.request(`skills.install`,{...ec(e),source:`clawhub`,slug:t,...r?{version:r}:{},...n?{acknowledgeClawHubRisk:!0}:{}});if(!H(e,i)||(await sc(e),!H(e,i)))return;e.clawhubInstallMessage={kind:`success`,text:Ks(a?.message??`已安装 ${t}`,a?.warning)}}catch(n){if(H(e,i)){let r=Gs(n),i=r?.clawhubTrustCode===zs.RISK_ACKNOWLEDGEMENT_REQUIRED;e.clawhubInstallMessage={kind:`error`,text:i?qs(r?.warning):Ks(Ws(n),r?.warning),...i?{acknowledgeSlug:t}:{},...i&&r?.version?{acknowledgeVersion:r.version}:{},...i?{acknowledgeLabel:`Acknowledge risk and install`}:{}}}}finally{H(e,i)&&e.clawhubInstallSlug===t&&(e.clawhubInstallSlug=null)}}";
  const installPatched =
    "async function yc(e,t,n=!1,r,i=!1){if(!e.client||!e.connected)return;let a=UcSkillHubRefParts(t),o=nc(e);e.clawhubInstallSlug=a.display,e.clawhubInstallMessage=null,e.requestUpdate?.();try{let s=await e.client.request(`skills.install`,{...ec(e),source:a.installSource||`clawhub`,slug:a.slug,...r?{version:r}:{},...n?{acknowledgeClawHubRisk:!0}:{},...i?{force:!0}:{}});if(!H(e,o)&&e.clawhubInstallSlug!==a.display)return;e.clawhubInstallMessage={kind:`success`,text:Ks(s?.message??`已安装 ${a.display}`,s?.warning)},e.clawhubInstallSlug===a.display&&(e.clawhubInstallSlug=null),e.requestUpdate?.(),await sc(e).catch(()=>{})}catch(s){if(H(e,o)||e.clawhubInstallSlug===a.display){let c=Gs(s),l=c?.clawhubTrustCode===zs.RISK_ACKNOWLEDGEMENT_REQUIRED,u=Ws(s),f=/eperm.*rename|fs-safe-move/i.test(u),d=!i&&(/already exists|force\\/update/i.test(u)||f),h=f?`Windows 拒绝写入技能安装目录，通常是目录已存在、被占用或杀毒软件正在扫描。请关闭正在使用该技能的窗口或进程后再点“覆盖重装”。\\n\\n原始错误：${u}`:u;e.clawhubInstallMessage={kind:`error`,text:l?qs(c?.warning):Ks(h,c?.warning),...l?{acknowledgeSlug:a.input??a.display}:{},...l&&c?.version?{acknowledgeVersion:c.version}:{},...l?{acknowledgeLabel:`确认风险并安装`}:{},...d?{forceSlug:a.input??a.display,forceLabel:`覆盖重装`}:{},...d&&r?{forceVersion:r}:{}},e.requestUpdate?.()}}finally{e.clawhubInstallSlug===a.display&&(e.clawhubInstallSlug=null,e.requestUpdate?.())}}";
  const installPatchedSlugDisplayPrevious =
    "async function yc(e,t,n=!1,r,i=!1){if(!e.client||!e.connected)return;let a=UcSkillHubRefParts(t),o=nc(e);e.clawhubInstallSlug=a.display,e.clawhubInstallMessage=null,e.requestUpdate?.();try{let s=await e.client.request(`skills.install`,{...ec(e),source:`clawhub`,slug:a.display,...r?{version:r}:{},...n?{acknowledgeClawHubRisk:!0}:{},...i?{force:!0}:{}});if(!H(e,o)&&e.clawhubInstallSlug!==a.display)return;e.clawhubInstallMessage={kind:`success`,text:Ks(s?.message??`Installed ${a.display}`,s?.warning)},e.clawhubInstallSlug===a.display&&(e.clawhubInstallSlug=null),e.requestUpdate?.(),await sc(e).catch(()=>{})}catch(s){if(H(e,o)||e.clawhubInstallSlug===a.display){let c=Gs(s),l=c?.clawhubTrustCode===zs.RISK_ACKNOWLEDGEMENT_REQUIRED,u=Ws(s),d=!i&&/already exists|force\\/update/i.test(u);e.clawhubInstallMessage={kind:`error`,text:l?qs(c?.warning):Ks(u,c?.warning),...l?{acknowledgeSlug:a.display}:{},...l&&c?.version?{acknowledgeVersion:c.version}:{},...l?{acknowledgeLabel:`确认风险并安装`}:{},...d?{forceSlug:a.display,forceLabel:`覆盖重装`}:{},...d&&r?{forceVersion:r}:{}},e.requestUpdate?.()}}finally{e.clawhubInstallSlug===a.display&&(e.clawhubInstallSlug=null,e.requestUpdate?.())}}";
  const installPatchedRefreshBlockingPrevious =
    "async function yc(e,t,n=!1,r,i=!1){if(!e.client||!e.connected)return;let a=UcSkillHubRefParts(t),o=nc(e);e.clawhubInstallSlug=a.display,e.clawhubInstallMessage=null,e.requestUpdate?.();try{let s=await e.client.request(`skills.install`,{...ec(e),source:`clawhub`,slug:a.display,...r?{version:r}:{},...n?{acknowledgeClawHubRisk:!0}:{},...i?{force:!0}:{}});if(!H(e,o)||(await sc(e),!H(e,o)))return;e.clawhubInstallMessage={kind:`success`,text:Ks(s?.message??`Installed ${a.display}`,s?.warning)},e.requestUpdate?.()}catch(s){if(H(e,o)||e.clawhubInstallSlug===a.display){let c=Gs(s),l=c?.clawhubTrustCode===zs.RISK_ACKNOWLEDGEMENT_REQUIRED,u=Ws(s),d=!i&&/already exists|force\\/update/i.test(u);e.clawhubInstallMessage={kind:`error`,text:l?qs(c?.warning):Ks(u,c?.warning),...l?{acknowledgeSlug:a.display}:{},...l&&c?.version?{acknowledgeVersion:c.version}:{},...l?{acknowledgeLabel:`确认风险并安装`}:{},...d?{forceSlug:a.display,forceLabel:`覆盖重装`}:{},...d&&r?{forceVersion:r}:{}},e.requestUpdate?.()}}finally{e.clawhubInstallSlug===a.display&&(e.clawhubInstallSlug=null,e.requestUpdate?.())}}";
  const installPatchedNoRefreshPrevious =
    "async function yc(e,t,n=!1,r,i=!1){if(!e.client||!e.connected)return;let a=UcSkillHubRefParts(t),o=nc(e);e.clawhubInstallSlug=a.display,e.clawhubInstallMessage=null;try{let s=await e.client.request(`skills.install`,{...ec(e),source:`clawhub`,slug:a.display,...r?{version:r}:{},...n?{acknowledgeClawHubRisk:!0}:{},...i?{force:!0}:{}});if(!H(e,o)||(await sc(e),!H(e,o)))return;e.clawhubInstallMessage={kind:`success`,text:Ks(s?.message??`Installed ${a.display}`,s?.warning)}}catch(s){if(H(e,o)||e.clawhubInstallSlug===a.display){let c=Gs(s),l=c?.clawhubTrustCode===zs.RISK_ACKNOWLEDGEMENT_REQUIRED,u=Ws(s),d=!i&&/already exists|force\\/update/i.test(u);e.clawhubInstallMessage={kind:`error`,text:l?qs(c?.warning):Ks(u,c?.warning),...l?{acknowledgeSlug:a.display}:{},...l&&c?.version?{acknowledgeVersion:c.version}:{},...l?{acknowledgeLabel:`确认风险并安装`}:{},...d?{forceSlug:a.display,forceLabel:`覆盖重装`}:{},...d&&r?{forceVersion:r}:{}}}}finally{e.clawhubInstallSlug===a.display&&(e.clawhubInstallSlug=null)}}";
  const installPatchedForcePrevious =
    "async function yc(e,t,n=!1,r,i=!1){if(!e.client||!e.connected)return;let a=UcSkillHubRefParts(t),o=nc(e);e.clawhubInstallSlug=a.display,e.clawhubInstallMessage=null;try{let s=await e.client.request(`skills.install`,{...ec(e),source:`clawhub`,slug:a.display,...r?{version:r}:{},...n?{acknowledgeClawHubRisk:!0}:{},...i?{force:!0}:{}});if(!H(e,o)||(await sc(e),!H(e,o)))return;e.clawhubInstallMessage={kind:`success`,text:Ks(s?.message??`Installed ${a.display}`,s?.warning)}}catch(s){if(H(e,o)){let c=Gs(s),l=c?.clawhubTrustCode===zs.RISK_ACKNOWLEDGEMENT_REQUIRED,u=Ws(s),d=!i&&/already exists|force\\/update/i.test(u);e.clawhubInstallMessage={kind:`error`,text:l?qs(c?.warning):Ks(u,c?.warning),...l?{acknowledgeSlug:a.display}:{},...l&&c?.version?{acknowledgeVersion:c.version}:{},...l?{acknowledgeLabel:`确认风险并安装`}:{},...d?{forceSlug:a.display,forceLabel:`覆盖重装`}:{},...d&&r?{forceVersion:r}:{}}}}finally{H(e,o)&&e.clawhubInstallSlug===a.display&&(e.clawhubInstallSlug=null)}}";
  const installPatchedPrevious =
    "async function yc(e,t,n=!1,r){if(!e.client||!e.connected)return;let a=UcSkillHubRefParts(t),i=nc(e);e.clawhubInstallSlug=a.display,e.clawhubInstallMessage=null;try{let o=await e.client.request(`skills.install`,{...ec(e),source:`clawhub`,slug:a.display,...r?{version:r}:{},...n?{acknowledgeClawHubRisk:!0}:{}});if(!H(e,i)||(await sc(e),!H(e,i)))return;e.clawhubInstallMessage={kind:`success`,text:Ks(o?.message??`Installed ${a.display}`,o?.warning)}}catch(o){if(H(e,i)){let r=Gs(o),i=r?.clawhubTrustCode===zs.RISK_ACKNOWLEDGEMENT_REQUIRED;e.clawhubInstallMessage={kind:`error`,text:i?qs(r?.warning):Ks(Ws(o),r?.warning),...i?{acknowledgeSlug:a.display}:{},...i&&r?.version?{acknowledgeVersion:r.version}:{},...i?{acknowledgeLabel:`确认风险并安装`}:{}}}}finally{H(e,i)&&e.clawhubInstallSlug===a.display&&(e.clawhubInstallSlug=null)}}";

  for (const file of listAssetFiles(/^index-.*\.js$/, "index")) {
    const before = read(file);
    let after = before.replace(searchOriginal, searchPatched);
    after = after.replace(riskTextOriginal, riskTextPatched);
    after = after.replace(riskTextSkillHubPrevious, riskTextPatched);
    after = after
      .replaceAll("SkillHub 安全扫描提示", "技能商店安全扫描提示")
      .replaceAll("安装前请复核 SkillHub 风险提示", "安装前请复核技能商店风险提示");
    after = after.replace(detailOriginal, detailPatched);
    after = after.replace(detailUnsafeOwnerHandle, detailPatched);
    after = after.replace(detailNoCachePrevious, detailPatched);
    after = after.replace(installOriginal, installPatched);
    after = after.replace(installPatchedPrevious, installPatched);
    after = after.replace(installPatchedForcePrevious, installPatched);
    after = after.replace(installPatchedNoRefreshPrevious, installPatched);
    after = after.replace(installPatchedRefreshBlockingPrevious, installPatched);
    after = after.replace(installPatchedSlugDisplayPrevious, installPatched);
    after = after.replaceAll(refPartsOriginal, refPartsPatched);
    after = after.replace(
      /function UcSkillHubRefParts\(e\)\{let t=typeof e==`string`\?e\.trim\(\):``;if\(t\.startsWith\(`@`\)\)\{let e=t\.slice\(1\)\.split\(`\/`\);if\(e\.length===2&&e\[0\]&&e\[1\]\)return\{display:t,slug:e\[1\],ownerHandle:e\[0\]\}\}return\{display:t,slug:t\}\}/g,
      refPartsPatched,
    );
    after = after.replaceAll("source:`clawhub`,slug:a.display", "source:a.installSource||`clawhub`,slug:a.slug");
    after = after.replaceAll("source:`clawhub`,slug:a.slug", "source:a.installSource||`clawhub`,slug:a.slug");
    after = after.replaceAll("acknowledgeSlug:a.display", "acknowledgeSlug:a.input??a.display");
    after = after.replaceAll("acknowledgeSlug:a.slug", "acknowledgeSlug:a.input??a.display");
    after = after.replaceAll("forceSlug:a.display", "forceSlug:a.input??a.display");
    after = after.replaceAll("forceSlug:a.slug", "forceSlug:a.input??a.display");
    after = after.replaceAll("`Installed ${a.display}`", "`已安装 ${a.display}`");
    after = after.replaceAll("`Installed ${t}`", "`已安装 ${t}`");
    after = after.replaceAll("??`Installed`", "??`已安装`");
    after = after.replaceAll("acknowledgeLabel:`Acknowledge risk and install`", "acknowledgeLabel:`确认风险并安装`");
    if (
      after === before &&
      !before.includes(searchPatched) &&
      !before.includes("function UcSkillHubRefParts(")
    ) {
      if (!before.includes("skills.detail") && !before.includes("skills.install") && !before.includes("skills.search")) {
        continue;
      }
      throw new Error(`Could not patch SkillHub identity-safe marketplace requests in ${file}`);
    }

    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Renames skill source groups for U-Claw users while preserving source keys.
 */
function patchSkillsSharedUiCopy() {
  const pairs = [
    ["label:`Workspace Skills`", "label:`工作区技能`"],
    ["label:`Built-in Skills`", "label:`内置依赖`"],
    ["label:`Installed Skills`", "label:`已安装技能商店`"],
    ["label:`已安装 SkillHub`", "label:`已安装技能商店`"],
    ["label:`Extra Skills`", "label:`额外技能`"],
    ["label:`Other Skills`", "label:`其他技能`"],
    ["`disabled`", "`已停用`"],
    ["`blocked by allowlist`", "`未在允许列表中`"],
    ["`blocked by agent filter`", "`被 Agent 技能筛选限制`"],
  ];

  for (const file of listAssetFiles(/^skills-shared-.*\.js$/, "skills-shared")) {
    const before = read(file);
    const after = replacePairs(before, pairs);
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Localizes high-value chat status labels and aria copy.
 */
function patchChatUiCopy() {
  const pairs = [
    ["Loading chat", "正在加载会话"],
    ["Run status:", "运行状态："],
    ["Sending message...", "正在发送消息..."],
    [" is working...", " 正在处理..."],
    ["`OpenClaw tool call failed`", "`U-Claw tool call failed`"],
    ["`OpenClaw tool call timed out`", "`U-Claw tool call timed out`"],
    ["`OpenClaw tool call aborted`", "`U-Claw tool call aborted`"],
    ["`OpenClaw finished with no text.`", "`U-Claw 运行结束但未返回文本。`"],
    ["`OpenClaw realtime tool call did not return a run id`", "`U-Claw realtime tool call did not return a run id`"],
    [
      "`Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.`",
      "`简短告知用户正在检查，然后等待最终 U-Claw 结果再回答。`",
    ],
    ["New messages", "新消息"],
    ["Remove queued message", "移除排队消息"],
    ["Cancel reply", "取消回复"],
    ["Not saved to chat history", "未保存到会话历史"],
    ["Replying to", "正在回复"],
    ["BTW side result", "临时结果"],
    ["e.assistantName||`OpenClaw`", "e.assistantName||`U-Claw`"],
    ["t?.name?.trim()||`Assistant`", "t?.name?.trim()||`U-Claw`"],
    ["e.assistantName||`Assistant`", "e.assistantName&&e.assistantName!==`Assistant`?e.assistantName:`U-Claw`"],
    ["assistantName:e.assistantName,assistantAvatar", "assistantName:e.assistantName===`Assistant`?`U-Claw`:e.assistantName,assistantAvatar"],
    ["A(`chat.composer.placeholder`,{name:e.assistantName||`agent`})", "A(`chat.composer.placeholder`,{name:e.assistantName&&e.assistantName!==`Assistant`?e.assistantName:`U-Claw`})"],
    [
      "return l=fi(l),{role:n,content:l,timestamp:f",
      "return l=fi(l).map(e=>e&&e.type===`text`&&e.text===[`The agent run failed before`,`producing a reply.`].join(` `)?{...e,text:`Agent 运行在生成回复前失败。`}:e),{role:n,content:l,timestamp:f",
    ],
    [
      "return l=fi(l).map(e=>e&&e.type===`text`&&e.text===`The agent run failed before producing a reply.`?{...e,text:`Agent 运行在生成回复前失败。`}:e),{role:n,content:l,timestamp:f",
      "return l=fi(l).map(e=>e&&e.type===`text`&&e.text===[`The agent run failed before`,`producing a reply.`].join(` `)?{...e,text:`Agent 运行在生成回复前失败。`}:e),{role:n,content:l,timestamp:f",
    ],
    ["Asking OpenClaw...", "正在询问 U-Claw..."],
    ["Preparing model...", "正在准备模型..."],
    [" is responding...", " 正在回复..."],
    ["Connecting voice input...", "正在连接语音输入..."],
    ["Listening...", "正在聆听..."],
    ["Starting new session...", "正在创建新会话..."],
    ["Resetting session...", "正在重置会话..."],
    ["Stopping current run...", "正在停止当前运行..."],
    ["Chat history cleared.", "会话历史已清空。"],
    ["Exporting session...", "正在导出会话..."],
    ["Unknown command: ", "未知命令："],
    ["**Available Commands**", "**可用命令**"],
    ["• Help – Show usage guide", "• 帮助 - 显示使用指南"],
    ["description:`Show available commands.`", "description:`显示可用命令。`"],
    ["description:`List all slash commands.`", "description:`列出全部 slash commands。`"],
    ["description:`List available runtime tools.`", "description:`列出当前可用 runtime tools。`"],
    ["description:`compact or verbose`", "description:`compact 或 verbose`"],
    ["description:`Run a skill by name.`", "description:`运行指定技能。`"],
    ["description:`Skill name`", "description:`技能名称`"],
    ["description:`Skill input`", "description:`技能输入`"],
    [
      "description:`Draft a reusable skill from recent work or named sources.`",
      "description:`从近期工作或指定来源草拟可复用技能。`",
    ],
    ["description:`Sources and requirements for the skill draft`", "description:`技能草稿的来源与要求`"],
    ["description:`Show current status.`", "description:`显示当前状态。`"],
    ["description:`Show or control the current goal.`", "description:`显示或控制当前目标。`"],
    ["description:`Pair Codex login.`", "description:`配对 Codex 登录。`"],
    ["description:`Provider to pair`", "description:`要配对的 provider`"],
    ["description:`Control text-to-speech (TTS).`", "description:`控制 text-to-speech (TTS)。`"],
    ["description:`TTS action`", "description:`TTS 动作`"],
    ["description:`Provider, limit, or text`", "description:`Provider、limit 或文本`"],
    [
      "TTS Actions:\n• On – Enable TTS for responses\n• Off – Disable TTS\n• Status – Show current settings\n• Provider – Show or set the voice provider\n• Limit – Set max characters for TTS\n• Summary – Toggle AI summary for long texts\n• Audio – Generate TTS from custom text\n• 帮助 - 显示使用指南",
      "TTS 动作：\n• On - 启用回复朗读\n• Off - 关闭朗读\n• Status - 查看当前设置\n• Provider - 查看或设置语音 provider\n• Limit - 设置 TTS 最大字符数\n• Summary - 切换长文本 AI 摘要\n• Audio - 从自定义文本生成 TTS\n• 帮助 - 显示使用指南",
    ],
    ["description:`Restart OpenClaw.`", "description:`Restart U-Claw.`"],
    ["description:`Clear chat history`", "description:`清空会话历史`"],
    ["description:`Abort and restart with a new message`", "description:`中止并用新消息重启`"],
    ["hp={steer:`Inject a message into the active run`}", "hp={steer:`向当前运行注入消息`}"],
    ["description:`Show your sender id.`", "description:`显示你的发送者 ID。`"],
    ["description:`Manage session-level settings (for example /session idle).`", "description:`管理会话级设置，例如 /session idle。`"],
    ["description:`Duration (24h, 90m) or off`", "description:`时长，如 24h、90m，或 off`"],
    ["description:`Inspect subagent runs for this session.`", "description:`查看此会话的子智能体运行。`"],
    ["description:`Run id, index, or session key`", "description:`运行 ID、序号或会话 key`"],
    ["description:`Additional input (limit/message)`", "description:`额外输入，如 limit/message`"],
    ["description:`Manage ACP sessions and runtime options.`", "description:`管理 ACP 会话与运行选项。`"],
    ["description:`Action to run`", "description:`要执行的动作`"],
    ["description:`Action arguments`", "description:`动作参数`"],
    [
      "description:`Bind this thread (Discord) or topic/conversation (Telegram) to a session target.`",
      "description:`将当前 thread/topic/conversation 绑定到会话目标。`",
    ],
    [
      "description:`Remove the current thread (Discord) or topic/conversation (Telegram) binding.`",
      "description:`移除当前 thread/topic/conversation 绑定。`",
    ],
    ["description:`List thread-bound agents for this session.`", "description:`列出此会话绑定的智能体。`"],
    ["description:`Send guidance to the active run in this session.`", "description:`向此会话的当前运行发送指引。`"],
    ["description:`Steering message`", "description:`指引消息`"],
    ["description:`Show or set config values.`", "description:`查看或设置配置值。`"],
    ["description:`Config path`", "description:`配置路径`"],
    ["description:`Value for set`", "description:`要设置的值`"],
    ["description:`Show or set OpenClaw MCP servers.`", "description:`查看或设置 U-Claw MCP servers。`"],
    ["description:`MCP server name`", "description:`MCP server 名称`"],
    ["description:`JSON config for set`", "description:`要设置的 JSON 配置`"],
    ["description:`List, show, enable, or disable plugins.`", "description:`列出、查看、启用或停用插件。`"],
    ["description:`Plugin id or name`", "description:`插件 ID 或名称`"],
    ["description:`Set runtime debug overrides.`", "description:`设置运行时 debug 覆盖项。`"],
    ["description:`Debug path`", "description:`Debug 路径`"],
    ["description:`Usage footer or cost summary.`", "description:`用量页脚或费用摘要。`"],
    ["description:`off, tokens, full, or cost`", "description:`off、tokens、full 或 cost`"],
    ["description:`Stop the current run.`", "description:`停止当前运行。`"],
    ["description:`Restart U-Claw.`", "description:`重启 U-Claw。`"],
    ["description:`Set group activation mode.`", "description:`设置群组激活模式。`"],
    ["description:`mention or always`", "description:`mention 或 always`"],
    ["description:`Set send policy.`", "description:`设置发送策略。`"],
    ["description:`on, off, or inherit`", "description:`on、off 或 inherit`"],
    ["description:`Reset the current session.`", "description:`重置当前会话。`"],
    ["description:`Start a new session.`", "description:`开始新会话。`"],
    ["description:`Name or rename the current session.`", "description:`命名或重命名当前会话。`"],
    ["description:`New session name (omit to see a suggestion)`", "description:`新会话名称；留空则查看建议`"],
    ["description:`Compact the session context.`", "description:`压缩会话上下文。`"],
    ["description:`Extra compaction instructions`", "description:`额外压缩指令`"],
    ["description:`Set thinking level.`", "description:`设置 thinking level。`"],
    ["description:`Thinking level`", "description:`Thinking level`"],
    ["description:`Toggle verbose mode.`", "description:`切换 verbose mode。`"],
    ["description:`on, off, or full`", "description:`on、off 或 full`"],
    ["description:`Toggle plugin trace lines.`", "description:`切换插件 trace lines。`"],
    ["description:`on, off, or raw`", "description:`on、off 或 raw`"],
    ["description:`Toggle fast mode.`", "description:`切换 fast mode。`"],
    ["description:`on, off, auto, default, or status`", "description:`on、off、auto、default 或 status`"],
    ["description:`Toggle reasoning visibility.`", "description:`切换 reasoning 可见性。`"],
    ["description:`on, off, or stream`", "description:`on、off 或 stream`"],
    ["description:`Toggle elevated mode.`", "description:`切换 elevated mode。`"],
    ["description:`on, off, ask, or full`", "description:`on、off、ask 或 full`"],
    ["description:`Set exec defaults for this session.`", "description:`设置此会话的 exec 默认值。`"],
    ["description:`sandbox, gateway, or node`", "description:`sandbox、gateway 或 node`"],
    ["description:`deny, allowlist, or full`", "description:`deny、allowlist 或 full`"],
    ["description:`off, on-miss, or always`", "description:`off、on-miss 或 always`"],
    ["description:`Node id or name`", "description:`Node ID 或名称`"],
    ["description:`Show or set the model.`", "description:`查看或设置模型。`"],
    ["description:`Model id (provider/model or id)`", "description:`模型 ID，即 provider/model 或 id`"],
    ["description:`List model providers/models.`", "description:`列出模型 providers/models。`"],
    ["description:`Adjust queue settings.`", "description:`调整队列设置。`"],
    ["description:`queue mode`", "description:`队列模式`"],
    ["description:`debounce duration (e.g. 500ms, 2s)`", "description:`debounce 时长，如 500ms、2s`"],
    ["description:`queue cap`", "description:`队列上限`"],
    ["description:`drop policy`", "description:`丢弃策略`"],
    ["description:`Run host shell commands (host-only).`", "description:`运行宿主机 shell 命令（仅 host）。`"],
    ["description:`Shell command`", "description:`Shell 命令`"],
    ["description:`Subagent label/index or session key/id/label`", "description:`子智能体标签/序号或会话 key/id/label`"],
    ["`Start a new session after the active run or queued messages finish.`", "`当前运行或排队消息完成后再开始新会话。`"],
    ["`Session list is still refreshing. Try New Chat again in a moment.`", "`会话列表仍在刷新，请稍后再试新建会话。`"],
    ["`New Chat could not create a new session. Try again in a moment.`", "`新会话创建失败，请稍后重试。`"],
    ["`Failed to list agents: ${String(e)}`", "`列出智能体失败：${String(e)}`"],
    ["`Session capability is unavailable`", "`会话能力不可用`"],
    ["`The active run ended before the steer message was accepted.`", "`当前运行在接收 steer 消息前已结束。`"],
    ["`Steer failed before it reached the run; try again.`", "`Steer 消息未送达运行，请重试。`"],
    ["`The active run ended before the redirect message was accepted.`", "`当前运行在接收 redirect 消息前已结束。`"],
    ["`Redirect failed before it reached the run; try again.`", "`Redirect 消息未送达运行，请重试。`"],
    ["\"No active run. Use the chat input or `/redirect` instead.\"", "\"当前无运行。请使用聊天输入框或 `/redirect`。\""],
    ["`Steered.`", "`已发送指引。`"],
    ["`Redirected.`", "`已重定向。`"],
    ["`Failed to steer: ${String(e)}`", "`发送指引失败：${String(e)}`"],
    ["`Failed to redirect: ${String(e)}`", "`重定向失败：${String(e)}`"],
    ["\"Usage: `/steer <message>`\"", "\"用法：`/steer <message>`\""],
    ["\"Usage: `/redirect <message>`\"", "\"用法：`/redirect <message>`\""],
    ["`New Chat is unavailable.`", "`新建会话不可用。`"],
    ["`Gateway not connected`", "`Gateway 未连接`"],
    [
      "`Cannot run \\`/${t}\\`: Control UI is not connected to the Gateway.`",
      "`无法运行 \\`/${t}\\`：界面尚未连接 Gateway。`",
    ],
    ["`Command \\`/${t}\\` failed unexpectedly.`", "`命令 \\`/${t}\\` 异常失败。`"],
    ["`Failed to set speed: ${String(t)}`", "`设置速度失败：${String(t)}`"],
    ["`Failed to set model: ${String(t)}`", "`设置模型失败：${String(t)}`"],
    ["`Failed to set thinking level: ${String(t)}`", "`设置 thinking level 失败：${String(t)}`"],
    ["`Chat failed before the run started; try again.`", "`运行开始前聊天失败，请重试。`"],
    ["`The run ended before the message was accepted.`", "`运行在接收消息前已结束。`"],
    ["`The active run ended before the detached message was accepted.`", "`当前运行在接收 detached 消息前已结束。`"],
    ["`Attached image: ${t}`", "`已附加图片：${t}`"],
    ["`Attached image`", "`已附加图片`"],
    ["`Attached file`", "`已附加文件`"],
    ["`Skill Workshop revision requests do not support attachments.`", "`Skill Workshop 修订请求不支持附件。`"],
    ["`Message will send when the Gateway reconnects.`", "`Gateway 重连后将发送消息。`"],
    ["`Start a new session? This will reset the current chat.`", "`开始新会话？这会重置当前聊天。`"],
  ];

  for (const file of listAssetFiles(/^chat-page-.*\.js$/, "chat-page")) {
    const before = read(file);
    const after = replacePairs(before, pairs);
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Keeps the default assistant identity branded when the runtime omits agent metadata.
 */
function patchAssistantIdentityUiCopy() {
  const pairs = [
    ["Wm=`Assistant`", "Wm=`U-Claw`"],
    ["var Wm=`Assistant`", "var Wm=`U-Claw`"],
    [
      "assistantIdentity:{agentId:null,name:`Assistant`,avatar:null,avatarSource:null,avatarStatus:null,avatarReason:null}",
      "assistantIdentity:{agentId:null,name:`U-Claw`,avatar:null,avatarSource:null,avatarStatus:null,avatarReason:null}",
    ],
  ];

  for (const file of listAssetFiles(/^(?:index|chat-page)-.*\.js$/, "index or chat-page")) {
    const before = read(file);
    const after = replacePairs(before, pairs);
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Adds a SkillHub dropdown beside the model selector while binding through Agent skills.
 */
function patchChatSkillHubDropdown() {
  const helper = `function UcSkillHubItems(e){return(e.report?.skills??[]).filter(e=>e&&typeof e.name==\`string\`&&e.name.trim()&&!(e?.source===\`openclaw-bundled\`||e?.bundled===!0))}function UcSkillHubHasCjk(e){return/[\\u3400-\\u9fff]/.test(String(e??\`\`))}function UcSkillHubTextCandidates(e){return e.flat(3).map(e=>String(e??\`\`).trim()).filter(Boolean)}function UcSkillHubPickChinese(e){let t=UcSkillHubTextCandidates(e);return t.find(UcSkillHubHasCjk)||t[0]||\`\`}function UcSkillHubChineseTitle(e){let t=UcSkillHubPickChinese([e.displayName,e.display_name,e.title,e.label,e.name_zh,e.nameZh,e.metadata?.displayName,e.metadata?.title,e.native?.skill?.displayName,e.native?.skill?.title,e.name,e.slug]);if(UcSkillHubHasCjk(t))return t;let n=UcSkillHubPickChinese([e.description_zh,e.summary_zh,e.descriptionZh,e.summaryZh,e.metadata?.description_zh,e.metadata?.summary_zh,e.native?.skill?.description_zh,e.native?.skill?.summary_zh,e.description,e.summary,e.metadata?.description,e.native?.skill?.description]);let r=String(n).split(/[：:。.!?；;\\n]/)[0]?.trim();return UcSkillHubHasCjk(r)&&r.length<=18?r:t}function UcSkillHubLabel(e){return UcSkillHubChineseTitle(e)||e.name}function UcSkillHubNormalizeText(e){let t=String(e??\`\`).trim();if(!t)return\`\`;let n=t.replaceAll(\`OpenClaw\`,\`U-Claw\`).replaceAll(\`ClawHub\`,\`SkillHub\`);if(/controlling web pages/i.test(n)&&/browser tool/i.test(n))return\`用于控制网页、处理多步骤流程、登录检查、标签页管理与失败恢复。\`;if(/connected .*node canvases/i.test(n)||/node canvases/i.test(n))return\`在已连接的 U-Claw 节点画布上展示 HTML，支持导航、快照与调试。\`;if(/^Use when\\b/i.test(n))return\`适用：\${n.replace(/^Use when\\s*/i,\`\`)}\`;return n}function UcSkillHubDescription(e){return UcSkillHubNormalizeText(UcSkillHubPickChinese([e.description_zh,e.summary_zh,e.descriptionZh,e.summaryZh,e.metadata?.description_zh,e.metadata?.summary_zh,e.native?.skill?.description_zh,e.native?.skill?.summary_zh,e.description,e.summary,e.metadata?.description,e.native?.skill?.description,e.source,\`技能商店技能\`]))}function UcSkillHubDropdown(e){let t=UcSkillHubItems(e),n=e.selectedSkill||\`\`,r=t.find(e=>e.name===n),i=!e.connected?\`技能暂不可用\`:e.loading?\`加载中…\`:r?UcSkillHubLabel(r):n||\`选择你的技能\`,a=!e.connected||e.saving,o=e.error||e.notice;return s\`
    <details
      class="chat-controls__session chat-controls__inline-select chat-controls__skillhub"
      @toggle=\${t=>{t.currentTarget.open&&e.onOpen?.()}}
    >
      <summary
        class="chat-controls__inline-select-trigger \${a?\`chat-controls__inline-select-trigger--disabled\`:\`\`}"
        data-chat-skillhub-select="true"
        data-chat-select-value=\${n}
        aria-label=\${\`选择你的技能：\${i}\`}
        aria-disabled=\${a?\`true\`:\`false\`}
        @click=\${e=>{a&&e.preventDefault()}}
      >
        <span class="chat-controls__inline-select-label">\${i}</span>
        <span class="chat-controls__inline-select-icon" aria-hidden="true">
          \${e.saving?z.loader:z.chevronDown}
        </span>
      </summary>
      <div
        class="chat-controls__inline-select-menu"
        aria-label="技能商店"
      >
        <div class="chat-controls__inline-select-section-label">技能商店</div>
        \${e.loading?s\`<div class="chat-controls__inline-select-empty">正在加载技能商店技能…</div>\`:t.length===0?s\`<div class="chat-controls__inline-select-empty">未找到可用于聊天的技能商店技能。</div>\`:l(t,u=>u.name,u=>s\`
              <button
                class="chat-controls__inline-select-option \${u.name===n?\`chat-controls__inline-select-option--selected\`:\`\`}"
                data-chat-skillhub-option=\${u.name}
                type="button"
                role="option"
                aria-selected=\${u.name===n?\`true\`:\`false\`}
                ?disabled=\${a}
                @click=\${t=>{if(t.preventDefault(),t.stopPropagation(),a)return;e.onSelect?.(u.name),t.currentTarget.closest(\`details\`)?.removeAttribute(\`open\`)}}
              >
                <span class="chat-controls__model-option-copy">
                  <span class="chat-controls__model-option-title">\${UcSkillHubLabel(u)}</span>
                  <span class="chat-controls__model-option-provider">\${UcSkillHubDescription(u)}</span>
                </span>
                <span
                  class="chat-controls__inline-select-check"
                  aria-hidden="true"
                  ?hidden=\${u.name!==n}
                >
                  \${z.check}
                </span>
              </button>
            \`)}
        \${o?s\`<div class="chat-controls__inline-select-section-label">\${o}</div>\`:c}
      </div>
    </details>
  \`}`;
  const helperDropdownStart = helper.indexOf("function UcSkillHubDropdown(e){");
  const helperPrefix = helper.slice(0, helperDropdownStart);

  const constructorState =
    "this.unreadPatchGuard=new sn,this.uclawSkillHubReport=null,this.uclawSkillHubAgentId=null,this.uclawSkillHubLoading=!1,this.uclawSkillHubSaving=!1,this.uclawSkillHubError=null,this.uclawSkillHubNotice=null,this.uclawSkillHubSelected=``,this.loadUclawSkillHubSkills=async e=>{let t=this.state;if(!t?.client||!t.connected||!e)return;this.uclawSkillHubAgentId===e&&this.uclawSkillHubReport&&!this.uclawSkillHubError||(this.uclawSkillHubAgentId=e,this.uclawSkillHubLoading=!0,this.uclawSkillHubError=null,this.requestUpdate?.(),await t.client.request(`skills.status`,{agentId:e}).then(t=>{this.state&&x_(this.state)===e&&(this.uclawSkillHubReport=t,this.uclawSkillHubAgentId=e)}).catch(e=>{this.uclawSkillHubError=`技能暂不可用：${e instanceof Error?e.message:String(e)}`}).finally(()=>{this.uclawSkillHubLoading=!1,this.requestUpdate?.()}))},this.selectUclawSkillHubSkill=async(e,t)=>{let n=this.state,r=t?.trim?.()??``;if(!n?.connected||!r||this.uclawSkillHubSaving)return;let i=this.context.runtimeConfig;if(!i)return this.uclawSkillHubError=`技能配置服务不可用`,this.requestUpdate?.();this.uclawSkillHubSaving=!0,this.uclawSkillHubError=null,this.uclawSkillHubNotice=null,this.requestUpdate?.();let a=-1,o=!1,s=[];try{await i.ensureLoaded(),a=i.ensureAgentEntry(e);if(a<0)throw Error(`无法创建 Agent 技能配置`);let t=i.state.configForm??i.state.configSnapshot?.config,n=Array.isArray(t?.agents?.list)?t.agents.list[a]:void 0,c=Array.isArray(n?.skills)?n.skills.filter(e=>typeof e==`string`&&e.trim()).map(e=>e.trim()):null;o=Array.isArray(c),s=o?c:[];let l=[...new Set([...s,r])];i.patchForm([`agents`,`list`,a,`skills`],l);let u=await i.save();if(u===!1)throw Error(i.state.lastError??`保存失败`);await this.context.agents.refreshList(),this.uclawSkillHubSelected=r,this.uclawSkillHubNotice=`已保存，新会话生效`}catch(e){try{a>=0&&(o?i.patchForm([`agents`,`list`,a,`skills`],s):i.removeFormValue?.([`agents`,`list`,a,`skills`]))}catch{}this.uclawSkillHubError=`保存技能选择失败：${e instanceof Error?e.message:String(e)}`}finally{this.uclawSkillHubSaving=!1,this.requestUpdate?.()}},this.handleCommandPaletteSlashCommand=";
  const legacyConstructorState =
    "this.unreadPatchGuard=new sn,this.uclawSkillHubReport=null,this.uclawSkillHubAgentId=null,this.uclawSkillHubLoading=!1,this.uclawSkillHubSaving=!1,this.uclawSkillHubError=null,this.uclawSkillHubNotice=null,this.uclawSkillHubSelected=``,this.loadUclawSkillHubSkills=async e=>{let t=this.state;if(!t?.client||!t.connected||!e)return;this.uclawSkillHubAgentId===e&&this.uclawSkillHubReport&&!this.uclawSkillHubError||(this.uclawSkillHubAgentId=e,this.uclawSkillHubLoading=!0,this.uclawSkillHubError=null,this.requestUpdate?.(),await t.client.request(`skills.status`,{agentId:e}).then(t=>{this.state&&x_(this.state)===e&&(this.uclawSkillHubReport=t,this.uclawSkillHubAgentId=e)}).catch(e=>{this.uclawSkillHubError=`技能商店暂不可用：${e instanceof Error?e.message:String(e)}`}).finally(()=>{this.uclawSkillHubLoading=!1,this.requestUpdate?.()}))},this.selectUclawSkillHubSkill=async(e,t)=>{let n=this.state,r=t?.trim?.()??``;if(!n?.connected||!r||this.uclawSkillHubSaving)return;let i=this.context.runtimeConfig;if(!i)return this.uclawSkillHubError=`技能配置服务不可用`,this.requestUpdate?.();this.uclawSkillHubSaving=!0,this.uclawSkillHubError=null,this.uclawSkillHubNotice=null,this.requestUpdate?.();try{await i.ensureLoaded();let t=i.ensureAgentEntry(e);if(t<0)throw Error(`无法创建 Agent 技能配置`);i.patchForm([`agents`,`list`,t,`skills`],[r]);let a=await i.save();if(a===!1)throw Error(i.state.lastError??`保存失败`);await this.context.agents.refreshList(),this.uclawSkillHubSelected=r,this.uclawSkillHubNotice=`已保存，新会话生效`}catch(e){this.uclawSkillHubError=`保存技能选择失败：${e instanceof Error?e.message:String(e)}`}finally{this.uclawSkillHubSaving=!1,this.requestUpdate?.()}},this.handleCommandPaletteSlashCommand=";

  for (const file of listAssetFiles(/^chat-page-.*\.js$/, "chat-page")) {
    let source = read(file);
    source = source.replaceAll("`SkillHub skill`", "`技能商店技能`");
    source = source
      .replaceAll("aria-label=\"SkillHub\"", "aria-label=\"技能商店\"")
      .replaceAll("SkillHub：${i}", "技能商店：${i}")
      .replaceAll(">SkillHub<", ">技能商店<")
      .replaceAll("正在加载 SkillHub 技能…", "正在加载技能商店技能…")
      .replaceAll("未找到可用于聊天的 SkillHub 技能。", "未找到可用于聊天的技能商店技能。")
      .replaceAll("`SkillHub 技能`", "`技能商店技能`")
      .replaceAll("replaceAll(`ClawHub`,`SkillHub`)", "replaceAll(`ClawHub`,`技能商店`)");
    source = source.replaceAll("n||`选择 Skill`", "n||`选择你的技能`");
    source = source.replaceAll(
      "i=e.loading?`加载中…`:r?UcSkillHubLabel(r):n||`选择你的技能`",
      "i=!e.connected?`技能暂不可用`:e.loading?`加载中…`:r?UcSkillHubLabel(r):n||`选择你的技能`",
    );
    source = source.replaceAll("n||`选择你的技能`", "n||`选择你的技能`");
    source = source.replaceAll("`技能暂不可用`", "`技能暂不可用`");
    source = source.replaceAll("技能商店暂不可用：${e instanceof Error?e.message:String(e)}", "技能暂不可用：${e instanceof Error?e.message:String(e)}");
    source = source.replaceAll("`技能配置服务不可用`", "`技能配置服务不可用`");
    source = source.replaceAll("`保存技能选择失败：${e instanceof Error?e.message:String(e)}`", "`保存技能选择失败：${e instanceof Error?e.message:String(e)}`");
    source = source.replaceAll("保存技能选择失败：${e instanceof Error?e.message:String(e)}", "保存技能选择失败：${e instanceof Error?e.message:String(e)}");
    source = source.replaceAll(
      "i=!e.connected?`技能暂不可用`:e.loading?`加载中…`:r?UcSkillHubLabel(r):n||`选择你的技能`",
      "i=!e.connected?`技能暂不可用`:e.loading?`加载中…`:r?UcSkillHubLabel(r):n||`选择你的技能`",
    );
    source = source
      .replaceAll("l(t,e=>e.name,e=>s`", "l(t,u=>u.name,u=>s`")
      .replaceAll("e.name===n", "u.name===n")
      .replaceAll("data-chat-skillhub-option=${e.name}", "data-chat-skillhub-option=${u.name}")
      .replaceAll("e.onSelect?.(e.name)", "e.onSelect?.(u.name)")
      .replaceAll("UcSkillHubLabel(e)", "UcSkillHubLabel(u)")
      .replaceAll("UcSkillHubDescription(e)", "UcSkillHubDescription(u)");
    source = source.replaceAll("t.find(e=>u.name===n)", "t.find(e=>e.name===n)");
    source = source.replace(
      /function UcSkillHubItems\(e\)\{[\s\S]*?\}function UcSkillHubDropdown\(e\)\{/,
      `${helperPrefix}function UcSkillHubDropdown(e){`,
    );
    source = source.replaceAll(legacyConstructorState, constructorState);

    if (!source.includes("function UcSkillHubDropdown(")) {
      if (!source.includes("function Dw(e){")) {
        throw new Error(`Could not locate composer controls helper in ${file}`);
      }
      source = source.replace("function Dw(e){", `${helper}function Dw(e){`);
    }

    if (!source.includes("this.loadUclawSkillHubSkills=async")) {
      const original = "this.unreadPatchGuard=new sn,this.handleCommandPaletteSlashCommand=";
      if (!source.includes(original)) {
        throw new Error(`Could not locate chat pane constructor state in ${file}`);
      }
      source = source.replace(original, constructorState);
    }

    if (!source.includes("skillHub:{agentId:t")) {
      const original =
        "composerControls:Dw({paneId:this.paneId,agentsList:e.agentsList,connected:e.connected,";
      const patched =
        "composerControls:Dw({paneId:this.paneId,agentsList:e.agentsList,connected:e.connected,skillHub:{agentId:t,connected:e.connected&&!!e.client,report:this.uclawSkillHubAgentId===t?this.uclawSkillHubReport:null,loading:this.uclawSkillHubAgentId===t&&this.uclawSkillHubLoading,saving:this.uclawSkillHubSaving,error:this.uclawSkillHubError,notice:this.uclawSkillHubNotice,selectedSkill:this.uclawSkillHubSelected,onOpen:()=>this.loadUclawSkillHubSkills(t),onSelect:e=>this.selectUclawSkillHubSkill(t,e)},";
      if (!source.includes(original)) {
        throw new Error(`Could not inject SkillHub props into chat composer in ${file}`);
      }
      source = source.replace(original, patched);
    }

    if (!source.includes("UcSkillHubDropdown(e.skillHub)")) {
      const original = `    <div
      class="chat-composer-model-control"`;
      const patched = `    \${e.skillHub?UcSkillHubDropdown(e.skillHub):c}
    <div
      class="chat-composer-model-control"`;
      if (!source.includes(original)) {
        throw new Error(`Could not locate model selector container in ${file}`);
      }
      source = source.replace(original, patched);
    }

    const before = read(file);
    if (writeIfChanged(file, before, source)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Localizes Agents page labels around overview and skill allowlists.
 */
function patchAgentsPageUiCopy() {
  const recoveryPairs = [
    ["agent技能", "agentSkills"],
    ["skills筛选", "skillsFilter"],
    ["on技能", "onSkills"],
    ["技能Refresh", "SkillsRefresh"],
    ["技能Loading", "SkillsLoading"],
    ["技能Error", "SkillsError"],
    ["技能Report", "SkillsReport"],
    ["技能AgentId", "SkillsAgentId"],
    ["onSkills筛选Change", "onSkillsFilterChange"],
    ["agent运行时", "agentRuntime"],
    ["按 Agent 管理可见Skills与工作区Skills，保存后生效。", "按 Agent 管理可见技能与工作区技能，保存后生效。"],
    ["搜索Skills", "搜索技能"],
    ["未找到Skills", "未找到技能"],
  ];
  const pairs = [
    ["<div class=\"card-title\">Overview</div>", "<div class=\"card-title\">概览</div>"],
    ["Workspace paths and identity metadata.", "工作区路径与身份信息。"],
    ["Primary Model", "主模型"],
    ["Skills Filter", "技能筛选"],
    ["Model Selection", "模型选择"],
    ["provider/model", "provider/model"],
    ["<div class=\"card-title\">Skills</div>", "<div class=\"card-title\">技能</div>"],
    [
      "Per-agent skill allowlist and workspace skills.",
      "按 Agent 管理可见技能与工作区技能，保存后生效。",
    ],
    ["Enable All", "全部启用"],
    ["Disable All", "全部停用"],
    ["Search skills", "搜索技能"],
    ["No skills found.", "未找到技能。"],
    ["Missing:", "缺少："],
    ["Reason:", "原因："],
    ["?`Saving…`:`Save`", "?`保存中…`:`保存`"],
    ["Not set", "未设置"],
    ["Fallbacks", "备用模型"],
    ["<div class=\"label\">SkillsFilter</div>", "<div class=\"label\">技能筛选</div>"],
    ["`${O} selected`", "`${O} 已选`"],
    ["`all skills`", "`全部技能`"],
    ["You have unsaved config changes.", "配置有未保存变更。"],
    ["Loading runtime tool catalog…", "正在加载运行时工具目录…"],
    [
      "Could not load runtime tool catalog. Showing built-in fallback list instead.",
      "无法加载运行时工具目录，暂显示内置兜底列表。",
    ],
    ["Available Right Now", "当前可用"],
    [
      "What this agent can use in the current chat session.",
      "此 Agent 在当前会话可使用的工具。",
    ],
    ["`no session`", "`无会话`"],
    ["Loading available tools…", "正在加载可用工具…"],
    ["Could not load available tools for this session.", "无法加载当前会话可用工具。"],
    ["No tools are available for this session right now.", "当前会话暂无可用工具。"],
    [" more live tools are available in the groups below.", " 个实时工具可用，见下方分组。"],
    [" more live tools", " 个实时工具"],
    ["Switch chat to this agent to view its live runtime tools.", "切换会话到此 Agent 后查看实时工具。"],
    ["Load the gateway config to adjust tool profiles.", "加载 Gateway 配置后可调整工具配置档。"],
    [
      "This agent is using an explicit allowlist in config. Tool overrides are managed in the",
      "此 Agent 使用 config 中的显式 allowlist。工具覆盖配置位于",
    ],
    ["Load the gateway config to set per-agent skills.", "加载 Gateway 配置后可设置单 Agent 技能。"],
    ["This agent uses a custom skill allowlist.", "此 Agent 使用自定义技能 allowlist。"],
    [
      "All skills are enabled. Disabling any skill will create a per-agent allowlist.",
      "当前启用全部技能；停用任一技能会创建单 Agent allowlist。",
    ],
    [">Filter<", ">筛选<"],
    ["${m.length} shown", "${m.length} 项"],
    ["`Tool`", "`工具`"],
    ["`Enabled Tool`", "`已启用工具`"],
    ["`${i.allowed?`Disable`:`Enable`} ${n.label}`", "`${i.allowed?`停用`:`启用`} ${n.label}`"],
    [">Disable<", ">停用<"],
    [">Enable<", ">启用<"],
    ["Quick Presets", "快捷预设"],
    [">Inherit<", ">继承<"],
    [">Profile<", ">配置档<"],
    [">Source<", ">来源<"],
    [">Enabled<", ">已启用<"],
    [">Live<", ">实时<"],
    [">Status<", ">状态<"],
    ["`agent override`", "`Agent 覆盖`"],
    ["`global default`", "`全局默认`"],
    ["?`Agent 覆盖`:r.profile?`全局默认`:`default`", "?`Agent 覆盖`:r.profile?`全局默认`:`默认`"],
    ["?`saving…`:e.configDirty?`unsaved`:`saved`", "?`保存中…`:e.configDirty?`未保存`:`已保存`"],
    ["<div class=\"card-title\">Tool Access</div>", "<div class=\"card-title\">工具权限</div>"],
    [
      "Profile + per-tool overrides for this agent.",
      "此 Agent 的工具配置档与单工具覆盖。",
    ],
    ["`Built-In`", "`内置`"],
    ["`Optional`", "`可选`"],
    ["`Live Now`", "`实时可用`"],
    ["`Disabled by agent override.`", "`已被 Agent 覆盖停用。`"],
    ["`Enabled by the current profile.`", "`已由当前配置档启用。`"],
    ["`Enabled by agent override.`", "`已由 Agent 覆盖启用。`"],
    ["`Not included in the current profile.`", "`未包含于当前配置档。`"],
    ["`Override Off`", "`覆盖关闭`"],
    ["`Enabled`", "`已启用`"],
    ["`Override On`", "`覆盖开启`"],
    ["`Profile Off`", "`配置档关闭`"],
    ["`Not Live`", "`未实时可用`"],
    ["`Other Agent`", "`其他 Agent`"],
    ["`Plugin: ${r}`", "`插件：${r}`"],
    ["Plugin: ${t.pluginId}", "插件：${t.pluginId}"],
    ["${Vn(i,`Live Tool`)}", "${i} 个实时工具"],
    [">Default Presets<", ">默认预设<"],
    [">Current Session<", ">当前会话<"],
    ["`Available now via ${qn(s)}.`", "`当前可通过 ${qn(s)} 使用。`"],
    [
      "`Not available in this chat session right now.`",
      "`当前会话暂不可用。`",
    ],
    [
      "`Switch chat to this agent to inspect live availability.`",
      "`切换会话到此 Agent 后查看实时可用性。`",
    ],
    [" Link to This Tool ", " 链接到此工具 "],
  ];

  for (const file of listAssetFiles(/^agents-page-.*\.js$/, "agents-page")) {
    const before = read(file);
    const recovered = replacePairs(before, recoveryPairs);
    let after = replacePairs(recovered, pairs)
      .replace("this.agentsPanel=`files`,this.toolsCatalogLoading", "this.agentsPanel=`overview`,this.toolsCatalogLoading");

    const expertLandingHelper = [
      "function UcExpertTemplates(){return[",
      "{id:`copywriter`,name:`文案写手`,avatar:`文`,category:`内容创作`,description:`把需求转成清晰、克制、可发布的中文文案。`,model:`默认模型`,skills:[],safety:`allowed`,prompt:`你是专业中文文案写手。先澄清目标人群、渠道、语气和转化目标，再给出可直接发布的标题、正文、备选表达和修改建议。回答要具体、克制、可执行。`},",
      "{id:`xiaohongshu`,name:`小红书写手`,avatar:`红`,category:`内容创作`,description:`面向种草、标题、封面文案与笔记结构。`,model:`默认模型`,skills:[],safety:`allowed`,prompt:`你是小红书内容专家。围绕人群痛点、使用场景、标题钩子、封面文字、正文结构和互动引导来产出笔记。避免夸大承诺，优先给多版可选方案。`},",
      "{id:`career`,name:`职业顾问`,avatar:`职`,category:`职业发展`,description:`梳理职业选择、面试准备、简历表达与成长计划。`,model:`默认模型`,skills:[],safety:`restricted`,prompt:`你是职业顾问。帮助用户拆解职业问题、简历定位、面试表达和行动计划。涉及重大职业选择时，说明假设和权衡，避免替用户做不可逆决定。`},",
      "{id:`machine-learning`,name:`机器学习`,avatar:`学`,category:`开发编程`,description:`解释模型、算法、实验设计与工程落地。`,model:`默认模型`,skills:[],safety:`allowed`,prompt:`你是机器学习专家。用准确术语解释算法、实验设计、数据处理、评估指标和工程落地。回答要包含关键假设、常见坑和可验证步骤。`},",
      "{id:`resume`,name:`简历写手`,avatar:`历`,category:`职业发展`,description:`把经历整理成更清楚的岗位匹配表达。`,model:`默认模型`,skills:[],safety:`allowed`,prompt:`你是简历写手。根据岗位目标提炼经历、量化成果、优化项目描述和个人优势。优先输出可复制到简历中的中文表达，并指出需要用户补充的数据。`},",
      "{id:`startup-ideas`,name:`创业点子王`,avatar:`创`,category:`商业运营`,description:`从人群、痛点、渠道和验证成本推演业务想法。`,model:`默认模型`,skills:[],safety:`allowed`,prompt:`你是创业点子顾问。围绕用户群、刚需场景、现有替代方案、获客渠道、MVP 和验证成本生成想法。每个想法都要给风险、验证方法和下一步行动。`},",
      "{id:`product-manager`,name:`产品经理`,avatar:`产`,category:`产品策略`,description:`拆需求、写 PRD、排优先级和验收标准。`,model:`默认模型`,skills:[],safety:`allowed`,prompt:`你是产品经理。先明确用户、场景、目标指标、约束和边界，再输出需求拆解、PRD 结构、优先级、交互流程、验收标准和风险。回答要克制、可执行，避免空泛口号。`},",
      "{id:`data-analyst`,name:`数据分析师`,avatar:`数`,category:`数据分析`,description:`拆指标、看口径、找异常和给分析框架。`,model:`默认模型`,skills:[],safety:`allowed`,prompt:`你是数据分析师。围绕业务问题定义指标口径、拆解漏斗、定位异常、设计对比和输出结论。回答需区分事实、假设和建议，并提示需要补充的数据。`},",
      "{id:`code-reviewer`,name:`代码审查`,avatar:`码`,category:`开发编程`,description:`按风险、回归、可维护性和测试缺口审查代码。`,model:`默认模型`,skills:[],safety:`allowed`,prompt:`你是资深代码审查专家。优先指出 bug、回归风险、安全风险、边界条件和缺失测试，按严重程度排序。不要泛泛评价风格；每个问题都要说明影响、触发条件和建议修复方向。`},",
      "{id:`test-designer`,name:`测试用例专家`,avatar:`测`,category:`质量保障`,description:`把需求转成边界、回归和验收用例。`,model:`默认模型`,skills:[],safety:`allowed`,prompt:`你是测试用例专家。根据需求拆分正常路径、异常路径、边界条件、兼容性、回归范围和验收标准。输出清晰的测试矩阵，并标注优先级和需要准备的数据。`},",
      "{id:`meeting-summary`,name:`会议纪要`,avatar:`会`,category:`办公效率`,description:`整理会议摘要、决议、待办和风险跟进。`,model:`默认模型`,skills:[],safety:`allowed`,prompt:`你是会议纪要专家。把输入内容整理成背景、关键讨论、明确决议、待办事项、负责人、截止时间和未决问题。缺少信息时用待确认标注，不要编造。`},",
      "{id:`translation-polish`,name:`翻译润色`,avatar:`译`,category:`办公效率`,description:`中英互译、商务表达、语气调整和润色。`,model:`默认模型`,skills:[],safety:`allowed`,prompt:`你是翻译润色专家。根据目标读者和语气要求进行中英互译、改写和润色。保留原意，说明关键措辞差异，并在需要时给正式、自然、简洁多个版本。`},",
      "{id:`contract-review`,name:`合同审阅`,avatar:`合`,category:`办公效率`,description:`梳理条款风险、缺失信息和谈判问题。`,model:`默认模型`,skills:[],safety:`restricted`,prompt:`你是合同审阅助手，不构成法律意见。帮助用户梳理合同结构、关键义务、付款、违约、解除、保密、知识产权和争议解决条款中的风险点，并给出需要向专业律师确认的问题清单。`},",
      "{id:`customer-support`,name:`客服话术`,avatar:`客`,category:`商业运营`,description:`生成回复模板、安抚话术和升级路径。`,model:`默认模型`,skills:[],safety:`allowed`,prompt:`你是客服话术专家。根据客户情绪、问题类型、业务规则和可提供补偿，输出礼貌、清晰、可执行的回复模板。复杂问题要给升级路径、记录要点和禁止承诺。`},",
      "{id:`operation-planner`,name:`活动运营`,avatar:`营`,category:`商业运营`,description:`设计活动方案、渠道节奏、转化路径和复盘指标。`,model:`默认模型`,skills:[],safety:`allowed`,prompt:`你是活动运营专家。围绕目标用户、核心卖点、渠道、时间节奏、资源预算和转化指标设计活动方案。输出活动机制、文案方向、执行清单、风险和复盘指标。`},",
      "{id:`ppt-outline`,name:`汇报策划`,avatar:`演`,category:`办公效率`,description:`把材料整理成汇报结构、页面标题和讲述节奏。`,model:`默认模型`,skills:[],safety:`allowed`,prompt:`你是汇报策划专家。根据受众、目标和材料，整理故事线、章节结构、页面标题、关键论据和讲述节奏。优先让结论明确、证据充分、下一步清楚。`}",
      "]}",
      "function UcExpertAgentId(e){return`uclaw-expert-${e.id}`}",
      "function UcExpertDefaultAgentId(e){return e.agentsList?.defaultId??`main`}",
      "function UcExpertPersonaStore(){try{let e=JSON.parse(globalThis.localStorage?.getItem(`uclaw.expertPersonas.v1`)||`{}`);return e&&typeof e==`object`&&!Array.isArray(e)?e:{}}catch{return{}}}",
      "function UcSetExpertPersona(e,t){try{if(!e)return;let n=UcExpertPersonaStore();n[e]=t,globalThis.localStorage?.setItem(`uclaw.expertPersonas.v1`,JSON.stringify(n))}catch{}}",
      "function UcExpertPrompt(e){return[`# ${e.name}`,``,e.prompt,``,`## 回答原则`,`- 默认使用中文，除非用户要求其他语言。`,`- 先识别用户目标和约束，再给出专业建议。`,`- 不确定时说明假设，并给出可验证的下一步。`,``,`## U-Claw Expert Metadata`,`- Template: ${e.id}` ,`- Category: ${e.category}`,`- Model: ${e.model}`,`- Skills: ${Array.isArray(e.skills)&&e.skills.length?e.skills.join(`, `):`默认继承`}`].join(`\\n`)}",
      "function UcCustomExpertDefaults(){return{name:``,avatar:`专`,description:``,prompt:``,model:``,skills:[]}}",
      "function UcExpertSlug(e){return(e||`custom`).toLowerCase().replace(/[^a-z0-9\\u4e00-\\u9fa5]+/g,`-`).replace(/^-+|-+$/g,``).slice(0,48)||`custom`}",
      "function UcCustomExpertAgentId(e){return`uclaw-expert-custom-${UcExpertSlug(e)}`}",
      "function UcCustomExpertPrompt(e,t){let n=Array.isArray(e.skills)&&e.skills.length?e.skills.join(`, `):`默认继承`;return[`# ${e.name}`,``,e.description?`> ${e.description}`:``,e.description?``:``,e.prompt,``,`## 回答原则`,`- 默认使用中文，除非用户要求其他语言。`,`- 按专家角色给出更专业、可执行的回答。`,`- 不确定时说明假设，并给出可验证的下一步。`,``,`## U-Claw Expert Metadata`,`- Custom Expert: ${t}`,`- Model: ${e.model||`默认继承`}`,`- Skills: ${n}`].filter(e=>e!==``).join(`\\n`)}",
      "function UcExpertAvailableSkills(e){return(e.agentSkills?.report?.skills??[]).filter(e=>e&&typeof e.name==`string`&&e.name.trim()).map(e=>({name:e.name.trim(),description:String(e.description||e.summary||``)}))}",
      "function UcExpertConfigEntry(e,t){return(e.config?.form?.agents?.list??[]).find(e=>e?.id===t)??null}",
      "function UcExpertSectionTitle(e,t,n){return a`<div class='uclaw-expert-section-title'><span class='uclaw-step'>${e}</span><div><div class='card-title'>${t}</div>${n?a`<div class='card-sub'>${n}</div>`:null}</div></div>`}",
      "function UcCustomExpertForm(e){let t=e.customExpertForm??UcCustomExpertDefaults(),n=new Set(Array.isArray(t.skills)?t.skills:[]),r=UcExpertAvailableSkills(e),i=!!e.expertCreateBusyId,o=Array.isArray(t.skills)?t.skills.length:0,s=(t.avatar??`专`).trim()||`专`,c=(t.name??``).trim()||`自定义专家`,l=(t.description??``).trim()||`补充一句说明，让会话更容易辨认`,u=!!(t.prompt??``).trim();return a`<section class='uclaw-create-panel uclaw-custom-expert-form' data-uclaw-custom-expert-form data-preserve-on-failure='表单失败不会清空'>${UcExpertSectionTitle(`2`,`自定义创建`,`没有合适模板时，用一张专家卡片快速定义角色。`)}<div class='uclaw-custom-card-head'><div class='uclaw-custom-preview-avatar'>${s.slice(0,4)}</div><div class='uclaw-custom-preview-copy'><div class='uclaw-custom-preview-title'>${c}</div><div class='uclaw-custom-preview-sub'>${l}</div></div><span class='uclaw-custom-preview-badge'>${u?`Prompt 已填写`:`待填写`}</span></div><div class='uclaw-custom-expert-grid'><label class='uclaw-custom-expert-field'><span class='uclaw-field-top'><span>专家名称</span><b>必填</b></span><input class='input uclaw-form-control' .value=${t.name??``} placeholder='例如：合同审阅专家' @input=${t=>e.onCustomExpertField?.(`name`,t.target.value)} /></label><label class='uclaw-custom-expert-field'><span class='uclaw-field-top'><span>头像</span><em>1-4 字</em></span><input class='input uclaw-form-control' maxlength='4' .value=${t.avatar??``} placeholder='专' @input=${t=>e.onCustomExpertField?.(`avatar`,t.target.value)} /></label><label class='uclaw-custom-expert-field wide'><span class='uclaw-field-top'><span>一句话描述</span><em>用于会话识别</em></span><input class='input uclaw-form-control' .value=${t.description??``} placeholder='说明这个专家适合解决什么问题' @input=${t=>e.onCustomExpertField?.(`description`,t.target.value)} /></label><label class='uclaw-custom-expert-field wide'><span class='uclaw-field-top'><span>Prompt</span><b>必填</b></span><textarea class='input uclaw-form-control uclaw-custom-expert-textarea' .value=${t.prompt??``} placeholder='写清楚专家角色、回答原则、边界和输出格式。' @input=${t=>e.onCustomExpertField?.(`prompt`,t.target.value)}></textarea></label><details class='uclaw-expert-options wide'><summary><span>模型与技能</span><span>${t.model?`已选模型`:o?`${o} 个技能`:`可选`}</span></summary><div class='uclaw-expert-options-body'><label class='uclaw-custom-expert-field'><span>模型</span><select class='input uclaw-form-control' .value=${t.model??``} @change=${t=>e.onCustomExpertField?.(`model`,t.target.value)}><option value=''>继承默认模型</option>${ie(e.config?.form,t.model||void 0,e.modelCatalog,t.model||null)}</select></label><div class='uclaw-custom-expert-field wide'><div class='row uclaw-section-head compact'><span>技能选择</span><button class='btn btn--sm' type='button' ?disabled=${e.agentSkills?.loading} @click=${()=>e.onCustomExpertRefreshSkills?.()}>${e.agentSkills?.loading?`刷新中…`:`刷新`}</button></div>${e.agentSkills?.error?a`<div class='uclaw-expert-status danger'>技能读取失败：${e.agentSkills.error}</div>`:null}<div class='uclaw-custom-expert-skills'>${r.length?r.map(r=>a`<label class='uclaw-custom-expert-skill'><input type='checkbox' .checked=${n.has(r.name)} @change=${t=>e.onCustomExpertSkill?.(r.name,t.target.checked)} /><span>${r.name}</span>${r.description?a`<small>${r.description}</small>`:null}</label>`):a`<div class='muted uclaw-empty-state'>暂无可选技能。点击刷新读取当前技能状态。</div>`}</div></div></div></details></div><div class='uclaw-custom-expert-actions'><button class='btn primary' type='button' ?disabled=${i||!e.connected} @click=${()=>e.onCreateCustomExpert?.()}>${e.expertCreateBusyId===`custom`?`创建中…`:`创建并进入会话`}</button><button class='btn btn--ghost' type='button' ?disabled=${i} @click=${()=>e.onResetCustomExpert?.()}>清空</button></div></section>`}",
      "function UcCustomExpertModal(e){return e.customExpertModalOpen?a`<div class='uclaw-custom-expert-modal' data-uclaw-custom-expert-modal role='dialog' aria-modal='true' aria-label='自定义创建专家' @click=${t=>{t.target===t.currentTarget&&e.onCloseCustomExpert?.()}}><div class='uclaw-custom-expert-modal-card'><div class='uclaw-modal-head'><div><div class='card-title'>自定义创建专家</div><div class='card-sub'>填写角色信息后，会写入 AGENTS.md 并进入对应专家会话。</div></div><button class='btn btn--ghost uclaw-modal-close' type='button' @click=${()=>e.onCloseCustomExpert?.()} aria-label='关闭'>关闭</button></div>${UcCustomExpertForm(e)}</div></div>`:null}",
      "function UcExpertTemplateByAgentId(e){return UcExpertTemplates().find(t=>UcExpertAgentId(t)===e)??null}",
      "function UcHiddenExpertIds(){try{return new Set(JSON.parse(globalThis.localStorage?.getItem(`uclaw.hiddenExperts.v1`)||`[]`).filter(e=>typeof e==`string`&&e.trim()))}catch{return new Set}}",
      "function UcSetHiddenExpertId(e,t){try{let n=UcHiddenExpertIds();t?n.add(e):n.delete(e),globalThis.localStorage?.setItem(`uclaw.hiddenExperts.v1`,JSON.stringify([...n]))}catch{}}",
      "function UcExpertSessions(e,t){return(e.sessionsResult?.sessions??[]).filter(e=>e&&typeof e.key==`string`&&m(e.key)?.agentId===t).slice(0,5)}",
      "function UcRecentExpertSessions(e){return(e.sessionsResult?.sessions??[]).filter(e=>e&&typeof e.key==`string`).slice(0,6)}",
      "function UcExpertCatalog(e){let t=UcHiddenExpertIds(),n=e.agentsList?.agents??[],r=new Map(n.map(e=>[e.id,e])),i=new Set(UcExpertTemplates().map(UcExpertAgentId)),a=UcExpertTemplates().map(t=>{let n=UcExpertAgentId(t),i=r.get(n)??null,o=UcExpertConfigEntry(e,n);return{...t,agentId:n,source:`built-in`,installed:!!i,agent:i,model:o?.model?String(o.model):t.model,skills:Array.isArray(o?.skills)?o.skills:t.skills,sessionCount:UcExpertSessions(e,n).length}}),o=n.filter(e=>typeof e.id==`string`&&e.id.startsWith(`uclaw-expert-`)&&!i.has(e.id)&&!t.has(e.id)).map(t=>{let n=UcExpertConfigEntry(e,t.id);return{id:t.id,name:t.name||t.id,avatar:t.emoji||`专`,category:`自定义专家`,description:`用户创建的专家，复用 OpenClaw Agent 与 AGENTS.md。`,model:n?.model?String(n.model):t.model?String(t.model):`默认模型`,skills:Array.isArray(n?.skills)?n.skills:[],safety:`allowed`,prompt:`打开 AGENTS.md 查看或编辑专家提示词。`,agentId:t.id,source:`custom`,installed:!0,agent:t,sessionCount:UcExpertSessions(e,t.id).length}});return[...a,...o]}",
      "function UcExpertActionButtons(e,t){let n=t.installed?`创建会话`:`选择创建`,r=e.expertCreateBusyId===t.id;return a`<div class='uclaw-expert-card-actions'><button class='btn btn--sm primary' type='button' ?disabled=${!!e.expertCreateBusyId||!e.connected} @click=${()=>t.installed?e.onNewExpertSession?.(t.agentId,t.name):e.onCreateExpert?.(t.id)}>${r?`创建中…`:n}</button></div>`}",
      "function UcExpertTemplateCard(e,t){return a`<article class='uclaw-expert-card ${t.installed?`is-installed`:`is-template`}' data-uclaw-expert-card=${t.agentId}><div class='uclaw-expert-card-main'><div class='uclaw-expert-avatar'>${t.avatar}</div><div class='uclaw-expert-body'><div class='uclaw-expert-name'>${t.name}</div><div class='uclaw-expert-meta'>${t.category} · ${t.installed?`已可用`:`模板`}</div><div class='uclaw-expert-desc'>${t.description}</div></div></div>${UcExpertActionButtons(e,t)}</article>`}",
      "function UcExpertTemplatePicker(e,t){let n=t.filter(e=>e.source===`built-in`);return a`<section class='uclaw-create-panel uclaw-expert-manager' data-uclaw-expert-manager>${UcExpertSectionTitle(`1`,`选择专家创建`,`优先从模板开始，选择后自动创建专家并进入会话。`)}<div class='uclaw-expert-card-grid'>${n.map(t=>UcExpertTemplateCard(e,t))}</div></section>`}",
      "function UcExpertManagement(e,t){return UcExpertTemplatePicker(e,t)}",
      "function UcExpertDetail(e,t){return null}",
      "function UcExpertLanding(e,t,n){let r=UcExpertCatalog(e);return a`",
      "    <section class='uclaw-expert-landing' data-uclaw-expert-landing data-uclaw-expert-create-center>",
      "      <div class='uclaw-expert-page-head'>",
      "        <div>",
      "          <h2>创建专家</h2>",
      "          <p>选择一个专家模板，或自定义一个角色。</p>",
      "        </div>",
      "        <button class='btn primary uclaw-open-custom-expert' type='button' ?disabled=${!!e.expertCreateBusyId||!e.connected} @click=${()=>e.onOpenCustomExpert?.()}>自定义创建</button>",
      "      </div>",
      "      ${e.expertCreateError?a`<div class='uclaw-expert-status danger'>${e.expertCreateError}</div>`:e.expertCreateMessage?a`<div class='uclaw-expert-status ok'>${e.expertCreateMessage}</div>`:null}",
      "      <div class='uclaw-create-layout'>",
      "        ${UcExpertTemplatePicker(e,r)}",
      "      </div>",
      "      ${UcCustomExpertModal(e)}",
      "    </section>",
      "  `}",
    ].join("\n");

    const expertLandingStart = "function UcExpertTemplates(){return[";
    if (after.includes(expertLandingStart)) {
      const start = after.indexOf(expertLandingStart);
      const end = after.indexOf("function Qn(e){", start);
      if (end >= 0) {
        after = `${after.slice(0, start)}${expertLandingHelper}${after.slice(end)}`;
      }
    } else {
      after = after.replace("function Qn(e){", `${expertLandingHelper}function Qn(e){`);
    }
    if (!after.includes("${UcExpertLanding(e,i,n)}")) {
      after = after.replace(
        '<div class="agents-layout">\n      <section class="agents-toolbar">',
        '<div class="agents-layout">\n      ${UcExpertLanding(e,i,n)}\n      <section class="agents-toolbar">',
      );
    }
    if (!after.includes("sessionsResult:this.sessionsResult")) {
      after = after.replace(
        "agentSkills:{report:this.agentSkillsReport,loading:this.agentSkillsLoading,error:this.agentSkillsError,agentId:this.agentSkillsAgentId,filter:this.skillsFilter},toolsCatalog:",
        "agentSkills:{report:this.agentSkillsReport,loading:this.agentSkillsLoading,error:this.agentSkillsError,agentId:this.agentSkillsAgentId,filter:this.skillsFilter},sessionsResult:this.sessionsResult,toolsCatalog:",
      );
    }
    if (!after.includes("expertCreateBusyId:null")) {
      after = after.replace(
        "this.agentSkillsReport=null,this.agentSkillsAgentId=null,this.skillsFilter=``,",
        "this.agentSkillsReport=null,this.agentSkillsAgentId=null,this.expertCreateBusyId=null,this.expertCreateMessage=null,this.expertCreateError=null,this.skillsFilter=``,",
      );
    }
    if (!after.includes("customExpertForm=UcCustomExpertDefaults()")) {
      after = after.replace(
        "this.expertCreateBusyId=null,this.expertCreateMessage=null,this.expertCreateError=null,this.skillsFilter=``,",
        "this.expertCreateBusyId=null,this.expertCreateMessage=null,this.expertCreateError=null,this.customExpertForm=UcCustomExpertDefaults(),this.skillsFilter=``,",
      );
    }
    if (!after.includes("customExpertModalOpen=!1")) {
      after = after.replace(
        "this.customExpertForm=UcCustomExpertDefaults(),this.skillsFilter=``,",
        "this.customExpertForm=UcCustomExpertDefaults(),this.customExpertModalOpen=!1,this.skillsFilter=``,",
      );
    }
    if (!after.includes("async createExpertFromTemplate(")) {
      after = after.replace(
        "runCronJobNow(e){let t=this.cron.cronJobs.find(t=>t.id===e);t&&xe(this.cron,t,`force`).finally(()=>{this.cron={...this.cron,cronJobs:[...this.cron.cronJobs]}})}render(){",
        "runCronJobNow(e){let t=this.cron.cronJobs.find(t=>t.id===e);t&&xe(this.cron,t,`force`).finally(()=>{this.cron={...this.cron,cronJobs:[...this.cron.cronJobs]}})}openExpertSession(e){e&&(this.context.gateway.setSessionKey(e),this.context.navigate(`chat`,{search:`?session=${encodeURIComponent(e)}`}))}async createSessionForExpert(e,t){if(!this.client||!this.connected){this.expertCreateError=`Gateway 未连接，无法创建专家会话。`;return}this.expertCreateBusyId=`session-${e}`,this.expertCreateMessage=null,this.expertCreateError=null;try{let n=await this.client.request(`sessions.create`,{agentId:e,label:t||e});if(!n?.key)throw new Error(`sessions.create returned no key`);this.expertCreateMessage=`已创建专家会话：${t||e}`,this.openExpertSession(n.key)}catch(e){this.expertCreateError=`创建专家会话失败：${e instanceof Error?e.message:String(e)}`}finally{this.expertCreateBusyId=null,this.requestUpdate()}}continueExpertSession(e,t){let n=UcExpertSessions({sessionsResult:this.sessionsResult},e)[0];n?.key?this.openExpertSession(n.key):void this.createSessionForExpert(e,t)}async editExpert(e){this.selectAgent(e),this.agentsPanel=`files`,this.agentFileActive=`AGENTS.md`,this.expertCreateMessage=`已打开专家核心文件 AGENTS.md，可编辑 prompt 后保存。`,this.expertCreateError=null,await this.loadAgentFiles(e,!0),await ke(this,e,`AGENTS.md`,{force:!0,preserveDraft:!0}),this.requestUpdate()}archiveExpert(e,t){if(UcExpertTemplateByAgentId(e)){this.expertCreateMessage=`内置专家不会归档；可编辑后另存为自定义专家。`,this.expertCreateError=null}else UcSetHiddenExpertId(e,!0),this.expertCreateMessage=`已从专家列表归档：${t||e}。底层 Agent 与历史会话未删除。`,this.expertCreateError=null;this.requestUpdate()}async createExpertFromTemplate(e){let t=UcExpertTemplates().find(t=>t.id===e);if(!t)return;if(!this.client||!this.connected){this.expertCreateError=`Gateway 未连接，无法创建专家。`;return}if(this.context.runtimeConfig.state.configFormDirty){this.expertCreateError=`存在未保存配置，请先保存或撤销后再创建专家。`;return}let n=this.client,r=UcExpertAgentId(t),i=t.name,a=`~/.openclaw/agents/${r}/workspace`;this.expertCreateBusyId=t.id,this.expertCreateMessage=null,this.expertCreateError=null;try{let e=(this.agentsList?.agents??[]).some(e=>e.id===r);if(!e)try{await n.request(`agents.create`,{name:r,workspace:a,emoji:t.avatar})}catch(e){if(!/already exists/i.test(String(e)))throw e}await n.request(`agents.update`,{agentId:r,name:i,workspace:a,emoji:t.avatar});let o=UcExpertPrompt(t);await n.request(`agents.files.set`,{agentId:r,name:`AGENTS.md`,content:o});let s=await n.request(`agents.files.get`,{agentId:r,name:`AGENTS.md`});if(!s?.file?.content?.includes(t.prompt))throw new Error(`AGENTS.md readback missing expert prompt`);await this.context.runtimeConfig.refresh({discardPendingChanges:!0});let c=this.ensureAgentIndex(r);if(c<0)throw new Error(`runtimeConfig readback missing agent ${r}`);if(Array.isArray(t.skills)&&t.skills.length>0)this.context.runtimeConfig.patchForm([`agents`,`list`,c,`skills`],t.skills);if(typeof t.modelRef==`string`&&t.modelRef.trim())this.context.runtimeConfig.patchForm([`agents`,`list`,c,`model`],t.modelRef.trim());(Array.isArray(t.skills)&&t.skills.length>0||typeof t.modelRef==`string`&&t.modelRef.trim())&&await this.context.runtimeConfig.save();await this.context.agents.refreshList(),this.syncAgentState();let l=this.agentsList?.agents?.find(e=>e.id===r);if(!l)throw new Error(`agents.list readback missing ${r}`);this.agentsSelectedId=r,this.context.agentIdentity.ensure([r]);let u=await n.request(`sessions.create`,{agentId:r,label:i});if(!u?.key)throw new Error(`sessions.create returned no key`);this.expertCreateMessage=`已创建专家并进入会话：${i}`,this.openExpertSession(u.key)}catch(e){this.expertCreateError=`创建专家失败：${e instanceof Error?e.message:String(e)}`}finally{this.expertCreateBusyId=null,this.requestUpdate()}}render(){",
      );
    }
    if (!after.includes("async createSessionForExpert(")) {
      after = after.replace(
        "runCronJobNow(e){let t=this.cron.cronJobs.find(t=>t.id===e);t&&xe(this.cron,t,`force`).finally(()=>{this.cron={...this.cron,cronJobs:[...this.cron.cronJobs]}})}async createExpertFromTemplate",
        "runCronJobNow(e){let t=this.cron.cronJobs.find(t=>t.id===e);t&&xe(this.cron,t,`force`).finally(()=>{this.cron={...this.cron,cronJobs:[...this.cron.cronJobs]}})}openExpertSession(e){e&&(this.context.gateway.setSessionKey(e),this.context.navigate(`chat`,{search:`?session=${encodeURIComponent(e)}`}))}async createSessionForExpert(e,t){if(!this.client||!this.connected){this.expertCreateError=`Gateway 未连接，无法创建专家会话。`;return}this.expertCreateBusyId=`session-${e}`,this.expertCreateMessage=null,this.expertCreateError=null;try{let n=await this.client.request(`sessions.create`,{agentId:e,label:t||e});if(!n?.key)throw new Error(`sessions.create returned no key`);this.expertCreateMessage=`已创建专家会话：${t||e}`,this.openExpertSession(n.key)}catch(e){this.expertCreateError=`创建专家会话失败：${e instanceof Error?e.message:String(e)}`}finally{this.expertCreateBusyId=null,this.requestUpdate()}}continueExpertSession(e,t){let n=UcExpertSessions({sessionsResult:this.sessionsResult},e)[0];n?.key?this.openExpertSession(n.key):void this.createSessionForExpert(e,t)}async editExpert(e){this.selectAgent(e),this.agentsPanel=`files`,this.agentFileActive=`AGENTS.md`,this.expertCreateMessage=`已打开专家核心文件 AGENTS.md，可编辑 prompt 后保存。`,this.expertCreateError=null,await this.loadAgentFiles(e,!0),await ke(this,e,`AGENTS.md`,{force:!0,preserveDraft:!0}),this.requestUpdate()}archiveExpert(e,t){if(UcExpertTemplateByAgentId(e)){this.expertCreateMessage=`内置专家不会归档；可编辑后另存为自定义专家。`,this.expertCreateError=null}else UcSetHiddenExpertId(e,!0),this.expertCreateMessage=`已从专家列表归档：${t||e}。底层 Agent 与历史会话未删除。`,this.expertCreateError=null;this.requestUpdate()}async createExpertFromTemplate",
      );
    }
    if (!after.includes("async createCustomExpert(")) {
      after = after.replace(
        "archiveExpert(e,t){if(UcExpertTemplateByAgentId(e)){this.expertCreateMessage=`内置专家不会归档；可编辑后另存为自定义专家。`,this.expertCreateError=null}else UcSetHiddenExpertId(e,!0),this.expertCreateMessage=`已从专家列表归档：${t||e}。底层 Agent 与历史会话未删除。`,this.expertCreateError=null;this.requestUpdate()}async createExpertFromTemplate",
        "archiveExpert(e,t){if(UcExpertTemplateByAgentId(e)){this.expertCreateMessage=`内置专家不会归档；可编辑后另存为自定义专家。`,this.expertCreateError=null}else UcSetHiddenExpertId(e,!0),this.expertCreateMessage=`已从专家列表归档：${t||e}。底层 Agent 与历史会话未删除。`,this.expertCreateError=null;this.requestUpdate()}resetCustomExpertForm(){this.customExpertForm=UcCustomExpertDefaults(),this.expertCreateError=null,this.requestUpdate()}updateCustomExpertField(e,t){this.customExpertForm={...(this.customExpertForm??UcCustomExpertDefaults()),[e]:t},this.requestUpdate()}toggleCustomExpertSkill(e,t){let n=new Set(this.customExpertForm?.skills??[]);t?n.add(e):n.delete(e),this.customExpertForm={...(this.customExpertForm??UcCustomExpertDefaults()),skills:[...n]},this.requestUpdate()}refreshCustomExpertSkills(){let e=this.resolveSelectedAgentId()??this.agentsList?.defaultId??this.agentsList?.agents?.[0]?.id??`main`;e&&je(this,e).finally(()=>this.requestUpdate())}async createCustomExpert(){let e=this.customExpertForm??UcCustomExpertDefaults(),t=(e.name??``).trim(),n=(e.prompt??``).trim();if(!this.client||!this.connected){this.expertCreateError=`Gateway 未连接，无法创建专家。`;return}if(!t||!n){this.expertCreateError=`请填写专家名称和 Prompt。`;return}if(this.context.runtimeConfig.state.configFormDirty){this.expertCreateError=`存在未保存配置，请先保存或撤销后再创建专家。`;return}let r=this.client,i=UcCustomExpertAgentId(t),a=(e.avatar??``).trim()||`专`,o=(e.description??``).trim(),s=(e.model??``).trim(),c=Array.isArray(e.skills)?e.skills.filter(e=>typeof e==`string`&&e.trim()).map(e=>e.trim()):[],l=`~/.openclaw/agents/${i}/workspace`;this.expertCreateBusyId=`custom`,this.expertCreateMessage=null,this.expertCreateError=null;try{let e=(this.agentsList?.agents??[]).some(e=>e.id===i);if(!e)try{await r.request(`agents.create`,{name:i,workspace:l,emoji:a})}catch(e){if(!/already exists/i.test(String(e)))throw e}await r.request(`agents.update`,{agentId:i,name:t,workspace:l,emoji:a});let u=UcCustomExpertPrompt({name:t,avatar:a,description:o,prompt:n,model:s,skills:c},i);await r.request(`agents.files.set`,{agentId:i,name:`AGENTS.md`,content:u});let d=await r.request(`agents.files.get`,{agentId:i,name:`AGENTS.md`});if(!d?.file?.content?.includes(n))throw new Error(`AGENTS.md readback missing expert prompt`);await this.context.runtimeConfig.refresh({discardPendingChanges:!0});let f=this.ensureAgentIndex(i);if(f<0)throw new Error(`runtimeConfig readback missing agent ${i}`);s?this.context.runtimeConfig.patchForm([`agents`,`list`,f,`model`],s):this.context.runtimeConfig.removeFormValue?.([`agents`,`list`,f,`model`]);c.length?this.context.runtimeConfig.patchForm([`agents`,`list`,f,`skills`],c):this.context.runtimeConfig.removeFormValue?.([`agents`,`list`,f,`skills`]);let p=await this.context.runtimeConfig.save();if(p===!1)throw new Error(this.context.runtimeConfig.state.lastError??`保存失败`);await this.context.runtimeConfig.refresh({discardPendingChanges:!0});let m=w(this.context.runtimeConfig.state)?.agents?.list,y=Array.isArray(m)?m.find(e=>e?.id===i):null;if(!y)throw new Error(`runtimeConfig readback missing agent ${i}`);let b=typeof y.model==`string`?y.model.trim():y.model&&typeof y.model==`object`?String(y.model.primary??y.model.model??y.model.id??``).trim():``;if(s&&b!==s)throw new Error(`model readback mismatch`);let x=Array.isArray(y.skills)?y.skills:[];if(c.some(e=>!x.includes(e)))throw new Error(`skills readback mismatch`);await this.context.agents.refreshList(),this.syncAgentState();let S=this.agentsList?.agents?.find(e=>e.id===i);if(!S)throw new Error(`agents.list readback missing ${i}`);this.agentsSelectedId=i,this.context.agentIdentity.ensure([i]);let C=await r.request(`sessions.create`,{agentId:i,label:t});if(!C?.key)throw new Error(`sessions.create returned no key`);this.customExpertForm=UcCustomExpertDefaults(),this.expertCreateMessage=`已创建自定义专家并进入会话：${t}`,this.openExpertSession(C.key)}catch(e){this.expertCreateError=`创建自定义专家失败：${e instanceof Error?e.message:String(e)}`}finally{this.expertCreateBusyId=null,this.requestUpdate()}}async createExpertFromTemplate",
      );
    }
    if (!after.includes("openCustomExpertModal()")) {
      after = after.replace(
        "resetCustomExpertForm(){this.customExpertForm=UcCustomExpertDefaults(),this.expertCreateError=null,this.requestUpdate()}",
        "openCustomExpertModal(){this.customExpertModalOpen=!0,this.expertCreateError=null,this.requestUpdate()}closeCustomExpertModal(){this.customExpertModalOpen=!1,this.requestUpdate()}resetCustomExpertForm(){this.customExpertForm=UcCustomExpertDefaults(),this.expertCreateError=null,this.requestUpdate()}",
      );
    }
    after = after.replace(
      "this.customExpertForm=UcCustomExpertDefaults(),this.expertCreateMessage=`已创建自定义专家并进入会话：${t}`",
      "this.customExpertForm=UcCustomExpertDefaults(),this.customExpertModalOpen=!1,this.expertCreateMessage=`已创建自定义专家并进入会话：${t}`",
    );
    after = after
      .replace(
        "async editExpert(e){this.selectAgent(e),this.agentsPanel=`overview`,this.agentFileActive=`AGENTS.md`",
        "async editExpert(e){this.selectAgent(e),this.agentsPanel=`files`,this.agentFileActive=`AGENTS.md`",
      )
      .replace(
        "if(!this.client||!this.connected){this.expertCreateError=`Gateway 未连接，无法创建专家。`;return}let n=this.client,",
        "if(!this.client||!this.connected){this.expertCreateError=`Gateway 未连接，无法创建专家。`;return}if(this.context.runtimeConfig.state.configFormDirty){this.expertCreateError=`存在未保存配置，请先保存或撤销后再创建专家。`;return}let n=this.client,",
      )
      .replace(
        "let n=this.client,r=UcExpertAgentId(t),i=t.name;this.expertCreateBusyId",
        "let n=this.client,r=UcExpertAgentId(t),i=t.name,a=`~/.openclaw/agents/${r}/workspace`;this.expertCreateBusyId",
      )
      .replace(
        "agents.create`,{name:r,workspace:`default`,emoji:t.avatar}",
        "agents.create`,{name:r,workspace:a,emoji:t.avatar}",
      )
      .replace(
        "agents.update`,{agentId:r,name:i,emoji:t.avatar}",
        "agents.update`,{agentId:r,name:i,workspace:a,emoji:t.avatar}",
      )
      .replace(
        "await n.request(`agents.update`,{agentId:r,name:i,workspace:a,emoji:t.avatar});let a=UcExpertPrompt(t);await n.request(`agents.files.set`,{agentId:r,name:`AGENTS.md`,content:a});let o=await n.request(`agents.files.get`,{agentId:r,name:`AGENTS.md`});if(!o?.file?.content?.includes(t.prompt))",
        "await n.request(`agents.update`,{agentId:r,name:i,workspace:a,emoji:t.avatar});let p=UcExpertPrompt(t);await n.request(`agents.files.set`,{agentId:r,name:`AGENTS.md`,content:p});let q=await n.request(`agents.files.get`,{agentId:r,name:`AGENTS.md`});if(!q?.file?.content?.includes(t.prompt))",
      )
      .replace(
        "label:`${t||e} 专家会话`",
        "label:t||e",
      )
      .replace(
        "label:`${i} 专家会话`",
        "label:i",
      )
      .replace(
        "label:`${t} 专家会话`",
        "label:t",
      );
    after = after
      .replace(
        "try{let n=await this.client.request(`sessions.create`,{agentId:e,label:t||e});if(!n?.key)throw new Error(`sessions.create returned no key`);this.expertCreateMessage=`已创建专家会话：${t||e}`,this.openExpertSession(n.key)}catch(e){this.expertCreateError=`创建专家会话失败：${e instanceof Error?e.message:String(e)}`}",
        "try{let r=UcExpertTemplateByAgentId(e),i=t||r?.name||e,a=r?UcExpertPrompt(r):`打开 ${e} 的 AGENTS.md 查看专家提示词。`,o=UcExpertDefaultAgentId(this),n=await this.client.request(`sessions.create`,{agentId:o,label:i});if(!n?.key)throw new Error(`sessions.create returned no key`);UcSetExpertPersona(n.key,{agentId:e,name:i,avatar:r?.avatar??`专`,description:r?.description??``,prompt:a,source:r?`built-in`:`custom`}),this.expertCreateMessage=`已在 main 下创建专家会话：${i}`,this.openExpertSession(n.key)}catch(e){this.expertCreateError=`创建专家会话失败：${e instanceof Error?e.message:String(e)}`}",
      )
      .replace(
        "this.agentsSelectedId=r,this.context.agentIdentity.ensure([r]);let u=await n.request(`sessions.create`,{agentId:r,label:i});if(!u?.key)throw new Error(`sessions.create returned no key`);this.expertCreateMessage=`已创建专家并进入会话：${i}`,this.openExpertSession(u.key)",
        "this.context.agentIdentity.ensure([r]);let u=UcExpertDefaultAgentId(this),d=await n.request(`sessions.create`,{agentId:u,label:i});if(!d?.key)throw new Error(`sessions.create returned no key`);UcSetExpertPersona(d.key,{agentId:r,name:i,avatar:t.avatar,description:t.description,prompt:o,source:`built-in`,templateId:t.id,model:t.model,skills:t.skills}),this.expertCreateMessage=`已在 main 下创建专家会话：${i}`,this.openExpertSession(d.key)",
      )
      .replace(
        "this.agentsSelectedId=r,this.context.agentIdentity.ensure([r]);let l=await n.request(`sessions.create`,{agentId:r,label:i});if(!l?.key)throw new Error(`sessions.create returned no key`);this.context.gateway.setSessionKey(l.key),this.expertCreateMessage=`已创建专家并进入会话：${i}`,this.context.navigate(`chat`,{search:`?session=${encodeURIComponent(l.key)}`})",
        "this.context.agentIdentity.ensure([r]);let l=UcExpertDefaultAgentId(this),u=await n.request(`sessions.create`,{agentId:l,label:i});if(!u?.key)throw new Error(`sessions.create returned no key`);UcSetExpertPersona(u.key,{agentId:r,name:i,avatar:t.avatar,description:t.description,prompt:o,source:`built-in`,templateId:t.id,model:t.model,skills:t.skills}),this.expertCreateMessage=`已在 main 下创建专家会话：${i}`,this.openExpertSession(u.key)",
      )
      .replace(
        "this.agentsSelectedId=i,this.context.agentIdentity.ensure([i]);let C=await r.request(`sessions.create`,{agentId:i,label:t});if(!C?.key)throw new Error(`sessions.create returned no key`);this.customExpertForm=UcCustomExpertDefaults(),this.expertCreateMessage=`已创建自定义专家并进入会话：${t}`,this.openExpertSession(C.key)",
        "this.context.agentIdentity.ensure([i]);let C=UcExpertDefaultAgentId(this),R=await r.request(`sessions.create`,{agentId:C,label:t});if(!R?.key)throw new Error(`sessions.create returned no key`);UcSetExpertPersona(R.key,{agentId:i,name:t,avatar:a,description:o,prompt:u,source:`custom`,model:s,skills:c}),this.customExpertForm=UcCustomExpertDefaults(),this.expertCreateMessage=`已在 main 下创建自定义专家会话：${t}`,this.openExpertSession(R.key)",
      );
    after = after.replace(
      "this.agentsSelectedId=i,this.context.agentIdentity.ensure([i]);let C=await r.request(`sessions.create`,{agentId:i,label:t});if(!C?.key)throw new Error(`sessions.create returned no key`);this.customExpertForm=UcCustomExpertDefaults(),this.customExpertModalOpen=!1,this.expertCreateMessage=`已创建自定义专家并进入会话：${t}`,this.openExpertSession(C.key)",
      "this.context.agentIdentity.ensure([i]);let C=UcExpertDefaultAgentId(this),R=await r.request(`sessions.create`,{agentId:C,label:t});if(!R?.key)throw new Error(`sessions.create returned no key`);UcSetExpertPersona(R.key,{agentId:i,name:t,avatar:a,description:o,prompt:u,source:`custom`,model:s,skills:c}),this.customExpertForm=UcCustomExpertDefaults(),this.customExpertModalOpen=!1,this.expertCreateMessage=`已在 main 下创建自定义专家会话：${t}`,this.openExpertSession(R.key)",
    );
    after = after.replaceAll(",category:`专家会话`", "");
    if (!after.includes("expertCreateBusyId:this.expertCreateBusyId")) {
      after = after.replace(
        "sessionsResult:this.sessionsResult,toolsCatalog:",
        "sessionsResult:this.sessionsResult,expertCreateBusyId:this.expertCreateBusyId,expertCreateMessage:this.expertCreateMessage,expertCreateError:this.expertCreateError,connected:this.connected,toolsCatalog:",
      );
    }
    if (!after.includes("customExpertForm:this.customExpertForm")) {
      after = after.replace(
        "expertCreateError:this.expertCreateError,connected:this.connected,toolsCatalog:",
        "expertCreateError:this.expertCreateError,customExpertForm:this.customExpertForm,connected:this.connected,toolsCatalog:",
      );
    }
    if (!after.includes("customExpertModalOpen:this.customExpertModalOpen")) {
      after = after.replace(
        "customExpertForm:this.customExpertForm,connected:this.connected,toolsCatalog:",
        "customExpertForm:this.customExpertForm,customExpertModalOpen:this.customExpertModalOpen,connected:this.connected,toolsCatalog:",
      );
    }
    if (!after.includes("onCreateExpert:e=>void this.createExpertFromTemplate(e)")) {
      after = after.replace(
        "modelCatalog:this.chatModelCatalog,onRefresh:",
        "modelCatalog:this.chatModelCatalog,onCreateExpert:e=>void this.createExpertFromTemplate(e),onRefresh:",
      );
    }
    if (!after.includes("onContinueExpert:(e,t)=>this.continueExpertSession(e,t)")) {
      after = after.replace(
        "modelCatalog:this.chatModelCatalog,onCreateExpert:e=>void this.createExpertFromTemplate(e),onRefresh:",
        "modelCatalog:this.chatModelCatalog,onCreateExpert:e=>void this.createExpertFromTemplate(e),onContinueExpert:(e,t)=>this.continueExpertSession(e,t),onNewExpertSession:(e,t)=>void this.createSessionForExpert(e,t),onEditExpert:e=>void this.editExpert(e),onArchiveExpert:(e,t)=>this.archiveExpert(e,t),onOpenSession:e=>this.openExpertSession(e),onRefresh:",
      );
    }
    if (!after.includes("onCreateCustomExpert:()=>void this.createCustomExpert()")) {
      after = after.replace(
        "onOpenSession:e=>this.openExpertSession(e),onRefresh:",
        "onOpenSession:e=>this.openExpertSession(e),onCustomExpertField:(e,t)=>this.updateCustomExpertField(e,t),onCustomExpertSkill:(e,t)=>this.toggleCustomExpertSkill(e,t),onCustomExpertRefreshSkills:()=>this.refreshCustomExpertSkills(),onCreateCustomExpert:()=>void this.createCustomExpert(),onResetCustomExpert:()=>this.resetCustomExpertForm(),onRefresh:",
      );
    }
    if (!after.includes("onOpenCustomExpert:()=>this.openCustomExpertModal()")) {
      after = after.replace(
        "onResetCustomExpert:()=>this.resetCustomExpertForm(),onRefresh:",
        "onResetCustomExpert:()=>this.resetCustomExpertForm(),onOpenCustomExpert:()=>this.openCustomExpertModal(),onCloseCustomExpert:()=>this.closeCustomExpertModal(),onRefresh:",
      );
    }
    if (!after.includes("`expertCreateBusyId`")) {
      after = after.replace(
        "n([i()],$.prototype,`agentSkillsAgentId`,void 0),n([i()],$.prototype,`skillsFilter`,void 0),",
        "n([i()],$.prototype,`agentSkillsAgentId`,void 0),n([i()],$.prototype,`expertCreateBusyId`,void 0),n([i()],$.prototype,`expertCreateMessage`,void 0),n([i()],$.prototype,`expertCreateError`,void 0),n([i()],$.prototype,`skillsFilter`,void 0),",
      );
    }
    if (!after.includes("`customExpertForm`")) {
      after = after.replace(
        "n([i()],$.prototype,`expertCreateError`,void 0),n([i()],$.prototype,`skillsFilter`,void 0),",
        "n([i()],$.prototype,`expertCreateError`,void 0),n([i()],$.prototype,`customExpertForm`,void 0),n([i()],$.prototype,`skillsFilter`,void 0),",
      );
    }
    if (!after.includes("`customExpertModalOpen`")) {
      after = after.replace(
        "n([i()],$.prototype,`customExpertForm`,void 0),n([i()],$.prototype,`skillsFilter`,void 0),",
        "n([i()],$.prototype,`customExpertForm`,void 0),n([i()],$.prototype,`customExpertModalOpen`,void 0),n([i()],$.prototype,`skillsFilter`,void 0),",
      );
    }

    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Localizes Channels page status copy without adding new channel capabilities.
 */
function patchChannelsPageUiCopy() {
  const pairs = [
    ["Schema unavailable. Use Raw.", "配置 schema 不可用，请使用 Raw。"],
    ["Channel config schema unavailable.", "渠道配置 schema 不可用。"],
    ["`Saving…`:`Save`", "`保存中…`:`保存`"],
    ["Accounts (", "账号 ("],
    ["Bot status and channel configuration.", "机器人状态与渠道配置。"],
    ["Chat API webhook status and channel configuration.", "Chat API webhook 状态与渠道配置。"],
    ["macOS bridge status and channel configuration.", "macOS 桥接状态与渠道配置。"],
    ["signal-cli status and channel configuration.", "signal-cli 状态与渠道配置。"],
    ["Decentralized DMs via Nostr relays (NIP-04).", "通过 Nostr relays 收发去中心化私信 (NIP-04)。"],
    ["Socket mode status and channel configuration.", "Socket Mode 状态与渠道配置。"],
    ["连接 WhatsApp Web and monitor connection health.", "连接 WhatsApp Web，并监控连接状态。"],
    ["alt=\"WhatsApp QR\"", "alt=\"WhatsApp 二维码\""],
    ["Link WhatsApp Web", "连接 WhatsApp Web"],
    ["Refreshing channel status...", "正在刷新渠道状态..."],
    ["Loading config schema…", "正在加载配置 schema…"],
    ["Profile update failed (", "资料更新失败 ("],
    ["Profile publish failed on all relays.", "资料发布到所有 relays 均失败。"],
    ["Profile published to relays.", "资料已发布到 relays。"],
    ["Profile update failed: ", "资料更新失败："],
    ["Profile import failed (", "资料导入失败 ("],
    ["Profile imported from relays. Review and publish.", "已从 relays 导入资料，请复核后发布。"],
    ["Profile imported. Review and publish.", "资料已导入，请复核后发布。"],
    ["Profile import failed: ", "资料导入失败："],
    [
      "Refreshing channel status in the background; showing the last successful snapshot.",
      "正在后台刷新渠道状态；当前显示上一次成功快照。",
    ],
    [
      "Some channel checks did not finish before the UI budget.",
      "部分渠道检查未能在 UI 预算时间内完成。",
    ],
    ["Some channel checks failed.", "部分渠道检查失败。"],
  ];

  for (const file of listAssetFiles(/^channels-page-.*\.js$/, "channels-page")) {
    const before = read(file);
    const after = replacePairs(before, pairs);
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

/**
 * Applies the final visible UI polish slice found by connected-page audit.
 */
function patchFinalUiPolish() {
  const groups = [
    {
      pattern: /^session-display-.*\.js$/,
      label: "session-display",
      pairs: [
        ["fallbackName:`Main Session`", "fallbackName:`主会话`"],
        ["prefix:`Subagent:`", "prefix:`子智能体：`"],
        ["fallbackName:`Subagent:`", "fallbackName:`子智能体：`"],
        ["prefix:`Cron:`", "prefix:`定时任务：`"],
        ["fallbackName:`Cron Job:`", "fallbackName:`定时任务：`"],
        ["fallbackName:`${n[e]??i(e)} Group`", "fallbackName:`${n[e]??i(e)} 群组`"],
        ["fallbackName:`${n[t]} Session`", "fallbackName:`${n[t]} 会话`"],
      ],
    },
    {
      pattern: /^overview-page-.*\.js$/,
      label: "overview-page",
      pairs: [
        ["p?`${_} jobs`:d(`common.disabled`)", "p?`${_} 个任务`:d(`common.disabled`)"],
        ["a`<span class=\"danger\">${v} failed</span>`", "a`<span class=\"danger\">${v} 个失败</span>`"],
        ["hint:`${r} tokens · ${i} msgs`", "hint:`${r} tokens · ${i} 条消息`"],
        ["hint:u>0?`${u} blocked`:`${l} active`", "hint:u>0?`${u} 个阻止`:`${l} 个活跃`"],
      ],
    },
    {
      pattern: /^index-.*\.js$/,
      label: "index js",
      pairs: [
        ["a?`just now`:`in <1m`", "a?`刚刚`:`不到 1 分钟后`"],
        ["a?`${s}m ago`:`in ${s}m`", "a?`${s} 分钟前`:`${s} 分钟后`"],
        ["a?`${c}h ago`:`in ${c}h`", "a?`${c} 小时前`:`${c} 小时后`"],
        ["a?`${l}d ago`:`in ${l}d`", "a?`${l} 天前`:`${l} 天后`"],
        ["return`${l}d ago`", "return`${l} 天前`"],
        ["return t===`just now`?`now`:t.endsWith(` ago`)?t.slice(0,-4):t", "return t===`刚刚`?`刚刚`:t.replace(/ 分钟前$/,`m`).replace(/ 小时前$/,`h`).replace(/ 天前$/,`d`)"],
      ],
    },
    {
      pattern: /^nodes-page-.*\.js$/,
      label: "nodes-page",
      pairs: [
        ["label:`Deny`", "label:`拒绝`"],
        ["label:`Allowlist`", "label:`白名单`"],
        ["label:`Full`", "label:`完全允许`"],
        ["label:`Off`", "label:`关闭`"],
        ["label:`On miss`", "label:`未命中时询问`"],
        ["label:`Always`", "label:`始终询问`"],
        ["<span class=\"label\">Scope</span>", "<span class=\"label\">范围</span>"],
        [">\n          Defaults\n        </button>", ">\n          默认\n        </button>"],
        ["<div class=\"list-title\">Host-native policy</div>", "<div class=\"list-title\">宿主机原生策略</div>"],
        ["<div class=\"list-sub\">Read-only here. Edit from the companion app or CLI.</div>", "<div class=\"list-sub\">此处只读。请在配套应用或 CLI 中编辑。</div>"],
        ["<span class=\"badge\">Native</span>", "<span class=\"badge\">原生</span>"],
        ["<div class=\"list-title\">Default action</div>", "<div class=\"list-title\">默认动作</div>"],
        ["${t.length} ${t.length===1?`rule`:`rules`}", "${t.length} 条规则"],
        ["${e.action} · ${e.shells?.join(`, `)||`all shells`} ·", "${e.action} · ${e.shells?.join(`, `)||`全部 shells`} ·"],
        ["${e.enabled===!1?`off`:`on`}", "${e.enabled===!1?`关`:`开`}"],
        ["<div class=\"card-title\">Exec approvals</div>", "<div class=\"card-title\">Exec 审批</div>"],
        ["Allowlist and approval policy for <span class=\"mono\">exec host=gateway/node</span>.", "<span class=\"mono\">exec host=gateway/node</span> 的 allowlist 与审批策略。"],
        ["${e.saving?`保存中…`:`Save`}", "${e.saving?`保存中…`:`保存`}"],
        ["<div class=\"list-title\">Target</div>", "<div class=\"list-title\">目标</div>"],
        ["Gateway edits local approvals; node edits the selected node.", "Gateway 编辑本地审批；节点编辑所选节点。"],
        ["<div class=\"list-title\">Security</div>", "<div class=\"list-title\">安全</div>"],
        ["<span>Mode</span>", "<span>模式</span>"],
        ["<div class=\"list-title\">Ask</div>", "<div class=\"list-title\">询问策略</div>"],
        ["${t?`Default security mode.`:`默认：${n.security}。`}", "${t?`默认安全模式。`:`默认：${n.security}。`}"],
        ["<div class=\"list-title\">Ask fallback</div>", "<div class=\"list-title\">询问兜底</div>"],
        ["<div class=\"list-title\">Auto-allow skill CLIs</div>", "<div class=\"list-title\">自动允许 Skill CLI</div>"],
        ["使用默认值 (${n.autoAllowSkills?`on`:`off`}).", "使用默认值 (${n.autoAllowSkills?`开`:`关`})。"],
        ["覆盖 (${m?`on`:`off`}).", "覆盖 (${m?`开`:`关`})。"],
        ["<span>Enabled</span>", "<span>已启用</span>"],
        [">Use default<", ">使用默认值<"],
        ["No nodes with system.run available.", "暂无可用 system.run 节点。"],
        ["<div class=\"card-sub\">Paired devices and live links.</div>", "<div class=\"card-sub\">已配对设备与实时连接。</div>"],
        ["<div class=\"card-title\">Devices</div>", "<div class=\"card-title\">设备</div>"],
        ["<div class=\"card-sub\">Pairing requests + role tokens.</div>", "<div class=\"card-sub\">配对请求与角色 tokens。</div>"],
        ["<div class=\"muted\" style=\"margin-top: 12px; margin-bottom: 8px;\">Paired</div>", "<div class=\"muted\" style=\"margin-top: 12px; margin-bottom: 8px;\">已配对</div>"],
      ],
    },
    {
      pattern: /^config-page-.*\.js$/,
      label: "config-page",
      pairs: [
        ["[[`quick`,`Simple`],[`advanced`,`Advanced`]]", "[[`quick`,`简洁`],[`advanced`,`高级`]]"],
        ["${V(g.brain,`Model & Thinking`)}", "${V(g.brain,`模型与思考`)}"],
        ["Connect →", "连接 →"],
        ["Configure →", "配置 →"],
        ["`Enabled`", "`已启用`"],
        ["`Disabled`", "`已禁用`"],
        ["`None`", "`无`"],
        ["`Slight`", "`轻微`"],
        ["`Default`", "`默认`"],
        ["`Round`", "`圆润`"],
        ["`Full`", "`完整`"],
        ["`Small`", "`小`"],
        ["`Large`", "`大`"],
        ["detail:r?`Configured`:void 0", "detail:r?`已配置`:void 0"],
      ],
    },
    {
      pattern: /^sessions-page-.*\.js$/,
      label: "sessions-page",
      pairs: [
        ["C=c(x?.name)??``", "C=(c(x?.name)??``).replace(/^Assistant$/,`U-Claw`)"],
        ["T=C&&y?`${S?`${S} `:``}${C} (${y.channel})`:null", "T=C&&y?`${S?`${S} `:``}${C}（${y.channel===`dashboard`?`控制台`:y.channel}）`:null"],
        ["of ${o} row${o===1?``:`s`}", "共 ${o} 行"],
        ["${se.map(e=>i`<option value=${e}>${e} per page</option>`)}", "${se.map(e=>i`<option value=${e}>每页 ${e} 条</option>`)}"],
        [">\n                    Previous\n                  </button>", ">\n                    上一页\n                  </button>"],
      ],
    },
  ];

  for (const group of groups) {
    for (const file of listAssetFiles(group.pattern, group.label)) {
      const before = read(file);
      const after = replacePairs(before, group.pairs);
      if (writeIfChanged(file, before, after)) {
        console.log(`patched ${path.relative(root, file)}`);
      }
    }
  }
}

/**
 * Appends U-Claw product UI tokens and layout polish to generated CSS assets.
 */
function patchControlUiTheme() {
  const markerStart = "/* U-Claw UI polish v1 */";
  const markerEnd = "/* End U-Claw UI polish v1 */";
  const block = `${markerStart}
:root,
:root[data-theme-mode="light"] {
  --font-body: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
  --font-display: var(--font-body);
  --uclaw-navy: #10162b;
  --uclaw-navy-soft: #1a2140;
  --uclaw-claw: #69b1ff;
  --uclaw-claw-strong: #0958d9;
  --uclaw-teal: #4096ff;
  --accent: #1677ff;
  --accent-hover: #0958d9;
  --accent-muted: #4096ff;
  --accent-subtle: #e6f4ff;
  --accent-foreground: #ffffff;
  --accent-glow: rgba(22, 119, 255, 0.24);
  --ring: #1677ff;
  --focus: rgba(22, 119, 255, 0.34);
  --primary: #1677ff;
  --primary-foreground: #ffffff;
  --selection-bg: #1677ff;
  --selection-fg: #ffffff;
  --bg: #f7f9fc;
  --bg-accent: #f2f6fb;
  --bg-elevated: #ffffff;
  --bg-hover: rgba(16, 22, 43, 0.05);
  --bg-muted: #eef3f8;
  --bg-content: #f7f9fc;
  --card: #ffffff;
  --card-foreground: #1f2937;
  --panel: #f8fafc;
  --panel-strong: #ffffff;
  --panel-hover: rgba(16, 22, 43, 0.06);
  --chrome: rgba(255, 255, 255, 0.96);
  --chrome-strong: #ffffff;
  --text: #293241;
  --text-strong: #10162b;
  --chat-text: #293241;
  --muted: #7a8393;
  --muted-strong: #596273;
  --muted-foreground: #7a8393;
  --border: #dbe3ee;
  --border-strong: rgba(16, 22, 43, 0.14);
  --border-hover: #91caff;
  --input: #ffffff;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
}

body {
  background:
    linear-gradient(180deg, rgba(230, 244, 255, 0.78), rgba(247, 249, 252, 0.88) 44%, rgba(255, 255, 255, 0) 72%),
    var(--bg);
  letter-spacing: 0;
}

.content {
  background: var(--bg-content);
}

.content:not(.content--chat):not(.content--workboard) {
  min-width: 0;
  overflow: auto;
  padding: 16px;
  background: var(--bg-content);
  background-image: linear-gradient(180deg, #f8fafc 0%, #f7f9fc 100%);
}

.content > openclaw-router-outlet,
.content openclaw-settings-page,
.content openclaw-config-page,
.content openclaw-agents-page,
.content openclaw-skills-page,
.content openclaw-channels-page {
  min-width: 0;
}

.card,
.panel,
.settings-workspace,
.data-table-wrapper {
  min-width: 0;
  border-radius: 8px;
}

.card-title,
.dashboard-header__breadcrumb-current,
.dashboard-header__breadcrumb-context,
.sidebar-item__label,
.chat-controls__inline-select-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ov-card__label,
.stat-label,
.sw-empty-state__eyebrow {
  text-transform: none;
  letter-spacing: 0;
}

.btn:not(.btn--icon),
.sw-btn {
  max-width: 100%;
  min-height: 36px;
  white-space: normal;
  text-align: center;
  line-height: 1.25;
}

.btn--icon,
.topbar-icon-btn,
.sidebar-brand__icon {
  flex: 0 0 auto;
}

.topbar,
.sidebar,
.login-gate {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(242, 246, 251, 0.9)),
    var(--chrome);
}

.sidebar {
  border-right-color: color-mix(in srgb, var(--uclaw-navy) 10%, var(--border));
}

.topbar {
  border-bottom-color: color-mix(in srgb, var(--uclaw-navy) 9%, var(--border));
  backdrop-filter: blur(14px);
}

.sidebar-brand__logo,
.topbar-brand__logo,
.login-gate__logo,
.agent-chat__avatar--logo img {
  object-fit: cover;
  border-radius: 10px;
  background:
    radial-gradient(circle at 30% 24%, #bae0ff 0 16%, transparent 17%),
    linear-gradient(135deg, var(--primary), var(--uclaw-teal) 58%, var(--uclaw-claw));
  box-shadow: 0 6px 16px rgba(22, 119, 255, 0.18);
}

.sidebar-brand__title,
.topbar-brand__title,
.login-gate__title {
  color: var(--uclaw-navy);
  font-weight: 760;
}

.login-gate__logo {
  width: 56px;
  height: 56px;
}

.agent-chat__avatar--logo {
  width: 54px;
  height: 54px;
  border: 1px solid color-mix(in srgb, var(--primary) 24%, var(--border));
  background: #ffffff;
  box-shadow: 0 12px 28px rgba(16, 22, 43, 0.08);
}

.agent-chat__avatar--logo img {
  width: 46px;
  height: 46px;
}

.nav-item.active,
.nav-item--active,
.sidebar-recent-session--active {
  color: var(--uclaw-navy);
  background: color-mix(in srgb, var(--accent-subtle) 78%, white 22%);
  border-color: color-mix(in srgb, var(--accent) 28%, transparent);
  box-shadow: inset 3px 0 0 var(--accent);
}

.nav-item.active .nav-item__icon,
.nav-item--active .nav-item__icon,
.sidebar-new-session,
.dashboard-header__breadcrumb-current {
  color: var(--accent);
}

.btn:not(.btn--ghost):not(.btn--icon),
.sw-btn,
.chat-send-btn {
  border-color: color-mix(in srgb, var(--accent) 28%, var(--border));
}

.chat-send-btn,
.agent-chat__input-btn--talk {
  color: #ffffff;
  background: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 8px 18px rgba(22, 119, 255, 0.22);
}

.chat-send-btn:hover,
.agent-chat__input-btn--talk:hover {
  background: var(--accent-hover);
}

.chat-controls__skillhub .chat-controls__inline-select-trigger {
  border-color: color-mix(in srgb, var(--accent) 34%, var(--border));
  background: color-mix(in srgb, var(--accent-subtle) 74%, white 26%);
}

.chat-controls__skillhub .chat-controls__inline-select-label,
.chat-controls__skillhub .chat-controls__inline-select-icon {
  color: var(--uclaw-navy);
}

.agent-chat__input:focus-within,
.chat-controls__inline-select-trigger:focus-visible,
.agent-tab:focus-visible,
.btn:focus-visible {
  outline-color: rgba(22, 119, 255, 0.34);
}

.data-table-wrapper {
  overflow-x: auto;
}

.data-table {
  min-width: 640px;
}

.field,
.field input,
.field textarea,
.field select,
.config-form,
.config-form * {
  min-width: 0;
}

.mono,
code,
pre,
.session-key-cell,
.login-gate__command,
.login-gate__failure-raw {
  overflow-wrap: anywhere;
  word-break: break-word;
}

.agent-chat__input {
  min-height: 52px;
  max-height: 150px;
  border-radius: 8px;
}

/* chat-composer-controls-polish-3 */
.agent-chat__input:focus-within {
  box-shadow: 0 0 0 3px rgba(22, 119, 255, 0.12), 0 14px 36px rgba(16, 22, 43, 0.08);
}

.chat-send-btn {
  width: 44px;
  min-width: 44px;
  height: 44px;
  border-radius: 8px;
}

.agent-chat__input:focus-within,
.chat-controls__inline-select-trigger:focus-visible,
.agent-tab:focus-visible,
.btn:focus-visible {
  outline: 2px solid rgba(22, 119, 255, 0.34);
  outline-offset: 2px;
}

.agent-chat__composer-controls,
.agent-chat__toolbar,
.chat-controls,
.chat-controls__session-row,
.chat-controls__actions {
  min-width: 0;
}

.agent-chat__composer-controls .chat-controls {
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  row-gap: 6px;
}

.chat-controls__skillhub,
.chat-composer-model-control {
  max-width: min(360px, 100%);
}

.chat-controls__skillhub {
  flex: 0 1 224px;
  min-width: 168px;
  max-width: min(240px, 100%);
}

.chat-composer-model-control {
  flex: 0 0 auto;
}

.chat-controls__inline-select-trigger {
  min-height: 32px;
  height: 32px;
  max-width: 100%;
  border-radius: 8px;
  box-shadow: none;
}

.chat-controls__skillhub .chat-controls__inline-select-trigger {
  width: 100%;
  min-width: 0;
  padding: 0 10px;
  background: #f8fafc;
  border-color: color-mix(in srgb, var(--accent) 18%, var(--border));
}

.chat-controls__skillhub .chat-controls__inline-select-label {
  min-width: 0;
  max-width: 170px;
  font-size: 13px;
  font-weight: 560;
  line-height: 1;
}

.chat-controls__skillhub .chat-controls__inline-select-icon {
  flex: 0 0 auto;
  margin-left: auto;
  opacity: 0.72;
}

.chat-composer-model-control .chat-controls__inline-select-trigger {
  min-width: 36px;
  padding: 0 8px;
}

.chat-controls__inline-select-menu {
  border: 1px solid color-mix(in srgb, var(--accent) 20%, var(--border));
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 18px 42px rgba(16, 22, 43, 0.14);
  max-width: min(420px, calc(100vw - 24px));
  max-height: min(420px, calc(100vh - 160px));
  overflow: auto;
}

.chat-controls__inline-select-option--selected,
.chat-controls__inline-select-check {
  color: var(--accent);
}

.voice-input-btn,
.voice-control-btn,
.chat-controls__voice button,
button[aria-label*="语音"],
button[aria-label*="麦克风"],
button[aria-label*="Voice"],
button[aria-label*="Microphone"] {
  color: #1677ff !important;
  border-color: #91caff !important;
  background: #e6f4ff !important;
}

.agent-chat__input-btn--talk {
  flex: 0 0 44px;
  width: 44px;
  min-width: 44px;
  height: 44px;
  min-height: 44px;
  align-self: center;
  margin: 0 8px 0 6px;
  border-radius: 10px;
  color: #1677ff !important;
  background: #e6f4ff !important;
  border-color: #91caff !important;
  box-shadow: none !important;
}

.agent-chat__input-btn--talk:hover:not(:disabled),
.agent-chat__input-btn--talk:focus-visible,
.agent-chat__input-btn--talk[aria-pressed="true"],
.agent-chat__input-btn--talk.is-active,
.agent-chat__input-btn--talk[data-state="active"] {
  color: #ffffff !important;
  background: #1677ff !important;
  border-color: #1677ff !important;
}

.agent-chat__input-btn--talk:disabled {
  color: #91caff !important;
  background: #f0f7ff !important;
  border-color: #bae0ff !important;
}

.agent-chat__input-btn--talk svg {
  width: 18px;
  height: 18px;
  color: currentColor;
  stroke: currentColor;
  fill: none;
}

.login-gate {
  padding: max(16px, env(safe-area-inset-top, 0px)) 16px max(16px, env(safe-area-inset-bottom, 0px));
}

.login-gate__card {
  max-width: min(520px, calc(100vw - 32px));
  border-radius: 8px;
  padding: clamp(20px, 4vw, 32px);
}

.login-gate__secret-row,
.login-gate__secret-row input {
  min-width: 0;
}

openclaw-channels-page .card-sub {
  color: var(--muted-strong);
  line-height: 1.55;
}

openclaw-channels-page .account-count {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  min-height: 24px;
  margin-top: 10px;
  padding: 3px 8px;
  border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border));
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
}

openclaw-channels-page .callout {
  border-radius: 8px;
  line-height: 1.55;
}

openclaw-channels-page .config-form {
  margin-top: 14px;
}

openclaw-skills-page .statusDot.warn {
  background: var(--accent-muted);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 11%, transparent);
}

openclaw-skills-page .statusDot.ok {
  background: var(--uclaw-teal);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--uclaw-teal) 10%, transparent);
}

openclaw-agents-page .uclaw-expert-landing {
  display: grid;
  gap: 14px;
  margin-bottom: 14px;
}

openclaw-agents-page .uclaw-expert-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 92px;
}

openclaw-agents-page .uclaw-expert-current {
  flex: 0 0 auto;
  max-width: min(320px, 40vw);
  color: var(--muted);
  font-size: 13px;
}

openclaw-agents-page .uclaw-expert-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(280px, 0.8fr);
  gap: 14px;
}

openclaw-agents-page .agents-layout > .uclaw-expert-landing ~ * {
  display: none !important;
}

openclaw-agents-page .uclaw-expert-landing {
  display: grid;
  gap: 12px;
  max-width: 1160px;
}

openclaw-agents-page .uclaw-expert-page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

openclaw-agents-page .uclaw-expert-page-head h2 {
  margin: 0;
  color: var(--text);
  font-size: 20px;
  line-height: 1.2;
  font-weight: 720;
}

openclaw-agents-page .uclaw-expert-page-head p {
  max-width: 720px;
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.42;
}

openclaw-agents-page .uclaw-create-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 12px;
}

openclaw-agents-page .uclaw-create-panel {
  min-width: 0;
}

openclaw-agents-page .uclaw-open-custom-expert {
  flex: 0 0 auto;
  min-height: 36px;
  padding-inline: 16px;
}

openclaw-agents-page .uclaw-expert-section-title {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  align-items: start;
  gap: 8px;
  margin-bottom: 8px;
}

openclaw-agents-page .uclaw-step {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 8px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  font-size: 12px;
  font-weight: 750;
}

openclaw-agents-page .uclaw-expert-status {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
}

openclaw-agents-page .uclaw-expert-status.ok {
  border-color: color-mix(in srgb, var(--uclaw-teal) 32%, var(--border));
  color: var(--uclaw-teal-strong);
  background: color-mix(in srgb, var(--uclaw-teal) 10%, transparent);
}

openclaw-agents-page .uclaw-expert-status.danger {
  border-color: color-mix(in srgb, var(--danger) 34%, var(--border));
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 9%, transparent);
}

openclaw-agents-page .uclaw-section-head {
  justify-content: space-between;
}

openclaw-agents-page .uclaw-template-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 12px;
}

openclaw-agents-page .uclaw-expert-manager,
openclaw-agents-page .uclaw-expert-detail {
  min-width: 0;
}

openclaw-agents-page .uclaw-expert-card-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(260px, 1fr));
  gap: 8px;
  margin-top: 8px;
}

openclaw-agents-page .uclaw-custom-expert-form {
  align-self: start;
  display: grid;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--surface-raised) 98%, white), color-mix(in srgb, var(--surface) 96%, white)),
    var(--surface-raised);
  box-shadow: 0 10px 24px color-mix(in srgb, var(--text) 7%, transparent);
}

openclaw-agents-page .uclaw-custom-expert-modal {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  padding: 28px;
  background: color-mix(in srgb, var(--text) 42%, transparent);
  backdrop-filter: blur(6px);
}

openclaw-agents-page .uclaw-custom-expert-modal-card {
  display: grid;
  gap: 12px;
  width: min(680px, calc(100vw - 56px));
  max-height: calc(100vh - 56px);
  overflow: auto;
  padding: 16px;
  border: 1px solid color-mix(in srgb, var(--border) 78%, var(--accent));
  border-radius: 8px;
  background:
    linear-gradient(180deg, #ffffff 0%, #f7faff 100%);
  box-shadow: 0 24px 80px color-mix(in srgb, var(--text) 32%, transparent);
}

openclaw-agents-page .uclaw-modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

openclaw-agents-page .uclaw-modal-close {
  flex: 0 0 auto;
}

openclaw-agents-page .uclaw-custom-expert-modal .uclaw-custom-expert-form {
  padding: 12px;
  border-color: color-mix(in srgb, var(--border) 82%, var(--accent));
  background: #ffffff;
  box-shadow: none;
}

openclaw-agents-page .uclaw-custom-card-head {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  min-height: 56px;
  padding: 9px;
  border: 1px solid color-mix(in srgb, var(--border) 82%, var(--accent));
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 7%, var(--surface-raised));
}

openclaw-agents-page .uclaw-custom-preview-avatar {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: 1px solid color-mix(in srgb, var(--accent) 18%, var(--border));
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
  font-size: 16px;
  font-weight: 750;
}

openclaw-agents-page .uclaw-custom-preview-copy {
  min-width: 0;
}

openclaw-agents-page .uclaw-custom-preview-title {
  overflow: hidden;
  color: var(--text);
  font-size: 15px;
  font-weight: 750;
  text-overflow: ellipsis;
  white-space: nowrap;
}

openclaw-agents-page .uclaw-custom-preview-sub {
  overflow: hidden;
  margin-top: 3px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

openclaw-agents-page .uclaw-custom-preview-badge {
  align-self: start;
  padding: 4px 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 84%, transparent);
  color: var(--muted);
  font-size: 11px;
  font-weight: 650;
}

openclaw-agents-page .uclaw-custom-expert-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
}

openclaw-agents-page .uclaw-custom-expert-field {
  display: grid;
  gap: 5px;
  min-width: 0;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
}

openclaw-agents-page .uclaw-custom-expert-field.wide {
  grid-column: 1 / -1;
}

openclaw-agents-page .uclaw-field-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 18px;
}

openclaw-agents-page .uclaw-field-top b,
openclaw-agents-page .uclaw-field-top em {
  font-size: 11px;
  font-style: normal;
  font-weight: 650;
}

openclaw-agents-page .uclaw-field-top b {
  color: var(--accent);
}

openclaw-agents-page .uclaw-field-top em {
  color: var(--muted);
}

openclaw-agents-page .uclaw-form-control {
  width: 100%;
  min-height: 36px;
  padding: 0 11px;
  border: 1px solid color-mix(in srgb, var(--border) 88%, var(--text));
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-raised) 96%, transparent);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  line-height: 1.35;
  box-shadow: inset 0 1px 0 color-mix(in srgb, white 54%, transparent);
  transition: border-color .16s ease, box-shadow .16s ease, background .16s ease;
}

openclaw-agents-page .uclaw-form-control:focus {
  border-color: color-mix(in srgb, var(--accent) 54%, var(--border));
  outline: none;
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent),
    inset 0 1px 0 color-mix(in srgb, white 60%, transparent);
}

openclaw-agents-page select.uclaw-form-control {
  cursor: pointer;
}

openclaw-agents-page .uclaw-custom-expert-textarea {
  min-height: 108px;
  padding: 10px 11px;
  resize: vertical;
  line-height: 1.5;
}

openclaw-agents-page .uclaw-expert-options {
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border) 86%, var(--accent));
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface) 92%, transparent);
}

openclaw-agents-page .uclaw-expert-options.wide {
  grid-column: 1 / -1;
}

openclaw-agents-page .uclaw-expert-options summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 38px;
  padding: 0 12px;
  cursor: pointer;
  color: var(--text);
  font-size: 13px;
  font-weight: 700;
}

openclaw-agents-page .uclaw-expert-options summary span:last-child {
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
}

openclaw-agents-page .uclaw-expert-options-body {
  display: grid;
  gap: 10px;
  padding: 2px 10px 10px;
  border-top: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
}

openclaw-agents-page .uclaw-custom-expert-skills {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 8px;
}

openclaw-agents-page .uclaw-custom-expert-skill {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  padding: 9px;
  border: 1px solid color-mix(in srgb, var(--border) 88%, var(--accent));
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-raised) 90%, transparent);
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
}

openclaw-agents-page .uclaw-custom-expert-skill small {
  display: -webkit-box;
  overflow: hidden;
  grid-column: 2;
  color: var(--muted);
  font-weight: 400;
  line-height: 1.4;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

openclaw-agents-page .uclaw-custom-expert-actions,
openclaw-agents-page .uclaw-section-head.compact {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

openclaw-agents-page .uclaw-custom-expert-actions .primary {
  flex: 1 1 180px;
  justify-content: center;
  min-height: 38px;
}

openclaw-agents-page .uclaw-expert-card {
  display: grid;
  gap: 8px;
  padding: 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-raised) 96%, white);
}

openclaw-agents-page .uclaw-expert-card.is-installed {
  border-color: color-mix(in srgb, var(--uclaw-teal) 28%, var(--border));
}

openclaw-agents-page .uclaw-expert-card-main {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  align-items: start;
  gap: 8px;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
}

openclaw-agents-page .uclaw-expert-card-actions,
openclaw-agents-page .uclaw-expert-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

openclaw-agents-page .uclaw-expert-card-actions .btn {
  min-height: 32px;
  padding-inline: 11px;
  font-size: 12px;
}

openclaw-agents-page .uclaw-expert-pill {
  flex: 0 0 auto;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1;
  background: color-mix(in srgb, var(--surface) 84%, transparent);
}

openclaw-agents-page .uclaw-expert-detail-grid {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  gap: 12px;
  margin-top: 14px;
}

openclaw-agents-page .uclaw-expert-avatar.large {
  width: 56px;
  height: 56px;
  font-size: 18px;
}

openclaw-agents-page .uclaw-expert-kv {
  display: grid;
  gap: 8px;
  margin: 12px 0 0;
}

openclaw-agents-page .uclaw-expert-kv div {
  display: grid;
  gap: 3px;
}

openclaw-agents-page .uclaw-expert-kv dt {
  color: var(--muted);
  font-size: 12px;
}

openclaw-agents-page .uclaw-expert-kv dd {
  margin: 0;
  color: var(--text);
  font-size: 12px;
  line-height: 1.45;
}

openclaw-agents-page .uclaw-expert-template {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-height: 96px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-raised) 82%, transparent);
}

openclaw-agents-page .uclaw-expert-avatar {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  font-weight: 700;
}

openclaw-agents-page .uclaw-expert-body {
  min-width: 0;
}

openclaw-agents-page .uclaw-expert-name {
  color: var(--text);
  font-size: 13px;
  font-weight: 650;
}

openclaw-agents-page .uclaw-expert-meta,
openclaw-agents-page .uclaw-expert-desc {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.32;
}

openclaw-agents-page .uclaw-expert-desc {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

openclaw-agents-page .uclaw-session-list {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}

openclaw-agents-page .uclaw-session-row {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
}

openclaw-agents-page .uclaw-empty-state {
  padding: 14px 0;
}

openclaw-channels-page .card,
openclaw-agents-page .card,
openclaw-skills-page .card,
openclaw-config-page .card {
  overflow: hidden;
}

@media (max-width: 900px) {
  .content:not(.content--chat):not(.content--workboard) {
    padding: 12px;
  }

  .data-table {
    min-width: 560px;
  }

  .chat-controls__skillhub,
  .chat-composer-model-control {
    max-width: 100%;
  }

  openclaw-agents-page .uclaw-expert-grid,
  openclaw-agents-page .uclaw-create-layout,
  openclaw-agents-page .uclaw-template-grid,
  openclaw-agents-page .uclaw-expert-card-grid,
  openclaw-agents-page .uclaw-expert-detail-grid,
  openclaw-agents-page .uclaw-custom-expert-grid,
  openclaw-agents-page .uclaw-custom-expert-skills {
    grid-template-columns: 1fr;
  }

  openclaw-agents-page .uclaw-expert-hero,
  openclaw-agents-page .uclaw-expert-template {
    align-items: stretch;
  }

  openclaw-agents-page .uclaw-expert-page-head,
  openclaw-agents-page .uclaw-modal-head {
    align-items: stretch;
    flex-direction: column;
  }

  openclaw-agents-page .uclaw-open-custom-expert,
  openclaw-agents-page .uclaw-modal-close {
    width: 100%;
    justify-content: center;
  }

  openclaw-agents-page .uclaw-custom-expert-modal {
    padding: 12px;
  }

  openclaw-agents-page .uclaw-custom-expert-modal-card {
    width: calc(100vw - 24px);
    max-height: calc(100vh - 24px);
  }
}

@media (max-width: 640px) {
  .content:not(.content--chat):not(.content--workboard) {
    padding: 8px;
  }

  .card,
  .panel,
  .settings-workspace,
  .data-table-wrapper {
    border-radius: 6px;
  }

  .agent-chat__composer-controls .chat-controls,
  .agent-chat__toolbar-left,
  .agent-chat__toolbar-right {
    width: 100%;
  }

  .chat-controls__inline-select-menu {
    max-height: min(360px, calc(100vh - 128px));
  }
}
${markerEnd}`;

  for (const file of listAssetFiles(/^index-.*\.css$/, "index css")) {
    const before = read(file);
    const withoutOld = before.replace(
      new RegExp(`${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}`),
      "",
    );
    const after = `${withoutOld.trimEnd()}\n${block}\n`;
    if (writeIfChanged(file, before, after)) {
      console.log(`patched ${path.relative(root, file)}`);
    }
  }
}

patchSkillsUninstallGateway();
patchSkillHubInstallGateway();
patchWindowsInstallPublishFallback();
patchChatPage();
patchChatUiCopy();
patchAssistantIdentityUiCopy();
patchChatSkillHubDropdown();
patchSkillsPageBranding();
patchSkillsPageBundledVisibility();
patchSkillsPageUiCopy();
patchSkillsPageStoreDiscovery();
patchSkillsPageLocalUninstallActions();
patchSkillsPageSearchConnectionSync();
patchSkillsPageDefaultStoreSearch();
patchSkillsPageStoreHomeState();
patchSkillsPageSearchIdentityRequests();
patchSkillsSharedUiCopy();
patchAgentsPageUiCopy();
patchChannelsPageUiCopy();
patchConfigFormUiCopy();
patchConfigPageUiCopy();
patchI18nUiCopy();
patchSecondaryPagesI18nUiCopy();
patchSecondaryPagesInlineUiCopy();
patchTertiaryPagesI18nUiCopy();
patchSkillWorkshopPageUiCopy();
patchDeepAgentsChatI18nUiCopy();
patchOverviewPageUiCopy();
patchControlUiHtmlBranding();
patchControlUiManifestBranding();
patchControlUiShellBranding();
patchControlUiSkillHubProxy();
patchIndexUiCopy();
patchPrimaryNavigationProjection();
patchFinalUiPolish();
patchControlUiBrandAssets();
patchControlUiTheme();
patchControlCss();
patchLocalMediaRoots();
patchOpenAiCompatibleImageResponses();
patchConfiguredUclawImageGenerationModelsOnly();
patchXaiVideoLoopbackAccess();
patchConfiguredMediaResultDownloadTrust();
patchXaiVideoDownloadFallback();
patchServiceWorker();
