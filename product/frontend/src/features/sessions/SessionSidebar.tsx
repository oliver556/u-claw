import type { SessionGroup, SessionSummary } from "@uclaw/shared";
import { AlertCircle, FolderPlus, LoaderCircle, MoreHorizontal, PanelLeft, Pencil, Pin, PinOff, Plus, RotateCw, Search, Trash2 } from "lucide-react";
import { Input, Modal, Popconfirm, Tooltip } from "antd";
import { useMemo, useState } from "react";

interface SessionSidebarProps {
  sessions: SessionSummary[];
  groups?: SessionGroup[];
  activeSessionId?: string;
  state: "loading" | "ready" | "error";
  error?: string;
  organizerState?: "loading" | "ready" | "error";
  organizerError?: string;
  creating?: boolean;
  hasMore?: boolean;
  onSelect(sessionId: string): void;
  onCreate(): void;
  onRename(session: SessionSummary): void;
  onRemove(session: SessionSummary): void;
  onLoadMore(): void;
  onRetry(): void;
  onClose(): void;
  onTogglePinned?(session: SessionSummary, pinned: boolean): void;
  onCreateGroup?(name: string): void;
  onRenameGroup?(group: SessionGroup, name: string): void;
  onAssignGroup?(session: SessionSummary, groupId: string | null): void;
  onRetryOrganizer?(): void;
}

