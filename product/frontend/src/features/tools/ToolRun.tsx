import type { ToolCall } from "@uclaw/shared";
import { Ban, CheckCircle2, ChevronRight, CircleAlert, Clock3, Code2, LoaderCircle, ShieldAlert } from "lucide-react";

const status = {
  queued: [Clock3, "已排队"],
  "waiting-authorization": [ShieldAlert, "等待授权"],
  running: [LoaderCircle, "运行中"],
  succeeded: [CheckCircle2, "已完成"],
  failed: [CircleAlert, "失败"],
  cancelled: [Ban, "已取消"],
} as const;

export function ToolRun({ tool }: { tool: ToolCall }) {
  const [StatusIcon, label] = status[tool.state];
  return <div className={`tool-run tool-${tool.state}`} role="status">
    <span className="tool-icon"><Code2 /></span>
    <span><strong>{tool.displayName}</strong><small>{tool.toolId}</small></span>
    <span className="tool-status"><StatusIcon className={tool.state === "running" ? "spin" : ""} />{label}</span>
    <ChevronRight aria-hidden="true" />
  </div>;
}
