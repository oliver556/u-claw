import type { ApprovalDecision, ApprovalRequest, Message, ToolCall } from "@uclaw/shared";
import { LoaderCircle } from "lucide-react";
import { Fragment, useEffect, useState } from "react";

import { ApprovalCard } from "../approvals/ApprovalCard";
import { ToolRun } from "../tools/ToolRun";
import type { StreamState } from "./useMessageStream";
import { MessageContent } from "./MessageContent";

interface MessageListProps {
  messages: Message[];
  stream: StreamState;
  awaitingResponse?: boolean;
  pendingApprovals: ApprovalRequest[];
  pendingTools: ToolCall[];
  canResolveApprovals: boolean;
  approvalCapabilities?: { exec: boolean; plugin: boolean };
  onResolveApproval(approval: ApprovalRequest, decision: ApprovalDecision): void | Promise<void>;
}

function elapsedSeconds(startedAt: string, completedAt: string): number | undefined {
  const elapsedSeconds = Math.max(0, Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000));
  return Number.isFinite(elapsedSeconds) ? elapsedSeconds : undefined;
}

function formatDuration(prefix: "已处理" | "耗时", totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${prefix} ${minutes} 分 ${seconds} 秒` : `${prefix} ${seconds} 秒`;
}

function ProcessingMeta({ startedAt, completedAt }: { startedAt: string; completedAt?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (completedAt !== undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [completedAt]);
  const seconds = elapsedSeconds(startedAt, completedAt ?? new Date(now).toISOString());
  if (seconds === undefined) return null;
  return <div className="message-run-meta" role="status"><span>{formatDuration(completedAt === undefined ? "已处理" : "耗时", seconds)}</span></div>;
}

function MessageFrame({ message }: { message: Message }) {
  const assistant = message.role === "assistant";
  const failed = message.status === "failed";
  return <article className={`message ${assistant ? "assistant-message" : "user-message"}${failed ? " failed-message" : ""}`} aria-label={`${assistant ? "助手消息" : "用户消息"}${failed ? "，发送失败" : ""}`}>
    <MessageContent blocks={message.blocks} />
    {failed ? <small className="message-delivery-status">发送失败</small> : null}
  </article>;
}

function ThinkingIndicator() {
  return <span className="thinking-indicator" role="status" aria-label="助手正在处理"><LoaderCircle className="spin" aria-hidden="true" />正在处理</span>;
}

export function MessageList({ messages, stream, awaitingResponse = false, pendingApprovals, pendingTools, canResolveApprovals, approvalCapabilities, onResolveApproval }: MessageListProps) {
  if (messages.length === 0 && stream.order.length === 0 && !awaitingResponse && pendingApprovals.length === 0 && pendingTools.length === 0) {
    return <div className="conversation-empty"><span className="brand-mark compact"><i /><i /><i /></span><strong>开始一段新会话</strong><p>输入任务，U-Claw 会在需要工具或权限时明确告知。</p></div>;
  }
  const streamToolIds = new Set(stream.order.flatMap((runId) => stream.runs[runId].tools.map((tool) => tool.id)));
  const streamApprovalIds = new Set(stream.order.flatMap((runId) => stream.runs[runId].approvals.map((approval) => approval.id)));
  const streamRunsByMessageId = new Map(stream.order.flatMap((runId) => {
    const run = stream.runs[runId];
    return run.finalMessage === undefined ? [] : [[run.finalMessage.id, run] as const];
  }));
  const hasActiveRun = stream.order.some((runId) => stream.runs[runId].terminal === undefined);
  let latestUserStartedAt: string | undefined;
  return <>{messages.map((message) => {
    if (message.role === "user") {
      latestUserStartedAt = message.createdAt;
      return <MessageFrame key={message.id} message={message} />;
    }
    const startedAt = latestUserStartedAt;
    const streamRun = streamRunsByMessageId.get(message.id);
    return <Fragment key={message.id}>
      {message.role === "assistant" && message.status === "completed" && startedAt !== undefined ? <ProcessingMeta startedAt={startedAt} completedAt={streamRun?.completedAt ?? message.updatedAt ?? message.createdAt} /> : null}
      <MessageFrame message={message} />
    </Fragment>;
  })}
    {stream.order.map((runId) => {
      const run = stream.runs[runId];
      if (run.finalMessage) return <div className="run-details" key={runId}>
        {run.tools.map((tool) => <ToolRun key={tool.id} tool={tool} />)}
        {run.approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} canResolve={approvalCapabilities?.[approval.family] ?? canResolveApprovals} onResolve={onResolveApproval} />)}
      </div>;
      return <Fragment key={runId}>
        {run.terminal === undefined && latestUserStartedAt !== undefined ? <ProcessingMeta startedAt={latestUserStartedAt} /> : null}
        <article className={`message assistant-message${run.text === "" && run.terminal === undefined ? " thinking-message" : ""}`} aria-label={`助手消息，${run.terminal === "aborted" ? "已停止" : run.terminal === "error" ? "失败" : "生成中"}`}>
        {run.text ? <MessageContent blocks={[{ id: `${runId}-stream`, type: "text", text: run.text, format: "markdown" }]} /> : run.terminal === undefined ? <ThinkingIndicator /> : null}
        {run.tools.map((tool) => <ToolRun key={tool.id} tool={tool} />)}
        {run.approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} canResolve={approvalCapabilities?.[approval.family] ?? canResolveApprovals} onResolve={onResolveApproval} />)}
        {run.errorMessage ? <p className="stream-note">{run.errorMessage}</p> : null}
        </article>
      </Fragment>;
    })}
    {awaitingResponse && !hasActiveRun ? <>{latestUserStartedAt === undefined ? null : <ProcessingMeta startedAt={latestUserStartedAt} />}<article className="message assistant-message thinking-message"><ThinkingIndicator /></article></> : null}
    {pendingTools.filter((tool) => !streamToolIds.has(tool.id)).map((tool) => <ToolRun key={tool.id} tool={tool} />)}
    {pendingApprovals.filter((approval) => !streamApprovalIds.has(approval.id)).map((approval) => <ApprovalCard key={approval.id} approval={approval} canResolve={approvalCapabilities?.[approval.family] ?? canResolveApprovals} onResolve={onResolveApproval} />)}
  </>;
}
