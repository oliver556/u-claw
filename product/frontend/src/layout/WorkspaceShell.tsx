import {
  emptySessionOrganizer,
  organizeSessions,
  type CapabilitySet,
  type GatewayStatus,
  type Session,
  type SessionGroup,
  type SessionOrganizerDocument,
  type SessionOrganizerService,
  type SessionSummary,
  type UClawClient,
} from "@uclaw/shared";
import { FolderArchive, PanelLeft, PanelRight, SquareTerminal } from "lucide-react";
import { Tooltip } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { routeForPath } from "../app/routes";
import { Conversation } from "../features/chat/Conversation";
import { SessionSidebar } from "../features/sessions/SessionSidebar";
import { CapabilitiesView } from "../features/capabilities/CapabilitiesView";
import { ChannelSettings } from "../features/channels/ChannelSettings";
import { TaskActivityCenter } from "../features/activity/TaskActivityCenter";
import { AppTitlebar } from "./AppTitlebar";
import { ContextPanel } from "./ContextPanel";
import { PrimaryRail } from "./PrimaryRail";

function SecondaryView({ title, description, system }: { title: string; description: string; system: boolean }) {
  const openAdvancedConsole = () => {
    const invoke = window.uclaw?.window?.invoke;
    if (!invoke) return;
    void invoke({ method: "open-advanced-console", requestId: `console-${Date.now()}`, params: {} });
  };
  return <section className="secondary-view"><header><h1>{title}</h1><p>{description}</p></header><div className="secondary-content"><div className="status-line"><i className="status-dot success" /><span>U 盘工作区可用</span><strong>已就绪</strong></div><div className="empty-panel"><FolderArchive /><strong>{title}入口已连接</strong><p>当前阶段保留稳定入口和运行状态。</p>{system ? <button className="secondary-command" type="button" onClick={openAdvancedConsole}><SquareTerminal />打开高级控制台</button> : null}</div></div></section>;
}

type WorkspaceClient = UClawClient & { sessionOrganizer?: SessionOrganizerService };

