import type { ChatQueueItem } from "@uclaw/shared";
import { Ellipsis, SendHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";

interface QueuedMessageBarProps {
  items: ChatQueueItem[];
  onSend(item: ChatQueueItem): void;
  onRemove(item: ChatQueueItem): void;
  onSave(item: ChatQueueItem, text: string, attachmentIds: string[]): void | Promise<void>;
  onAddAttachments?(currentIds: string[]): Promise<string[]>;
  onReleaseAttachments?(attachmentIds: string[]): void;
}

export function QueuedMessageBar({ items, onSend, onRemove, onSave, onAddAttachments, onReleaseAttachments }: QueuedMessageBarProps) {
  const [menuId, setMenuId] = useState<string>();
  const [editingId, setEditingId] = useState<string>();
  const [editingText, setEditingText] = useState("");
  const [editingAttachments, setEditingAttachments] = useState<string[]>([]);
  const [retainedAttachments, setRetainedAttachments] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string>();
  if (items.length === 0) return null;
  return <section className="queued-message-bar" aria-label="消息队列">
    {items.map((item) => <article key={item.id}>
      {editingId === item.id ? <>
        <textarea aria-label="编辑队列消息" value={editingText} onChange={(event) => setEditingText(event.target.value)} />
        <div className="queued-message-attachments">{editingAttachments.map((id) => <span key={id} aria-label={`队列附件 ${id}`}>{id}<button type="button" aria-label={`移除队列附件 ${id}`} onClick={() => { setEditingAttachments((current) => current.filter((value) => value !== id)); if (retainedAttachments.includes(id)) { setRetainedAttachments((current) => current.filter((value) => value !== id)); onReleaseAttachments?.([id]); } }}><Trash2 /></button></span>)}</div>
        {onAddAttachments ? <button type="button" aria-label="添加队列附件" onClick={() => void onAddAttachments(editingAttachments).then((ids) => { setEditingAttachments((current) => [...current, ...ids]); setRetainedAttachments((current) => [...current, ...ids]); }).catch((error) => setSaveError(error instanceof Error ? error.message : "添加附件失败"))}>添加附件</button> : null}
        <button type="button" aria-label="保存队列消息" onClick={() => void Promise.resolve(onSave(item, editingText, editingAttachments)).then(() => { onReleaseAttachments?.(retainedAttachments); setRetainedAttachments([]); setEditingId(undefined); setSaveError(undefined); }).catch((error) => setSaveError(error instanceof Error ? error.message : "保存失败"))}>保存</button>
        <button type="button" onClick={() => { onReleaseAttachments?.(retainedAttachments); setRetainedAttachments([]); setEditingId(undefined); }}>取消</button>
        {saveError ? <span role="alert">{saveError}</span> : null}
      </> : <>
        <span><strong>{item.text || "附件消息"}</strong><small>{item.status === "failed" ? item.error?.message ?? "发送失败" : "等待发送"}</small></span>
        <button type="button" aria-label={`调整方向：${item.text}`} title="调整方向" onClick={() => onSend(item)}><SendHorizontal /></button>
        <button type="button" aria-label={`删除：${item.text}`} title="删除" onClick={() => onRemove(item)}><Trash2 /></button>
        <button type="button" aria-label={`更多：${item.text}`} title="更多" onClick={() => setMenuId((current) => current === item.id ? undefined : item.id)}><Ellipsis /></button>
        {menuId === item.id ? <div className="queued-message-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setEditingId(item.id); setEditingText(item.text); setEditingAttachments(item.attachmentIds); setRetainedAttachments([]); setSaveError(undefined); setMenuId(undefined); }}>编辑消息</button></div> : null}
      </>}
    </article>)}
  </section>;
}
