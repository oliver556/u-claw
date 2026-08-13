import type { ChatQueueItem } from "@uclaw/shared";
import { Ellipsis, SendHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";

interface QueuedMessageBarProps {
  items: ChatQueueItem[];
  onSend(item: ChatQueueItem): void;
  onRemove(item: ChatQueueItem): void;
  onSave(item: ChatQueueItem, text: string): void;
}

export function QueuedMessageBar({ items, onSend, onRemove, onSave }: QueuedMessageBarProps) {
  const [menuId, setMenuId] = useState<string>();
  const [editingId, setEditingId] = useState<string>();
  const [editingText, setEditingText] = useState("");
  if (items.length === 0) return null;
  return <section className="queued-message-bar" aria-label="消息队列">
    {items.map((item) => <article key={item.id}>
      {editingId === item.id ? <>
        <textarea aria-label="编辑队列消息" value={editingText} onChange={(event) => setEditingText(event.target.value)} />
        <button type="button" aria-label="保存队列消息" onClick={() => { onSave(item, editingText); setEditingId(undefined); }}>保存</button>
        <button type="button" onClick={() => setEditingId(undefined)}>取消</button>
      </> : <>
        <span><strong>{item.text || "附件消息"}</strong><small>{item.status === "failed" ? item.error?.message ?? "发送失败" : "等待发送"}</small></span>
        <button type="button" aria-label={`调整方向：${item.text}`} title="调整方向" onClick={() => onSend(item)}><SendHorizontal /></button>
        <button type="button" aria-label={`删除：${item.text}`} title="删除" onClick={() => onRemove(item)}><Trash2 /></button>
        <button type="button" aria-label={`更多：${item.text}`} title="更多" onClick={() => setMenuId((current) => current === item.id ? undefined : item.id)}><Ellipsis /></button>
        {menuId === item.id ? <div className="queued-message-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setEditingId(item.id); setEditingText(item.text); setMenuId(undefined); }}>编辑消息</button></div> : null}
      </>}
    </article>)}
  </section>;
}
