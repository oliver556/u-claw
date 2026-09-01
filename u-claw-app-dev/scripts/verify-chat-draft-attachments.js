const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const assetsDir = path.join(root, 'node_modules', 'openclaw', 'dist', 'control-ui', 'assets');

function readAsset(pattern, label) {
  const name = fs.readdirSync(assetsDir).find((entry) => pattern.test(entry));
  if (!name) throw new Error(`Missing ${label}`);
  return fs.readFileSync(path.join(assetsDir, name), 'utf8');
}

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function check(ok, label) {
  if (!ok) throw new Error(`Missing ${label}`);
  console.log(`PASS ${label}`);
}

const chat = readAsset(/^chat-page-.*\.js$/, 'chat page asset');
const css = readAsset(/^index-.*\.css$/, 'index stylesheet');
const patch = readProjectFile('scripts/patch-openclaw.js');

check(chat.includes('function UcSerializeDraftAttachments('), 'draft attachment serializer exists');
check(chat.includes('i=Array.isArray(t.attachments)?t.attachments.map(Uu).filter(e=>e!==null):void 0'), 'persisted composer entry reads attachments');
check(chat.includes('attachments:a.attachments??[]'), 'composer restore loads persisted attachments');
check(chat.includes('c=UcSerializeDraftAttachments(e.chatAttachments??[])'), 'composer persist serializes current attachments');
check(chat.includes('c.length>0?{attachments:c}:{}'), 'composer localStorage stores attachments when present');
check(chat.includes('function uClawSaveComposerAttachments(e,t)'), 'in-memory per-session attachment save helper');
check(chat.includes('function uClawRestoreComposerAttachments(e,t)'), 'in-memory per-session attachment restore helper');
check(chat.includes('uClawSaveComposerAttachments(e,n)'), 'session switch saves current attachments');
check(chat.includes('e.chatAttachments=uClawRestoreComposerAttachments(e,t)'), 'session switch restores target attachments before persisted restore');
check(chat.includes('chatAttachmentsBySession:{}'), 'chat state owns per-session attachment map');
check(chat.includes('chatAttachments:e.chatAttachments'), 'composer persistence snapshot tracks attachments');
check(chat.includes('lastPersisted?.chatAttachments!==e?.chatAttachments'), 'request update persists attachment-only changes');

check(css.includes('.agent-chat__composer-shell .chat-attachments-preview'), 'composer attachment strip css');
check(css.includes('.agent-chat__composer-shell .chat-attachment-thumb{position:relative;flex:0 0 auto;width:58px;height:58px'), 'composer image thumb fixed size');
check(css.includes('.agent-chat__composer-shell .chat-attachment-remove{position:absolute;top:3px;right:3px'), 'composer remove button overlay');

check(patch.includes('function UcSerializeDraftAttachments('), 'source patch owns draft attachment serializer');
check(patch.includes('const composerAttachmentCss = ['), 'source patch owns composer attachment css');
