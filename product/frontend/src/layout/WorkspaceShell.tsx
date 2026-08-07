import { ChevronRight, Code2, FolderArchive, PanelLeft, PanelRight, Plus, Search } from "lucide-react";
import { Tooltip } from "antd";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

import { routeForPath } from "../app/routes";
import { AppTitlebar } from "./AppTitlebar";
import { ContextPanel } from "./ContextPanel";
import { PrimaryRail } from "./PrimaryRail";

const sessions = [
  ["整理产品发布清单", "正在核对安装包和说明文档", "刚刚"],
  ["调研本地知识库方案", "比较三种向量数据库的维护成本", "10:42"],
  ["回复客户问题汇总", "从收件箱提取待确认事项", "09:18"],
] as const;

function SessionPanel({ onClose }: { onClose: () => void }) {
  return <aside className="session-panel" aria-label="会话栏">
    <header><div><small>工作台</small><h1>最近会话</h1></div><Tooltip title="新建会话"><button className="icon-button primary-soft" type="button" aria-label="新建会话"><Plus aria-hidden="true" /></button></Tooltip></header>
    <label className="session-search"><Search /><span className="sr-only">搜索会话</span><input type="search" placeholder="搜索会话" /></label>
    <div className="session-list">
      <p className="panel-label">今天</p>
      {sessions.map(([title, preview, time], index) => <button key={title} type="button" className={`session-row${index === 0 ? " active" : ""}`}>
        <strong>{title}</strong><span>{preview}</span><time>{time}</time>
      </button>)}
    </div>
    <div className="storage-summary"><span><i className="status-dot success" />数据写入正常</span><strong>空间充足</strong></div>
    <Tooltip title="收起会话栏"><button className="panel-edge-close" type="button" aria-label="收起会话栏" onClick={onClose}><PanelLeft aria-hidden="true" /></button></Tooltip>
  </aside>;
}

function WorkCanvas({ sessionsOpen, contextOpen, openSessions, openContext }: { sessionsOpen: boolean; contextOpen: boolean; openSessions: () => void; openContext: () => void }) {
  return <section className="work-canvas">
    <header className="canvas-head">
      <div className="canvas-title">
        {!sessionsOpen ? <Tooltip title="展开会话栏"><button className="icon-button" type="button" aria-label="展开会话栏" onClick={openSessions}><PanelLeft aria-hidden="true" /></button></Tooltip> : null}
        <div><h2>整理产品发布清单</h2><p>工作区：U:\U-Claw\Projects <span>自动保存</span></p></div>
      </div>
      <div className="canvas-actions"><button type="button"><FolderArchive />归档</button>{!contextOpen ? <Tooltip title="展开上下文舱"><button className="icon-button" type="button" aria-label="展开上下文舱" onClick={openContext}><PanelRight aria-hidden="true" /></button></Tooltip> : null}</div>
    </header>
    <div className="conversation">
      <p className="conversation-date">今天 14:26</p>
      <article className="message user-message"><header><span className="avatar">李</span><strong>你</strong></header><p>帮我检查 `U:\release\U-Claw-0.9.0`，整理发布前必须处理的问题。先看安装包、校验文件和说明文档，不要修改任何文件。</p></article>
      <article className="message"><header><span className="brand-mark compact"><i /><i /><i /></span><strong>U-Claw</strong><small>GPT-5.2</small></header><p>已按只读方式检查发布目录。安装包和校验文件一致，但发布说明缺少升级与数据迁移提示。</p>
        <button className="tool-run" type="button"><span className="tool-icon"><Code2 /></span><span><strong>检查发布目录</strong><small>4 个步骤，全部完成</small></span><span className="success-text">已完成</span><ChevronRight /></button>
        <div className="result-block"><header><strong>发布前问题</strong><small>2 项</small></header><div className="result-row warning-row"><span>需处理</span><div><strong>缺少升级路径说明</strong><p>未说明从 `0.8.x` 升级时是否需要退出旧版客户端。</p></div></div><div className="result-row"><span>建议</span><div><strong>缺少数据目录说明</strong><p>建议明确用户数据仍写入 U 盘。</p></div></div></div>
      </article>
    </div>
    <div className="composer"><textarea aria-label="给 U-Claw 发送消息" placeholder="输入消息，或用 @ 引用文件和能力" /><footer><button type="button">添加附件</button><button type="button" disabled>发送</button></footer></div>
  </section>;
}

function SecondaryView({ title, description }: { title: string; description: string }) {
  return <section className="secondary-view"><header><h1>{title}</h1><p>{description}</p></header><div className="secondary-content"><div className="status-line"><i className="status-dot success" /><span>U 盘工作区可用</span><strong>已就绪</strong></div><div className="empty-panel"><FolderArchive /><strong>{title}入口已连接</strong><p>当前阶段保留稳定入口和运行状态。</p></div></div></section>;
}

export function WorkspaceShell() {
  const { pathname } = useLocation();
  const route = routeForPath(pathname);
  const isWork = route.path === "/";
  const [sessionsOpen, setSessionsOpen] = useState(() => window.innerWidth > 680);
  const [contextOpen, setContextOpen] = useState(() => window.innerWidth > 680);

  useEffect(() => {
    const closeDrawersOnNarrowViewport = () => {
      if (window.innerWidth <= 680) {
        setSessionsOpen(false);
        setContextOpen(false);
      }
    };
    window.addEventListener("resize", closeDrawersOnNarrowViewport);
    return () => window.removeEventListener("resize", closeDrawersOnNarrowViewport);
  }, []);

  return <div className="app-shell">
    <a className="skip-link" href="#main">跳到主要内容</a>
    <AppTitlebar />
    <div className={`workspace-grid${sessionsOpen ? "" : " sessions-collapsed"}${contextOpen ? "" : " context-collapsed"}`}>
      <PrimaryRail />
      {isWork && sessionsOpen ? <SessionPanel onClose={() => setSessionsOpen(false)} /> : null}
      <main id="main" className="main-canvas" tabIndex={-1}>
        {isWork ? <WorkCanvas sessionsOpen={sessionsOpen} contextOpen={contextOpen} openSessions={() => setSessionsOpen(true)} openContext={() => setContextOpen(true)} /> : <SecondaryView title={route.label} description={route.description} />}
      </main>
      {isWork && contextOpen ? <ContextPanel onClose={() => setContextOpen(false)} /> : null}
    </div>
  </div>;
}