export function WorkspaceShell({ client }: { client: WorkspaceClient }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const route = routeForPath(pathname);
  const isWork = route.path === "/";
  const [sessionsOpen, setSessionsOpen] = useState(() => window.innerWidth > 680);
  const [contextOpen, setContextOpen] = useState(() => window.innerWidth > 680);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [nextSessionCursor, setNextSessionCursor] = useState<string | null>(null);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [sessionState, setSessionState] = useState<"loading" | "ready" | "error">("loading");
  const [sessionError, setSessionError] = useState<string>();
  const [organizer, setOrganizer] = useState<SessionOrganizerDocument>(emptySessionOrganizer);
  const [organizerState, setOrganizerState] = useState<"loading" | "ready" | "error">("loading");
  const [organizerError, setOrganizerError] = useState<string>();
  const [activeSession, setActiveSession] = useState<Session>();
  const [capabilities, setCapabilities] = useState<CapabilitySet>();
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [activity, setActivity] = useState<Record<string, string[]>>({});
  const [activityCenterOpen, setActivityCenterOpen] = useState(false);
  const selectionRequest = useRef(0);

  const selectSession = useCallback(async (sessionId: string) => {
    const request = ++selectionRequest.current;
    try {
      const session = await client.sessions.get(sessionId);
      if (request === selectionRequest.current) setActiveSession(session);
    } catch (error) {
      if (request === selectionRequest.current) setSessionError(error instanceof Error ? error.message : "会话打开失败");
    }
  }, [client]);

  const loadSessions = useCallback(async () => {
    setSessionState("loading");
    setSessionError(undefined);
    try {
      const page = await client.sessions.list();
      setSessions(page.items);
      setNextSessionCursor(page.nextCursor);
      setHasMoreSessions(page.hasMore);
      setSessionState("ready");
      if (page.items.length > 0) await selectSession(page.items[0].id);
      else setActiveSession(undefined);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "会话加载失败");
      setSessionState("error");
    }
  }, [client, selectSession]);

  const loadOrganizer = useCallback(async () => {
    setOrganizerState("loading");
    setOrganizerError(undefined);
    if (client.sessionOrganizer === undefined) {
      setOrganizer(emptySessionOrganizer());
      setOrganizerState("ready");
      return;
    }
    try {
      setOrganizer(await client.sessionOrganizer.get());
      setOrganizerState("ready");
    } catch (error) {
      setOrganizer(emptySessionOrganizer());
      setOrganizerError(error instanceof Error ? error.message : "整理信息读取失败");
      setOrganizerState("error");
    }
  }, [client]);

  useEffect(() => { void loadSessions(); }, [loadSessions]);
  useEffect(() => { void loadOrganizer(); }, [loadOrganizer]);
  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    void client.gateway.negotiate().then((value) => { if (mounted) setCapabilities(value); }).catch(() => undefined);
    void (async () => {
      try {
        for await (const status of client.gateway.watchStatus(controller.signal)) {
          if (!mounted) return;
          setGatewayStatus(status);
        }
      } catch {
        if (mounted) setGatewayStatus(await client.gateway.getStatus().catch(() => undefined));
      }
    })();
    return () => { mounted = false; controller.abort(); };
  }, [client]);

  useEffect(() => {
    const closeDrawersOnNarrowViewport = () => {
      if (window.innerWidth <= 680) { setSessionsOpen(false); setContextOpen(false); }
    };
    window.addEventListener("resize", closeDrawersOnNarrowViewport);
    return () => window.removeEventListener("resize", closeDrawersOnNarrowViewport);
  }, []);

  const createSession = async () => {
    if (creatingSession) return;
    setCreatingSession(true);
    try {
      const created = await client.sessions.create({ title: "新会话" });
      selectionRequest.current += 1;
      setSessions((current) => [...current, created]);
      setActiveSession(created);
      if (window.innerWidth <= 680) setSessionsOpen(false);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "新建会话失败");
      setSessionState("error");
    } finally {
      setCreatingSession(false);
    }
  };

  const loadMoreSessions = async () => {
    if (!hasMoreSessions || nextSessionCursor === null) return;
    try {
      const page = await client.sessions.list({ cursor: nextSessionCursor });
      setSessions((current) => {
        const known = new Set(current.map((session) => session.id));
        return [...current, ...page.items.filter((session) => !known.has(session.id))];
      });
      setNextSessionCursor(page.nextCursor);
      setHasMoreSessions(page.hasMore);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "加载更多会话失败");
    }
  };

  const renameSession = async (summary: SessionSummary) => {
    const title = window.prompt("会话名称", summary.title)?.trim();
    if (title === undefined || title === "" || title === summary.title) return;
    if (client.sessions.rename === undefined) {
      setSessionError("当前连接不支持重命名会话");
      return;
    }
    try {
      const renamed = await client.sessions.rename(summary.id, title);
      setSessions((current) => current.map((item) => item.id === renamed.id ? renamed : item));
      setActiveSession((current) => current?.id === renamed.id ? renamed : current);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "重命名会话失败");
    }
  };

  const removeSession = async (summary: SessionSummary) => {
    try {
      await client.sessions.remove(summary.id);
      setSessions((current) => current.filter((item) => item.id !== summary.id));
      if (activeSession?.id === summary.id) {
        const next = sessions.find((item) => item.id !== summary.id);
        if (next) await selectSession(next.id);
        else setActiveSession(undefined);
      }
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "主会话无法删除，已恢复显示");
    }
  };

  const refreshSessions = async (sessionId: string) => {
    try {
      const [page, refreshed] = await Promise.all([client.sessions.list(), client.sessions.get(sessionId)]);
      setSessions(page.items);
      setNextSessionCursor(page.nextCursor);
      setHasMoreSessions(page.hasMore);
      setActiveSession((current) => current?.id === sessionId ? refreshed : current);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "会话刷新失败");
    }
  };

  const appendActivity = (sessionId: string, message: string) => {
    setActivity((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), message] }));
  };

  const updateOrganizer = async (operation: (service: SessionOrganizerService) => Promise<SessionOrganizerDocument>) => {
    if (client.sessionOrganizer === undefined) return;
    setOrganizerError(undefined);
    try {
      setOrganizer(await operation(client.sessionOrganizer));
      setOrganizerState("ready");
    } catch (error) {
      setOrganizerError(error instanceof Error ? error.message : "整理信息保存失败");
      setOrganizerState("error");
    }
  };

  const organizedSessions = organizeSessions(sessions, organizer, "");

  return <div className="app-shell">
    <a className="skip-link" href="#main" onClick={(event) => { event.preventDefault(); document.getElementById("main")?.focus(); }}>跳到主要内容</a>
    <AppTitlebar status={gatewayStatus} onReconnect={() => client.gateway.reconnect()} onOpenActivity={() => setActivityCenterOpen(true)} />
    <div className={isWork ? `workspace-grid${sessionsOpen ? "" : " sessions-collapsed"}${contextOpen ? "" : " context-collapsed"}` : "workspace-grid secondary-layout"}>
      <PrimaryRail />
      {isWork && sessionsOpen ? <SessionSidebar
        sessions={organizedSessions}
        groups={organizer.groups}
        activeSessionId={activeSession?.id}
        state={sessionState}
        error={sessionError}
        organizerState={organizerState}
        organizerError={organizerError}
        creating={creatingSession}
        hasMore={hasMoreSessions}
        onSelect={(id) => void selectSession(id)}
        onCreate={() => void createSession()}
        onRename={(session) => void renameSession(session)}
        onRemove={(session) => void removeSession(session)}
        onLoadMore={() => void loadMoreSessions()}
        onRetry={() => void loadSessions()}
        onClose={() => setSessionsOpen(false)}
        onTogglePinned={(session, pinned) => void updateOrganizer((service) => service.setPinned(session.id, pinned))}
        onCreateGroup={(name) => void updateOrganizer((service) => service.createGroup(name))}
        onRenameGroup={(group: SessionGroup, name) => void updateOrganizer((service) => service.renameGroup(group.id, name))}
        onAssignGroup={(session, groupId) => void updateOrganizer((service) => service.assignGroup(session.id, groupId))}
        onRetryOrganizer={() => void loadOrganizer()}
      /> : null}
      <main id="main" className="main-canvas" tabIndex={-1}>
        {isWork ? activeSession === undefined
          ? <section className="work-canvas workspace-placeholder"><header className="canvas-head"><div className="canvas-title">{!sessionsOpen ? <Tooltip title="展开会话栏"><button className="icon-button" type="button" aria-label="展开会话栏" onClick={() => setSessionsOpen(true)}><PanelLeft /></button></Tooltip> : null}<strong>工作区</strong></div>{!contextOpen ? <Tooltip title="展开上下文舱"><button className="icon-button" type="button" aria-label="展开上下文舱" onClick={() => setContextOpen(true)}><PanelRight /></button></Tooltip> : null}</header><div className="conversation-state"><FolderArchive /><strong>{sessionState === "loading" ? "正在准备工作区" : "还没有会话"}</strong></div></section>
          : <Conversation key={activeSession.id} client={client} session={activeSession} capabilities={capabilities} gatewayStatus={gatewayStatus} sessionsOpen={sessionsOpen} contextOpen={contextOpen} draft={drafts[activeSession.id] ?? ""} onDraftChange={(value) => setDrafts((current) => ({ ...current, [activeSession.id]: value }))} onActivity={(message) => appendActivity(activeSession.id, message)} onSendSuccess={(sessionId) => void refreshSessions(sessionId)} onSessionUpdated={(sessionId) => void refreshSessions(sessionId)} openSessions={() => setSessionsOpen(true)} openContext={() => setContextOpen(true)} />
          : route.path === "/capabilities" ? <CapabilitiesView /> : route.path === "/connections" ? <ChannelSettings /> : <SecondaryView title={route.label} description={route.description} system={route.path === "/system"} />}
      </main>
      {isWork && contextOpen ? <ContextPanel client={client} session={activeSession} capabilities={capabilities} activity={activeSession === undefined ? [] : activity[activeSession.id] ?? []} onClose={() => setContextOpen(false)} /> : null}
    </div>
    <TaskActivityCenter open={activityCenterOpen} service={client.activityCenter} onClose={() => setActivityCenterOpen(false)} onOpenSession={(sessionId) => {
      navigate("/");
      void selectSession(sessionId);
      setActivityCenterOpen(false);
    }} />
  </div>;
}
