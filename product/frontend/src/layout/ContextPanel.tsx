import { Activity, Brain, FileText, Folder, HardDrive, X } from "lucide-react";
import { Tooltip } from "antd";
import { useRef, useState } from "react";

const tabs = ["文件", "记忆", "活动"] as const;
const tabIds = { 文件: "files", 记忆: "memory", 活动: "activity" } as const;

export function ContextPanel({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("文件");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const activateTab = (index: number) => {
    const tab = tabs[index];
    setActiveTab(tab);
    tabRefs.current[index]?.focus();
  };

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    activateTab(nextIndex);
  };

  const activeId = tabIds[activeTab];

  return (
    <aside className="context-panel" aria-label="上下文舱">
      <header><h2>上下文</h2><Tooltip title="收起上下文舱"><button className="icon-button" type="button" aria-label="收起上下文舱" onClick={onClose}><X aria-hidden="true" /></button></Tooltip></header>
      <div className="context-tabs" role="tablist" aria-label="上下文类型">
        {tabs.map((tab, index) => {
          const id = tabIds[tab];
          return <button
            ref={(node) => { tabRefs.current[index] = node; }}
            key={tab}
            id={`context-tab-${id}`}
            type="button"
            role="tab"
            aria-controls={`context-panel-${id}`}
            aria-selected={activeTab === tab}
            tabIndex={activeTab === tab ? 0 : -1}
            onClick={() => setActiveTab(tab)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >{tab}</button>;
        })}
      </div>
      <div className="context-content" id={`context-panel-${activeId}`} role="tabpanel" aria-labelledby={`context-tab-${activeId}`}>
        {activeTab === "文件" ? <>
          <p className="panel-label">本次会话</p>
          <button className="file-row" type="button"><span className="file-type">MD</span><span><strong>release-notes.md</strong><small>已读取</small></span></button>
          <button className="file-row" type="button"><span className="file-type neutral">TXT</span><span><strong>checksums.txt</strong><small>已验证</small></span></button>
          <button className="file-row" type="button"><span className="file-type warning"><Folder /></span><span><strong>U-Claw-0.9.0</strong><small>发布目录</small></span></button>
          <div className="context-callout"><HardDrive /><span><strong>工作目录在 U 盘</strong><small>文件不会复制到本机缓存。</small></span></div>
        </> : null}
        {activeTab === "记忆" ? <div className="empty-panel"><Brain /><strong>发布流程偏好</strong><p>检查期间不写入文件，所有修改先确认。</p></div> : null}
        {activeTab === "活动" ? <div className="empty-panel"><Activity /><strong>目录检查完成</strong><p>会话已自动保存。</p></div> : null}
      </div>
      <footer><FileText /><span>上下文使用量</span><strong>余量充足</strong></footer>
    </aside>
  );
}
