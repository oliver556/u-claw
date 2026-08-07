import type { ApprovalDecision, ApprovalRequest, CapabilitySet, GatewayStatus, Message, MessageEvent, Session, ToolCall, UClawClient } from "@uclaw/shared";
import { AlertCircle, FolderArchive, LoaderCircle, PanelLeft, PanelRight, RotateCw, WifiOff } from "lucide-react";
import { Tooltip } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { useMessageStream } from "./useMessageStream";

interface ConversationProps {
  client: UClawClient;
  session: Session;
  capabilities?: CapabilitySet;
  gatewayStatus?: GatewayStatus;
  sessionsOpen: boolean;
  contextOpen: boolean;
  draft: string;
  onDraftChange(value: string): void;
  onActivity(message: string): void;
  onSendSuccess(sessionId: string): void;
  openSessions(): void;
  openContext(): void;
}

function requestId() {
  return globalThis.crypto?.randomUUID?.() ?? `request-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function resolveApproval(client: Pick<UClawClient, "approvals">, approval: ApprovalRequest, decision: ApprovalDecision) {
  if (approval.family === "exec") return client.approvals.resolveExec({ ref: { family: "exec", id: approval.id }, decision });
  return client.approvals.resolvePlugin({ ref: { family: "plugin", id: approval.id }, decision });
}

export function Conversation({ client, session, capabilities, gatewayStatus, sessionsOpen, contextOpen, draft, onDraftChange, onActivity, onSendSuccess, openSessions, openContext }: ConversationProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [historyState, setHistoryState] = useState<"loading" | "ready" | "error">("loading");
  const [historyError, setHistoryError] = useState<string>();
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [pendingTools, setPendingTools] = useState<ToolCall[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const activeRunId = useRef<string | undefined>(undefined);
  const sendController = useRef<AbortController | undefined>(undefined);
  const stopRequested = useRef(false);
  const mounted = useRef(true);
  const resolvingApprovals = useRef(new Set<string>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sendController.current?.abort();
    };
  }, []);

  const onStreamEvent = useCallback((event: MessageEvent) => {
    if (!mounted.current) return;
    if (event.type === "started") {
      activeRunId.current = event.runId;
      onActivity("响应已开始");
      if (stopRequested.current) void client.chat.abort(event.runId).catch(() => undefined);
    } else if (event.type === "tool") onActivity(`工具：${event.tool.displayName}`);
    else if (event.type === "approval") onActivity(`等待授权：${event.approval.title}`);
    else if (event.type === "final") onActivity("响应已完成");
    else if (event.type === "aborted") onActivity("响应已停止");
    else if (event.type === "error") onActivity(`响应失败：${event.error.message}`);
  }, [client, onActivity]);
  const { state: stream, consume, dismissApproval } = useMessageStream(onStreamEvent);

  const loadHistory = useCallback(async () => {
    setHistoryState("loading");
    setHistoryError(undefined);
    try {
      const [history, approvals] = await Promise.all([
        client.chat.list(session.id),
        client.approvals.listPending(session.id).catch(() => []),
      ]);
      const tools = await Promise.all(approvals.flatMap((approval) => approval.family === "exec" && approval.toolCallId !== undefined
        ? [client.tools.getCall(approval.toolCallId).catch(() => undefined)]
        : []));
      setMessages(history.items);
      setPendingApprovals(approvals);
      setPendingTools(tools.filter((tool): tool is ToolCall => tool !== undefined));
      setHistoryState("ready");
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "消息加载失败");
      setHistoryState("error");
    }
  }, [client, session.id]);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  const unavailable = gatewayStatus !== undefined && !gatewayStatus.businessAvailable;
  const attachmentsSupported = capabilities?.features.attachments === true;
  const canResolveApprovals = capabilities?.features.approvalResolve === true;

  const send = async () => {
    const text = draft.trim();
    if (text.length === 0 || sending || unavailable) return;
    setSendError(undefined);
    setSending(true);
    stopRequested.current = false;
    const controller = new AbortController();
    sendController.current = controller;
    onActivity("消息已发送");
    const optimistic: Message = {
      id: `local-${requestId()}`, sessionId: session.id, role: "user", status: "completed",
      blocks: [{ id: `local-block-${requestId()}`, type: "text", text, format: "plain" }],
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);
    const restoreFailedDraft = (message: string) => {
      setMessages((current) => current.filter((item) => item.id !== optimistic.id));
      onDraftChange(text);
      setSendError(message);
    };
    try {
      const terminal = await consume(client.chat.send({ sessionId: session.id, clientRequestId: requestId(), blocks: [{ type: "text", text, format: "plain" }] }, controller.signal));
      if (!mounted.current) return;
      if (terminal?.type === "error") restoreFailedDraft(terminal.error.message);
      else if (terminal?.type === "final") {
        onDraftChange("");
        onSendSuccess(session.id);
      }
    } catch (error) {
      if (mounted.current && !stopRequested.current) restoreFailedDraft(error instanceof Error ? error.message : "发送失败");
    } finally {
      activeRunId.current = undefined;
      sendController.current = undefined;
      stopRequested.current = false;
      if (mounted.current) setSending(false);
    }
  };

  const stop = async () => {
    stopRequested.current = true;
    const runId = activeRunId.current;
    if (runId === undefined) return;
    try { await client.chat.abort(runId); }
    catch (error) { setSendError(error instanceof Error ? error.message : "停止失败"); }
  };

  const handleApproval = async (approval: ApprovalRequest, decision: ApprovalDecision) => {
    if (resolvingApprovals.current.has(approval.id)) return;
    resolvingApprovals.current.add(approval.id);
    try {
      await resolveApproval(client, approval, decision);
      setPendingApprovals((current) => current.filter((item) => item.id !== approval.id));
      dismissApproval(approval.id);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "授权处理失败");
    } finally {
      resolvingApprovals.current.delete(approval.id);
    }
  };

  const titleMeta = useMemo(() => session.model?.label ?? "默认模型", [session.model?.label]);

  return <section className="work-canvas">
    <header className="canvas-head">
      <div className="canvas-title">
        {!sessionsOpen ? <Tooltip title="展开会话栏"><button className="icon-button" type="button" aria-label="展开会话栏" onClick={openSessions}><PanelLeft /></button></Tooltip> : null}
        <div><h2>{session.title}</h2><p>{titleMeta} <span>{sending ? "生成中" : "自动保存"}</span></p></div>
      </div>
      <div className="canvas-actions"><button type="button" disabled title="当前版本不支持归档"><FolderArchive />归档</button>{!contextOpen ? <Tooltip title="展开上下文舱"><button className="icon-button" type="button" aria-label="展开上下文舱" onClick={openContext}><PanelRight /></button></Tooltip> : null}</div>
    </header>
    {unavailable ? <div className="connection-alert" role="alert"><WifiOff /><span><strong>服务连接已断开</strong><small>消息暂时无法发送，草稿仍保留在本机。</small></span><button type="button" onClick={() => void client.gateway.reconnect()}><RotateCw />重新连接</button></div> : null}
    <div className="conversation" aria-busy={historyState === "loading"}>
      {historyState === "loading" ? <div className="conversation-state"><LoaderCircle className="spin" /><span>正在加载消息</span></div> : null}
      {historyState === "error" ? <div className="conversation-state" role="alert"><AlertCircle /><strong>消息加载失败</strong><span>{historyError}</span><button type="button" onClick={() => void loadHistory()}><RotateCw />重试</button></div> : null}
      {historyState === "ready" ? <MessageList messages={messages} stream={stream} pendingApprovals={pendingApprovals} pendingTools={pendingTools} canResolveApprovals={canResolveApprovals} onResolveApproval={(approval, decision) => void handleApproval(approval, decision)} /> : null}
    </div>
    {sendError ? <div className="send-error" role="alert"><AlertCircle /><span><strong>发送失败</strong>{sendError}</span></div> : null}
    <Composer value={draft} disabled={unavailable || historyState !== "ready"} sending={sending} attachmentsSupported={attachmentsSupported} onChange={onDraftChange} onSend={() => void send()} onStop={() => void stop()} />
  </section>;
}
