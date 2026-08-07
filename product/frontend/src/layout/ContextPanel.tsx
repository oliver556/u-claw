import { X } from "lucide-react";
import { Tooltip } from "antd";
import { ContextTabs } from "../features/context/ContextTabs";

export function ContextPanel({ onClose }: { onClose: () => void }) {
  return (
    <aside className="context-panel" aria-label="上下文舱">
      <header><h2>上下文</h2><Tooltip title="收起上下文舱"><button className="icon-button" type="button" aria-label="收起上下文舱" onClick={onClose}><X aria-hidden="true" /></button></Tooltip></header>
      <ContextTabs />
    </aside>
  );
}
