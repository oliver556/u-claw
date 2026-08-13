import type { SessionGroup, SessionSummary } from "@uclaw/shared";
import { AlertCircle, Bell, ChevronLeft, Folder, FolderPlus, LoaderCircle, MoreHorizontal, PanelLeft, Pencil, Pin, PinOff, Plus, RotateCw, Search, Trash2, X } from "lucide-react";
import { Input, Modal, Popconfirm, Tooltip } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";

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
  onRename(session: SessionSummary, title: string): Promise<void>;
  onRemove(session: SessionSummary): void;
  onLoadMore(): void;
  onRetry(): void;
  onClose(): void;
  onOpenActivity?(): void;
  onTogglePinned?(session: SessionSummary, pinned: boolean): void;
  onCreateGroup?(name: string): void;
  onRenameGroup?(group: SessionGroup, name: string): void;
  onRemoveGroup?(group: SessionGroup): void;
  onAssignGroup?(session: SessionSummary, groupId: string | null): void;
  onRetryOrganizer?(): void;
}

type SidebarView = "recent" | "groups";

export function SessionSidebar({
  sessions, groups = [], activeSessionId, state, error, organizerState = "ready", organizerError,
  creating = false, hasMore = false, onSelect, onCreate, onRename, onRemove, onLoadMore, onRetry,
  onClose, onOpenActivity = () => undefined, onTogglePinned = () => undefined,
  onCreateGroup = () => undefined, onRenameGroup = () => undefined, onRemoveGroup = () => undefined,
  onAssignGroup = () => undefined, onRetryOrganizer = () => undefined,
}: SessionSidebarProps) {
  const [view, setView] = useState<SidebarView>("recent");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeGroupId, setActiveGroupId] = useState<string>();
  const [openSessionMenu, setOpenSessionMenu] = useState<string>();
  const [openGroupMenu, setOpenGroupMenu] = useState<string>();
  const [renameSession, setRenameSession] = useState<SessionSummary>();
  const [sessionName, setSessionName] = useState("");
  const [renameError, setRenameError] = useState<string>();
  const [renamingSession, setRenamingSession] = useState(false);
  const [groupDialog, setGroupDialog] = useState<{ mode: "create" } | { mode: "rename"; group: SessionGroup }>();
  const [groupName, setGroupName] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);
  useEffect(() => {
    if (openSessionMenu === undefined && openGroupMenu === undefined) return;
    const closeOnOutsideInteraction = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.session-popover, [data-session-menu-trigger="true"]')) return;
      setOpenSessionMenu(undefined);
      setOpenGroupMenu(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenSessionMenu(undefined);
      setOpenGroupMenu(undefined);
    };
    document.addEventListener("mousedown", closeOnOutsideInteraction);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideInteraction);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openGroupMenu, openSessionMenu]);
  useEffect(() => {
    setOpenSessionMenu(undefined);
    setOpenGroupMenu(undefined);
  }, [activeSessionId]);

  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const sortedSessions = useMemo(() => [...sessions].sort((left, right) => Number(right.pinned) - Number(left.pinned)
    || Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id)), [sessions]);
  const visibleSessions = useMemo(() => sortedSessions.filter((session) => normalizedQuery === ""
    || `${session.title} ${session.lastMessagePreview ?? ""}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery)), [normalizedQuery, sortedSessions]);
  const activeGroup = groups.find((group) => group.id === activeGroupId);
  const groupOptions = [{ value: "", label: "未分组" }, ...groups.map((group) => ({ value: group.id, label: group.name }))];
  const closeMenus = () => { setOpenSessionMenu(undefined); setOpenGroupMenu(undefined); };
  const openRenameDialog = (session: SessionSummary) => {
    setRenameSession(session);
    setSessionName(session.title);
    setRenameError(undefined);
    closeMenus();
  };
  const closeRenameDialog = () => {
    if (renamingSession) return;
    setRenameSession(undefined);
    setSessionName("");
    setRenameError(undefined);
  };
  const submitRenameDialog = async () => {
    const title = sessionName.trim();
    if (!renameSession || title === "" || title === renameSession.title || renamingSession) return;
    setRenamingSession(true);
    setRenameError(undefined);
    try {
      await onRename(renameSession, title);
      setRenameSession(undefined);
      setSessionName("");
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : "重命名会话失败");
    } finally {
      setRenamingSession(false);
    }
  };
  const closeGroupDialog = () => { setGroupDialog(undefined); setGroupName(""); };
  const submitGroupDialog = () => {
    const name = groupName.trim();
    if (!groupDialog || name === "") return;
    if (groupDialog.mode === "create") onCreateGroup(name);
    else if (name !== groupDialog.group.name) onRenameGroup(groupDialog.group, name);
    closeGroupDialog();
  };
  const closeSearch = () => { setSearchOpen(false); setQuery(""); };

  const sessionRow = (session: SessionSummary) => <div key={session.id} className={`session-row${activeSessionId === session.id ? " active" : ""}`} onContextMenu={(event) => { event.preventDefault(); setOpenGroupMenu(undefined); setOpenSessionMenu(session.id); }}>
    <button type="button" aria-label={`${session.title}，${session.lastMessagePreview ?? "暂无消息"}`} onClick={() => { closeMenus(); onSelect(session.id); }}>
      <strong>{session.title}</strong>
      <span>{session.lastMessagePreview ?? "暂无消息"}</span>
      <time>{new Date(session.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>
    </button>
    <button className="session-more" data-session-menu-trigger="true" type="button" aria-label={`会话操作 ${session.title}`} aria-expanded={openSessionMenu === session.id} onClick={() => { setOpenGroupMenu(undefined); setOpenSessionMenu((current) => current === session.id ? undefined : session.id); }}><MoreHorizontal /></button>
    {openSessionMenu === session.id ? <div className="session-popover" role="menu" aria-label={`${session.title} 会话菜单`}>
      <button type="button" role="menuitem" aria-label={session.pinned ? "取消固定会话" : "固定会话"} onClick={() => { onTogglePinned(session, !session.pinned); closeMenus(); }}>{session.pinned ? <PinOff /> : <Pin />}{session.pinned ? "取消固定" : "固定"}</button>
      <label><Folder /><span>移到分组</span><select aria-label={`设置 ${session.title} 的分组`} value={session.groupId ?? ""} onChange={(event) => { onAssignGroup(session, event.target.value === "" ? null : event.target.value); closeMenus(); }}>{groupOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <button type="button" role="menuitem" aria-label="重命名会话" onClick={() => openRenameDialog(session)}><Pencil />重命名</button>
      {session.id === "agent:main:main" ? null : <Popconfirm title="删除此会话？" description="删除后无法恢复。" okText="删除" cancelText="取消" onConfirm={() => { onRemove(session); closeMenus(); }}><button className="danger" type="button" role="menuitem" aria-label="删除会话"><Trash2 />删除</button></Popconfirm>}
    </div> : null}
  </div>;

  const today = new Date().toDateString();
  const recentSections = normalizedQuery !== "" ? [{ id: "search", label: "搜索结果", items: visibleSessions }] : [
    { id: "pinned", label: "固定", items: visibleSessions.filter((session) => session.pinned) },
    { id: "today", label: "今天", items: visibleSessions.filter((session) => !session.pinned && new Date(session.updatedAt).toDateString() === today) },
    { id: "earlier", label: "更早", items: visibleSessions.filter((session) => !session.pinned && new Date(session.updatedAt).toDateString() !== today) },
  ];
  const displayedSessions = searchOpen ? visibleSessions : activeGroup ? sortedSessions.filter((session) => session.groupId === activeGroup.id) : [];

  return <aside className="session-panel" aria-label="会话栏">
    <header className="session-panel-head"><h1>会话</h1><div className="session-head-actions">
      <Tooltip title="新建会话"><button className="icon-button" type="button" aria-label="新建会话" disabled={creating} onClick={onCreate}>{creating ? <LoaderCircle className="spin" /> : <Plus />}</button></Tooltip>
      <Tooltip title="搜索会话"><button className="icon-button" type="button" aria-label="搜索会话" aria-pressed={searchOpen} onClick={() => setSearchOpen(true)}><Search /></button></Tooltip>
      <Tooltip title="任务活动中心"><button className="icon-button" type="button" aria-label="打开任务活动中心" onClick={onOpenActivity}><Bell /></button></Tooltip>
    </div></header>
    {searchOpen ? <div className="session-search-state"><label className="session-search"><Search /><span className="sr-only">搜索会话</span><input ref={searchRef} type="search" placeholder="搜索会话" value={query} onChange={(event) => setQuery(event.target.value)} /></label><button type="button" aria-label="关闭会话搜索" onClick={closeSearch}><X /></button></div> : <div className="session-view-tabs" role="tablist" aria-label="会话视图"><button type="button" role="tab" aria-selected={view === "recent"} onClick={() => { setView("recent"); setActiveGroupId(undefined); closeMenus(); }}>最近</button><button type="button" role="tab" aria-selected={view === "groups"} onClick={() => { setView("groups"); closeMenus(); }}>分组</button></div>}
    {organizerState === "loading" ? <div className="organizer-status"><LoaderCircle className="spin" />正在加载整理信息</div> : null}
    {organizerState === "error" ? <div className="organizer-status error" role="alert"><AlertCircle /><span>{organizerError ?? "整理信息读取失败"}</span><button type="button" aria-label="重试整理信息" onClick={onRetryOrganizer}><RotateCw /></button></div> : null}
    {state === "ready" && error ? <div className="organizer-status error" role="alert"><AlertCircle /><span>{error}</span><button type="button" aria-label="刷新会话" onClick={onRetry}><RotateCw /></button></div> : null}
    <div className="session-list" aria-busy={state === "loading"}>
      {state === "loading" ? <div className="session-state"><LoaderCircle className="spin" /><span>正在加载会话</span></div> : null}
      {state === "error" ? <div className="session-state" role="alert"><AlertCircle /><span>{error ?? "会话加载失败"}</span><button type="button" onClick={onRetry}><RotateCw />重试</button></div> : null}
      {state === "ready" && sessions.length === 0 && view === "recent" ? <div className="session-state"><span>还没有会话</span><button type="button" onClick={onCreate}><Plus />新建会话</button></div> : null}
      {state === "ready" && searchOpen && visibleSessions.length === 0 ? <div className="session-state"><span>没有匹配的会话</span></div> : null}
      {state === "ready" && (view === "recent" || searchOpen) ? recentSections.map((section) => section.items.length > 0 ? <section className="session-section" key={section.id} aria-label={section.label}><p className="panel-label">{section.label}<span>{section.items.length}</span></p>{section.items.map(sessionRow)}</section> : null) : null}
      {state === "ready" && view === "groups" && !searchOpen && !activeGroup ? <section className="session-groups" aria-label="我的分组"><div className="session-group-heading"><p className="panel-label">我的分组<span>{groups.length}</span></p><Tooltip title="新建分组"><button type="button" aria-label="新建分组" onClick={() => { setGroupName(""); setGroupDialog({ mode: "create" }); }}><FolderPlus /></button></Tooltip></div>{groups.length === 0 ? <div className="session-state"><span>还没有分组</span></div> : groups.map((group) => <div className="session-group-row" key={group.id}><button type="button" aria-label={`打开分组 ${group.name}`} onClick={() => { setActiveGroupId(group.id); closeMenus(); }}><Folder /><span>{group.name}</span><small>{sessions.filter((session) => session.groupId === group.id).length}</small></button><button type="button" data-session-menu-trigger="true" aria-label={`分组操作 ${group.name}`} onClick={() => setOpenGroupMenu((current) => current === group.id ? undefined : group.id)}><MoreHorizontal /></button>{openGroupMenu === group.id ? <div className="session-popover" role="menu"><button type="button" aria-label={`重命名分组 ${group.name}`} onClick={() => { setGroupName(group.name); setGroupDialog({ mode: "rename", group }); closeMenus(); }}><Pencil />重命名</button><Popconfirm title="删除此分组？" description="组内会话会移到未分组，不会被删除。" okText="删除分组" cancelText="取消" onConfirm={() => { onRemoveGroup(group); closeMenus(); }}><button className="danger" type="button" aria-label={`删除分组 ${group.name}`}><Trash2 />删除</button></Popconfirm></div> : null}</div>)}</section> : null}
      {state === "ready" && view === "groups" && !searchOpen && activeGroup ? <section className="session-section" aria-label={activeGroup.name}><button className="session-group-back" type="button" aria-label="返回分组列表" onClick={() => setActiveGroupId(undefined)}><ChevronLeft />{activeGroup.name}</button>{displayedSessions.length > 0 ? displayedSessions.map(sessionRow) : <div className="session-state"><span>这个分组还没有会话</span></div>}</section> : null}
      {state === "ready" && hasMore ? <button className="session-load-more" type="button" onClick={onLoadMore}><MoreHorizontal />加载更多</button> : null}
    </div>
    <Tooltip title="收起会话栏"><button className="panel-edge-close" type="button" aria-label="收起会话栏" onClick={onClose}><PanelLeft /></button></Tooltip>
    <Modal title={groupDialog?.mode === "rename" ? "重命名分组" : "新建分组"} open={groupDialog !== undefined} onCancel={closeGroupDialog} onOk={submitGroupDialog} okButtonProps={{ disabled: groupName.trim() === "" }} okText={groupDialog?.mode === "rename" ? "保存分组名称" : "创建分组"} cancelText="取消" afterOpenChange={(open) => open && document.querySelector<HTMLInputElement>('input[aria-label="分组名称"]')?.focus()}>
      <Input aria-label="分组名称" value={groupName} maxLength={80} onChange={(event) => setGroupName(event.target.value)} onPressEnter={submitGroupDialog} />
    </Modal>
    <Modal title="重命名会话" open={renameSession !== undefined} onCancel={closeRenameDialog} onOk={() => void submitRenameDialog()} confirmLoading={renamingSession} okButtonProps={{ disabled: sessionName.trim() === "" || sessionName.trim() === renameSession?.title }} okText="保存会话名称" cancelText="取消" afterOpenChange={(open) => open && document.querySelector<HTMLInputElement>('input[aria-label="会话名称"]')?.focus()}>
      <Input aria-label="会话名称" value={sessionName} maxLength={80} status={renameError ? "error" : undefined} onChange={(event) => setSessionName(event.target.value)} onPressEnter={() => void submitRenameDialog()} />
      {renameError ? <div className="session-rename-error" role="alert">{renameError}</div> : null}
    </Modal>
  </aside>;
}
