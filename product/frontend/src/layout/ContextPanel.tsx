import { Activity, Brain, FileText, Folder, HardDrive, X } from "lucide-react";
import { Tooltip } from "antd";
import { useState } from "react";

const tabs = ["文件", "记忆", "活动"] as const;

export function ContextPanel({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("文件");

  return (
    <aside className="context-panel" aria-label="上下文舱">
      <header><h2>上下文</h2><Tooltip title="收起上下文舱"><button className="icon-button" type="button" aria-label="收起上下文舱" onClick={onClose}><X aria-hidden="true" /></button></Tooltip></header>
      <div className="context-tabs" role="tablist" aria-label="上下文类型">
        {tabs.map((tab) => <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} onClick={() => setActiveTab(tab)}>{tab}</button>)}
      </div>
      <div className="context-content">
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
