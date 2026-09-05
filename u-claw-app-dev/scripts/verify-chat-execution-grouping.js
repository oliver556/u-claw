#!/usr/bin/env node
"use strict";

/**
 * Verifies Bavi-box chat projects OpenClaw tool events as a compact execution
 * trace, without changing the underlying session.tool data contract.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const openclawDistDir = path.join(root, "node_modules", "openclaw", "dist");
const assetsDir = path.join(root, "node_modules", "openclaw", "dist", "control-ui", "assets");
const patchFile = path.join(root, "scripts", "patch-openclaw.js");
const swFile = path.join(root, "node_modules", "openclaw", "dist", "control-ui", "sw.js");

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function findAsset(pattern, label) {
  const matches = fs.readdirSync(assetsDir).filter((name) => pattern.test(name));
  if (matches.length !== 1) {
    throw new Error(`Expected one ${label}, found ${matches.length}: ${matches.join(", ")}`);
  }
  return path.join(assetsDir, matches[0]);
}

const chatSource = read(findAsset(/^chat-page-.*\.js$/, "chat-page bundle"));
const cssSource = read(findAsset(/^index-.*\.css$/, "control-ui stylesheet"));
const sessionTranscriptSource = read(path.join(openclawDistDir, "session-transcript-path-EobUxjvp.js"));
const chatGatewaySource = read(path.join(openclawDistDir, "chat-pg-BxhF6.js"));
const patchSource = read(patchFile);
const swSource = read(swFile);

const checks = [
  [chatSource, "ariaLabel:\"已完成 · 执行过程 · \"+(n.length||1)+\" 步\"", "execution trace keeps an accessible label without visible process copy"],
  [chatSource, "hi(`assistant`,{name:r,avatar:t.assistantAvatar??null}", "tool activity uses the assistant avatar"],
  [chatSource, "部分步骤未完成", "tool failures are softened in the summary"],
  [chatSource, "步骤未完成", "expanded failed step label is localized"],
  [chatSource, "function uClawChatReadingStatus(", "semantic loading status helper is installed"],
  [chatSource, "function uClawChatStreamRunItems(", "consecutive stream fragments are merged for display"],
  [chatSource, "function uClawChatActivityState(", "execution trace status helper is installed"],
  [chatSource, "function uClawCompactChatRenderItems(", "historical render items are compacted by turn"],
  [chatSource, "function uClawPushCompactTurn(", "tool groups are collected before final assistant output"],
  [chatSource, "kind:`assistant-turn`", "tool execution and final output share one assistant turn item"],
  [chatSource, "function uClawAssistantTurn(", "assistant turn renderer is installed"],
  [chatSource, "t.kind===`assistant-turn`?", "chat renderer handles merged assistant turns"],
  [chatSource, "processContents", "pre-tool assistant text is collapsed into the execution process"],
  [chatSource, "uclaw-execution:plain:", "normal no-tool chat also shows a consistent execution process header"],
  [chatSource, "q=e=>!uClawIsAssistantPendingRenderItem(e)", "pure loading bubbles are filtered from execution process contents"],
  [chatSource, "v=(i?.processContents?.length||0)>0||(i?.messages?.length||0)>0", "empty execution traces do not render a blank body"],
  [chatSource, "<span class=\"chat-activity-group__label\">${u.label}</span>", "assistant execution header hides process wording"],
  [chatSource, "o.processContents=[...a.filter(q),...m.filter(q)]", "execution process hides duplicated inner loading rows"],
  [chatSource, "l.every(e=>e.outputText!==void 0||e.isError===!0)", "completed non-image tool-only turns do not remain stuck as running"],
  [chatSource, "u&&!d&&!h", "image tool output does not complete the turn before final media output"],
  [chatSource, "o.hasFinalContents=c", "execution state knows whether final assistant content exists"],
  [chatSource, "uClawAssistantTurnHasFinalContent", "completed final output marks execution as done"],
  [chatSource, "uClawCompactChatRenderItems(nx(h))", "chat renderer uses compacted historical items"],
  [chatSource, "if(n===`tool`){", "single and multi-step tool groups use compact activity rendering"],
  [chatSource, "正在思考", "blank loading can explain thinking state"],
  [chatSource, "正在执行 · 当前：", "blank loading can explain tool execution state"],
  [chatSource, "正在提交视频生成", "video generation has a specific submitting state"],
  [chatSource, "正在生成回复", "blank loading can explain response generation state"],
  [chatSource, "进行中", "execution trace can show running state"],
  [chatSource, "已完成", "execution trace can show completed state"],
  [chatSource, "function uClawIsAssistantPendingRenderItem(", "pending loading bubbles can be identified before display"],
  [chatSource, "pendingStatus", "execution summary follows pending status changes"],
  [chatSource, "i?.pendingStatus||(u.running", "running execution header uses the current semantic status"],
  [chatSource, "正在调用 ${u.detail.slice(3)}", "running execution header falls back to current tool name"],
  [chatSource, "u.detail.startsWith(`正在`)?u.detail:null", "running execution header can show waiting media result"],
  [chatSource, "u.running||l?`running`:`done`", "running and completed execution traces use separate expansion keys"],
  [chatSource, "f=v&&(u.running||l?b!==!1:b===!0)", "execution traces only expand when there are steps to show"],
  [chatSource, "Math.max(a.length", "assistant turn counts process-only running steps"],
  [chatSource, "chat-activity-group__spinner", "running execution trace has a visible spinner"],
  [chatSource, "图片结果已返回", "collapsed image trace explains returned output"],
  [chatSource, "正在等待图片结果", "image generation waits for final media output"],
  [chatSource, "视频生成已提交，完成后自动显示", "collapsed video trace explains async completion"],
  [chatSource, "视频结果已返回", "collapsed video trace explains returned output"],
  [chatSource, "e.kind===`reading-indicator`?mS(e):", "reading indicator receives status context"],
  [chatSource, "status:uClawChatReadingStatus(e)", "live stream loading derives status from observable state"],
  [chatSource, "uClawChatStreamRunItems(e).map", "stream-run rendering uses merged display items"],
  [chatSource, "if(e.showToolCalls)for(let e of p)t.push({kind:`message`,key:e.key,message:e.message})", "tool messages are displayed as one compact block before response stream"],
  [chatSource, "activeRun:i&&Je(i)", "active session state is passed into chat rendering"],
  [chatSource, "e.activeRun===t.activeRun", "active session rendering cache invalidates correctly"],
  [chatSource, "status:uClawChatReadingStatus(e,{activeRun:!0})", "active sessions show a syncing placeholder without local stream"],
  [chatSource, "function uClawSaveLiveSession(", "running chat UI state is cached before session switch"],
  [chatSource, "function uClawRestoreLiveSession(", "running chat UI state can be restored after session switch"],
  [chatSource, "chatMessages:[...e.chatMessages??[]]", "running chat cache preserves optimistic local messages"],
  [chatSource, "chatQueue:[...e.chatQueue??[]]", "running chat cache preserves in-flight user queue"],
  [chatSource, "function uClawMergeLiveQueue(", "running chat restore merges cached user queue"],
  [chatSource, "e.chatMessages=ql(e.chatMessages,t.chatMessages)", "running chat restore merges cached local messages"],
  [chatSource, "uClawSaveLiveSession(e,n)", "session switch saves live stream state"],
  [chatSource, "rx(m,uClawCompactChatRenderItems(nx(h)))", "deleted synthetic assistant turns invalidate render cache"],
  [chatSource, "let r=uClawRestoreLiveSession(e,t)", "session switch restores live stream state"],
  [chatSource, "uClawForgetLiveSession(e,e.sessionKey),await e.sessions.reset", "clearing chat history drops stale live cache"],
  [chatSource, "chatLiveBySession:new Map", "component state owns live session cache"],
  [chatSource, "__uclawChatLiveBySession", "live session cache survives chat component remounts"],
  [chatSource, "function uClawRememberBackgroundDelta(", "background text deltas are cached when received"],
  [chatSource, "function uClawRememberBackgroundStreamItem(", "background tool stream items are cached when received"],
  [chatSource, "function uClawRememberHiddenSubmittedChat(", "hidden-session send acknowledgements preserve optimistic user messages"],
  [chatSource, "uClawRememberHiddenSubmittedChat(e,l,a.agentId,o,c?s:void 0,d,r)", "send acknowledgement updates hidden session cache"],
  [chatSource, "uClawForgetLiveSession(e,t.sessionKey)", "background final clears stale live cache"],
  [chatSource, "pu(e)&&uClawRestoreLiveSession(e,n)", "history refresh restores live cache before falling back to syncing"],
  [chatSource, "正在同步进度", "restored active sessions show syncing status"],
  [chatSource, "uClawRestoredRunSyncing", "restored active session flag is present"],
  [chatSource, "e.chatRunId=null,e.chatRunStatus=null,e.chatStream=``", "fallback restore does not keep stale run id"],
  [chatSource, "pu(e)&&!e.chatRunId&&e.chatStream===null", "active history refresh keeps a visible running placeholder"],
  [chatSource, 'content="删除"', "delete tooltip is localized"],
  [chatSource, 'aria-label="删除消息"', "delete button aria label is localized"],
  [chatSource, "删除这条消息？", "delete confirmation prompt is localized"],
  [chatSource, "不再询问", "delete confirmation remember option is localized"],
  [chatSource, ">取消</button>", "delete confirmation cancel action is localized"],
  [chatSource, ">删除</button>", "delete confirmation destructive action is localized"],
  [chatSource, "!t&&e.canAbort?s`", "composer stop button only renders when the draft is empty"],
  [sessionTranscriptSource, "function uClawChatErrorDisplayText(message)", "assistant error display preserves real error details"],
  [sessionTranscriptSource, "uClawChatErrorDisplayText(message) ?? GATEWAY_ASSISTANT_ERROR_FALLBACK_TEXT", "empty assistant errors prefer real error metadata"],
  [sessionTranscriptSource, "const uClawVisibleErrorText = uClawChatErrorDisplayText(message);", "visible assistant errors are replaced with sanitized real error details"],
  [sessionTranscriptSource, "回复生成失败，未返回具体错误。请查看日志。", "assistant error fallback is localized"],
  [chatGatewaySource, "params.stopReason ?? (params.errorMessage ? \"error\" : \"stop\")", "gateway injected assistant messages can persist error stopReason"],
  [chatGatewaySource, "...params.errorMessage ? { errorMessage: params.errorMessage } : {}", "gateway injected assistant messages preserve errorMessage"],
  [chatGatewaySource, "async function appendWebchatErrorTranscript(params)", "gateway dispatch errors are persisted to transcript"],
  [chatGatewaySource, "function uClawVisibleWebchatErrorText(value)", "realtime gateway error text is sanitized before display"],
  [chatGatewaySource, "const errorText = uClawVisibleWebchatErrorText(params.errorMessage);", "chat error broadcasts use sanitized visible text"],
  [chatGatewaySource, "idempotencyKey: `${params.runId}:error`", "persisted gateway errors are idempotent"],
  [patchSource, "function patchChatErrorDetails()", "patch script owns chat error detail preservation"],
  [patchSource, "uClawChatErrorDisplayText(message) ?? GATEWAY_ASSISTANT_ERROR_FALLBACK_TEXT", "patch script preserves real error details in history projection"],
  [patchSource, "async function appendWebchatErrorTranscript(params)", "patch script owns gateway error transcript append"],
  [patchSource, "function uClawVisibleWebchatErrorText(value)", "patch script owns realtime gateway error display sanitizing"],
  [cssSource, "uclaw-turn-execution-grouping-19", "runtime stylesheet has execution grouping marker"],
  [cssSource, "uclaw-chat-reading-status-1", "runtime stylesheet has semantic loading marker"],
  [cssSource, ".chat-group--assistant-turn .chat-activity-group--turn", "execution trace renders inside the assistant turn"],
  [cssSource, ".chat-group--assistant-turn .chat-activity-group--turn{width:fit-content;max-width:100%;margin-bottom:6px}", "collapsed execution trace width follows its label"],
  [cssSource, ".chat-group--assistant-turn .chat-activity-group--turn.is-open{width:100%}", "expanded execution trace still gives details full width"],
  [cssSource, ".chat-group--assistant-turn button.chat-activity-group__summary:not(:has(.collapse-chevron)){cursor:default}", "empty execution trace is not presented as expandable"],
  [cssSource, ".chat-group--assistant-turn button.chat-activity-group__summary:not(:has(.collapse-chevron)):hover", "empty execution trace does not look expandable on hover"],
  [cssSource, ".chat-group--assistant-turn .chat-activity-group__summary .collapse-chevron--collapsed{transform:rotate(-90deg)}", "expandable execution traces show collapsed arrow state"],
  [cssSource, ".chat-group--assistant-turn .chat-activity-group__process", "pre-tool process content stays collapsed"],
  [cssSource, ".chat-group--assistant-turn .chat-activity-group__body{margin-left:0!important;padding:8px 12px 10px 14px!important}", "assistant turn execution body uses compact left padding"],
  [cssSource, ".chat-group--assistant-turn .chat-activity-group__body>.chat-bubble--tool-shell{margin:0!important}", "assistant turn nested tool shell keeps panel structure without extra margin"],
  [cssSource, ".chat-group--assistant-turn .chat-activity-group__body .chat-bubble--tool-shell{padding:0!important;border:0!important;background:transparent!important;box-shadow:none!important}", "nested tool rows remove bubble chrome inside execution body"],
  [cssSource, ".chat-group--assistant-turn .chat-activity-group__body .chat-tools-inline{display:flex!important;flex-direction:column!important;gap:3px!important}", "nested tool rows use compact consistent spacing"],
  [cssSource, ".chat-group--assistant-turn .chat-activity-group__body .chat-tool-msg-summary__label{display:none!important}", "nested tool rows suppress duplicated status labels"],
  [cssSource, ".chat-group:not(.chat-group--assistant-turn):has(.chat-reading-indicator.uclaw-chat-reading-status) .chat-group-messages{width:100%;max-width:var(--chat-message-max-width,min(900px,68%))}", "standalone loading indicator uses execution header width"],
  [cssSource, ".chat-group:not(.chat-group--assistant-turn) .chat-reading-indicator.uclaw-chat-reading-status", "standalone loading indicator is styled as an execution header"],
  [cssSource, ".chat-activity-group__process .chat-bubble", "process text is rendered without nested bubble chrome"],
  [cssSource, ".chat-activity-group__spinner", "running execution summary shows spinner"],
  [cssSource, "@keyframes uclaw-activity-spin", "running execution spinner animates"],
  [cssSource, ".uclaw-chat-reading-status__label", "semantic loading label is styled"],
  [cssSource, ".chat-activity-group__summary.is-running", "execution trace running state is styled"],
  [cssSource, ".chat-activity-group__state", "execution trace state detail is styled"],
  [cssSource, ".chat-group>.chat-avatar{align-self:flex-start!important", "avatars align with the first message line"],
  [cssSource, ".chat-group.assistant:has(+ .chat-group.tool) + .chat-group.tool>.chat-avatar{visibility:hidden!important}", "tool avatar is hidden only after an assistant avatar is already visible"],
  [cssSource, ".chat-group.tool + .chat-group.assistant>.chat-avatar{visibility:hidden!important}", "repeated assistant avatar is suppressed after tool trace"],
  [swSource, "chat-execution-grouping-19-chat-delete-i18n-1-chat-composer-single-action-1-chat-delete-render-cache-1-chat-hidden-send-restore-1", "service worker cache version changes for hidden send restore"],
  [patchSource, "uclaw-turn-execution-grouping-19", "patch script owns execution grouping marker"],
  [patchSource, "u.running||l?`running`:`done`", "patch script separates running and completed expansion state"],
  [patchSource, "f=v&&(u.running||l?b!==!1:b===!0)", "empty execution traces cannot enter expanded state"],
  [patchSource, "uclaw-chat-reading-status-1", "patch script owns semantic loading marker"],
  [patchSource, "function uClawChatReadingStatus(", "patch script owns semantic loading helper"],
  [patchSource, "function uClawChatStreamRunItems(", "patch script owns stream display merge helper"],
  [patchSource, "function uClawChatActivityState(", "patch script owns execution trace status helper"],
  [patchSource, "function uClawCompactChatRenderItems(", "patch script owns historical render compaction helper"],
  [patchSource, "function uClawPushCompactTurn(", "patch script owns turn-level execution compaction"],
  [patchSource, "uclaw-execution:plain:", "patch script keeps normal no-tool chat visually consistent"],
  [patchSource, "q=e=>!uClawIsAssistantPendingRenderItem(e)", "patch script filters duplicated pending rows from execution process"],
  [patchSource, "v=(i?.processContents?.length||0)>0||(i?.messages?.length||0)>0", "patch script suppresses blank execution bodies"],
  [patchSource, "l.every(e=>e.outputText!==void 0||e.isError===!0)", "patch script completes non-image tool-only turns with outputs"],
  [patchSource, "u&&!d&&!h", "patch script keeps image tool output pending before final media"],
  [patchSource, "o.hasFinalContents=c", "patch script tracks final assistant content"],
  [patchSource, "function uClawIsAssistantPendingRenderItem(", "patch script identifies pending loading rows"],
  [patchSource, "pendingStatus", "patch script updates execution summary from pending status"],
  [patchSource, "i?.pendingStatus||(u.running", "patch script promotes current semantic status into header"],
  [patchSource, "正在调用 ${u.detail.slice(3)}", "patch script falls back to current tool name in header"],
  [patchSource, "u.detail.startsWith(`正在`)?u.detail:null", "patch script can show waiting media result in header"],
  [patchSource, "f=v&&(u.running||l?b!==!1:b===!0)", "patch script opens traces only when details exist"],
  [patchSource, "chat-activity-group__spinner", "patch script owns visible running spinner"],
  [patchSource, "kind:`assistant-turn`", "patch script owns merged assistant turn item"],
  [patchSource, "function uClawAssistantTurn(", "patch script owns merged assistant turn renderer"],
  [patchSource, "t.kind===`assistant-turn`?", "patch script routes merged assistant turns"],
  [patchSource, "if(n===`tool`){", "patch script makes every tool group compact"],
  [patchSource, "if(e.showToolCalls)for(let e of p)t.push({kind:`message`,key:e.key,message:e.message})", "patch script separates tool block from response stream"],
  [patchSource, "activeRun:i&&Je(i)", "patch script passes active run state to renderer"],
  [patchSource, "status:uClawChatReadingStatus(e,{activeRun:!0})", "patch script owns active run placeholder"],
  [patchSource, "function uClawSaveLiveSession(", "patch script owns live session cache helper"],
  [patchSource, "function uClawRestoreLiveSession(", "patch script owns live session restore helper"],
  [patchSource, "chatMessages:[...e.chatMessages??[]]", "patch script preserves optimistic local messages in live cache"],
  [patchSource, "chatQueue:[...e.chatQueue??[]]", "patch script preserves in-flight user queue in live cache"],
  [patchSource, "function uClawMergeLiveQueue(", "patch script owns live queue restore helper"],
  [patchSource, "rx(m,uClawCompactChatRenderItems(nx(h)))", "patch script invalidates render cache for synthetic assistant turn deletes"],
  [patchSource, "uClawForgetLiveSession(e,e.sessionKey),await e.sessions.reset", "patch script clears live cache when chat history is cleared"],
  [patchSource, "__uclawChatLiveBySession", "patch script stores live cache globally"],
  [patchSource, "function uClawRememberBackgroundDelta(", "patch script owns background delta cache helper"],
  [patchSource, "function uClawRememberBackgroundStreamItem(", "patch script owns background tool cache helper"],
  [patchSource, "function uClawRememberHiddenSubmittedChat(", "patch script owns hidden-session send restore helper"],
  [patchSource, "uClawRememberHiddenSubmittedChat(e,l,a.agentId,o,c?s:void 0,d,r)", "patch script updates hidden session cache after send acknowledgement"],
  [patchSource, "uClawForgetLiveSession(e,t.sessionKey)", "patch script clears background final live cache"],
  [patchSource, "pu(e)&&uClawRestoreLiveSession(e,n)", "patch script restores live cache during active history refresh"],
  [patchSource, "e.chatRunId=null,e.chatRunStatus=null,e.chatStream=``", "patch script clears stale run id on syncing placeholder"],
  [patchSource, "Delete this message?", "patch script owns delete confirmation localization source"],
  [patchSource, "!t&&e.canAbort?s`", "patch script owns composer single action state"],
];

for (const [source, needle, label] of checks) {
  if (!source.includes(needle)) {
    throw new Error(`Missing ${label}: ${needle}`);
  }
}

const markerCount = cssSource.split("uclaw-turn-execution-grouping-19").length - 1;
if (markerCount !== 1) {
  throw new Error(`Expected one execution grouping CSS marker, found ${markerCount}`);
}

const hiddenStepCountNeedles = [
  "${S.label} · 执行过程 · ${i} 步",
  "${u.label} · 执行过程 · ${o} 步",
  "执行过程 · 1 步",
  "<span class=\"chat-activity-group__label\">${u.label} · 执行过程</span>",
  ".uclaw-chat-reading-status__label::after{content:' · 执行过程'}",
];
for (const needle of hiddenStepCountNeedles) {
  if (chatSource.includes(needle) || cssSource.includes(needle)) {
    throw new Error(`Visible execution step count should be hidden: ${needle}`);
  }
}

const englishDeleteCopyNeedles = [
  'content="Delete"',
  'aria-label="Delete message"',
  "Delete this message?",
  "Don't ask again",
  ">Cancel</button>",
  ">Delete</button>",
];
for (const needle of englishDeleteCopyNeedles) {
  if (chatSource.includes(needle)) {
    throw new Error(`English delete copy should be localized: ${needle}`);
  }
}

console.log("chat execution grouping verified");
