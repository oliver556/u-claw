import type { SessionSummary } from "@uclaw/shared";
import { AlertCircle, LoaderCircle, MoreHorizontal, PanelLeft, Pencil, Plus, RotateCw, Search, Trash2 } from "lucide-react";
import { Popconfirm, Tooltip } from "antd";
import { useState } from "react";

interface SessionSidebarProps {
  sessions: SessionSummary[];
  activeSessionId?: string;
  state: "loading" | "ready" | "error";
  error?: string;
  creating?: boolean;
  hasMore?: boolean;
  onSelect(sessionId: string): void;
  onCreate(): void;
  onRename(session: SessionSummary): void;
  onRemove(session: SessionSummary): void;
  onLoadMore(): void;
  onRetry(): void;
  onClose(): void;
}

export function SessionSidebar({ sessions, activeSessionId, state, error, creating = false, hasMore = false, onSelect, onCreate, onRename, onRemove, onLoadMore, onRetry, onClose }: SessionSidebarProps) {
  const [query, setQuery] = useState("");
  const visibleSessions = sessions.filter((session) => `${session.title} ${session.lastMessagePreview ?? ""}`.toLocaleLowerCase("zh-CN").includes(query.trim().toLocaleLowerCase("zh-CN")));
  return <aside className="session-panel" aria-label="会话栏">
    <header><div><small>工作台</small><h1>最近会话</h1></div><Tooltip title="新建会话"><button className="icon-button primary-soft" type="button" aria-label="新建会话" disabled={creating} onClick={onCreate}>{creating ? <LoaderCircle className="spin" /> : <Plus aria-hidden="true" />}</button></Tooltip></header>
    <label className="session-search"><Search aria-hidden="true" /><span className="sr-only">搜索会话</span><input type="search" placeholder="搜索会话" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    <div className="session-list" aria-busy={state === "loading"}>
      <p className="panel-label">会话</p>
      {state === "loading" ? <div className="session-state"><LoaderCircle className="spin" /><span>正在加载会话</span></div> : null}
      {state === "error" ? <div className="session-state" role="alert"><AlertCircle /><span>{error ?? "会话加载失败"}</span><button type="button" onClick={onRetry}><RotateCw />重试</button></div> : null}
      {state === "ready" && sessions.length === 0 ? <div className="session-state"><span>还没有会话</span><button type="button" onClick={onCreate}><Plus />新建会话</button></div> : null}
      {state === "ready" && sessions.length > 0 && visibleSessions.length === 0 ? <div className="session-state"><span>没有匹配的会话</span></div> : null}
      {state === "ready" ? visibleSessions.map((session) => <div key={session.id} className={`session-row${activeSessionId === session.id ? " active" : ""}`}>
        <button type="button" aria-label={`${session.title}，${session.lastMessagePreview ?? "暂无消息"}`} onClick={() => onSelect(session.id)}><strong>{session.title}</strong><span>{session.lastMessagePreview ?? "暂无消息"}</span><time>{new Date(session.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></button>
        <div className="session-row-actions"><Tooltip title="重命名"><button type="button" aria-label="重命名会话" onClick={() => onRename(session)}><Pencil /></button></Tooltip><Popconfirm title="删除此会话？" description="删除后无法恢复。" okText="删除" cancelText="取消" onConfirm={() => onRemove(session)}><button type="button" aria-label="删除会话"><Trash2 /></button></Popconfirm></div>
      </div>) : null}
      {state === "ready" && hasMore ? <button className="session-load-more" type="button" onClick={onLoadMore}><MoreHorizontal />加载更多</button> : null}
    </div>
    <div className="storage-summary"><span><i className="status-dot success" />数据写入正常</span><strong>空间充足</strong></div>
    <Tooltip title="收起会话栏"><button className="panel-edge-close" type="button" aria-label="收起会话栏" onClick={onClose}><PanelLeft aria-hidden="true" /></button></Tooltip>
  </aside>;
}
