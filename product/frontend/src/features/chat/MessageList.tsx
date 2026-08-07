import type { ApprovalDecision, ApprovalRequest, Message, ToolCall } from "@uclaw/shared";

import { ApprovalCard } from "../approvals/ApprovalCard";
import { ToolRun } from "../tools/ToolRun";
import type { StreamState } from "./useMessageStream";
import { MessageContent } from "./MessageContent";

interface MessageListProps {
  messages: Message[];
  stream: StreamState;
  pendingApprovals: ApprovalRequest[];
  pendingTools: ToolCall[];
  canResolveApprovals: boolean;
  onResolveApproval(approval: ApprovalRequest, decision: ApprovalDecision): void;
}

function MessageFrame({ message }: { message: Message }) {
  const assistant = message.role === "assistant";
  return <article className={`message ${assistant ? "assistant-message" : "user-message"}`}>
    <header>{assistant ? <span className="brand-mark compact"><i /><i /><i /></span> : <span className="avatar">李</span>}<strong>{assistant ? "U-Claw" : "你"}</strong>{message.model ? <small>{message.model.label}</small> : null}</header>
    <MessageContent blocks={message.blocks} />
  </article>;
}

export function MessageList({ messages, stream, pendingApprovals, pendingTools, canResolveApprovals, onResolveApproval }: MessageListProps) {
  if (messages.length === 0 && stream.order.length === 0 && pendingApprovals.length === 0 && pendingTools.length === 0) {
    return <div className="conversation-empty"><span className="brand-mark compact"><i /><i /><i /></span><strong>开始一段新会话</strong><p>输入任务，U-Claw 会在需要工具或权限时明确告知。</p></div>;
  }
  return <>{messages.map((message) => <MessageFrame key={message.id} message={message} />)}
    {stream.order.map((runId) => {
      const run = stream.runs[runId];
      if (run.finalMessage) return <MessageFrame key={runId} message={run.finalMessage} />;
      return <article className="message assistant-message" key={runId}>
        <header><span className="brand-mark compact"><i /><i /><i /></span><strong>U-Claw</strong><small>{run.terminal === "aborted" ? "已停止" : run.terminal === "error" ? "失败" : "生成中"}</small></header>
        {run.text ? <MessageContent blocks={[{ id: `${runId}-stream`, type: "text", text: run.text, format: "markdown" }]} /> : null}
        {run.tools.map((tool) => <ToolRun key={tool.id} tool={tool} />)}
        {run.approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} canResolve={canResolveApprovals} onResolve={onResolveApproval} />)}
        {run.errorMessage ? <p className="stream-note">{run.errorMessage}</p> : null}
      </article>;
    })}
    {pendingTools.map((tool) => <ToolRun key={tool.id} tool={tool} />)}
    {pendingApprovals.map((approval) => <ApprovalCard key={approval.id} approval={approval} canResolve={canResolveApprovals} onResolve={onResolveApproval} />)}
  </>;
}