export function SessionSidebar({
  sessions,
  groups = [],
  activeSessionId,
  state,
  error,
  organizerState = "ready",
  organizerError,
  creating = false,
  hasMore = false,
  onSelect,
  onCreate,
  onRename,
  onRemove,
  onLoadMore,
  onRetry,
  onClose,
  onTogglePinned = () => undefined,
  onCreateGroup = () => undefined,
  onRenameGroup = () => undefined,
  onAssignGroup = () => undefined,
  onRetryOrganizer = () => undefined,
}: SessionSidebarProps) {
  const [query, setQuery] = useState("");
  const [activeGroupId, setActiveGroupId] = useState<string>();
  const [groupDialog, setGroupDialog] = useState<{ mode: "create" } | { mode: "rename"; group: SessionGroup }>();
  const [groupName, setGroupName] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const scopedSessions = useMemo(() => activeGroupId === undefined ? sessions : sessions.filter((session) => session.groupId === activeGroupId), [activeGroupId, sessions]);
  const visibleSessions = useMemo(() => scopedSessions
    .filter((session) => normalizedQuery === "" || `${session.title} ${session.lastMessagePreview ?? ""}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id)), [normalizedQuery, scopedSessions]);
  const groupOptions = [{ value: "", label: "未分组" }, ...groups.map((group) => ({ value: group.id, label: group.name }))];
  const closeGroupDialog = () => {
    setGroupDialog(undefined);
    setGroupName("");
  };
  const submitGroupDialog = () => {
    const name = groupName.trim();
    if (!groupDialog || name === "") return;
    if (groupDialog.mode === "create") onCreateGroup(name);
    else if (name !== groupDialog.group.name) onRenameGroup(groupDialog.group, name);
    closeGroupDialog();
  };

  const sessionRow = (session: SessionSummary) => <div key={session.id} className={`session-row${activeSessionId === session.id ? " active" : ""}`}>
    <button type="button" aria-label={`${session.title}，${session.lastMessagePreview ?? "暂无消息"}`} onClick={() => onSelect(session.id)}>
      <strong>{session.title}</strong>
      <span>{session.lastMessagePreview ?? "暂无消息"}</span>
      <time>{new Date(session.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>
    </button>
    <div className="session-organizer-controls">
      <select aria-label={`设置 ${session.title} 的分组`} value={session.groupId ?? ""} onChange={(event) => onAssignGroup(session, event.target.value === "" ? null : event.target.value)}>
        {groupOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <Tooltip title={session.pinned ? "取消固定" : "固定"}><button type="button" aria-label={session.pinned ? "取消固定会话" : "固定会话"} onClick={() => onTogglePinned(session, !session.pinned)}>{session.pinned ? <PinOff /> : <Pin />}</button></Tooltip>
      <Tooltip title="重命名"><button type="button" aria-label="重命名会话" onClick={() => onRename(session)}><Pencil /></button></Tooltip>
      <Popconfirm title="删除此会话？" description="删除后无法恢复。" okText="删除" cancelText="取消" onConfirm={() => onRemove(session)}><button type="button" aria-label="删除会话"><Trash2 /></button></Popconfirm>
    </div>
  </div>;

  const sections = normalizedQuery !== ""
    ? [{ id: "search", label: "搜索结果", items: visibleSessions }]
    : activeGroupId !== undefined
      ? groups.filter((group) => group.id === activeGroupId).map((group) => ({ id: group.id, label: group.name, items: visibleSessions }))
    : [
        { id: "pinned", label: "已固定", items: visibleSessions.filter((session) => session.pinned) },
        ...groups.map((group) => ({ id: group.id, label: group.name, items: visibleSessions.filter((session) => !session.pinned && session.groupId === group.id) })),
        { id: "ungrouped", label: "未分组", items: visibleSessions.filter((session) => !session.pinned && session.groupId === undefined) },
      ];

  return <aside className="session-panel" aria-label="会话栏">
    <header><div><small>工作台</small><h1>最近会话</h1></div><Tooltip title="新建会话"><button className="icon-button primary-soft" type="button" aria-label="新建会话" disabled={creating} onClick={onCreate}>{creating ? <LoaderCircle className="spin" /> : <Plus aria-hidden="true" />}</button></Tooltip></header>
    <label className="session-search"><Search aria-hidden="true" /><span className="sr-only">搜索会话</span><input type="search" placeholder="搜索会话" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    <div className="session-group-bar">
      <span>分组</span>
      {groups.length === 0 ? <small>还没有分组</small> : <div>{groups.map((group) => <span key={group.id} className={activeGroupId === group.id ? "active" : undefined}><button type="button" aria-label={`筛选分组 ${group.name}`} aria-pressed={activeGroupId === group.id} onClick={() => setActiveGroupId((current) => current === group.id ? undefined : group.id)}>{group.name}</button><Tooltip title="重命名分组"><button type="button" aria-label={`重命名分组 ${group.name}`} onClick={() => { setGroupName(group.name); setGroupDialog({ mode: "rename", group }); }}><Pencil /></button></Tooltip></span>)}</div>}
      <Tooltip title="新建分组"><button type="button" aria-label="新建分组" onClick={() => { setGroupName(""); setGroupDialog({ mode: "create" }); }}><FolderPlus /></button></Tooltip>
    </div>
    {organizerState === "loading" ? <div className="organizer-status"><LoaderCircle className="spin" />正在加载整理信息</div> : null}
    {organizerState === "error" ? <div className="organizer-status error" role="alert"><AlertCircle /><span>{organizerError ?? "整理信息读取失败"}</span><button type="button" aria-label="重试整理信息" onClick={onRetryOrganizer}><RotateCw /></button></div> : null}
    {state === "ready" && error ? <div className="organizer-status error" role="alert"><AlertCircle /><span>{error}</span><button type="button" aria-label="刷新会话" onClick={onRetry}><RotateCw /></button></div> : null}
    <div className="session-list" aria-busy={state === "loading"}>
      {state === "loading" ? <div className="session-state"><LoaderCircle className="spin" /><span>正在加载会话</span></div> : null}
      {state === "error" ? <div className="session-state" role="alert"><AlertCircle /><span>{error ?? "会话加载失败"}</span><button type="button" onClick={onRetry}><RotateCw />重试</button></div> : null}
      {state === "ready" && sessions.length === 0 ? <div className="session-state"><span>还没有会话</span><button type="button" onClick={onCreate}><Plus />新建会话</button></div> : null}
      {state === "ready" && sessions.length > 0 && visibleSessions.length === 0 ? <div className="session-state"><span>没有匹配的会话</span></div> : null}
      {state === "ready" && visibleSessions.length > 0 ? sections.map((section) => section.items.length > 0 ? <section className="session-section" key={section.id} aria-label={section.label}><p className="panel-label">{section.label}<span>{section.items.length}</span></p>{section.items.map(sessionRow)}</section> : null) : null}
      {state === "ready" && hasMore ? <button className="session-load-more" type="button" onClick={onLoadMore}><MoreHorizontal />加载更多</button> : null}
    </div>
    <div className="storage-summary"><span><i className="status-dot success" />数据写入正常</span><strong>空间充足</strong></div>
    <Tooltip title="收起会话栏"><button className="panel-edge-close" type="button" aria-label="收起会话栏" onClick={onClose}><PanelLeft aria-hidden="true" /></button></Tooltip>
    <Modal
      title={groupDialog?.mode === "rename" ? "重命名分组" : "新建分组"}
      open={groupDialog !== undefined}
      onCancel={closeGroupDialog}
      onOk={submitGroupDialog}
      okButtonProps={{ disabled: groupName.trim() === "" }}
      okText={groupDialog?.mode === "rename" ? "保存分组名称" : "创建分组"}
      cancelText="取消"
      afterOpenChange={(open) => open && document.querySelector<HTMLInputElement>('input[aria-label="分组名称"]')?.focus()}
    >
      <Input aria-label="分组名称" value={groupName} maxLength={80} onChange={(event) => setGroupName(event.target.value)} onPressEnter={submitGroupDialog} />
    </Modal>
  </aside>;
}
