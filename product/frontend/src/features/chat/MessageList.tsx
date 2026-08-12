import type { ApprovalDecision, ApprovalRequest, Message, ToolCall } from "@uclaw/shared";
import { Fragment } from "react";

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
  approvalCapabilities?: { exec: boolean; plugin: boolean };
  onResolveApproval(approval: ApprovalRequest, decision: ApprovalDecision): void | Promise<void>;
}

function MessageFrame({ message }: { message: Message }) {
  const assistant = message.role === "assistant";
  return <article className={`message ${assistant ? "assistant-message" : "user-message"}`} aria-label={assistant ? "助手消息" : "用户消息"}>
    <MessageContent blocks={message.blocks} />
  </article>;
}

export function MessageList({ messages, stream, pendingApprovals, pendingTools, canResolveApprovals, approvalCapabilities, onResolveApproval }: MessageListProps) {
  if (messages.length === 0 && stream.order.length === 0 && pendingApprovals.length === 0 && pendingTools.length === 0) {
    return <div className="conversation-empty"><span className="brand-mark compact"><i /><i /><i /></span><strong>开始一段新会话</strong><p>输入任务，U-Claw 会在需要工具或权限时明确告知。</p></div>;
  }
  const streamToolIds = new Set(stream.order.flatMap((runId) => stream.runs[runId].tools.map((tool) => tool.id)));
  const streamApprovalIds = new Set(stream.order.flatMap((runId) => stream.runs[runId].approvals.map((approval) => approval.id)));
  return <>{messages.map((message) => <MessageFrame key={message.id} message={message} />)}
    {stream.order.map((runId) => {
      const run = stream.runs[runId];
      if (run.finalMessage) return <Fragment key={runId}><MessageFrame message={run.finalMessage} />
        {run.tools.map((tool) => <ToolRun key={tool.id} tool={tool} />)}
        {run.approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} canResolve={approvalCapabilities?.[approval.family] ?? canResolveApprovals} onResolve={onResolveApproval} />)}
      </Fragment>;
      return <article className="message assistant-message" aria-label={`助手消息，${run.terminal === "aborted" ? "已停止" : run.terminal === "error" ? "失败" : "生成中"}`} key={runId}>
        {run.text ? <MessageContent blocks={[{ id: `${runId}-stream`, type: "text", text: run.text, format: "markdown" }]} /> : null}
        {run.tools.map((tool) => <ToolRun key={tool.id} tool={tool} />)}
        {run.approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} canResolve={approvalCapabilities?.[approval.family] ?? canResolveApprovals} onResolve={onResolveApproval} />)}
        {run.errorMessage ? <p className="stream-note">{run.errorMessage}</p> : null}
      </article>;
    })}
    {pendingTools.filter((tool) => !streamToolIds.has(tool.id)).map((tool) => <ToolRun key={tool.id} tool={tool} />)}
    {pendingApprovals.filter((approval) => !streamApprovalIds.has(approval.id)).map((approval) => <ApprovalCard key={approval.id} approval={approval} canResolve={approvalCapabilities?.[approval.family] ?? canResolveApprovals} onResolve={onResolveApproval} />)}
  </>;
}
