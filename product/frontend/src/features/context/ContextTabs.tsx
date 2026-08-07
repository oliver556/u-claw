import type { CapabilitySet, FileSummary, Session, UClawClient } from "@uclaw/shared";
import { Activity, Brain, FileText, Folder } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const tabs = ["文件", "记忆", "活动"] as const;
const tabIds = { 文件: "files", 记忆: "memory", 活动: "activity" } as const;

interface ContextTabsProps {
  client: UClawClient;
  session?: Session;
  capabilities?: CapabilitySet;
  activity: string[];
}

export function ContextTabs({ client, session, capabilities, activity }: ContextTabsProps) {
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("文件");
  const [files, setFiles] = useState<FileSummary[]>([]);
  const [fileState, setFileState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activate = (index: number) => { setActiveTab(tabs[index]); tabRefs.current[index]?.focus(); };
  const activeId = tabIds[activeTab];
  const filesSupported = capabilities?.methods.has("files.list") === true;

  useEffect(() => {
    if (!filesSupported) {
      setFiles([]);
      setFileState("idle");
      return;
    }
    let mounted = true;
    setFileState("loading");
    void client.files.list().then((page) => {
      if (mounted) {
        setFiles(page.items);
        setFileState("ready");
      }
    }).catch(() => { if (mounted) setFileState("error"); });
    return () => { mounted = false; };
  }, [client, filesSupported]);

  return <>
    <div className="context-tabs" role="tablist" aria-label="上下文类型">{tabs.map((tab, index) => <button
      ref={(node) => { tabRefs.current[index] = node; }} key={tab} id={`context-tab-${tabIds[tab]}`} type="button" role="tab"
      aria-controls={`context-panel-${tabIds[tab]}`} aria-selected={activeTab === tab} tabIndex={activeTab === tab ? 0 : -1}
      onClick={() => setActiveTab(tab)} onKeyDown={(event) => {
        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined;
        if (next !== undefined) { event.preventDefault(); activate(next); }
      }}>{tab}</button>)}</div>
    <div className="context-content" id={`context-panel-${activeId}`} role="tabpanel" aria-labelledby={`context-tab-${activeId}`}>
      {activeTab === "文件" ? <><p className="panel-label">{session?.title ?? "未选择会话"}</p>{capabilities === undefined ? <div className="empty-panel"><FileText /><strong>正在检查文件能力</strong></div> : !filesSupported ? <div className="empty-panel"><FileText /><strong>文件不可用</strong><p>当前连接未提供文件读取能力。</p></div> : fileState === "loading" ? <div className="empty-panel"><FileText /><strong>正在加载文件</strong></div> : fileState === "error" ? <div className="empty-panel"><FileText /><strong>文件加载失败</strong></div> : files.length === 0 ? <div className="empty-panel"><FileText /><strong>本次会话没有文件</strong></div> : files.map((file) => <button className="file-row" type="button" key={file.id}><span className="file-type">{file.entryType === "directory" ? <Folder /> : "FILE"}</span><span><strong>{file.name}</strong><small>{file.entryType === "directory" ? "目录" : "文件"}</small></span></button>)}</> : null}
      {activeTab === "记忆" ? <div className="empty-panel"><Brain /><strong>记忆不可用</strong><p>当前连接未提供记忆读取能力。</p></div> : null}
      {activeTab === "活动" ? <div className="empty-panel"><Activity /><strong>{session?.title ?? "未选择会话"}</strong>{activity.length === 0 ? <p>此会话暂无活动。</p> : activity.map((item, index) => <p key={`${index}-${item}`}>{item}</p>)}</div> : null}
    </div>
    <footer><FileText /><span>上下文使用量</span><strong>余量充足</strong></footer>
  </>;
}
