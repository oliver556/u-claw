import { Activity, Brain, FileText, Folder, HardDrive } from "lucide-react";
import { useRef, useState } from "react";

const tabs = ["文件", "记忆", "活动"] as const;
const tabIds = { 文件: "files", 记忆: "memory", 活动: "activity" } as const;

export function ContextTabs() {
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("文件");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activate = (index: number) => { setActiveTab(tabs[index]); tabRefs.current[index]?.focus(); };
  const activeId = tabIds[activeTab];
  return <>
    <div className="context-tabs" role="tablist" aria-label="上下文类型">{tabs.map((tab, index) => <button
      ref={(node) => { tabRefs.current[index] = node; }} key={tab} id={`context-tab-${tabIds[tab]}`} type="button" role="tab"
      aria-controls={`context-panel-${tabIds[tab]}`} aria-selected={activeTab === tab} tabIndex={activeTab === tab ? 0 : -1}
      onClick={() => setActiveTab(tab)} onKeyDown={(event) => {
        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined;
        if (next !== undefined) { event.preventDefault(); activate(next); }
      }}>{tab}</button>)}</div>
    <div className="context-content" id={`context-panel-${activeId}`} role="tabpanel" aria-labelledby={`context-tab-${activeId}`}>
      {activeTab === "文件" ? <><p className="panel-label">本次会话</p><button className="file-row" type="button"><span className="file-type">MD</span><span><strong>release-notes.md</strong><small>已读取</small></span></button><button className="file-row" type="button"><span className="file-type neutral">TXT</span><span><strong>checksums.txt</strong><small>已验证</small></span></button><button className="file-row" type="button"><span className="file-type warning"><Folder /></span><span><strong>U-Claw-0.9.0</strong><small>发布目录</small></span></button><div className="context-callout"><HardDrive /><span><strong>工作目录在 U 盘</strong><small>文件不会复制到本机缓存。</small></span></div></> : null}
      {activeTab === "记忆" ? <div className="empty-panel"><Brain /><strong>发布流程偏好</strong><p>检查期间不写入文件，所有修改先确认。</p></div> : null}
      {activeTab === "活动" ? <div className="empty-panel"><Activity /><strong>目录检查完成</strong><p>会话已自动保存。</p></div> : null}
    </div>
    <footer><FileText /><span>上下文使用量</span><strong>余量充足</strong></footer>
  </>;
}
