import { X } from "lucide-react";
import { Tooltip } from "antd";
import type { CapabilitySet, Session, UClawClient } from "@uclaw/shared";
import { ContextTabs } from "../features/context/ContextTabs";

interface ContextPanelProps {
  client: UClawClient;
  session?: Session;
  capabilities?: CapabilitySet;
  activity: string[];
  onClose(): void;
}

export function ContextPanel({ client, session, capabilities, activity, onClose }: ContextPanelProps) {
  return (
    <aside className="context-panel" aria-label="上下文舱">
      <header><h2>上下文</h2><Tooltip title="收起上下文舱"><button className="icon-button" type="button" aria-label="收起上下文舱" onClick={onClose}><X aria-hidden="true" /></button></Tooltip></header>
      <ContextTabs client={client} session={session} capabilities={capabilities} activity={activity} />
    </aside>
  );
}
