import type { CapabilitySet, GatewayStatus, Session, SessionSummary, UClawClient } from "@uclaw/shared";
import { FolderArchive, PanelLeft, PanelRight, SquareTerminal } from "lucide-react";
import { Tooltip } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import { routeForPath } from "../app/routes";
import { Conversation } from "../features/chat/Conversation";
import { SessionSidebar } from "../features/sessions/SessionSidebar";
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

export function WorkspaceShell({ client }: { client: UClawClient }) {
  const { pathname } = useLocation();
  const route = routeForPath(pathname);
  const isWork = route.path === "/";
  const [sessionsOpen, setSessionsOpen] = useState(() => window.innerWidth > 680);
  const [contextOpen, setContextOpen] = useState(() => window.innerWidth > 680);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionState, setSessionState] = useState<"loading" | "ready" | "error">("loading");
  const [sessionError, setSessionError] = useState<string>();
  const [activeSession, setActiveSession] = useState<Session>();
  const [capabilities, setCapabilities] = useState<CapabilitySet>();
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [activity, setActivity] = useState<Record<string, string[]>>({});
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
      setSessionState("ready");
      if (page.items.length > 0) await selectSession(page.items[0].id);
      else setActiveSession(undefined);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "会话加载失败");
      setSessionState("error");
    }
  }, [client, selectSession]);

  useEffect(() => { void loadSessions(); }, [loadSessions]);
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
    try {
      const created = await client.sessions.create({ title: "新会话" });
      selectionRequest.current += 1;
      setSessions((current) => [...current, created]);
      setActiveSession(created);
      if (window.innerWidth <= 680) setSessionsOpen(false);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "新建会话失败");
      setSessionState("error");
    }
  };

  const refreshSessions = async (sessionId: string) => {
    try {
      const [page, refreshed] = await Promise.all([client.sessions.list(), client.sessions.get(sessionId)]);
      setSessions(page.items);
      setActiveSession((current) => current?.id === sessionId ? refreshed : current);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "会话刷新失败");
    }
  };

  const appendActivity = (sessionId: string, message: string) => {
    setActivity((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), message] }));
  };

  return <div className="app-shell">
    <a className="skip-link" href="#main" onClick={(event) => { event.preventDefault(); document.getElementById("main")?.focus(); }}>跳到主要内容</a>
    <AppTitlebar status={gatewayStatus} onReconnect={() => client.gateway.reconnect()} />
    <div className={isWork ? `workspace-grid${sessionsOpen ? "" : " sessions-collapsed"}${contextOpen ? "" : " context-collapsed"}` : "workspace-grid secondary-layout"}>
      <PrimaryRail />
      {isWork && sessionsOpen ? <SessionSidebar sessions={sessions} activeSessionId={activeSession?.id} state={sessionState} error={sessionError} onSelect={(id) => void selectSession(id)} onCreate={() => void createSession()} onRetry={() => void loadSessions()} onClose={() => setSessionsOpen(false)} /> : null}
      <main id="main" className="main-canvas" tabIndex={-1}>
        {isWork ? activeSession === undefined
          ? <section className="work-canvas workspace-placeholder"><header className="canvas-head"><div className="canvas-title">{!sessionsOpen ? <Tooltip title="展开会话栏"><button className="icon-button" type="button" aria-label="展开会话栏" onClick={() => setSessionsOpen(true)}><PanelLeft /></button></Tooltip> : null}<strong>工作区</strong></div>{!contextOpen ? <Tooltip title="展开上下文舱"><button className="icon-button" type="button" aria-label="展开上下文舱" onClick={() => setContextOpen(true)}><PanelRight /></button></Tooltip> : null}</header><div className="conversation-state"><FolderArchive /><strong>{sessionState === "loading" ? "正在准备工作区" : "还没有会话"}</strong></div></section>
          : <Conversation key={activeSession.id} client={client} session={activeSession} capabilities={capabilities} gatewayStatus={gatewayStatus} sessionsOpen={sessionsOpen} contextOpen={contextOpen} draft={drafts[activeSession.id] ?? ""} onDraftChange={(value) => setDrafts((current) => ({ ...current, [activeSession.id]: value }))} onActivity={(message) => appendActivity(activeSession.id, message)} onSendSuccess={(sessionId) => void refreshSessions(sessionId)} openSessions={() => setSessionsOpen(true)} openContext={() => setContextOpen(true)} />
          : <SecondaryView title={route.label} description={route.description} system={route.path === "/system"} />}
      </main>
      {isWork && contextOpen ? <ContextPanel client={client} session={activeSession} capabilities={capabilities} activity={activeSession === undefined ? [] : activity[activeSession.id] ?? []} onClose={() => setContextOpen(false)} /> : null}
    </div>
  </div>;
}
